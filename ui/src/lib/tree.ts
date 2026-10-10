// The page tree as `workspace_tree_compact` sends it: each page as an array (half the size of the
// objects of `workspace_tree` in a large workspace), decoded into the same objects.

import type { FolderStyle } from "./filing";
import type { PageNode } from "./types";

/** `arcalo_core::model::PageRow`: id, parent, title, icon, position, updated, favorite, daily date, kind, created, filing folder, folder style, children. */
export type PageRow = [number, number | null, string, string | null, number, string, boolean, string | null, string | null, string, string | null, FolderStyle | null, PageRow[]];

/** The pages of `rows` as the nodes of `workspace_tree` (live pages: `deleted_at` is null). */
export function fromPageRows(rows: PageRow[]): PageNode[] {
  return rows.map(([id, parent_id, title, icon, position, updated_at, favorite, daily_date, kind, created_at, system, style, children]) => {
    const node: PageNode = { id, parent_id, title, icon, position, updated_at, favorite, daily_date, deleted_at: null, children: fromPageRows(children), created_at };
    // Absent unless set, as in `workspace_tree`.
    if (kind != null) node.kind = kind;
    if (system != null) node.system = system;
    if (style != null) node.style = style;
    return node;
  });
}
