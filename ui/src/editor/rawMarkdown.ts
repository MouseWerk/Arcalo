// Markdown the editor has no block or mark for, kept exactly as written:
// - raw HTML and HTML comments (`<kbd>`, `<details>`, `<!-- Notiz -->`, `a<b und c>d`) as
//   small read-only chips (inline) or boxes (block) that save their source verbatim;
//   the source mode edits them. Nothing is rendered as HTML.
// - `\#tag`: an escaped hash stays escaped (and is no tag), marked on the `#` itself.
// Plus the helpers for code fences and empty tasks that the serializer uses.

import { Mark, Node } from "@tiptap/core";

/** Inline raw HTML (a tag, a comment, or a tag with its text up to the closing tag). */
export const HtmlInline = Node.create({
  name: "htmlInline",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return { raw: { default: "", rendered: false } };
  },
  parseHTML() {
    return [{ tag: "span[data-html-inline]", getAttrs: (el) => ({ raw: (el as HTMLElement).textContent ?? "" }) }];
  },
  renderHTML({ node }) {
    return ["span", { "data-html-inline": "", class: "md-html", title: "HTML – im Quelltext bearbeiten", contenteditable: "false" }, node.attrs.raw];
  },
  renderText: ({ node }) => node.attrs.raw,
  renderMarkdown: (node) => String(node.attrs?.raw ?? ""),
});

/** A raw HTML block (e.g. `<div>…</div>`, `<details>`, a comment on its own lines). */
export const HtmlBlock = Node.create({
  name: "htmlBlock",
  group: "block",
  atom: true,
  selectable: true,
  addAttributes() {
    return { raw: { default: "", rendered: false } };
  },
  parseHTML() {
    return [{ tag: "pre[data-html-block]", preserveWhitespace: "full", getAttrs: (el) => ({ raw: (el as HTMLElement).textContent ?? "" }) }];
  },
  renderHTML({ node }) {
    return ["pre", { "data-html-block": "", class: "md-html-block", title: "HTML – im Quelltext bearbeiten", contenteditable: "false" }, node.attrs.raw];
  },
  renderText: ({ node }) => node.attrs.raw,
  renderMarkdown: (node) => String(node.attrs?.raw ?? ""),
});

/** Characters that continue a `#tag` (as in the tag highlighting). */
const TAG_CHAR = /[\p{L}\p{N}_/-]/u;

/** A `#` written as `\#`: saved with its backslash, never read as a tag. */
export const LiteralHash = Mark.create({
  name: "literalHash",
  inclusive: false,
  excludes: "_",
  parseHTML() {
    return [{ tag: "span[data-literal-hash]" }];
  },
  renderHTML() {
    return ["span", { "data-literal-hash": "" }, 0];
  },
  markdownTokenizer: {
    name: "literalHash",
    level: "inline",
    start: (src: string) => {
      const i = src.search(/\\#[\p{L}\p{N}_/-]/u);
      return i;
    },
    tokenize(src) {
      if (!src.startsWith("\\#") || !TAG_CHAR.test(src.charAt(2))) return undefined;
      return { type: "literalHash", raw: "\\#", text: "#" };
    },
  },
  parseMarkdown: (_token, h) => h.applyMark("literalHash", [h.createTextNode("#")]),
  renderMarkdown: (node, h) => `\\${h.renderChildren(node)}`,
});

/** Tags a `<br>` stands for: a line break (tables write their line breaks that way). */
export const isBreakTag = (html: string) => /^<br\s*\/?>$/i.test(html.trim());

/** The node for a raw HTML token of marked: a verbatim chip or block, `<br>` a line break. */
export function rawHtmlNode(token: { raw?: string; text?: string; block?: boolean }) {
  const raw = String(token.raw ?? token.text ?? "");
  if (!raw.trim()) return null;
  if (token.block) return { type: "htmlBlock", attrs: { raw: raw.replace(/\s+$/, "") } };
  if (isBreakTag(raw)) return { type: "hardBreak", attrs: { raw } };
  return { type: "htmlInline", attrs: { raw } };
}

/** A code fence that `content` cannot close: one backtick longer than its longest run (min. 3). */
export function codeFence(content: string): string {
  let longest = 0;
  for (const m of content.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  return "`".repeat(Math.max(3, longest + 1));
}

/**
 * `- [ ]` with nothing after it is an empty task (Obsidian, GitHub), but the task syntax needs
 * a space behind the box: adds it, outside of fenced code.
 */
export function openEmptyTasks(md: string): string {
  if (!/\[[ xX]\][ \t]*$/m.test(md)) return md;
  let fence: string | null = null;
  return md
    .split("\n")
    .map((line) => {
      const f = /^\s*(`{3,}|~{3,})/.exec(line);
      if (fence) {
        if (f && f[1][0] === fence[0] && f[1].length >= fence.length && line.trim() === f[1]) fence = null;
        return line;
      }
      if (f) {
        fence = f[1];
        return line;
      }
      return /^\s*[-+*]\s+\[[ xX]\]$/.test(line) ? `${line} ` : line;
    })
    .join("\n");
}
