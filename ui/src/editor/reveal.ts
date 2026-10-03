// Scroll-to-text: open a page, wait for its editor, find a passage and flash it.
// Used by citations in assistant answers; usable from anywhere via `revealText`.

import { Extension, type Editor } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import { citeNeedles } from "../lib/citations";
import { scrollMotion } from "../lib/motion";

// ------------------------------------------------------------ editor registry

const editors = new Map<Editor, number>();

/** Registers a mounted note editor for `pageId`; returns the unregister function. */
export function registerEditor(pageId: number, editor: Editor): () => void {
  editors.set(editor, pageId);
  return () => {
    if (editors.get(editor) === pageId) editors.delete(editor);
  };
}

const visible = (e: Editor) => {
  const dom = e.view.dom as HTMLElement;
  return dom.isConnected && dom.getClientRects().length > 0;
};

/** The shown editor of a page, the one in the active pane first. */
export function editorForPage(pageId: number): Editor | null {
  const list = [...editors].filter(([e, id]) => id === pageId && !e.isDestroyed && visible(e)).map(([e]) => e);
  return list.find((e) => (e.view.dom as HTMLElement).closest(".pane.active")) ?? list[0] ?? null;
}

// ---------------------------------------------------------------- locating

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFC")
    .replace(/[‘’‚]/g, "'")
    .replace(/[“”„]/g, '"')
    .replace(/\s+/g, " ")
    .trim();

/** Text of a block as the reader sees it: wiki links by their label, chips left out. */
export function blockText(node: PMNode): string {
  return node.textBetween(0, node.content.size, " ", (leaf) => {
    if (leaf.type.name === "wikiLink") return leaf.attrs.alias || (leaf.attrs.anchor ? `${leaf.attrs.target} › ${leaf.attrs.anchor}` : leaf.attrs.target);
    if (leaf.type.name === "hardBreak") return " ";
    return "";
  });
}

export interface Located {
  /** Position before the text block. */
  from: number;
  /** Position after it. */
  to: number;
}

/** The first text block containing one of `needles` (tried in order; case/space-insensitive). */
export function locateText(doc: PMNode, needles: string[]): Located | null {
  for (const needle of needles) {
    const n = norm(needle);
    if (!n) continue;
    let found: Located | null = null;
    doc.descendants((node, pos) => {
      if (found) return false;
      if (!node.isTextblock) return true;
      if (norm(blockText(node)).includes(n)) found = { from: pos, to: pos + node.nodeSize };
      return false;
    });
    if (found) return found;
  }
  return null;
}

// ------------------------------------------------------------------- flash

export const citeFlashKey = new PluginKey<DecorationSet>("citeFlash");
export const FLASH_MS = 2200;

/** Highlights a block briefly (`.cite-flash`), set through the `citeFlashKey` meta. */
export const CiteFlash = Extension.create({
  name: "citeFlash",
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: citeFlashKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, set) {
            const meta = tr.getMeta(citeFlashKey) as Located | null | undefined;
            if (meta === null) return DecorationSet.empty;
            if (meta) return DecorationSet.create(tr.doc, [Decoration.node(meta.from, meta.to, { class: "cite-flash" })]);
            return set.map(tr.mapping, tr.doc);
          },
        },
        props: { decorations: (state) => citeFlashKey.getState(state) },
      }),
    ];
  },
});

/** Selects the start of `range`, scrolls it to the middle and flashes it. */
export function flashRange(editor: Editor, range: Located) {
  const { state } = editor;
  const sel = TextSelection.near(state.doc.resolve(Math.min(range.from + 1, state.doc.content.size)));
  editor.view.dispatch(state.tr.setSelection(sel).setMeta(citeFlashKey, range));
  editor.view.focus();
  const dom = editor.view.nodeDOM(range.from) as HTMLElement | null;
  (dom?.nodeType === 1 ? dom : dom?.parentElement)?.scrollIntoView({ behavior: scrollMotion(), block: "center" });
  window.setTimeout(() => {
    if (!editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(citeFlashKey, null));
  }, FLASH_MS);
}

// ------------------------------------------------------------------ reveal

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Waits (up to `timeout` ms) for a shown editor of the page with content. */
export async function waitForEditor(pageId: number, timeout = 6000): Promise<Editor | null> {
  const end = Date.now() + timeout;
  for (;;) {
    const e = editorForPage(pageId);
    if (e) return e;
    if (Date.now() > end) return null;
    await sleep(60);
  }
}

/**
 * Opens a page (through `open`), waits for its editor and shows the passage: `text` is a
 * chunk of Markdown (its first sentence, paragraph start or heading is searched) or plain
 * text. Falls back to the top of the page. Resolves whether the passage was found.
 */
export async function revealText(pageId: number, text: string, open: (pageId: number) => void): Promise<boolean> {
  open(pageId);
  // Let the tab switch render before looking for the editor.
  await sleep(30);
  const editor = await waitForEditor(pageId);
  if (!editor) return false;
  const needles = citeNeedles(text);
  if (!needles.length && text.trim()) needles.push(text.trim().slice(0, 80));
  const range = locateText(editor.state.doc, needles);
  if (!range) {
    editor.commands.focus("start");
    (editor.view.dom as HTMLElement).closest(".page-scroll")?.scrollTo({ top: 0, behavior: scrollMotion() });
    return false;
  }
  flashRange(editor, range);
  return true;
}
