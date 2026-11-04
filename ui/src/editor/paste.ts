// Smart paste classifiers (pure): what a clipboard text is, before the editor inserts it.
// Spreadsheet rows become tables, Teams chat copies a list, a lone URL a titled link and
// stack traces or logs a code block. Anything else is left to the normal paste.

export interface ChatMessage {
  name: string;
  time: string | null;
  lines: string[];
}

export type PasteKind =
  | { kind: "table"; rows: string[][] }
  | { kind: "chat"; messages: ChatMessage[] }
  | { kind: "url"; url: string }
  | { kind: "code"; code: string; language: string | null }
  | { kind: "markdown"; markdown: string };

const lines = (text: string) => text.replace(/\r\n?/g, "\n").split("\n");

// ------------------------------------------------------------------- URL

/** A single http(s) URL (whitespace around it allowed), else null. */
export function singleUrl(text: string): string | null {
  const t = text.trim();
  if (!/^https?:\/\/[^\s<>"'`]+$/i.test(t)) return null;
  try {
    const u = new URL(t);
    return u.hostname ? t : null;
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------- tables

/**
 * Tab-separated rows (Excel, Google Sheets, LibreOffice): at least two rows of the same width
 * (two or more cells). Quoted cells (`"a""b"`, with line breaks inside) are unquoted.
 */
export function parseTsv(text: string): string[][] | null {
  const src = text.replace(/\r\n?/g, "\n").replace(/\n$/, "");
  if (!src.includes("\t")) return null;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let i = 0;
  let atCellStart = true;
  while (i < src.length) {
    const c = src[i];
    if (atCellStart && c === '"') {
      // Quoted cell: up to the closing quote; "" is a quote.
      let j = i + 1;
      let out = "";
      let closed = false;
      while (j < src.length) {
        if (src[j] === '"') {
          if (src[j + 1] === '"') {
            out += '"';
            j += 2;
            continue;
          }
          closed = true;
          j++;
          break;
        }
        out += src[j++];
      }
      if (closed && (j >= src.length || src[j] === "\t" || src[j] === "\n")) {
        cell = out;
        i = j;
        atCellStart = false;
        continue;
      }
    }
    atCellStart = false;
    if (c === "\t") {
      row.push(cell);
      cell = "";
      atCellStart = true;
    } else if (c === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      atCellStart = true;
    } else cell += c;
    i++;
  }
  row.push(cell);
  rows.push(row);
  const width = rows[0].length;
  if (rows.length < 2 || width < 2 || rows.some((r) => r.length !== width)) return null;
  // Tab-indented code has an empty first cell in every row.
  if (rows.every((r) => r[0].trim() === "")) return null;
  if (rows.every((r) => r.every((c) => c.trim() === ""))) return null;
  return rows.map((r) => r.map((c) => c.trim()));
}

/** The `<table>` of pasted HTML (Word, web pages), when the table is (nearly) all of it. */
export function parseHtmlTable(html: string): string[][] | null {
  if (!/<table[\s>]/i.test(html) || typeof DOMParser === "undefined") return null;
  const doc = new DOMParser().parseFromString(html, "text/html");
  const table = doc.querySelector("table");
  if (!table) return null;
  const text = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
  const all = text(doc.body.textContent);
  if (all.length > 0 && text(table.textContent).length / all.length < 0.9) return null;
  const rows: string[][] = [];
  for (const tr of table.querySelectorAll("tr")) {
    if (tr.closest("table") !== table) continue;
    const row: string[] = [];
    for (const cell of tr.children) {
      if (!/^t[hd]$/i.test(cell.tagName)) continue;
      row.push(cell.querySelector("p, div, br") ? cellLines(cell) : text(cell.textContent));
      const span = Math.min(20, Number(cell.getAttribute("colspan")) || 1);
      for (let k = 1; k < span; k++) row.push("");
    }
    if (row.length) rows.push(row);
  }
  const width = Math.max(0, ...rows.map((r) => r.length));
  if (!rows.length || width < 1 || rows.length * width < 2) return null;
  return rows.map((r) => [...r, ...Array<string>(width - r.length).fill("")]);
}

/** Text of a cell with its paragraphs and line breaks as `\n`. */
function cellLines(cell: Element): string {
  const parts: string[] = [];
  let cur = "";
  const walk = (n: Node) => {
    if (n.nodeType === 3) cur += n.textContent;
    else if (n.nodeName === "BR") (parts.push(cur), (cur = ""));
    else {
      const block = /^(P|DIV|LI)$/.test(n.nodeName);
      if (block && cur.trim()) (parts.push(cur), (cur = ""));
      n.childNodes.forEach(walk);
      if (block) (parts.push(cur), (cur = ""));
    }
  };
  cell.childNodes.forEach(walk);
  parts.push(cur);
  return parts.map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
}

// ------------------------------------------------------------- Teams chat

const TIME = String.raw`\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AaPp]\.?[Mm]\.?)?`;
const DAY_WORDS = "Gestern|Heute|Vorgestern|Yesterday|Today|Montag|Dienstag|Mittwoch|Donnerstag|Freitag|Samstag|Sonntag|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Mo|Di|Mi|Do|Fr|Sa|So|Mon|Tue|Wed|Thu|Fri|Sat|Sun";
const DATE = String.raw`(?:\d{1,2}\.\s?\d{1,2}\.(?:\s?\d{2,4})?|\d{1,2}/\d{1,2}(?:/\d{2,4})?|\d{4}-\d{2}-\d{2}|(?:${DAY_WORDS})\.?(?:,?\s\d{1,2}\.\s?\d{1,2}\.(?:\d{2,4})?)?)`;
const STAMP = String.raw`(?:${DATE}[,\s]\s*)?(${TIME})`;
// 1–5 words; each starts upper-case (or is a name particle / a bracketed note like "(Extern)").
const WORD = String.raw`(?:\p{Lu}[\p{L}\p{M}'’.-]*|von|van|der|den|de|zu|la|le|di|da|\([^)\n]{1,20}\))`;
const NAME = String.raw`(\p{Lu}[\p{L}\p{M}'’.-]*(?:,?\s${WORD}){0,4}?)`;

const BRACKET_HEAD = new RegExp(String.raw`^\[${STAMP}\]\s+${NAME}(?::\s*(.*))?$`, "u");
const NAME_TIME_HEAD = new RegExp(String.raw`^${NAME}[,\s]\s*${STAMP}$`, "u");
const NAME_ONLY = new RegExp(String.raw`^${NAME}$`, "u");
const STAMP_ONLY = new RegExp(String.raw`^${STAMP}$`, "u");

/**
 * A Teams chat copy as messages, or null. Understood forms (German and English clients):
 * - `[10:32] Max Mustermann` / `[24.09.2026 10:32] Max Mustermann` then the message lines;
 * - `[10:32] Max Mustermann: Nachricht` on one line;
 * - `Max Mustermann 10:32` / `Max Mustermann, Gestern 10:32` then the message lines (classic);
 * - `Max Mustermann` and on the next line `10:32` then the message lines (new Teams).
 * Needs two messages (one in the bracket forms, which only Teams writes).
 */
export function parseTeamsChat(text: string): ChatMessage[] | null {
  const ls = lines(text).map((l) => l.trim());
  const messages: ChatMessage[] = [];
  let bracket = false;
  let cur: ChatMessage | null = null;
  for (let i = 0; i < ls.length; i++) {
    const l = ls[i];
    if (!l) continue;
    let m = BRACKET_HEAD.exec(l);
    if (m) {
      bracket = true;
      cur = { name: m[2].trim(), time: m[1], lines: m[3] ? [m[3].trim()] : [] };
      messages.push(cur);
      continue;
    }
    m = NAME_TIME_HEAD.exec(l);
    if (m && !bracket) {
      cur = { name: m[1].trim(), time: m[2], lines: [] };
      messages.push(cur);
      continue;
    }
    const next = ls[i + 1] ?? "";
    const stamp = STAMP_ONLY.exec(next);
    if (!bracket && stamp && NAME_ONLY.test(l)) {
      cur = { name: l, time: stamp[1], lines: [] };
      messages.push(cur);
      i++;
      continue;
    }
    if (!cur) return null; // text before the first header: not a chat copy
    cur.lines.push(l);
  }
  if (messages.length < (bracket ? 1 : 2)) return null;
  if (messages.some((m) => !m.lines.length)) return null;
  return messages;
}

// ------------------------------------------------------- stack traces, logs

const PY_HEAD = /^Traceback \(most recent call last\):/m;
const PY_FRAME = /^\s*File "[^"]+", line \d+/;
const JAVA_FRAME = /^\s*at [\w$./<>]+\((?:[\w$.-]+\.(?:java|kt|scala|groovy|clj):\d+|Native Method|Unknown Source)\)\s*$/;
const JAVA_HEAD = /^(?:Exception in thread "[^"]*" |Caused by: )?[a-z][\w$]*(?:\.[\w$]+)+(?:Exception|Error|Throwable)\b/;
const JAVA_MORE = /^\s*\.\.\. \d+ (?:more|common frames omitted)$/;
const DOTNET_FRAME = /^\s*at [\w.`<>[\],+|]+\([^)]*\)(?: in .+:line \d+)?\s*$/;
const DOTNET_HEAD = /^(?:Unhandled exception\. )?System(?:\.\w+)+(?:Exception|Error):|--- End of (?:inner exception )?stack trace/;
const JS_FRAME = /^\s*at (?:(?:async |new )?[^\s()]+(?: \[as [^\]]+\])? \()?(?:[^\s()]+):\d+:\d+\)?\s*$/;
const JS_HEAD = /^(?:Uncaught )?(?:[A-Z]\w*)?(?:Error|Exception)(?: \[[\w_]+\])?: /;
const LEVEL = /\b(?:TRACE|DEBUG|INFO|NOTICE|WARN(?:ING)?|ERROR|ERR|FATAL|CRITICAL|SEVERE)\b/;
const LOG_STAMP = /^\[?(?:\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?|\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}(?::\d{2})?|\d{2}:\d{2}:\d{2}(?:[.,]\d+)?)/;

/**
 * Multi-line text that looks like a stack trace (Java, .NET, Python, JavaScript) or a log
 * (timestamps with levels): the code block's language, `null` for plain logs; `undefined` otherwise.
 */
export function detectTrace(text: string): { language: string | null } | undefined {
  const ls = lines(text).filter((l) => l.trim());
  if (ls.length < 2) return undefined;
  const count = (re: RegExp) => ls.filter((l) => re.test(l)).length;
  const py = count(PY_FRAME);
  if (PY_HEAD.test(text) && py >= 1) return { language: "python" };
  const java = count(JAVA_FRAME) + count(JAVA_MORE);
  const javaHead = ls.some((l) => JAVA_HEAD.test(l.trim()));
  if (java >= 2 || (java >= 1 && javaHead)) return { language: "java" };
  const js = count(JS_FRAME);
  const jsHead = ls.some((l) => JS_HEAD.test(l.trim()));
  if (js >= 2 || (js >= 1 && jsHead)) return { language: "javascript" };
  const dotnet = count(DOTNET_FRAME);
  const dotnetHead = ls.some((l) => DOTNET_HEAD.test(l.trim()));
  if (dotnet >= 2 || (dotnet >= 1 && dotnetHead)) return { language: "csharp" };
  if (py >= 2) return { language: "python" };
  const log = ls.filter((l) => LOG_STAMP.test(l.trim()) && LEVEL.test(l)).length;
  if (log >= 2 && log * 2 >= ls.length) return { language: null };
  return undefined;
}

// ------------------------------------------------------------- Word lists

// What Word and Outlook put before a list item: a bullet (also Symbol/Wingdings code points), or a
// number or letter with `.` or `)`. In the plain text the marker is followed by a tab.
const BULLET_MARK = /^[•·◦▪▫■□‣⁃∙○●–—\-*o§]$/;
const ORDERED_MARK = /^\(?(?:\d{1,3}|[a-zA-Z]|[ivxlcIVXLC]{1,6})[.)]$/;

/** Rows split at tabs that are list items copied from Word or Outlook (`•⇥Punkt`, `1.⇥Eins`), as Markdown lines. */
function listRows(rows: string[][]): string[] | null {
  if (!rows.every((r) => r.length === 2 && (BULLET_MARK.test(r[0]) || ORDERED_MARK.test(r[0])))) return null;
  let n = 0;
  return rows.map(([mark, item]) => (ORDERED_MARK.test(mark) && !BULLET_MARK.test(mark) ? `${++n}. ${item}` : `- ${item}`));
}

/**
 * Word and Outlook copy lists as paragraphs (`<p style="mso-list:l0 level2 lfo1">`) with the bullet or
 * number as text in front: turned into real nested `<ul>`/`<ol>` lists, the marker dropped.
 */
export function wordListsToHtml(html: string): string {
  if (!/mso-list/i.test(html) || typeof DOMParser === "undefined") return html;
  const doc = new DOMParser().parseFromString(html, "text/html");
  const items = [...doc.body.querySelectorAll<HTMLElement>("p, h1, h2, h3, h4, h5, h6")].filter((p) => /mso-list:\s*l\d+\s+level\d+/i.test(p.getAttribute("style") ?? ""));
  if (!items.length) return html;
  type Open = { list: HTMLElement; level: number; li: HTMLElement | null };
  let stack: Open[] = [];
  let listId = "";
  let last: Element | null = null;
  for (const p of items) {
    const m = /mso-list:\s*(l\d+)\s+level(\d+)/i.exec(p.getAttribute("style") ?? "")!;
    const level = Math.min(9, Number(m[2]));
    // The marker: the `mso-list:Ignore` span (inside `<![if !supportLists]>`), or the first text of the paragraph.
    const ignore = p.querySelector<HTMLElement>("[style*='mso-list:Ignore' i], [style*='mso-list: Ignore' i]");
    let mark = (ignore?.textContent ?? "").replace(/[\s ]+/g, " ").trim();
    if (ignore) {
      let marker: Element = ignore;
      while (marker.parentElement && marker.parentElement !== p && marker.parentElement.textContent?.trim() === ignore.textContent?.trim()) marker = marker.parentElement;
      marker.remove();
    } else {
      const walker = doc.createTreeWalker(p, NodeFilter.SHOW_TEXT);
      let first = walker.nextNode();
      while (first && !first.textContent?.trim()) first = walker.nextNode();
      const lead = first ? /^[\s ]*(\S{1,6})[\s ]+/.exec(first.textContent ?? "") : null;
      if (first && lead && (BULLET_MARK.test(lead[1]) || ORDERED_MARK.test(lead[1]))) {
        mark = lead[1];
        first.textContent = (first.textContent ?? "").slice(lead[0].length);
      }
    }
    const ordered = ORDERED_MARK.test(mark) && !BULLET_MARK.test(mark);
    // A list goes on while its paragraphs follow each other (only whitespace or comments between them).
    let prev = p.previousSibling;
    while (prev && (prev.nodeType === 8 || (prev.nodeType === 3 && !prev.textContent?.trim()))) prev = prev.previousSibling;
    if (prev !== last || m[1] !== listId) stack = [];
    listId = m[1];
    while (stack.length && stack[stack.length - 1].level > level) stack.pop();
    let top = stack[stack.length - 1];
    if (!top || top.level < level || (top.list.tagName === "OL") !== ordered) {
      if (top && top.level === level) stack.pop();
      const list = doc.createElement(ordered ? "ol" : "ul");
      const start = /^\(?(\d{1,3})[.)]$/.exec(mark);
      if (ordered && start && start[1] !== "1") list.setAttribute("start", start[1]);
      const parent = stack[stack.length - 1]?.li;
      if (parent) parent.append(list);
      else p.before(list);
      top = { list, level, li: null };
      stack.push(top);
    }
    const li = doc.createElement("li");
    const para = doc.createElement(/^H\d$/.test(p.tagName) ? p.tagName.toLowerCase() : "p");
    para.append(...p.childNodes);
    li.append(para);
    top.list.append(li);
    top.li = li;
    // `p` stays in place until the next item has looked at its neighbour; all are removed below.
    last = p;
  }
  for (const p of items) p.remove();
  return doc.body.innerHTML;
}

// --------------------------------------------------------------- classify

/** What `text` (and the HTML flavor, if any) should become; null for a normal paste. */
export function classifyPaste(text: string, html = ""): PasteKind | null {
  // Copied inside the editor: ProseMirror's own slice.
  if (html.includes("data-pm-slice")) return null;
  const url = singleUrl(text);
  if (url) return { kind: "url", url };
  const trace = text.includes("\n") ? detectTrace(text) : undefined;
  if (trace) return { kind: "code", code: text.replace(/\r\n?/g, "\n").replace(/\n+$/, ""), language: trace.language };
  const tsv = parseTsv(text);
  // A list from Word or Outlook (`•⇥Punkt` per line) is no table: its HTML has the list, plain text becomes one.
  const items = tsv ? listRows(tsv) : null;
  if (items) return html ? null : { kind: "markdown", markdown: items.join("\n") + "\n" };
  if (tsv) return { kind: "table", rows: tsv };
  const table = html ? parseHtmlTable(html) : null;
  if (table) return { kind: "table", rows: table };
  const chat = text.includes("\n") ? parseTeamsChat(text) : null;
  if (chat) return { kind: "chat", messages: chat };
  if (isMarkdownText(text, html)) return { kind: "markdown", markdown: text.replace(/\r\n?/g, "\n") };
  return null;
}

// ------------------------------------------------------------- markdown

// Lines that make text Markdown: headings, list items and tasks, quotes and callouts, fences, table rows.
const MD_BLOCK = /^ {0,3}(?:#{1,6}[ \t]+\S|[-*+][ \t]+\S|\d{1,3}[.)][ \t]+\S|>[ \t]?\S|```|~~~|\|.*\|[ \t]*$)/;
// Inline syntax that plain prose does not contain by accident: bold, wiki links, links, code spans.
const MD_INLINE = /\*\*[^*\n]+\*\*|\[\[[^\]\n]+\]\]|\[[^\]\n]+\]\((?:https?:|mailto:|<)[^)\n]*\)|(?:^|\s)`[^`\n]+`/;

/**
 * Markdown copied as plain text (a `.md` file, a code editor, an AI chat): shown formatted instead of
 * as literal `#`, `-` and `**`. Only plain text or a code editor's HTML (monospace lines) counts, so
 * web pages and Office keep their own formatting, and a lone list-like line stays as typed text.
 */
export function isMarkdownText(text: string, html = ""): boolean {
  if (html && !/white-space:\s*pre|<pre[\s>]/i.test(html)) return false;
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks = lines.filter((l) => MD_BLOCK.test(l)).length;
  if (blocks >= 2 || (blocks === 1 && /^ {0,3}(?:#{1,6}[ \t]|```|~~~)/m.test(text))) return true;
  return MD_INLINE.test(text);
}
