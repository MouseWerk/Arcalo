// Keeping the author's Markdown: a page is saved the way it was written.
//
// Two layers, both set up while the Markdown is parsed (MarkdownManager is patched once here):
// - Source blocks: every top-level block keeps the text it was read from (`src`) and the blank
//   lines before it (`gap`). A block that is still exactly as it was read is saved as that text,
//   so a page opened and saved without edits stays byte-identical, whatever syntax it uses.
// - Source style: blocks and marks remember how they were written (bullet `*`/`+`/`-`, `1)`,
//   `~~~` and longer fences, `_x_`/`__x__`, setext headings, `***` rules, reference links,
//   compact tables, list indentation) and an edited block is written in that style again.
//   New content uses the editor's defaults.

import { Extension, Node, type Editor } from "@tiptap/core";
import { MarkdownManager, extractAbsorbedBlankLines } from "@tiptap/markdown";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { TIGHT_MARK } from "./blocks";
import { t } from "../lib/i18n";

export interface Tok {
  type: string;
  raw?: string;
  text?: string;
  href?: string;
  title?: string | null;
  tag?: string;
  lang?: string;
  codeBlockStyle?: string;
  loose?: boolean;
  ordered?: boolean;
  items?: Tok[];
  tokens?: Tok[];
  /** A task item of the task list tokenizer: the indentation of its nested lines. */
  indent?: string;
  __top?: boolean;
  __gap?: Gap | null;
}

export interface JNode {
  type?: string;
  attrs?: Record<string, unknown>;
  content?: JNode[];
  marks?: unknown[];
  text?: string;
  /** Index of the source text that stands for this block (set by `prepareSource`). */
  __raw?: number;
  /** Blank lines to write before this block (set by `prepareSource`). */
  __gap?: number;
}

interface MarkResult {
  mark: string;
  content: JNode[];
  attrs?: Record<string, unknown>;
}

/** The blank lines before a top-level block: `n` lines after the block with source hash `prev`, `empties` implicit empty paragraphs between. */
export interface Gap {
  n: number;
  prev: string;
  empties: number;
}

// ---------------------------------------------------------------- helpers

/** A short hash of a block's source (cyrb53), to recognize the block before a gap. */
export function hashText(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** A block's source without the line ends and blank lines after it. */
export const blockSource = (raw: string) => raw.replace(/(?:\r?\n[ \t]*)+$/, "").replace(/\r?\n$/, "");

const newlines = (s: string) => (s.match(/\n/g) ?? []).length;
const trailingNewlines = (s: string) => /\n*$/.exec(s)![0].length;
const leadingWs = (line: string) => /^[ \t]*/.exec(line)![0];

/** Tab stops as CommonMark counts them. */
const TAB = 4;
export function columns(ws: string): number {
  let col = 0;
  for (const c of ws) col = c === "\t" ? col + TAB - (col % TAB) : col + 1;
  return col;
}

/** `line` without its first `n` columns of indentation (a tab cut in half leaves spaces). */
export function dedent(line: string, n: number): string {
  let col = 0;
  let i = 0;
  while (i < line.length && col < n) {
    const c = line[i];
    if (c === " ") col++;
    else if (c === "\t") {
      const w = TAB - (col % TAB);
      if (col + w > n) return " ".repeat(col + w - n) + line.slice(i + 1);
      col += w;
    } else break;
    i++;
  }
  return line.slice(i);
}

/** Reference labels match case-insensitively with collapsed whitespace (CommonMark). */
export const normLabel = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

// ---------------------------------------------------------------- source style of a token

/** The marker and the indentation of the nested lines of a list item, from its source. */
function itemStyle(raw: string | undefined): { indent?: string; cont?: string } {
  if (!raw) return {};
  const lines = raw.split("\n");
  const own = leadingWs(lines[0]);
  const out: { indent?: string; cont?: string } = {};
  // The line after the marker line continues its paragraph (indented or lazy).
  if (lines.length > 1 && lines[1].trim()) {
    const ws = leadingWs(lines[1]);
    out.cont = ws.startsWith(own) ? ws.slice(own.length) : "";
  }
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const ws = leadingWs(line);
    if (ws.length > own.length && ws.startsWith(own)) {
      out.indent = ws.slice(own.length);
      break;
    }
  }
  return out;
}

const firstLine = (raw: string | undefined) => (raw ?? "").replace(/^(?:[ \t]*\n)+/, "").split("\n")[0];

/** Style attributes of a list (and its items) as written. */
function styleList(token: Tok, out: JNode) {
  const items = token.items ?? [];
  const head = firstLine(items[0]?.raw ?? token.raw);
  const attrs: Record<string, unknown> = { ...out.attrs };
  if (out.type === "orderedList") {
    const m = /^[ \t]*(\d+|[A-Za-z]{1,2}|[ivxlcdmIVXLCDM]+)([.)])/.exec(head);
    if (m?.[2] === ")") attrs.delim = ")";
    const numbers = items.map((it) => /^[ \t]*(\d+)[.)]/.exec(firstLine(it.raw))?.[1]);
    if (numbers.length > 1 && numbers.every((n) => n != null && n === numbers[0])) attrs.lazy = true;
  } else {
    const m = /^[ \t]*([-+*])/.exec(head);
    if (m && m[1] !== "-") attrs.bullet = m[1];
  }
  // Items separated by blank lines (CommonMark „loose“): the blank lines stay.
  // (marked's items end with their line break, Tiptap's ordered items without; a mixed list's parts are lists of their own.)
  const blankAfter = token.loose !== undefined ? /\n[ \t]*\n[ \t]*$/ : /\n[ \t]*$/;
  const loose = items.slice(0, -1).some((it) => blankAfter.test(it.raw ?? ""));
  if (loose && items.length > 1) attrs.loose = true;
  out.attrs = attrs;
  const kids = out.content ?? [];
  if (kids.length !== items.length) return;
  kids.forEach((kid, i) => {
    const s = items[i].indent != null ? { indent: items[i].indent, ...contOf(items[i].raw) } : itemStyle(items[i].raw);
    if (s.indent != null || s.cont != null) kid.attrs = { ...kid.attrs, ...(s.indent != null ? { indent: s.indent } : {}), ...(s.cont != null ? { cont: s.cont } : {}) };
    if (s.indent === "\t") tabsDown(kid);
  });
}

/** marked reads nested lists with their tabs as four spaces: lists under a tab-indented item indent with tabs too. */
function tabsDown(item: JNode) {
  for (const child of item.content ?? []) {
    if (child.type !== "bulletList" && child.type !== "orderedList" && child.type !== "taskList") continue;
    for (const sub of child.content ?? []) {
      if (sub.attrs?.indent === "    ") {
        sub.attrs = { ...sub.attrs, indent: "\t" };
        tabsDown(sub);
      }
    }
  }
}

const contOf = (raw: string | undefined) => {
  const { cont } = itemStyle(raw);
  return cont != null ? { cont } : {};
};

const isMarkResult = (r: unknown): r is MarkResult => !!r && typeof r === "object" && "mark" in r;

/** A link as written: inline `[x](u)`, `<u>`, a bare URL, or a reference `[x][r]`, `[x][]`, `[x]`. */
export function linkForm(raw: string): { form: string; ref?: string } {
  if (raw.startsWith("<")) return { form: "angle" };
  if (!raw.startsWith("[")) return { form: "bare" };
  if (raw.endsWith(")")) return { form: "inline" };
  const full = /\]\[([^\]]+)\]$/.exec(raw);
  if (full) return { form: "full", ref: full[1] };
  if (raw.endsWith("[]")) return { form: "collapsed", ref: raw.slice(1, -3) };
  return { form: "shortcut", ref: raw.slice(1, -1) };
}

/** Adds what the source looked like to the node or mark a token became. */
function styleToken(token: Tok, out: unknown): unknown {
  const raw = token.raw ?? "";
  switch (token.type) {
    case "em":
    case "strong":
      if (isMarkResult(out) && raw.startsWith("_")) out.attrs = { ...out.attrs, delim: "_" };
      return out;
    case "del":
      if (isMarkResult(out) && /^~(?!~)/.test(raw)) out.attrs = { ...out.attrs, delim: "~" };
      return out;
    case "link":
      if (isMarkResult(out)) out.attrs = { ...out.attrs, ...linkForm(raw) };
      return out;
    case "br":
      if (out && typeof out === "object" && !Array.isArray(out) && raw && raw !== "  \n") (out as JNode).attrs = { ...(out as JNode).attrs, raw };
      return out;
    case "heading": {
      const node = out as JNode | null;
      if (!node || Array.isArray(node) || node.type !== "heading") return out;
      const lines = raw.replace(/\n+$/, "").split("\n");
      if (!/^[ \t]{0,3}#/.test(lines[0])) {
        const under = lines[lines.length - 1].trim();
        if (/^(=+|-+)$/.test(under)) node.attrs = { ...node.attrs, setext: under };
      } else {
        const close = /[ \t]+#+[ \t]*$/.exec(lines[0]);
        if (close && !/^[ \t]{0,3}#+[ \t]+#+[ \t]*$/.test(lines[0])) node.attrs = { ...node.attrs, close: close[0] };
      }
      return out;
    }
    case "hr": {
      const node = out as JNode | null;
      const markup = raw.trim();
      if (node && !Array.isArray(node) && markup && markup !== "---") node.attrs = { ...node.attrs, markup };
      return out;
    }
    case "code": {
      // Tiptap drops a fence indented by one to three spaces (` ```js`): read like any fence.
      let node = out as JNode | JNode[] | null;
      if ((!node || (Array.isArray(node) && !node.length)) && /^[ \t]{1,3}(`{3,}|~{3,})/.test(raw)) {
        node = { type: "codeBlock", attrs: { language: token.lang || null }, content: token.text ? [{ type: "text", text: token.text }] : [] };
      }
      if (!node || Array.isArray(node) || node.type !== "codeBlock") return node;
      const line = raw.split("\n")[0];
      if (token.codeBlockStyle === "indented") node.attrs = { ...node.attrs, fence: line.startsWith("\t") ? "\t" : "    " };
      else {
        const m = /^([ \t]{0,3})(`{3,}|~{3,})(.*)$/.exec(line);
        if (m) node.attrs = { ...node.attrs, fence: m[1] + m[2], info: m[3] };
      }
      return node;
    }
    case "list":
    case "taskList": {
      const nodes = (Array.isArray(out) ? out : [out]) as JNode[];
      for (const n of nodes) if (n && (n.type === "bulletList" || n.type === "orderedList" || n.type === "taskList")) styleList(token, n);
      return out;
    }
    case "table": {
      const node = out as JNode | null;
      if (node && !Array.isArray(node) && node.type === "table") {
        const style = tableStyle(raw);
        if (style) node.attrs = { ...node.attrs, style };
      }
      return out;
    }
  }
  return out;
}

/** How a table was written when it is not the aligned, padded default: `{ compact, outer, sep }`. */
export function tableStyle(raw: string): { compact: boolean; outer: boolean; sep: string } | null {
  const lines = raw.replace(/\n+$/, "").split("\n").map((l) => l.replace(/[ \t]+$/, ""));
  if (lines.length < 2) return null;
  const outer = lines.every((l) => /^\s*\|/.test(l) && /\|$/.test(l));
  const aligned = outer && lines.every((l) => l.length === lines[0].length) && /^\|(?: [^|]*\|)+$/.test(lines[1]) && /^\| :?-+:? \|/.test(lines[1]);
  if (aligned) return null;
  return { compact: true, outer, sep: lines[1] };
}

const STYLED_TOKENS = new Set(["em", "strong", "del", "link", "br", "heading", "hr", "code", "list", "taskList", "table"]);

// ---------------------------------------------------------------- source blocks of a parse

let depth = 0;

/** The Markdown being parsed (line ends as the lexer sees them), to take each block's source from. */
let parsing: string | null = null;

/**
 * Marks the top-level tokens with the blank lines before them. Their source is taken from the
 * Markdown itself where marked trimmed it (a list's last line loses its trailing spaces).
 */
function markTopTokens(tokens: Tok[]): Tok[] {
  const norm = extractAbsorbedBlankLines(tokens as never) as unknown as Tok[];
  let prev: Tok | null = null;
  let lines = 0;
  let empties = 0;
  let at = 0;
  return norm.map((tok, i) => {
    const raw = tok.raw ?? "";
    if (parsing != null && at >= 0 && parsing.startsWith(raw, at)) {
      at += raw.length;
      const trail = /^[ \t]+(?=\n|$)/.exec(parsing.slice(at, at + 200));
      if (trail && tok.type !== "space" && !raw.endsWith("\n")) {
        tok = { ...tok, raw: raw + trail[0] };
        at += trail[0].length;
      }
    } else at = -1;
    if (tok.type === "space") {
      lines += newlines(tok.raw ?? "");
      // Tiptap turns long runs of blank lines into empty paragraphs (createImplicitEmptyParagraphsFromSpace).
      const seps = ((tok.raw ?? "").replace(/\r\n/g, "\n").match(/\n\n/g) ?? []).length;
      const last = !norm.slice(i + 1).some((t) => t.type !== "space");
      empties += Math.max(seps - (prev === null || last ? 0 : 1), 0);
      return tok;
    }
    const gap: Gap | null = prev ? { n: Math.max(0, lines - 1), prev: hashText(blockSource(prev.raw ?? "")), empties } : null;
    prev = tok;
    lines = trailingNewlines(tok.raw ?? "");
    empties = 0;
    return { ...tok, __top: true, __gap: gap };
  });
}

/** Top-level blocks keep their source and the blank lines before them. */
function markTopNode(token: Tok, out: unknown) {
  const nodes = (Array.isArray(out) ? out : [out]) as (JNode | null)[];
  const first = nodes[0];
  if (!first || typeof first !== "object") return;
  const attrs: Record<string, unknown> = { ...first.attrs };
  if (nodes.length === 1 && token.raw) attrs.src = blockSource(token.raw);
  if (token.__gap) attrs.gap = token.__gap;
  first.attrs = attrs;
}

{
  const proto = MarkdownManager.prototype as unknown as {
    parse: (md: string) => unknown;
    parseTokens: (tokens: Tok[], implicit?: boolean, ...rest: unknown[]) => unknown;
    parseToken: (token: Tok, ...rest: unknown[]) => unknown;
    registerExtension: (ext: unknown) => void;
    applyMarkToContent: (type: string, content: JNode[], attrs?: Record<string, unknown>) => JNode[];
    registry: Map<string, { tokenName?: string; parseMarkdown?: (token: Tok, helpers: unknown) => unknown; __styled?: boolean }[]>;
  };
  const parse = proto.parse;
  proto.parse = function (this: unknown, md) {
    const outer = parsing;
    parsing = depth === 0 ? md.replace(/\r\n|\r/g, "\n") : outer;
    try {
      return parse.call(this, md);
    } finally {
      parsing = outer;
    }
  };
  const parseTokens = proto.parseTokens;
  proto.parseTokens = function (this: unknown, tokens, implicit, ...rest) {
    const top = depth === 0 && implicit === true;
    depth++;
    try {
      return parseTokens.call(this, top ? markTopTokens(tokens) : tokens, implicit, ...rest);
    } finally {
      depth--;
    }
  };
  const parseToken = proto.parseToken;
  // (A mixed bullet/task list is parsed again in parts, from copies of its token: marked once.)
  let inTop = false;
  proto.parseToken = function (this: unknown, token, ...rest) {
    if (!token.__top || inTop) return parseToken.call(this, token, ...rest);
    inTop = true;
    let out: unknown;
    try {
      out = parseToken.call(this, token, ...rest);
    } finally {
      inTop = false;
    }
    if (out) markTopNode(token, out);
    return out;
  };
  // Every handler of a styled token adds the style of its source.
  const register = proto.registerExtension;
  proto.registerExtension = function (this: typeof proto, ext) {
    register.call(this, ext);
    for (const specs of this.registry.values()) {
      for (const spec of specs) {
        const parse = spec.parseMarkdown;
        if (spec.__styled || !parse || !STYLED_TOKENS.has(spec.tokenName ?? "")) continue;
        spec.__styled = true;
        spec.parseMarkdown = (token, helpers) => styleToken(token, parse(token, helpers));
      }
    }
  };
  // A mark around a link, image or embed (`**[[Seite]]**`, `[![Badge](b.svg)](url)`) applies to it too:
  // Tiptap marks only text and dropped these.
  const apply = proto.applyMarkToContent;
  proto.applyMarkToContent = function (this: unknown, type, content, attrs) {
    const out = apply.call(this, type, content, attrs);
    return out.map((node) => {
      if (node.type === "text" || node.type === "hardBreak" || node.content) return node;
      return { ...node, marks: [...(node.marks ?? []), attrs ? { type, attrs } : { type }] };
    });
  };
}

// ---------------------------------------------------------------- task lists (tab-indented)

const TASK_ITEM = /^([ \t]*)([-+*])[ \t]+\[([ xX])\][ \t]+(.*)$/;

interface Lexer {
  inlineTokens: (src: string) => Tok[];
  blockTokens: (src: string) => Tok[];
}

/**
 * Tiptap's task list tokenizer, reading indentation in columns: nested lines indented with a tab
 * (Obsidian's default) lost their first characters (`\t- [ ] b` became `[ ] b`). Items also keep
 * their source and the indentation of their nested lines.
 */
export function tokenizeTaskList(src: string, lexer: Lexer): Tok | undefined {
  const lines = src.split("\n");
  const items: Tok[] = [];
  let raw = "";
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = TASK_ITEM.exec(line);
    // (Blank lines before the list are marked's: they separate it from what came before.)
    if (!m) {
      if (items.length) break;
      return undefined;
    }
    const own = columns(m[1]);
    const itemLines = [line];
    raw += `${line}\n`;
    i++;
    while (i < lines.length) {
      const next = lines[i];
      if (!next.trim()) {
        const k = lines.slice(i + 1).findIndex((l) => l.trim() !== "");
        if (k === -1 || columns(leadingWs(lines[i + 1 + k])) <= own) break;
      } else if (columns(leadingWs(next)) <= own) break;
      itemLines.push(next);
      raw += `${next}\n`;
      i++;
    }
    const nested = itemLines
      .slice(1)
      .map((l) => dedent(l, own + 2))
      .join("\n");
    let nestedTokens: Tok[] | undefined;
    if (nested.trim()) {
      const sub = tokenizeTaskList(nested, lexer);
      const rest = sub ? nested.slice(sub.raw!.length) : nested;
      nestedTokens = sub ? (rest.trim() ? [sub, ...lexer.blockTokens(rest)] : [sub]) : lexer.blockTokens(nested);
    }
    const style = itemStyle(itemLines.join("\n"));
    items.push({
      type: "taskItem",
      raw: itemLines.join("\n"),
      text: m[4],
      tokens: lexer.inlineTokens(m[4]),
      indent: style.indent,
      ...({ mainContent: m[4], indentLevel: own, checked: m[3].toLowerCase() === "x", nestedTokens } as object),
    });
  }
  if (!items.length) return undefined;
  return { type: "taskList", raw, items };
}

// ---------------------------------------------------------------- reference definitions

/** `[label]: https://…` of reference links, kept as written (a muted source line in the editor). */
export const RefDefinition = Node.create({
  name: "refDefinition",
  group: "block",
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      label: { default: "", rendered: false },
      href: { default: "", rendered: false },
      title: { default: null, rendered: false },
      raw: { default: "", rendered: false },
    };
  },
  parseHTML() {
    return [{ tag: "pre[data-ref-def]", preserveWhitespace: "full", getAttrs: (el) => ({ raw: (el as HTMLElement).textContent ?? "" }) }];
  },
  renderHTML({ node }) {
    return ["pre", { "data-ref-def": "", class: "md-html-block md-ref-def", title: t("editor.refDefinition"), contenteditable: "false" }, node.attrs.raw];
  },
  renderText: ({ node }) => node.attrs.raw,
  markdownTokenName: "def",
  parseMarkdown: (token) => ({
    type: "refDefinition",
    attrs: { label: normLabel(String(token.tag ?? "")), href: token.href ?? "", title: token.title ?? null, raw: String(token.raw ?? "").replace(/\s+$/, "") },
  }),
  renderMarkdown: (node, _h, ctx) => {
    const raw = String(node.attrs?.raw ?? "");
    // Definitions one per line stay together (unless the file had a blank line between).
    const gap = node.attrs?.gap as Gap | undefined;
    return (ctx as { previousNode?: JNode } | undefined)?.previousNode?.type === "refDefinition" && (!gap || gap.n === 0) ? TIGHT_MARK + raw : raw;
  },
});

// ---------------------------------------------------------------- serializing

/** Placeholders for source blocks and blank lines; resolved in `cleanMarkdown`. */
export const RAW_OPEN = "";
export const RAW_CLOSE = "";
export const GAP_LINE = "";
export const RAW_RE = /(\d+)/g;
// `_x_` and `__x__` are written with sentinels: inside a word they cannot work and become `*`.
export const EM_OPEN = "";
export const EM_CLOSE = "";
export const STRONG_OPEN = "";
export const STRONG_CLOSE = "";

/** Blocks written as their source when unchanged. */
const RAW_TYPES = new Set(["paragraph", "heading", "codeBlock", "horizontalRule", "table", "blockquote", "bulletList", "orderedList", "taskList", "refDefinition", "htmlBlock"]);

let enabled = true;
/** Source blocks on/off (tests check the style layer alone). */
export function setSourceBlocks(on: boolean) {
  enabled = on;
}

const originals = new WeakMap<Editor, Map<string, PMNode[]>>();

/** Remembers the top-level blocks of `doc` as read from the file (after creating or reloading). */
export function rememberSource(editor: Editor, doc: PMNode = editor.state.doc) {
  let map = originals.get(editor);
  if (!map) originals.set(editor, (map = new Map()));
  doc.forEach((node) => {
    const src = node.attrs.src;
    if (typeof src !== "string") return;
    const list = map.get(src);
    if (!list) map.set(src, [node]);
    else if (!list.some((n) => n === node || n.eq(node))) list.push(node);
  });
}

/** The reference definitions of a document by label. */
function refDefs(doc: PMNode): Map<string, { href: string; title: string | null }> {
  const defs = new Map<string, { href: string; title: string | null }>();
  doc.descendants((node) => {
    if (node.type.name === "refDefinition") {
      const label = String(node.attrs.label);
      if (!defs.has(label)) defs.set(label, { href: String(node.attrs.href), title: (node.attrs.title as string | null) ?? null });
      return false;
    }
    return !node.isTextblock;
  });
  return defs;
}

/** Whether every reference link in `node` still has its definition (else its source would lose the link). */
function refsResolve(node: PMNode, defs: Map<string, { href: string }>): boolean {
  let ok = true;
  node.descendants((n) => {
    if (!ok) return false;
    for (const m of n.marks) {
      const ref = m.type.name === "link" ? (m.attrs.ref as string | undefined) : undefined;
      if (ref != null && defs.get(normLabel(ref))?.href !== m.attrs.href) ok = false;
    }
    return true;
  });
  return ok;
}

let renderDefs: Map<string, { href: string; title: string | null }> | null = null;

/** The definition a reference link is written with, when it still matches the link. */
export function refFor(label: string, href: string, title: string | null): boolean {
  const def = renderDefs?.get(normLabel(label));
  return !!def && def.href === href && (def.title ?? null) === (title || null);
}

const isEmptyParagraph = (n: PMNode) => n.type.name === "paragraph" && n.childCount === 0;

/**
 * Marks the top-level blocks of `json` (the editor's JSON) that are written as their source
 * (`__raw`, an index into the returned list) and the blank lines before them (`__gap`).
 */
export function prepareSource(editor: Editor, json: JNode): string[] {
  const raws: string[] = [];
  const doc = editor.state.doc;
  renderDefs = refDefs(doc);
  const content = json.content ?? [];
  const map = originals.get(editor);
  if (!enabled || !map || content.length !== doc.childCount) return raws;
  const same: boolean[] = [];
  doc.forEach((node, _offset, i) => {
    const src = node.attrs.src;
    const unchanged = typeof src === "string" && !!map.get(src)?.some((o) => o === node || o.eq(node));
    same[i] = unchanged;
    if (unchanged && RAW_TYPES.has(node.type.name) && (!src.includes("[") || refsResolve(node, renderDefs!))) content[i].__raw = raws.push(src as string) - 1;
    const gap = node.attrs.gap as Gap | null | undefined;
    if (!gap || i === 0) return;
    let k = i - 1;
    let empties = 0;
    while (k >= 0 && isEmptyParagraph(doc.child(k)) && doc.child(k).attrs.src == null) {
      k--;
      empties++;
    }
    const prev = k >= 0 ? doc.child(k) : null;
    // Blank lines as written after the same block (it may be edited); none only where both are unchanged.
    if (prev && typeof prev.attrs.src === "string" && empties === gap.empties && hashText(prev.attrs.src) === gap.prev && (gap.n > 0 || (unchanged && same[k]))) content[i].__gap = gap.n;
  });
  return raws;
}

/** Ends serializing (reference links are written inline again outside of `toMarkdown`). */
export function endSource() {
  renderDefs = null;
}

/** Writes `_x_`/`__x__` with `*` where the underscore would touch a letter or digit (no emphasis there). */
export function resolveUnderscores(md: string): string {
  if (!/[]/.test(md)) return md;
  const pass = (s: string, open: string, close: string, d: string, star: string) =>
    s.replace(new RegExp(`${open}${d}([\\s\\S]*?)${d}${close}`, "g"), (m, inner: string, at: number, all: string) => {
      const before = all[at - 1] ?? "";
      const after = all[at + m.length] ?? "";
      const intra = /[\p{L}\p{N}]/u.test(before) || /[\p{L}\p{N}]/u.test(after);
      return intra ? star + inner + star : d + inner + d;
    });
  return pass(pass(md, EM_OPEN, EM_CLOSE, "_", "*"), STRONG_OPEN, STRONG_CLOSE, "__", "**").replace(/[-]/g, "");
}

// ---------------------------------------------------------------- list rendering

interface RenderHelpers {
  renderChildren: (nodes: unknown, separator?: string) => string;
  renderChild?: (node: unknown, index: number) => string;
  indent: (content: string) => string;
}
interface RenderContext {
  index?: number;
  parentType?: string;
  previousNode?: JNode;
  meta?: { parentAttrs?: Record<string, unknown> };
}

const width = (s: string) => columns(s);

/** A list item: the marker, the first paragraph and the nested blocks, indented as the source was. */
export function renderListItem(node: JNode, h: RenderHelpers, prefix: string, indent: string): string {
  const [first, ...rest] = node.content ?? [];
  let out = prefix + (first ? h.renderChildren([first]) : "");
  const cont = node.attrs?.cont;
  if (typeof cont === "string" && cont && first?.type === "paragraph") out = out.split("\n").map((l, i) => (i && l ? cont + l : l)).join("\n");
  rest.forEach((child, i) => {
    const text = h.renderChild?.(child, i + 1) ?? h.renderChildren([child]);
    if (text == null) return;
    const block = text
      .split("\n")
      .map((l) => (l ? indent + l : ""))
      .join("\n");
    out += child.type === "paragraph" ? `\n\n${block}` : `\n${block}`;
  });
  return out;
}

/** The marker of a list item in its list (`- `, `* `, `3. `, `1) `). */
export function listMarker(ctx: RenderContext | undefined): string {
  const parent = ctx?.meta?.parentAttrs ?? {};
  if (ctx?.parentType === "orderedList") {
    const start = Number(parent.start ?? 1) || 1;
    const n = parent.lazy ? start : start + (ctx.index ?? 0);
    return `${n}${parent.delim === ")" ? ")" : "."} `;
  }
  return `${typeof parent.bullet === "string" ? parent.bullet : "-"} `;
}

/** Indentation of nested blocks: as written, else two spaces (or the width of a number marker). */
export function itemIndent(node: JNode, h: RenderHelpers, prefix: string, ordered: boolean): string {
  const own = node.attrs?.indent;
  if (typeof own === "string" && own) return own;
  const base = h.indent("");
  return ordered && width(base) < width(prefix) ? " ".repeat(width(prefix)) : base;
}

// ---------------------------------------------------------------- the extension

const BLOCK_TYPES = ["paragraph", "heading", "codeBlock", "horizontalRule", "table", "blockquote", "bulletList", "orderedList", "taskList", "refDefinition", "htmlBlock", "columns", "footnotes", "footnoteDefinition", "tableOfContents", "pageEmbed", "callout"];

const attr = (keepOnSplit = false) => ({ default: null, rendered: false, keepOnSplit });

/** Source and style attributes; the source blocks' placeholders when serializing. */
export const SourceStyle = Extension.create({
  name: "sourceStyle",
  addGlobalAttributes() {
    return [
      { types: BLOCK_TYPES, attributes: { src: attr(), gap: attr() } },
      { types: ["bold", "italic", "strike"], attributes: { delim: attr() } },
      { types: ["link"], attributes: { form: attr(), ref: attr() } },
      { types: ["heading"], attributes: { setext: attr(), close: attr() } },
      { types: ["horizontalRule"], attributes: { markup: attr() } },
      { types: ["codeBlock"], attributes: { fence: attr(), info: attr() } },
      { types: ["bulletList", "taskList"], attributes: { bullet: attr(), loose: attr() } },
      { types: ["orderedList"], attributes: { delim: attr(), loose: attr(), lazy: attr() } },
      { types: ["listItem", "taskItem"], attributes: { indent: attr(true), cont: attr(true) } },
      { types: ["table"], attributes: { style: attr() } },
    ];
  },
  addProseMirrorPlugins() {
    const editor = this.editor;
    // The document as read, when the editor state is first made (`create` fires only later).
    return [
      new Plugin({
        key: new PluginKey("sourceStyle"),
        state: {
          init: (_config, state) => {
            if (!originals.has(editor)) rememberSource(editor, state.doc);
            return null;
          },
          apply: () => null,
        },
      }),
    ];
  },
  onBeforeCreate() {
    const manager = (this.editor as unknown as { markdown?: Manager }).markdown;
    if (!manager) return;
    const renderNode = manager.renderNodeToMarkdown.bind(manager);
    manager.renderNodeToMarkdown = (node, ...rest) => {
      const raw = node.__raw;
      const gap = node.__gap;
      if (raw == null && gap == null) return renderNode(node, ...rest);
      let out = raw != null ? RAW_OPEN + raw + RAW_CLOSE : renderNode(node, ...rest);
      if (gap === 0) out = TIGHT_MARK + out.replace(/^\n+/, "");
      else if (gap != null && gap > 1) out = `${GAP_LINE}\n`.repeat(gap - 1) + out.replace(/^\n+/, "");
      return out;
    };
    // Marked links, images and embeds (see applyMarkToContent): rendered once and carried as text
    // with the marks, so the marks open and close around them like around words.
    const withBoundaries = manager.renderNodesWithMarkBoundaries.bind(manager);
    manager.renderNodesWithMarkBoundaries = (nodes, parent, ...rest) => {
      if (!nodes.some((n) => n.type !== "text" && n.type !== "hardBreak" && n.marks?.length && !n.content)) return withBoundaries(nodes, parent, ...rest);
      const mapped = nodes.map((n, i) => {
        if (n.type === "text" || n.type === "hardBreak" || !n.marks?.length || n.content) return n;
        const text = renderNode({ ...n, marks: undefined }, parent, i, rest[1] ?? 0);
        return { type: "text", text, marks: n.marks, [RENDERED]: text } as JNode;
      });
      return withBoundaries(mapped, parent, ...rest);
    };
  },
});

/** A text node standing for a rendered inline node (written as it is, no escaping). */
export const RENDERED = "__rendered";

interface Manager {
  renderNodeToMarkdown: (node: JNode, ...rest: unknown[]) => string;
  renderNodesWithMarkBoundaries: (nodes: JNode[], parent: JNode, separator?: string, level?: number) => string;
}
