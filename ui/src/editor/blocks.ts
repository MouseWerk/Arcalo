// Layout blocks of the editor: columns, the table of contents and footnotes.
//
// Markdown forms (all round-trip exactly, see roundtrip.test.ts):
// - Columns: HTML comments around ordinary Markdown, so other viewers (Obsidian, GitHub)
//   hide the markers and show the columns one after another:
//     <!-- spalten -->
//     Linke Spalte
//     <!-- spalte -->
//     Rechte Spalte
//     <!-- /spalten -->
//   (blank lines between marker and content). Column blocks may be nested.
// - Table of contents: a line `[TOC]` (Typora, MkDocs, Python-Markdown use the same marker).
// - Footnotes: `[^1]` references and `[^1]: Text` definitions (Pandoc/Obsidian/GitHub),
//   continuation lines indented by four spaces.

import { Extension, InputRule, Node, type Editor } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";

// ---------------------------------------------------------------- columns

export const COLUMNS_OPEN = "<!-- spalten -->";
export const COLUMN_BREAK = "<!-- spalte -->";
export const COLUMNS_CLOSE = "<!-- /spalten -->";

/**
 * Splits `src` (starting at `<!-- spalten -->`) into the Markdown of its columns and the raw
 * length of the block. Nested column blocks and fenced code stay inside their column.
 * Returns null without a closing marker.
 */
export function splitColumns(src: string): { raw: string; parts: string[] } | null {
  const lines = src.split("\n");
  if (lines[0].trim() !== COLUMNS_OPEN) return null;
  const parts: string[][] = [[]];
  let depth = 1;
  let fence: string | null = null;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    const f = /^(`{3,}|~{3,})/.exec(t);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && t.slice(f[1].length).trim() === "") fence = null;
    } else if (f) fence = f[1];
    else if (t === COLUMNS_OPEN) depth++;
    else if (t === COLUMNS_CLOSE && --depth === 0) {
      const raw = lines.slice(0, i + 1).join("\n") + (i + 1 < lines.length ? "\n" : "");
      return { raw, parts: parts.map((p) => p.join("\n").trim()) };
    } else if (t === COLUMN_BREAK && depth === 1) {
      parts.push([]);
      continue;
    }
    parts[parts.length - 1].push(line);
  }
  return null;
}

export const Column = Node.create({
  name: "column",
  content: "block+",
  isolating: true,
  parseHTML() {
    return [{ tag: "div[data-column]" }];
  },
  renderHTML() {
    return ["div", { "data-column": "", class: "column" }, 0];
  },
  renderMarkdown: (node, h) => h.renderChildren(node.content ?? [], "\n\n"),
});

export const Columns = Node.create({
  name: "columns",
  group: "block",
  content: "column+",
  defining: true,
  parseHTML() {
    return [{ tag: "div[data-columns]" }];
  },
  renderHTML() {
    return ["div", { "data-columns": "", class: "columns" }, 0];
  },
  markdownTokenizer: {
    name: "columns",
    level: "block",
    start: (src: string) => {
      const m = /^[ \t]*<!-- spalten -->[ \t]*$/m.exec(src);
      return m ? m.index : -1;
    },
    tokenize(src, _tokens, lexer) {
      if (!src.startsWith(COLUMNS_OPEN)) return undefined;
      const s = splitColumns(src);
      if (!s) return undefined;
      return { type: "columns", raw: s.raw, cols: s.parts.map((p) => lexer.blockTokens(p)) };
    },
  },
  parseMarkdown: (token, h) =>
    h.createNode(
      "columns",
      undefined,
      (token.cols as Parameters<typeof h.parseChildren>[0][]).map((tokens) => {
        const content = h.parseChildren(tokens);
        return h.createNode("column", undefined, content.length ? content : [{ type: "paragraph" }]);
      }),
    ),
  renderMarkdown: (node, h) => `${COLUMNS_OPEN}\n\n${h.renderChildren(node.content ?? [], `\n\n${COLUMN_BREAK}\n\n`)}\n\n${COLUMNS_CLOSE}`,
});

/** Replaces the current (empty) block by `n` columns and puts the caret into the first one. */
export function insertColumns(editor: Editor, n: number) {
  const col = () => ({ type: "column", content: [{ type: "paragraph" }] });
  const { $from } = editor.state.selection;
  const before = $from.depth > 0 ? $from.before(1) : $from.pos;
  editor.chain().insertContent({ type: "columns", content: Array.from({ length: n }, col) }).run();
  // The new block starts at or right after the old one; find it and enter its first paragraph.
  let at = -1;
  editor.state.doc.nodesBetween(Math.max(0, before - 1), Math.min(editor.state.doc.content.size, before + 4 + n * 4), (node, pos) => {
    if (at < 0 && node.type.name === "columns") at = pos;
    return at < 0;
  });
  if (at >= 0) editor.chain().setTextSelection(at + 3).focus().run();
}

// --------------------------------------------------------- table of contents

export interface TocEntry {
  level: number;
  text: string;
  pos: number;
}

/** The page's headings in order (also inside columns and callouts). */
export function headingsOf(doc: PMNode): TocEntry[] {
  const out: TocEntry[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === "heading") {
      const text = node.textContent.trim();
      if (text) out.push({ level: node.attrs.level, text, pos });
      return false;
    }
    return true;
  });
  return out;
}

export interface TocTree {
  entry: TocEntry;
  children: TocTree[];
}

/** Nests headings by level; a jump (H1 → H3) nests one step, like Obsidian's outline. */
export function tocTree(entries: TocEntry[]): TocTree[] {
  const root: TocTree[] = [];
  const stack: TocTree[] = [];
  for (const entry of entries) {
    const item = { entry, children: [] };
    while (stack.length && stack[stack.length - 1].entry.level >= entry.level) stack.pop();
    (stack.length ? stack[stack.length - 1].children : root).push(item);
    stack.push(item);
  }
  return root;
}

export const TOC_MARKER = "[TOC]";

export const TableOfContents = Node.create({
  name: "tableOfContents",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,
  parseHTML() {
    return [{ tag: "nav[data-toc]" }];
  },
  renderHTML() {
    return ["nav", { "data-toc": "", class: "toc-block" }];
  },
  renderText: () => TOC_MARKER,
  markdownTokenizer: {
    name: "tableOfContents",
    level: "block",
    start: (src: string) => {
      const m = /^\[TOC\][ \t]*$/m.exec(src);
      return m ? m.index : -1;
    },
    tokenize(src) {
      const m = /^\[TOC\][ \t]*(?:\n|$)/.exec(src);
      return m ? { type: "tableOfContents", raw: m[0] } : undefined;
    },
  },
  parseMarkdown: (_token, h) => h.createNode("tableOfContents"),
  renderMarkdown: () => TOC_MARKER,

  addNodeView() {
    return ({ editor }) => {
      const dom = document.createElement("nav");
      dom.className = "toc-block";
      dom.dataset.toc = "";
      dom.contentEditable = "false";
      const head = document.createElement("div");
      head.className = "toc-head";
      head.textContent = "Inhaltsverzeichnis";
      const body = document.createElement("div");
      dom.append(head, body);
      let last = "";
      const render = () => {
        const entries = headingsOf(editor.state.doc);
        const key = entries.map((e) => `${e.level}:${e.text}`).join("\n");
        if (key === last && body.childNodes.length) return;
        last = key;
        body.replaceChildren();
        if (!entries.length) {
          const empty = document.createElement("div");
          empty.className = "toc-empty";
          empty.textContent = "Noch keine Überschriften auf dieser Seite";
          body.append(empty);
          return;
        }
        let index = 0;
        const list = (items: TocTree[]) => {
          const ul = document.createElement("ul");
          for (const it of items) {
            const li = document.createElement("li");
            const b = document.createElement("button");
            b.type = "button";
            b.className = `toc-link toc-l${it.entry.level}`;
            b.dataset.index = String(index++);
            b.textContent = it.entry.text;
            li.append(b);
            if (it.children.length) li.append(list(it.children));
            ul.append(li);
          }
          return ul;
        };
        body.append(list(tocTree(entries)));
      };
      const onTr = ({ transaction }: { transaction: { docChanged: boolean } }) => transaction.docChanged && render();
      editor.on("transaction", onTr);
      render();
      dom.addEventListener("mousedown", (e) => {
        const b = (e.target as HTMLElement).closest<HTMLButtonElement>(".toc-link");
        if (!b || e.button !== 0) return;
        e.preventDefault();
        const entry = headingsOf(editor.state.doc)[Number(b.dataset.index)];
        if (!entry) return;
        editor.chain().focus().setTextSelection(entry.pos + entry.text.length + 1).run();
        const el = editor.view.nodeDOM(entry.pos) as HTMLElement | null;
        el?.scrollIntoView?.({ behavior: "smooth", block: "start" });
      });
      return {
        dom,
        // Clicks on entries are ours; anywhere else selects the block.
        stopEvent: (e: Event) => !!(e.target as HTMLElement).closest?.(".toc-link"),
        ignoreMutation: () => true,
        destroy: () => void editor.off("transaction", onTr),
        update: (node: PMNode) => node.type.name === "tableOfContents",
      };
    };
  },
});

// -------------------------------------------------------------- footnotes

const REF_RE = /^\[\^([^\]\s^]+)\](?!:)/;
const DEF_RE = /^\[\^([^\]\s^]+)\]:(?:[ \t]+|(?=\n)|$)/;

/** Consumes a definition `[^x]: text` with its continuation lines (indented by 4 spaces or a tab). */
export function matchDefinition(src: string): { raw: string; label: string; text: string } | null {
  const m = DEF_RE.exec(src);
  if (!m) return null;
  const lines = src.split("\n");
  const first = lines[0].slice(m[0].length);
  const rest: string[] = [];
  for (let i = 1; i < lines.length && /^(?: {4}|\t)\S/.test(lines[i]); i++) rest.push(lines[i].replace(/^(?: {4}|\t)/, ""));
  const count = 1 + rest.length;
  const raw = lines.slice(0, count).join("\n") + (count < lines.length ? "\n" : "");
  return { raw, label: m[1], text: [first, ...rest].join("\n") };
}

// A definition that directly follows another (no blank line) is written without the blank line:
// the renderer marks it and `cleanMarkdown` (schema.ts) removes the separator before the mark.
export const TIGHT_MARK = "";

export const FootnoteRef = Node.create({
  name: "footnoteRef",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return { label: { default: "1" } };
  },
  parseHTML() {
    return [{ tag: "sup[data-footnote]", getAttrs: (el) => ({ label: (el as HTMLElement).dataset.footnote }) }];
  },
  renderHTML({ node }) {
    return ["sup", { "data-footnote": node.attrs.label, class: "footnote-ref" }];
  },
  renderText: ({ node }) => `[^${node.attrs.label}]`,
  markdownTokenizer: {
    name: "footnoteRef",
    level: "inline",
    start: (src: string) => src.indexOf("[^"),
    tokenize(src) {
      const m = REF_RE.exec(src);
      return m ? { type: "footnoteRef", raw: m[0], label: m[1] } : undefined;
    },
  },
  parseMarkdown: (token) => ({ type: "footnoteRef", attrs: { label: token.label } }),
  renderMarkdown: (node) => `[^${node.attrs?.label}]`,
  addInputRules() {
    return [
      new InputRule({
        find: /\[\^([^\]\s^]+)\]$/,
        handler: ({ state, range, match }) => {
          state.tr.replaceWith(range.from, range.to, this.type.create({ label: match[1] }));
        },
      }),
    ];
  },
});

export const FootnoteDefinition = Node.create({
  name: "footnoteDefinition",
  group: "block",
  content: "inline*",
  addAttributes() {
    return { label: { default: "1" }, tight: { default: false, rendered: false } };
  },
  parseHTML() {
    return [{ tag: "div[data-footnote-def]", getAttrs: (el) => ({ label: (el as HTMLElement).dataset.footnoteDef }) }];
  },
  renderHTML({ node }) {
    return ["div", { "data-footnote-def": node.attrs.label, class: "footnote-def" }, 0];
  },
  markdownTokenizer: {
    name: "footnoteDefinition",
    level: "block",
    start: (src: string) => {
      const m = /^\[\^[^\]\s^]+\]:/m.exec(src);
      return m ? m.index : -1;
    },
    tokenize(src, tokens, lexer) {
      const d = matchDefinition(src);
      if (!d) return undefined;
      // Directly after another definition (a blank line in between ends up in that one's raw).
      const prev = tokens[tokens.length - 1] as { type?: string; raw?: string } | undefined;
      const tight = prev?.type === "footnoteDefinition" && !/\n\s*\n$/.test(prev.raw ?? "");
      return { type: "footnoteDefinition", raw: d.raw, label: d.label, tight, tokens: lexer.inlineTokens(d.text) };
    },
  },
  parseMarkdown: (token, h) => h.createNode("footnoteDefinition", { label: token.label, tight: !!token.tight }, h.parseInline(token.tokens ?? [])),
  renderMarkdown: (node, h, ctx) => {
    const text = h.renderChildren(node.content ?? []).replace(/\n/g, "\n    ");
    const tight = node.attrs?.tight && ctx?.previousNode?.type === "footnoteDefinition";
    return `${tight ? TIGHT_MARK : ""}[^${node.attrs?.label}]:${text ? " " + text : ""}`;
  },
  addKeyboardShortcuts() {
    return {
      // Enter leaves the definition (a new paragraph below) instead of splitting it.
      Enter: ({ editor }) => {
        const { $from, empty } = editor.state.selection;
        if (!empty || $from.parent.type.name !== "footnoteDefinition") return false;
        const after = $from.after();
        return editor.chain().insertContentAt(after, { type: "paragraph" }).setTextSelection(after + 1).run();
      },
    };
  },
});

/** Display numbers: references in order of appearance, then definitions nobody refers to. */
export function footnoteNumbers(doc: PMNode): Map<string, number> {
  const nums = new Map<string, number>();
  const defs: string[] = [];
  doc.descendants((node) => {
    if (node.type.name === "footnoteRef" && !nums.has(node.attrs.label)) nums.set(node.attrs.label, nums.size + 1);
    if (node.type.name === "footnoteDefinition") defs.push(node.attrs.label);
    return true;
  });
  for (const d of defs) if (!nums.has(d)) nums.set(d, nums.size + 1);
  return nums;
}

/** Next free numeric label (`1`, `2`, …) of the document. */
export function nextFootnoteLabel(doc: PMNode): string {
  let max = 0;
  doc.descendants((node) => {
    if (node.type.name === "footnoteRef" || node.type.name === "footnoteDefinition") {
      const n = Number(node.attrs.label);
      if (Number.isInteger(n)) max = Math.max(max, n);
    }
    return true;
  });
  return String(max + 1);
}

function findNode(doc: PMNode, type: string, label: string): { node: PMNode; pos: number } | null {
  let hit: { node: PMNode; pos: number } | null = null;
  doc.descendants((node, pos) => {
    if (hit) return false;
    if (node.type.name === type && node.attrs.label === label) hit = { node, pos };
    return true;
  });
  return hit;
}

/** `/Fußnote`: a reference at the caret, its definition at the end of the page, caret into the definition. */
export function insertFootnote(editor: Editor) {
  const label = nextFootnoteLabel(editor.state.doc);
  editor.chain().focus().insertContent({ type: "footnoteRef", attrs: { label } }).run();
  const { state } = editor;
  const doc = state.doc;
  const last = doc.lastChild;
  const replaceLast = last?.type.name === "paragraph" && last.content.size === 0 && doc.childCount > 1;
  const end = doc.content.size;
  const from = replaceLast ? end - last!.nodeSize : end;
  const prev = replaceLast ? doc.child(doc.childCount - 2) : last;
  const def = state.schema.nodes.footnoteDefinition.create({ label, tight: prev?.type.name === "footnoteDefinition" });
  const tr = state.tr.replaceWith(from, end, def);
  tr.setSelection(TextSelection.create(tr.doc, from + 1)).scrollIntoView();
  editor.view.dispatch(tr);
  editor.commands.focus();
}

function scrollTo(view: EditorView, pos: number) {
  const el = view.nodeDOM(pos) as HTMLElement | null;
  el?.scrollIntoView?.({ behavior: "smooth", block: "center" });
}

/** Jumps from a reference to its definition (caret at its end). */
function jumpToDefinition(view: EditorView, label: string) {
  const hit = findNode(view.state.doc, "footnoteDefinition", label);
  if (!hit) return;
  const tr = view.state.tr.setSelection(TextSelection.create(view.state.doc, hit.pos + hit.node.nodeSize - 1));
  view.dispatch(tr);
  view.focus();
  scrollTo(view, hit.pos);
}

/** Back-link: from a definition to (behind) its first reference. */
function jumpToReference(view: EditorView, label: string) {
  const hit = findNode(view.state.doc, "footnoteRef", label);
  if (!hit) return;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, hit.pos + 1)));
  view.focus();
  const dom = view.nodeDOM(hit.pos) as HTMLElement | null;
  dom?.scrollIntoView?.({ behavior: "smooth", block: "center" });
}

const BACK_ICON =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5 5.5 5.5 0 0 1-5.5 5.5H11"/></svg>';

const footnoteKey = new PluginKey<DecorationSet>("footnotes");

function buildDecorations(doc: PMNode): DecorationSet {
  const nums = footnoteNumbers(doc);
  const defined = new Set<string>();
  const referenced = new Set<string>();
  doc.descendants((node) => {
    if (node.type.name === "footnoteDefinition") defined.add(node.attrs.label);
    if (node.type.name === "footnoteRef") referenced.add(node.attrs.label);
    return true;
  });
  const decos: Decoration[] = [];
  doc.descendants((node, pos, parent, index) => {
    if (node.type.name === "footnoteRef") {
      const label = node.attrs.label;
      decos.push(Decoration.node(pos, pos + node.nodeSize, { "data-num": String(nums.get(label) ?? "?"), class: defined.has(label) ? "" : "is-missing", title: "" }));
      return false;
    }
    if (node.type.name === "footnoteDefinition") {
      const label = node.attrs.label;
      const first = !parent || index === 0 || parent.child(index - 1).type.name !== "footnoteDefinition";
      decos.push(Decoration.node(pos, pos + node.nodeSize, { "data-num": String(nums.get(label) ?? "?"), class: first ? "is-first" : "" }));
      if (first) {
        decos.push(
          Decoration.widget(
            pos,
            () => {
              const h = document.createElement("div");
              h.className = "footnotes-head";
              h.contentEditable = "false";
              h.textContent = "Fußnoten";
              return h;
            },
            { side: -1, key: "footnotes-head", ignoreSelection: true },
          ),
        );
      }
      if (referenced.has(label)) {
        decos.push(
          Decoration.widget(
            pos + node.nodeSize - 1,
            () => {
              const b = document.createElement("button");
              b.type = "button";
              b.className = "footnote-back";
              b.contentEditable = "false";
              b.dataset.label = label;
              b.title = "Zurück zum Verweis";
              b.setAttribute("aria-label", "Zurück zum Verweis");
              b.innerHTML = BACK_ICON;
              return b;
            },
            { side: 1, key: `back-${label}`, ignoreSelection: true },
          ),
        );
      }
      return false;
    }
    return true;
  });
  return DecorationSet.create(doc, decos);
}

/** Numbers, the „Fußnoten“ heading, back-links, click-to-jump and the hover card. */
export const Footnotes = Extension.create({
  name: "footnotes",
  addProseMirrorPlugins() {
    let card: HTMLDivElement | null = null;
    let timer: number | undefined;
    const hide = () => {
      window.clearTimeout(timer);
      card?.remove();
      card = null;
    };
    const show = (view: EditorView, ref: HTMLElement) => {
      hide();
      const label = ref.dataset.footnote ?? "";
      card = document.createElement("div");
      card.className = "link-preview footnote-preview";
      card.setAttribute("role", "tooltip");
      const def = [...view.dom.querySelectorAll<HTMLElement>(".footnote-def")].find((d) => d.dataset.footnoteDef === label);
      const num = document.createElement("span");
      num.className = "footnote-preview-num";
      num.textContent = ref.dataset.num ?? "";
      const body = document.createElement("div");
      body.className = "footnote-preview-body";
      if (def && def.textContent?.trim()) {
        const copy = def.cloneNode(true) as HTMLElement;
        copy.querySelectorAll(".footnote-back, .footnotes-head, .ProseMirror-trailingBreak").forEach((n) => n.remove());
        body.append(...copy.childNodes);
      } else {
        body.classList.add("is-empty");
        body.textContent = def ? "Leere Fußnote" : `Fußnote [^${label}] ist nicht definiert`;
      }
      card.append(num, body);
      document.body.append(card);
      const r = ref.getBoundingClientRect();
      const w = Math.min(380, window.innerWidth - 16);
      card.style.width = `${w}px`;
      card.style.left = `${Math.max(8, Math.min(r.left - 12, window.innerWidth - w - 8))}px`;
      const h = card.offsetHeight;
      card.style.top = `${r.bottom + 6 + h < window.innerHeight ? r.bottom + 6 : Math.max(8, r.top - h - 6)}px`;
    };
    return [
      new Plugin({
        key: footnoteKey,
        state: {
          init: (_, { doc }) => buildDecorations(doc),
          apply: (tr, old) => (tr.docChanged ? buildDecorations(tr.doc) : old),
        },
        props: {
          decorations(state) {
            return footnoteKey.getState(state);
          },
          handleDOMEvents: {
            mousedown(view, event) {
              if (event.button !== 0) return false;
              const t = event.target as HTMLElement;
              const back = t.closest?.<HTMLElement>(".footnote-back");
              if (back) {
                event.preventDefault();
                hide();
                jumpToReference(view, back.dataset.label ?? "");
                return true;
              }
              const ref = t.closest?.<HTMLElement>(".footnote-ref");
              if (ref && view.dom.contains(ref)) {
                event.preventDefault();
                hide();
                jumpToDefinition(view, ref.dataset.footnote ?? "");
                return true;
              }
              return false;
            },
            mouseover(view, event) {
              const ref = (event.target as HTMLElement).closest?.<HTMLElement>(".footnote-ref");
              if (!ref) return false;
              window.clearTimeout(timer);
              timer = window.setTimeout(() => ref.isConnected && ref.matches(":hover") && show(view, ref), 250);
              return false;
            },
            mouseout(_view, event) {
              if ((event.target as HTMLElement).closest?.(".footnote-ref")) {
                window.clearTimeout(timer);
                timer = window.setTimeout(hide, 150);
              }
              return false;
            },
            keydown() {
              hide();
              return false;
            },
          },
        },
        view: () => ({ destroy: hide }),
      }),
    ];
  },
});
