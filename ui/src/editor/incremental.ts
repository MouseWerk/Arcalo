// Decorations that follow an edit instead of being rebuilt for the whole note on every keystroke.

import type { Node as PMNode } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import { DecorationSet, type Decoration } from "@tiptap/pm/view";

export interface Range {
  from: number;
  to: number;
}

/** Above this many changed top-level blocks a full rebuild is as cheap. */
const MAX_BLOCKS = 200;

/**
 * The ranges of `tr.doc` that `tr` changed (inserted content, changed marks or attributes), or
 * null when a step cannot say (then everything counts as changed).
 */
export function changedRanges(tr: Transaction): Range[] | null {
  const out: Range[] = [];
  const maps = tr.mapping.maps;
  for (let i = 0; i < maps.length; i++) {
    const rest = tr.mapping.slice(i + 1);
    const add = (from: number, to: number) => out.push({ from: rest.map(from, -1), to: Math.max(rest.map(from, -1), rest.map(to, 1)) });
    let any = false;
    maps[i].forEach((_os, _oe, from, to) => {
      any = true;
      add(from, to);
    });
    if (any) continue;
    // Steps without a position map: marks and attributes.
    const step = tr.steps[i] as unknown as { from?: number; to?: number; pos?: number };
    if (typeof step.from === "number" && typeof step.to === "number") add(step.from, step.to);
    else if (typeof step.pos === "number") add(step.pos, step.pos + 1);
    else if (tr.steps[i].toJSON().stepType !== "docAttr") return null;
  }
  return out;
}

/** The top-level blocks of `doc` that touch one of `ranges`, in document order. */
export function touchedBlocks(doc: PMNode, ranges: Range[]): { node: PMNode; pos: number }[] {
  const seen = new Set<number>();
  const out: { node: PMNode; pos: number }[] = [];
  const size = doc.content.size;
  for (const r of ranges) {
    doc.nodesBetween(Math.max(0, r.from - 1), Math.min(size, r.to + 1), (node, pos) => {
      if (!seen.has(pos)) {
        seen.add(pos);
        out.push({ node, pos });
      }
      return false;
    });
  }
  return out.sort((a, b) => a.pos - b.pos);
}

/**
 * Decorations built per top-level block (`build(node, pos)`: those of one block, all inside it),
 * carried over an edit: mapped, and rebuilt only for the blocks the edit touched.
 */
export function blockDecorations(doc: PMNode, build: (node: PMNode, pos: number) => Decoration[]): DecorationSet {
  const decos: Decoration[] = [];
  doc.forEach((node, pos) => {
    for (const d of build(node, pos)) decos.push(d);
  });
  return DecorationSet.create(doc, decos);
}

export function updateBlockDecorations(old: DecorationSet, tr: Transaction, build: (node: PMNode, pos: number) => Decoration[]): DecorationSet {
  if (!tr.docChanged) return old;
  const ranges = changedRanges(tr);
  const blocks = ranges && touchedBlocks(tr.doc, ranges);
  if (!blocks || blocks.length > MAX_BLOCKS) return blockDecorations(tr.doc, build);
  let set = old.map(tr.mapping, tr.doc);
  const fresh: Decoration[] = [];
  for (const { node, pos } of blocks) {
    const end = pos + node.nodeSize;
    // Everything inside the block, and what an edit stretched across its edge (a split tag).
    const stale = set.find(pos, end).filter((d) => (d.from < end && d.to > pos) || (d.from === d.to && d.from > pos && d.from < end));
    if (stale.length) set = set.remove(stale);
    for (const d of build(node, pos)) fresh.push(d);
  }
  return fresh.length ? set.add(tr.doc, fresh) : set;
}

/** Whether `tr` inserted, removed or touched a node for which `hit` is true (or next to one). */
export function touchesNodes(tr: Transaction, hit: (node: PMNode) => boolean): boolean {
  const maps = tr.mapping.maps;
  const check = (doc: PMNode, from: number, to: number) => {
    let found = false;
    doc.nodesBetween(Math.max(0, from - 1), Math.min(doc.content.size, to + 1), (node) => {
      if (found) return false;
      if (hit(node)) found = true;
      return !found;
    });
    return found;
  };
  for (let i = 0; i < maps.length; i++) {
    let found = false;
    maps[i].forEach((oldStart, oldEnd) => {
      if (!found && check(tr.docs[i], oldStart, oldEnd)) found = true;
    });
    if (found) return true;
  }
  const ranges = changedRanges(tr);
  if (!ranges) return true;
  return ranges.some((r) => check(tr.doc, r.from, r.to));
}
