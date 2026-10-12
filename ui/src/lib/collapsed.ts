// Open folders of the sidebar tree, kept in localStorage (`arcalo.expanded`). Folders start
// collapsed: only the ones opened by hand are stored, so a new folder (a new year of daily notes,
// an import) does not unfold the tree. Before 1.19 the collapsed ones were stored
// (`arcalo.collapsed`); the first start with a tree turns that list into this one.

import type { PageNode } from "./types";

const KEY = "arcalo.expanded";
const OLD_KEY = "arcalo.collapsed";
/** Fired when folders were collapsed from outside the sidebar (e.g. after an import). */
export const COLLAPSED_EVENT = "arcalo:collapsed";

const parse = (raw: string | null): number[] | null => {
  if (raw == null) return null;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x) => typeof x === "number") : null;
  } catch {
    return null;
  }
};
const read = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

/** The stored open folders; `null` while nothing was stored yet (see `migrateCollapsed`). */
export function readExpanded(): Set<number> | null {
  const ids = parse(read(KEY));
  return ids ? new Set(ids) : null;
}

export function writeExpanded(ids: Set<number>) {
  try {
    localStorage.setItem(KEY, JSON.stringify([...ids]));
    localStorage.removeItem(OLD_KEY);
  } catch {
    // Storage full or blocked: the state just is not remembered.
  }
}

/** The collapsed folders a version before 1.19 stored, if any. */
export const readOldCollapsed = (): number[] | null => parse(read(OLD_KEY));

/** The open folders of a tree whose collapsed ones were stored (every other folder was open). */
export function migrateCollapsed(collapsed: Iterable<number>, folders: Iterable<number>): Set<number> {
  const closed = new Set(collapsed);
  return new Set([...folders].filter((id) => !closed.has(id)));
}

/** `ids` without the ones that are gone (deleted pages); the same set when nothing is gone. */
export function pruneIds(ids: Set<number>, alive: (id: number) => boolean): Set<number> {
  for (const id of ids) if (!alive(id)) return new Set([...ids].filter(alive));
  return ids;
}

/** Collapses `ids` (they leave the stored open folders). */
export function collapsePages(ids: number[]) {
  if (!ids.length) return;
  const open = readExpanded();
  if (open) {
    ids.forEach((id) => open.delete(id));
    writeExpanded(open);
  }
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
