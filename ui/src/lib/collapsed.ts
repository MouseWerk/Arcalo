// Collapsed folders of the sidebar tree, kept in localStorage (`annalo.collapsed`).

import type { PageNode } from "./types";

const KEY = "annalo.collapsed";
/** Fired when folders were collapsed from outside the sidebar (e.g. after an import). */
export const COLLAPSED_EVENT = "annalo:collapsed";

export function readCollapsed(): Set<number> {
  try {
    return new Set(JSON.parse(localStorage.getItem(KEY) ?? "[]"));
  } catch {
    return new Set();
  }
}

export function writeCollapsed(ids: Set<number>) {
  try {
    localStorage.setItem(KEY, JSON.stringify([...ids]));
  } catch {
    // Storage full or blocked: the state just is not remembered.
  }
}

/** Collapses `ids` (in addition to the already collapsed ones). */
export function collapsePages(ids: number[]) {
  if (!ids.length) return;
  const next = readCollapsed();
  ids.forEach((id) => next.add(id));
  writeCollapsed(next);
  window.dispatchEvent(new CustomEvent(COLLAPSED_EVENT));
}

/** Pages with subpages below `root` (not `root` itself). */
export function foldersBelow(root: PageNode | undefined): number[] {
  const out: number[] = [];
  const walk = (n: PageNode) =>
    n.children.forEach((c) => {
      if (c.children.length) out.push(c.id);
      walk(c);
    });
  if (root) walk(root);
  return out;
}
