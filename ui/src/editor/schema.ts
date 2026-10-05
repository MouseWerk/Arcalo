// The editor schema shared by the app and the Markdown round-trip tests.

import { Extension, type Editor, type Extensions } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Paragraph from "@tiptap/extension-paragraph";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Table, TableKit, renderTableToMarkdown } from "@tiptap/extension-table";
import Highlight from "@tiptap/extension-highlight";
import { Placeholder } from "@tiptap/extensions";
import { Markdown, MarkdownManager } from "@tiptap/markdown";
import Link from "@tiptap/extension-link";
import { IssueChips } from "./issueChips";
import { RecurringTasks } from "./recurTasks";
import { Callouts, DueWords, ImageEmbed, MarkdownImage, SlashCommand, TagHighlight, TimeEntryChip, WikiLink, WikiLinkSuggest, ZeitCommand, ZeitSuggest, type LinkSuggestItem, type ZeitResult, type ZeitSuggestItem } from "./extensions";
import { FindInPage } from "./find";
import { DrawingEmbed } from "./drawing";
import { AttachmentDrop, FileEmbed, anchorPage, isPdfName } from "./fileEmbed";
import { pdfAnchor } from "../lib/linking";
import { CiteFlash } from "./reveal";
import { FocusSelection } from "./focusSelection";
import { TYPING_DEFAULTS, TypingAids, type TypingPrefs } from "./typing";
import { SmartPaste } from "./smartPaste";
import { t } from "../lib/i18n";
import { Column, Columns, FootnoteDefinition, FootnoteRef, Footnotes, TableOfContents, TIGHT_MARK } from "./blocks";
import { HtmlBlock, HtmlInline, LiteralHash, codeFence, openEmptyTasks, rawHtmlNode } from "./rawMarkdown";
import { CHUNK_LINES, chunkedLex } from "./chunkedLex";
import { LazyHighlight, lowlight } from "./languages";
import { PageEmbed, type PageEmbedOptions } from "./pageEmbed";
import { RichBlocks, type RichBlocksOptions } from "./richBlocks";
import type { Lexer } from "marked";
import {
  EM_CLOSE,
  EM_OPEN,
  GAP_LINE,
  RAW_RE,
  RENDERED,
  RefDefinition,
  STRONG_CLOSE,
  STRONG_OPEN,
  SourceStyle,
  endSource,
  itemIndent,
  listMarker,
  normLabel,
  prepareSource,
  refFor,
  renderListItem,
  resolveUnderscores,
  tokenizeTaskList,
  type JNode,
} from "./sourceStyle";

export { lowlight };

/**
 * Escapes only what would change meaning when the Markdown is parsed again.
 * The default serializer escapes every `[ ] _ * ~`, which litters files
 * (`a\_b`, `\[Entwurf\]`) that Obsidian users read and edit directly.
 */
export function escapeText(t: string, atLineStart = true, around: { before?: boolean; after?: boolean } = {}): string {
  let s = t
    .replace(/\\(?=[\\`*_[\]~=#<>!|.)+-])/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\[\[/g, "\\[\\[")
    .replace(/\[\^/g, "\\[^")
    .replace(/\[([^\]\n]*)\]\(/g, "\\[$1\\](");
  // Text next to other inline content (a mark, a link): its edge counts as punctuation there.
  s = (around.before ? EDGE : "") + s + (around.after ? EDGE : "");
  s = s
    .replace(/\*+/g, (run, at: number, all: string) => (flanking(all[at - 1], all[at + run.length]) ? run.replace(/\*/g, "\\*") : run))
    .replace(/_+/g, (run, at: number, all: string) => (flanking(all[at - 1], all[at + run.length]) ? run.replace(/_/g, "\\_") : run))
    .replace(EDGE_RE, "")
    .replace(/~~/g, "\\~\\~")
    .replace(/==/g, "\\=\\=")
    .replace(/&(?=#?\w+;)/g, "&amp;")
    // A no-break space is invisible in the file: written as the entity Obsidian users type.
    .replace(/\u00a0/g, "&nbsp;")
    // `<` only where it would start HTML, a comment or an autolink (`a < b`, `Map<K, V>` stay).
    .replace(/<(?=[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>|\/[A-Za-z][A-Za-z0-9-]*\s*>|[!?]|[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*>|[^\s<>@]+@[^\s<>]+>)/g, "&lt;");
  return s
    .split("\n")
    .map((line, i) => (i > 0 || atLineStart ? escapeLineStart(line) : line))
    .join("\n");
}

/** Stands for inline content next to a text while escaping it. */
const EDGE = "\uE050";
const EDGE_RE = /\uE050/g;
const WORD = /[\p{L}\p{N}]/u;

/**
 * Whether a run of `*` or `_` between `prev` and `next` could open or close emphasis (it touches
 * text on one side and is not inside a word); then the whole run is escaped.
 */
function flanking(prev: string | undefined, next: string | undefined): boolean {
  const opens = next != null && !/\s/.test(next) && !(prev != null && WORD.test(prev));
  const closes = prev != null && !/\s/.test(prev) && !(next != null && WORD.test(next));
  return opens || closes;
}

/** Escapes what would turn a line into a block (heading, list, quote, setext underline). */
function escapeLineStart(line: string): string {
  if (/^\s{0,3}(?:-+|=+)\s*$/.test(line)) return line.replace(/^(\s*)/, "$1\\");
  return line.replace(/^(\s{0,3})(#{1,6}(?=\s|$)|[-+*](?=\s|$)|>)/, "$1\\$2").replace(/^(\s{0,3}\d+)([.)])(?=\s|$)/, "$1\\$2");
}

/** Marks paragraphs rendered inside table cells, where `|` must be escaped. */
export const IN_TABLE_CELL = "__inTableCell";

interface JsonNode {
  type?: string;
  attrs?: Record<string, unknown>;
  content?: JsonNode[];
  marks?: (string | { type: string })[];
}

function markTableCells(node: JsonNode): JsonNode {
  const mark = (n: JsonNode): JsonNode => ({ ...n, attrs: { ...n.attrs, [IN_TABLE_CELL]: true }, content: n.content?.map(mark) });
  return {
    ...node,
    content: node.content?.map((row) => ({ ...row, content: row.content?.map((cell) => ({ ...cell, content: cell.content?.map(mark) })) })),
  };
}

/** Tiptap's table start(): whether the rest starts with a header and a separator row. */
export function tableStart(src: string): number {
  // Same as splitting the rest into lines and looking at the first two, without the split.
  const a = src.indexOf("\n");
  if (a < 0) return -1;
  const b = src.indexOf("\n", a + 1);
  const sep = src.slice(a + 1, b < 0 ? src.length : b);
  if (!/^[ \t|:]*-[ \t|:-]*$/.test(sep) || !sep.includes("|")) return -1;
  return src.slice(0, a).includes("|") ? 0 : -1;
}

/** Characters of a cell as written in the file (code fences and link sentinels are resolved later). */
const cellWidth = (s: string) => s.replace(CODE_RE, (_m, code: string) => codeSpan(code)).replace(SENTINELS_RE, "").length;

/**
 * Tiptap's table serializer with column widths that match the file: sentinels do not count,
 * and the alignment colons are part of the separator's width instead of adding to it.
 */
function renderTable(node: JsonNode, h: Parameters<typeof renderTableToMarkdown>[1]): string {
  type Cell = { text: string; header: boolean; align: string | null };
  const rows: Cell[][] = (node.content ?? []).map((row) =>
    (row.content ?? []).map((cell) => {
      const content = cell.content ?? [];
      const raw = content.length > 1 ? content.map((child) => h.renderChildren(child as never)).join("\n") : h.renderChildren(content as never);
      const text = raw.replace(/[ \t]*\r?\n[ \t]*/g, "<br>").replace(/\s+/g, " ").trim();
      const align = cell.attrs?.align;
      return { text, header: cell.type === "tableHeader", align: align === "left" || align === "right" || align === "center" ? align : null };
    }),
  );
  const cols = rows.reduce((max, r) => Math.max(max, r.length), 0);
  if (!cols) return "";
  const widths = Array.from({ length: cols }, (_, i) => Math.max(3, ...rows.map((r) => cellWidth(r[i]?.text ?? ""))));
  const aligns = Array.from({ length: cols }, (_, i) => rows.find((r) => r[i]?.align)?.[i]?.align ?? null);
  const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - cellWidth(s)));
  const line = (cells: string[]) => `| ${cells.map((c, i) => pad(c, widths[i])).join(" | ")} |\n`;
  const hasHeader = rows[0].some((c) => c.header);
  const sep = widths.map((w, i) => {
    const a = aligns[i];
    if (a === "left") return `:${"-".repeat(w - 1)}`;
    if (a === "right") return `${"-".repeat(w - 1)}:`;
    if (a === "center") return `:${"-".repeat(w - 2)}:`;
    return "-".repeat(w);
  });
  const cellsOf = (r: Cell[]) => Array.from({ length: cols }, (_, i) => r[i]?.text ?? "");
  // A table written without padding stays that way, with its separator row while the columns match.
  const style = node.attrs?.style as { compact?: boolean; outer?: boolean; sep?: string } | null | undefined;
  if (style?.compact) {
    const row = (cells: string[]) => (style.outer ? `| ${cells.join(" | ")} |\n` : `${cells.join(" | ")}\n`);
    const seps = (style.sep ?? "").replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
    const sepAlign = (c: string) => (c.startsWith(":") && c.endsWith(":") && c.length > 1 ? "center" : c.startsWith(":") ? "left" : c.endsWith(":") ? "right" : null);
    const sameSep = seps.length === cols && seps.every((c, i) => /^:?-+:?$/.test(c) && sepAlign(c) === aligns[i]);
    const own = aligns.map((a) => (a === "left" ? ":--" : a === "right" ? "--:" : a === "center" ? ":-:" : "---"));
    let out = "\n" + row(hasHeader ? cellsOf(rows[0]) : cellsOf([])) + (sameSep ? `${style.sep}\n` : row(own));
    for (const r of hasHeader ? rows.slice(1) : rows) out += row(cellsOf(r));
    return out;
  }
  let out = "\n" + line(hasHeader ? cellsOf(rows[0]) : cellsOf([])) + `| ${sep.join(" | ")} |\n`;
  for (const r of hasHeader ? rows.slice(1) : rows) out += line(cellsOf(r));
  return out;
}

const MarkdownTable = Table.extend({
  renderMarkdown: (node, h) => renderTable(markTableCells(node as JsonNode), h),
  markdownTokenizer: Table.config.markdownTokenizer && { ...Table.config.markdownTokenizer, start: tableStart },
});

type RenderSpec = { renderMarkdown?: (node: JsonNode, ...rest: unknown[]) => string };

interface SerializerInternals {
  codeTypes: Set<string>;
  nodeTypeRegistry: Map<string, RenderSpec[]>;
  encodeTextForMarkdown: (text: string, node: JsonNode, parent?: JsonNode) => string;
}

let chunkLines = CHUNK_LINES;

/** Lines per lexed piece; 0 lexes notes as a whole (tests compare both). */
export function setChunkedLexing(lines: number) {
  chunkLines = lines;
}

interface ListToken {
  type: string;
  raw?: string;
  text?: string;
  items?: ListToken[];
  spacedBefore?: boolean;
}
const LIST_TOKENS = new Set(["list", "taskList"]);
/** A token's source ends with a blank line. */
const BLANK_END = /\n[ \t>]*\n[ \t>]*$/;
const isTask = (item: ListToken) => /^\s*[-+*]\s+\[[ xX]\]\s+/.test(item.raw ?? item.text ?? "");
const setSpaced = (node: JsonNode | null | undefined) => {
  if (node && (node.type === "bulletList" || node.type === "taskList")) node.attrs = { ...node.attrs, spacedBefore: true };
};

// Parsing: every manager (the editor's initial content is parsed before extensions can
// adjust their own manager). Raw HTML and comments are kept verbatim instead of being
// converted or dropped; `- [ ]` without text is an empty task.
{
  const proto = MarkdownManager.prototype as unknown as { parse: (md: string) => unknown; parseHTMLToken: typeof rawHtmlNode };
  const parse = proto.parse;
  proto.parse = function (this: unknown, md: string) {
    return parse.call(this, openEmptyTasks(md));
  };
  proto.parseHTMLToken = rawHtmlNode;
  // Entities (`&nbsp;`, `&copy;`, `&#124;`) read as their characters like everywhere else; Tiptap
  // decodes only `&amp; &lt; &gt; &quot;` and would show `&nbsp;` and save it as `&amp;nbsp;`.
  const entityProto = MarkdownManager.prototype as unknown as {
    parseInlineTokens: (tokens: { type: string; text?: string }[]) => unknown;
    parseFallbackToken: (token: { type: string; text?: string }, ...rest: unknown[]) => unknown;
  };
  const inline = entityProto.parseInlineTokens;
  entityProto.parseInlineTokens = function (this: unknown, tokens) {
    return inline.call(this, tokens.map(decodeTextToken));
  };
  const fallback = entityProto.parseFallbackToken;
  entityProto.parseFallbackToken = function (this: unknown, token, ...rest) {
    return fallback.call(this, decodeTextToken(token), ...rest);
  };
  // A bullet list and a task list next to each other: whether the author left a blank line between
  // them is kept on the second list (`spacedBefore`), so an unedited page is saved unchanged.
  const listProto = MarkdownManager.prototype as unknown as {
    parseTokens: (tokens: ListToken[], ...rest: unknown[]) => unknown;
    parseToken: (token: ListToken, ...rest: unknown[]) => JsonNode | JsonNode[] | null;
    parseListToken: (token: ListToken) => JsonNode | JsonNode[] | null;
  };
  const parseTokens = listProto.parseTokens;
  listProto.parseTokens = function (this: unknown, tokens, ...rest) {
    // A list after a blank line: a `space` token before it, or one the previous list swallowed.
    const flagged = tokens.map((t, i) => {
      const prev = tokens[i - 1];
      const blank = prev && LIST_TOKENS.has(t.type) && (prev.type === "space" || (LIST_TOKENS.has(prev.type) && BLANK_END.test(prev.raw ?? "")));
      return blank ? { ...t, spacedBefore: true } : t;
    });
    return parseTokens.call(this, flagged, ...rest);
  };
  const parseToken = listProto.parseToken;
  listProto.parseToken = function (this: unknown, token, ...rest) {
    const out = parseToken.call(this, token, ...rest);
    if (token.spacedBefore) setSpaced(Array.isArray(out) ? out[0] : out);
    return out;
  };
  const parseListToken = listProto.parseListToken;
  listProto.parseListToken = function (this: unknown, token) {
    // The parts of a split list are parsed from copies of the token: the flag is for the first only.
    const { spacedBefore: _, ...plain } = token;
    const out = parseListToken.call(this, plain);
    if (!Array.isArray(out) || out.length < 2 || !token.items) return out;
    // Tiptap splits a list with bullet and task items into one list per run (same grouping here).
    const blankBefore: boolean[] = [];
    token.items.forEach((item, i) => {
      const prev = token.items![i - 1];
      if (prev && isTask(item) !== isTask(prev)) blankBefore.push(BLANK_END.test(prev.raw ?? ""));
    });
    if (blankBefore.length === out.length - 1) blankBefore.forEach((b, i) => b && setSpaced(out[i + 1]));
    return out;
  };
  // Long notes are lexed in pieces (see chunkedLex.ts); the tokens are the same.
  const managerProto = MarkdownManager.prototype as unknown as { createLexer: () => Lexer };
  const createLexer = managerProto.createLexer;
  managerProto.createLexer = function (this: unknown) {
    const lexer = createLexer.call(this);
    lexer.lex = (src: string) => (chunkLines > 0 ? chunkedLex(lexer, src, chunkLines) : Object.getPrototypeOf(lexer).lex.call(lexer, src));
    return lexer;
  };
}

const ENTITY_RE = /&(?:#\d{1,7}|#[xX][\da-fA-F]{1,6}|[A-Za-z][A-Za-z\d]{1,31});/g;
let entityBox: HTMLTextAreaElement | null = null;

/** Decodes HTML entities except the four Tiptap decodes itself (those stay for it). */
export function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(ENTITY_RE, (m) => {
    if (/^&(amp|lt|gt|quot);$/.test(m)) return m;
    entityBox ??= document.createElement("textarea");
    entityBox.innerHTML = m;
    const c = entityBox.value;
    // Unknown names stay as written; a decoded `&` or `<` is encoded again for Tiptap's decoding.
    return c === m ? m : c.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  });
}

function decodeTextToken<T extends { type: string; text?: string }>(token: T): T {
  return token.type === "text" && token.text?.includes("&") ? { ...token, text: decodeEntities(token.text) } : token;
}

/** The plain text inside a serialized node (code block content). */
const textOf = (node: JsonNode): string => (node.content ?? []).map((c) => (c as { text?: string }).text ?? textOf(c)).join("");

type ListHelpers = Parameters<typeof renderListItem>[1];
type ListContext = Parameters<typeof listMarker>[0];

/**
 * A code block in the fence it was written with (backticks or tildes, at least as long as
 * before) and its info string as written; indented code stays indented where it can.
 */
export function renderCodeBlock(node: JsonNode, ctx?: { parentType?: string; previousNode?: JsonNode }): string {
  const language = String(node.attrs?.language ?? "");
  const text = textOf(node);
  const style = typeof node.attrs?.fence === "string" ? node.attrs.fence : "";
  // Indented code needs a block before it that it cannot continue (not a list) and no blank edge lines.
  const prev = ctx?.previousNode?.type ?? "";
  if (/^(?: {4}|\t)$/.test(style) && !language && ctx?.parentType === "doc" && prev && !/List$/.test(prev) && text.trim() && !/^\s*\n|\n\s*$/.test(text)) {
    return text
      .split("\n")
      .map((l) => (l ? style + l : l))
      .join("\n");
  }
  const m = /([`~]{3,})$/.exec(style);
  let fence = codeFence(text);
  if (m?.[1][0] === "~") {
    const longest = Math.max(0, ...[...text.matchAll(/^ {0,3}(~{3,})/gm)].map((r) => r[1].length));
    fence = "~".repeat(Math.max(3, m[1].length, longest + 1));
  } else if (m && m[1].length > fence.length) fence = m[1];
  const info = typeof node.attrs?.info === "string" && node.attrs.info.trim() === language ? node.attrs.info : language;
  return `${fence}${info}\n${text}\n${fence}`;
}

/** Installs the minimal escaping on the editor's Markdown serializer. */
const MarkdownFidelity = Extension.create({
  name: "markdownFidelity",
  addGlobalAttributes() {
    // A `<br>` written in the file stays `<br>` (instead of becoming two trailing spaces).
    // A list after a bullet/task list of the other kind that had a blank line before it in the file.
    return [
      { types: ["hardBreak"], attributes: { raw: { default: null, rendered: false } } },
      { types: ["bulletList", "taskList"], attributes: { spacedBefore: { default: false, rendered: false, keepOnSplit: false } } },
    ];
  },
  onBeforeCreate() {
    const manager = (this.editor as unknown as { markdown?: SerializerInternals }).markdown;
    if (!manager) return;
    for (const spec of manager.nodeTypeRegistry.get("hardBreak") ?? []) {
      const render = spec.renderMarkdown;
      if (!render) continue;
      spec.renderMarkdown = (node, ...rest) => (typeof node.attrs?.raw === "string" ? node.attrs.raw : render(node, ...rest));
    }
    // Code containing ``` gets a longer fence, so the block does not end early. The fence as
    // written (`~~~`, four backticks, indented code) is kept.
    for (const spec of manager.nodeTypeRegistry.get("codeBlock") ?? []) {
      spec.renderMarkdown = (node, ...rest) => renderCodeBlock(node, rest[1] as { parentType?: string; previousNode?: JsonNode } | undefined);
    }
    // Lists and items with the markers, numbering, spacing and indentation of the source.
    for (const type of ["bulletList", "orderedList", "taskList"]) {
      for (const spec of manager.nodeTypeRegistry.get(type) ?? []) {
        spec.renderMarkdown = (node, ...rest) => (node.content ? (rest[0] as ListHelpers).renderChildren(node.content, node.attrs?.loose ? "\n\n" : "\n") : "");
      }
    }
    for (const spec of manager.nodeTypeRegistry.get("listItem") ?? []) {
      spec.renderMarkdown = (node, ...rest) => {
        const [h, ctx] = rest as [ListHelpers, ListContext];
        const prefix = listMarker(ctx);
        return renderListItem(node, h, prefix, itemIndent(node, h, prefix, ctx?.parentType === "orderedList"));
      };
    }
    // An empty task keeps the space after its box, which makes it a task when read again.
    for (const spec of manager.nodeTypeRegistry.get("taskItem") ?? []) {
      spec.renderMarkdown = (node, ...rest) => {
        const [h, ctx] = rest as [ListHelpers, ListContext];
        const bullet = ctx?.meta?.parentAttrs?.bullet;
        const prefix = `${typeof bullet === "string" ? bullet : "-"} [${node.attrs?.checked ? "x" : " "}] `;
        return renderListItem(node, h, prefix, itemIndent(node, h, prefix, false)).replace(/^([-+*] \[[ x]\])(?=\n|$)/, "$1 ");
      };
    }
    // Setext headings (`Titel` over `===`) and closing hashes stay; `***` and `___` rules too.
    for (const spec of manager.nodeTypeRegistry.get("heading") ?? []) {
      spec.renderMarkdown = (node, ...rest) => {
        if (!node.content) return "";
        const level = Number(node.attrs?.level ?? 1) || 1;
        const text = (rest[0] as ListHelpers).renderChildren(node.content);
        const setext = node.attrs?.setext;
        if (typeof setext === "string" && setext[0] === (level === 1 ? "=" : level === 2 ? "-" : "") && text.trim() && !text.includes("\n")) return `${text}\n${setext}`;
        return `${"#".repeat(level)} ${text}${typeof node.attrs?.close === "string" ? node.attrs.close : ""}`;
      };
    }
    for (const spec of manager.nodeTypeRegistry.get("horizontalRule") ?? []) {
      spec.renderMarkdown = (node) => (typeof node.attrs?.markup === "string" ? node.attrs.markup : "---");
    }
    // `_x_`, `__x__` and `~x~` as written.
    const marks: [string, string, string, string][] = [
      ["italic", "*", EM_OPEN + "_", "_" + EM_CLOSE],
      ["bold", "**", STRONG_OPEN + "__", "__" + STRONG_CLOSE],
      ["strike", "~~", "~", "~"],
    ];
    for (const [type, plain, open, close] of marks) {
      for (const spec of manager.nodeTypeRegistry.get(type) ?? []) {
        spec.renderMarkdown = (node, ...rest) => {
          const text = (rest[0] as ListHelpers).renderChildren(node);
          const own = node.attrs?.delim === (type === "strike" ? "~" : "_");
          return own ? `${open}${text}${close}` : `${plain}${text}${plain}`;
        };
      }
    }
    // A task list right after a bullet list (or the other way round) is one list in Markdown: written
    // without the blank line between, which would make it a loose list in other readers. A blank
    // line the author wrote there is kept.
    for (const type of ["bulletList", "taskList"]) {
      for (const spec of manager.nodeTypeRegistry.get(type) ?? []) {
        const render = spec.renderMarkdown;
        if (!render) continue;
        spec.renderMarkdown = (node, ...rest) => {
          const out = render(node, ...rest);
          const prev = (rest[1] as { previousNode?: { type?: string } } | undefined)?.previousNode?.type;
          const adjacent = !node.attrs?.spacedBefore && ((type === "taskList" && prev === "bulletList") || (type === "bulletList" && prev === "taskList"));
          return adjacent && typeof out === "string" ? TIGHT_MARK + out : out;
        };
      }
    }
    // Empty paragraphs at the end of a quote (a fresh foldable callout) would leave bare `>` lines.
    for (const spec of manager.nodeTypeRegistry.get("blockquote") ?? []) {
      const render = spec.renderMarkdown;
      if (!render) continue;
      spec.renderMarkdown = (node, ...rest) => {
        const content = [...(node.content ?? [])];
        while (content.length > 1 && content[content.length - 1].type === "paragraph" && !content[content.length - 1].content?.length) content.pop();
        return render({ ...node, content }, ...rest);
      };
    }
    // Inline code is bracketed with sentinels; its fence is chosen from the text in `cleanMarkdown`.
    for (const spec of manager.nodeTypeRegistry.get("code") ?? []) {
      spec.renderMarkdown = (_node, ...rest) => `${CODE_OPEN}${(rest[0] as { renderChildren: (n: unknown) => string }).renderChildren(_node.content)}${CODE_CLOSE}`;
    }
    manager.encodeTextForMarkdown = (text, node, parent) => {
      const inCode = (parent?.type != null && manager.codeTypes.has(parent.type)) || (node.marks ?? []).some((m) => manager.codeTypes.has(typeof m === "string" ? m : m.type));
      // A `|` in inline code still ends a table cell (GFM): escaped there, the code reads the same.
      if (inCode) return parent?.attrs?.[IN_TABLE_CELL] && !(parent?.type != null && manager.codeTypes.has(parent.type)) ? text.replace(/\|/g, "\\|") : text;
      // A link, image or embed with marks, already written (sourceStyle.ts).
      const rendered = (node as Record<string, unknown>)[RENDERED];
      if (typeof rendered === "string") return rendered;
      const siblings = parent?.content ?? [];
      const idx = siblings.indexOf(node);
      // A footnote definition's text follows `[^1]: `, never at the start of a line.
      const atLineStart = !node.marks?.length && parent?.type !== "footnoteDefinition" && (idx === 0 || (idx > 0 && siblings[idx - 1].type === "hardBreak"));
      const inline = (n: JsonNode | undefined) => n != null && n.type !== "hardBreak";
      const out = escapeText(text, atLineStart, { before: idx > 0 && inline(siblings[idx - 1]), after: idx >= 0 && inline(siblings[idx + 1]) });
      return parent?.attrs?.[IN_TABLE_CELL] ? out.replace(/\|/g, "\\|") : out;
    };
  },
});

/** Unescapes what `escapeText` added, to compare link text with its href. */
const unescapeText = (t: string) => t.replace(/\\([\\`*_[\]~=#<>!|().+-])/g, "$1").replace(/&lt;/g, "<").replace(/&amp;/g, "&");

// Marks are serialized as opening/closing strings without seeing their text,
// so links are bracketed with sentinels and resolved in `cleanMarkdown`.
const LINK_OPEN = "\uE000";
const LINK_CLOSE = "\uE001";
const CODE_OPEN = "\uE010";
const CODE_CLOSE = "\uE011";
// (U+E002 is the footnotes' TIGHT_MARK.)
const SENTINELS_RE = /[\uE000\uE001\uE006-\uE009\uE010\uE011]/g;
const CODE_RE = /\uE010([^\uE010\uE011]*)\uE011/g;

/** Inline code with a fence longer than any backtick run inside, padded where a space or backtick would be lost. */
export function codeSpan(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((r) => r.length));
  const fence = "`".repeat(longest + 1);
  const pad = /^`|`$/.test(text) || (/^ [\s\S]* $/.test(text) && text.trim() !== "") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** A link destination: in `<…>` when it has spaces, angle brackets or parentheses a bare one cannot hold. */
export function linkDestination(href: string): string {
  const bare = /^(?:[^\s()<>]|\([^\s()<>]*\))*$/.test(href);
  return bare ? href : `<${href.replace(/[<>\n]/g, (c) => encodeURIComponent(c))}>`;
}

/** Bare URLs and e-mail addresses stay bare instead of becoming `[x](x)` (where a reader links them bare). */
export function linkMarkdown(text: string, href: string, title?: string | null): string {
  if (!title) {
    const plain = unescapeText(text);
    if (plain === href && /^(?:https?|ftp):\/\/\S+$/i.test(href)) return href;
    if (href === `mailto:${plain}` && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(plain)) return plain;
    if (plain.startsWith("www.") && href === `http://${plain}`) return plain;
  }
  return title ? `[${text}](${href} "${title}")` : `[${text}](${href})`;
}

// How a link was written (sourceStyle.ts `linkForm`), carried inside its sentinels.
const FORM_INLINE = "";
const FORM_ANGLE = "";
const FORM_REF = "";
const FORM_REF_END = "";

const MarkdownLink = Link.extend({
  renderMarkdown: (node, h) => {
    const href: string = node.attrs?.href ?? "";
    const title: string = node.attrs?.title ?? "";
    const form = node.attrs?.form as string | null | undefined;
    const ref = node.attrs?.ref as string | null | undefined;
    // A reference link stays one while its definition still says the same.
    const meta =
      ref != null && refFor(ref, href, title || null)
        ? `${FORM_REF}${form === "full" ? "f" : form === "collapsed" ? "c" : "s"}${ref}${FORM_REF_END}`
        : form === "inline"
          ? FORM_INLINE
          : form === "angle"
            ? FORM_ANGLE
            : "";
    return `${LINK_OPEN}${meta}[${h.renderChildren(node)}](${linkDestination(href)}${title ? ` "${title.replace(/[\\"]/g, "\\$&")}"` : ""})${LINK_CLOSE}`;
  },
});

const LINK_RE = new RegExp(
  `${LINK_OPEN}(${FORM_INLINE}|${FORM_ANGLE}|${FORM_REF}[fcs][^${FORM_REF_END}]*${FORM_REF_END})?\\[([^${LINK_OPEN}${LINK_CLOSE}]*)\\]\\(((?:[^\\s()<>]|\\([^\\s()<>]*\\))*|<[^<>\\n]*>)(?: "((?:[^"\\\\]|\\\\.)*)")?\\)${LINK_CLOSE}`,
  "g",
);

/** A link in its written form (see `MarkdownLink`); `null` form: the default. */
function writeLink(meta: string | undefined, text: string, dest: string, title: string | undefined): string {
  if (meta?.startsWith(FORM_REF)) {
    const kind = meta[1];
    const label = meta.slice(2, -1);
    const same = normLabel(unescapeText(text)) === normLabel(label);
    if (kind === "c" && same) return `[${text}][]`;
    if (kind === "s" && same) return `[${text}]`;
    return `[${text}][${label}]`;
  }
  if (meta === FORM_INLINE) return title ? `[${text}](${dest} "${title}")` : `[${text}](${dest})`;
  if (meta === FORM_ANGLE && !title) {
    const plain = unescapeText(text);
    if (plain === dest) return `<${dest}>`;
    if (dest === `mailto:${plain}`) return `<${plain}>`;
  }
  return linkMarkdown(text, dest, title);
}

export interface SchemaOptions {
  onOpenLink?: (target: string, newTab: boolean, anchor: string | null) => void;
  onOpenTag?: (tag: string) => void;
  isKnown?: (target: string) => boolean;
  searchPages?: (q: string) => Promise<LinkSuggestItem[]>;
  book?: (line: string) => Promise<ZeitResult | null>;
  /** The note being edited: its `/zeit` chips stay linked to their bookings (timeChip.ts). */
  pageId?: number;
  /** Booked, but the `/zeit` line is gone from the document. */
  onZeitLost?: (res: ZeitResult) => void;
  /** URL of an attachment name. */
  attachmentUrl?: (name: string) => string;
  /** Stores a pasted/dropped image, returns the attachment name. */
  uploadImage?: (file: File) => Promise<string | null>;
  /** Stores any other pasted/dropped file under its name, returns the attachment name. */
  uploadFile?: (file: File) => Promise<string | null>;
  /** Slash „Datei einfügen“: file dialog, embeds the chosen files. */
  onPickFile?: (editor: Editor) => void;
  /** Size of an attachment in bytes (`null`: missing), for file chips. */
  attachmentSize?: (name: string) => Promise<number | null>;
  /** Click on a file chip: opens the file in its default app. */
  onOpenFile?: (name: string) => void;
  /** Click on a PDF card: opens the PDF viewer. */
  onOpenPdf?: (name: string, page: number | null, highlight?: number | null) => void;
  /** Renders the first page of a PDF into a canvas; resolves to the page count. */
  renderPdfPreview?: (name: string, canvas: HTMLCanvasElement, width: number) => Promise<number>;
  onPickTemplate?: (editor: Editor) => void;
  onPickImage?: (editor: Editor) => void;
  /** Slash „KI bearbeiten“: inline AI bar on the current block. */
  onAi?: (editor: Editor) => void;
  /** Slash „Zusammenfassung“: meeting summary of the page. */
  onSummary?: (editor: Editor) => void;
  /** `/voice`: records a voice note into this page. */
  onVoice?: (editor: Editor) => void;
  /** Slash „Zeichnung“: new drawing at the caret. */
  onInsertDrawing?: (editor: Editor) => void;
  /** Click on a drawing embed: opens the drawing editor. */
  onOpenDrawing?: (name: string) => void;
  /** `/zeit` autocomplete: Netzplan/Vorgang options for the typed query. */
  zeitRefs?: (query: string) => Promise<ZeitSuggestItem[]>;
  /** `/zeit` autocomplete: Leistungsarten after `#`. */
  zeitLeistungsarten?: (query: string) => Promise<ZeitSuggestItem[]>;
  /** Smart paste of a lone URL: the page's title (null: keep the URL). */
  fetchTitle?: (url: string) => Promise<string | null>;
  /** A repeating task ticked off: the due date of its next occurrence (null: none). */
  taskNextDue?: (text: string) => Promise<string | null>;
  /** Typing aids (Settings → Editor), read on every keystroke. */
  typing?: () => TypingPrefs;
  /** Live view of a page embed `![[Seite#Abschnitt]]` (none: a placeholder). */
  embedPage?: PageEmbedOptions["mount"];
  /** Live preview of ```mermaid and ```query blocks (none: the code only). */
  richBlock?: RichBlocksOptions["mount"];
}

/**
 * Paragraphs as in StarterKit, except that a line with only `![alt](src)` stays a paragraph:
 * Tiptap unwraps it for block images, but images are inline here (`MarkdownImage`), and an
 * image directly in the document is invalid content that breaks the first edit.
 */
const ImageParagraph = Paragraph.extend({
  parseMarkdown: (token, helpers) => {
    const tokens = token.tokens ?? [];
    if (tokens.length === 1 && tokens[0].type === "image") return helpers.createNode("paragraph", undefined, helpers.parseInline(tokens));
    return Paragraph.config.parseMarkdown!(token, helpers);
  },
});

/** Task lists with tab-indented nesting and their items' source (sourceStyle.ts). */
const SourceTaskList = TaskList.extend({
  markdownTokenizer: TaskList.config.markdownTokenizer && {
    ...TaskList.config.markdownTokenizer,
    tokenize: (src: string, _tokens: unknown, lexer: unknown) => tokenizeTaskList(src, lexer as Parameters<typeof tokenizeTaskList>[1]) as never,
  },
});

export function buildExtensions(o: SchemaOptions = {}): Extensions {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3, 4, 5, 6] },
      codeBlock: false,
      link: false,
      paragraph: false,
    }),
    FocusSelection,
    ImageParagraph,
    MarkdownLink.configure({
      openOnClick: false,
      autolink: true,
      linkOnPaste: true,
      HTMLAttributes: { rel: "noopener noreferrer", target: null },
      // Links to e-mails taken over (`annalo-mail://<id>`, components/MailImport.tsx) are kept.
      isAllowedUri: (url, ctx) => /^annalo-mail:\/\/[0-9a-z]+\/?$/i.test(url.trim()) || ctx.defaultValidate(url),
    }),
    CodeBlockLowlight.configure({ lowlight, defaultLanguage: null }),
    LazyHighlight,
    SourceTaskList,
    TaskItem.configure({ nested: true, a11y: { checkboxLabel: (node) => t("editor.taskCheckbox", { text: node.textContent || t("editor.taskEmpty") }) } }),
    Highlight,
    TableKit.configure({ table: false }),
    MarkdownTable.configure({ resizable: false }),
    Placeholder.configure({
      placeholder: ({ node }) => (node.type.name === "heading" ? t("editor.headingPh") : t("editor.placeholder")),
      showOnlyCurrent: true,
    }),
    Markdown,
    SourceStyle,
    MarkdownFidelity,
    RefDefinition,
    WikiLink.configure({
      onOpen: o.onOpenLink ?? (() => {}),
      isKnown: o.isKnown ?? (() => true),
      fileSize: o.attachmentSize ?? (async () => null),
      // Like a file embed: PDFs in the viewer, other files in their default app.
      onOpenFile: (name, anchor) => (isPdfName(name) ? o.onOpenPdf?.(name, anchorPage(anchor == null ? null : `#${anchor}`), pdfAnchor(anchor).highlight) : o.onOpenFile?.(name)),
    }),
    WikiLinkSuggest.configure({ search: o.searchPages ?? (async () => []) }),
    SlashCommand.configure({ onTemplate: o.onPickTemplate ?? null, onImage: o.onPickImage ?? null, onAi: o.onAi ?? null, onSummary: o.onSummary ?? null, onDrawing: o.onInsertDrawing ?? null, onFile: o.onPickFile ?? null, onVoice: o.onVoice ?? null }),
    ImageEmbed.configure({ resolve: o.attachmentUrl ?? ((n) => `attachments/${encodeURIComponent(n)}`) }),
    FileEmbed.configure({
      size: o.attachmentSize ?? (async () => null),
      onOpen: o.onOpenFile ?? (() => {}),
      onOpenPdf: o.onOpenPdf ?? (() => {}),
      audioUrl: o.attachmentUrl ?? null,
      renderPdfPreview: o.renderPdfPreview ?? null,
    }),
    PageEmbed.configure({ mount: o.embedPage ?? null }),
    RichBlocks.configure({ mount: o.richBlock ?? null }),
    AttachmentDrop.configure({ uploadImage: o.uploadImage ?? null, uploadFile: o.uploadFile ?? null }),
    SmartPaste.configure({ fetchTitle: o.fetchTitle ?? null }),
    MarkdownImage.configure({ resolve: o.attachmentUrl ?? ((n) => n) }),
    DrawingEmbed.configure({ resolve: o.attachmentUrl ?? ((n) => `attachments/${encodeURIComponent(n)}`), onOpen: o.onOpenDrawing ?? (() => {}) }),
    TimeEntryChip.configure({ pageId: o.pageId ?? null }),
    ZeitCommand.configure({ book: o.book ?? (async () => null), onLost: o.onZeitLost ?? (() => {}) }),
    ZeitSuggest.configure({ refs: o.zeitRefs ?? (async () => []), leistungsarten: o.zeitLeistungsarten ?? (async () => []) }),
    TagHighlight.configure({ onOpen: o.onOpenTag ?? (() => {}) }),
    IssueChips,
    DueWords,
    RecurringTasks.configure({ nextDue: o.taskNextDue ?? null }),
    FindInPage,
    Callouts,
    HtmlInline,
    HtmlBlock,
    LiteralHash,
    Columns,
    Column,
    TableOfContents,
    FootnoteRef,
    FootnoteDefinition,
    Footnotes,
    CiteFlash,
    TypingAids.configure({ prefs: o.typing ?? (() => TYPING_DEFAULTS) }),
  ];
}

/**
 * Serializes the document and removes escapes the serializer adds but that
 * Obsidian-style Markdown does not need (callout markers, task brackets,
 * wiki-link brackets in plain text).
 */
export function toMarkdown(editor: Editor): string {
  const manager = (editor as unknown as { markdown?: { serialize: (json: unknown) => string } }).markdown;
  if (!manager) return cleanMarkdown(editor.getMarkdown());
  const json = editor.getJSON() as JNode;
  // Unchanged blocks are written as read (sourceStyle.ts).
  const raws = prepareSource(editor, json);
  try {
    return cleanMarkdown(manager.serialize(json), raws);
  } finally {
    endSource();
  }
}

/** How a page's text breaks its lines and what is before and after its first and last block. */
export interface TextShape {
  crlf: boolean;
  lead: string;
  end: string;
  /** What a body without text ends with, written while it stays without text. */
  empty?: string;
}

/** The shape of a page body as read (Windows line ends, leading blank lines, the line ends at the end). */
export function textShape(body: string): TextShape {
  const crlf = body.includes("\r\n") && !/(^|[^\r])\n/.test(body);
  const lf = body.replace(/\r\n/g, "\n");
  // An empty page has no ending of its own: text written into it ends like new content.
  if (!lf.trim()) return { crlf, lead: "", end: "\n", empty: lf };
  return { crlf, lead: /^\n*/.exec(lf)![0], end: /\n*$/.exec(lf)![0] };
}

/** `toMarkdown`'s text in the shape the page had, so a save changes only what was edited. */
export function withShape(md: string, shape: TextShape): string {
  const out = md.trim() ? shape.lead + md.replace(/\n+$/, "") + shape.end : (shape.empty ?? shape.end);
  return shape.crlf ? out.replace(/\n/g, "\r\n") : out;
}

/** Runs of blank lines become one, except inside fenced code, which stays as written. */
export function collapseBlankLines(md: string): string {
  const out: string[] = [];
  let fence: { ch: string; len: number } | null = null;
  let blanks = 0;
  for (const line of md.split("\n")) {
    if (fence) {
      const close = line.match(/^\s*(`{3,}|~{3,})\s*$/);
      if (close && close[1][0] === fence.ch && close[1].length >= fence.len) fence = null;
      out.push(line);
      continue;
    }
    if (line === "") {
      if (++blanks > 1) continue;
    } else {
      blanks = 0;
      const open = line.match(/^\s*(`{3,}|~{3,})/);
      if (open) fence = { ch: open[1][0], len: open[1].length };
    }
    out.push(line);
  }
  return out.join("\n");
}

export function cleanMarkdown(md: string, raws: string[] = []): string {
  return (
    resolveUnderscores(collapseBlankLines(md
      .replace(CODE_RE, (_m, text: string) => codeSpan(text))
      .replace(LINK_RE, (m, meta: string | undefined, text: string, href: string, title: string | undefined, at: number, all: string) => {
        const out = writeLink(meta, text, href, title);
        // A bare URL would swallow a footnote reference right behind it (`https://x.de[^1]`).
        return out === href && all.startsWith("[^", at + m.length) ? `[${text}](${href})` : out;
      })
      .replace(SENTINELS_RE, "")
      .replace(/^((?:>\s?)+)\\\[!(\w+)\\\]/gm, "$1[!$2]")
      // Footnote definitions written one per line stay together.
      // (also indented, or quoted in a callout: the blank line before the mark goes, the prefix stays)
      .replace(new RegExp(`(?:\n[ \t>]*)*\n([ \t>]*)${TIGHT_MARK}`, "g"), "\n$1")
      .replace(new RegExp(TIGHT_MARK, "g"), ""),
    ))
      // Extra blank lines as the file had them (sourceStyle.ts `Gap`).
      .replace(GAP_LINE_RE, "")
      .replace(/^\n+/, "")
      .trimEnd()
      // A final empty task keeps the space after its box.
      .replace(/(^|\n)(\s*[-+*] \[[ xX]\])$/, "$1$2 ")
      .replace(RAW_RE, (_m, i: string) => raws[Number(i)] ?? "") + "\n"
  );
}

const GAP_LINE_RE = new RegExp(GAP_LINE, "g");
