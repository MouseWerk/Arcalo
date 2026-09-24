// Editor tools (toolbar „Werkzeuge“, shortcuts): case changes, sorting and de-duplicating
// lines, moving blocks, text statistics. The text logic is plain functions (tested); the
// commands apply it to the selected blocks.

import type { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";

export type CaseMode = "upper" | "lower" | "title";

/** "hallo WELT" → "HALLO WELT" / "hallo welt" / "Hallo Welt" (German-aware). */
export function changeCase(text: string, mode: CaseMode): string {
  if (mode === "upper") return text.toLocaleUpperCase("de-DE");
  if (mode === "lower") return text.toLocaleLowerCase("de-DE");
  return text.toLocaleLowerCase("de-DE").replace(/(^|[\s\-–(„"'/])(\p{L})/gu, (_, sep: string, c: string) => sep + c.toLocaleUpperCase("de-DE"));
}

const collator = new Intl.Collator("de", { numeric: true, sensitivity: "base" });

/** Indices of `lines` in sorted order (A–Z, numbers naturally, umlauts like their base letter). */
export function sortOrder(lines: string[], descending = false): number[] {
  const idx = lines.map((_, i) => i);
  idx.sort((a, b) => collator.compare(lines[a].trim(), lines[b].trim()) * (descending ? -1 : 1) || a - b);
  return idx;
}

/** Indices of the first occurrence of each line (ignoring case and surrounding spaces). */
export function uniqueOrder(lines: string[]): number[] {
  const seen = new Set<string>();
  const out: number[] = [];
  lines.forEach((l, i) => {
    const key = l.trim().toLocaleLowerCase("de-DE");
    if (!seen.has(key)) {
      seen.add(key);
      out.push(i);
    }
  });
  return out;
}

export interface TextStats {
  words: number;
  chars: number;
  charsNoSpaces: number;
  paragraphs: number;
  /** Minutes at 200 words per minute, at least 1 for any text. */
  readingMinutes: number;
}

export function textStats(text: string): TextStats {
  const words = (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’\-_.]*/gu) ?? []).length;
  const paragraphs = text.split(/\n\s*\n|\n/).filter((p) => p.trim()).length;
  return {
    words,
    chars: text.replace(/\n/g, "").length,
    charsNoSpaces: text.replace(/\s/g, "").length,
    paragraphs,
    readingMinutes: words ? Math.max(1, Math.round(words / 200)) : 0,
  };
}

/** The blocks the selection touches, as siblings of one parent: list items of one list, or
 *  top-level blocks. `null` when the selection is inside a single text block of a table/code. */
function selectedSiblings(editor: Editor): { parentPos: number; from: number; to: number; nodes: PMNode[] } | null {
  const { $from, $to } = editor.state.selection;
  const range = $from.blockRange($to);
  if (!range) return null;
  const parent = range.parent;
  const nodes: PMNode[] = [];
  for (let i = range.startIndex; i < range.endIndex; i++) nodes.push(parent.child(i));
  return { parentPos: range.start, from: range.start, to: range.end, nodes };
}

/** Rewrites the selected blocks in a new order (sorting, de-duplicating). One undo step. */
function reorderBlocks(editor: Editor, order: (texts: string[]) => number[]): boolean {
  const sel = selectedSiblings(editor);
  if (!sel || sel.nodes.length < 2) return false;
  const texts = sel.nodes.map((n) => n.textContent);
  const idx = order(texts);
  const { tr } = editor.state;
  tr.replaceWith(sel.from, sel.to, idx.map((i) => sel.nodes[i]));
  tr.setSelection(TextSelection.create(tr.doc, sel.from + 1, Math.min(tr.doc.content.size, sel.from + idx.reduce((a, i) => a + sel.nodes[i].nodeSize, 0) - 1)));
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

export const sortSelectedLines = (editor: Editor, descending = false) => reorderBlocks(editor, (t) => sortOrder(t, descending));
export const dedupeSelectedLines = (editor: Editor) => reorderBlocks(editor, uniqueOrder);

/** Changes the case of the selected text, keeping its marks. */
export function changeSelectionCase(editor: Editor, mode: CaseMode): boolean {
  const { from, to, empty } = editor.state.selection;
  if (empty) return false;
  const { tr } = editor.state;
  editor.state.doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText) return;
    const start = Math.max(from, pos);
    const end = Math.min(to, pos + node.nodeSize);
    const text = node.text!.slice(start - pos, end - pos);
    const next = changeCase(text, mode);
    if (next !== text && next.length === text.length) tr.insertText(next, tr.mapping.map(start), tr.mapping.map(end));
  });
  tr.setSelection(TextSelection.create(tr.doc, from, to));
  editor.view.dispatch(tr);
  return true;
}

/** Moves the block with the cursor (a list item within its list, else a top-level block) up
 *  or down by one. */
export function moveBlock(editor: Editor, dir: -1 | 1): boolean {
  const { $from } = editor.state.selection;
  // Innermost list item, else the top-level block.
  let depth = $from.depth;
  while (depth > 1 && !/^(listItem|taskItem)$/.test($from.node(depth).type.name)) depth--;
  if (depth < 1) return false;
  const parent = $from.node(depth - 1);
  const index = $from.index(depth - 1);
  const target = index + dir;
  if (target < 0 || target >= parent.childCount) return false;
  const node = $from.node(depth);
  const start = $from.before(depth);
  const other = parent.child(target);
  const { tr } = editor.state;
  const offset = editor.state.selection.from - start;
  if (dir === -1) {
    const otherStart = start - other.nodeSize;
    tr.delete(start, start + node.nodeSize).insert(otherStart, node);
    tr.setSelection(TextSelection.create(tr.doc, otherStart + offset));
  } else {
    const end = start + node.nodeSize;
    tr.delete(start, end).insert(start + other.nodeSize, node);
    tr.setSelection(TextSelection.create(tr.doc, start + other.nodeSize + offset));
  }
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

/** Removes marks and turns the selected blocks into plain paragraphs. */
export function clearFormatting(editor: Editor) {
  return editor.chain().focus().unsetAllMarks().clearNodes().run();
}

/** Plain text of the selection, or of the whole note when nothing is selected. */
export function statsText(editor: Editor): { text: string; selection: boolean } {
  const { from, to, empty } = editor.state.selection;
  return empty ? { text: editor.state.doc.textBetween(0, editor.state.doc.content.size, "\n", " "), selection: false } : { text: editor.state.doc.textBetween(from, to, "\n", " "), selection: true };
}
