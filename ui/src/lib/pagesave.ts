// A page after a save of its own editor.

import type { PageDoc } from "./types";

/**
 * The page after its own editor saved `content`: tags, links and the time from the server's
 * answer (only the fields it has; the rest stays as it was).
 */
export function withSaved(cur: PageDoc, saved: Partial<Pick<PageDoc, "tags" | "backlinks" | "unresolved_links" | "updated_at">> | null | undefined, content: string): PageDoc {
  const s = saved ?? {};
  return {
    ...cur,
    content,
    tags: s.tags ?? cur.tags,
    backlinks: s.backlinks ?? cur.backlinks,
    unresolved_links: s.unresolved_links ?? cur.unresolved_links,
    updated_at: s.updated_at ?? cur.updated_at,
  };
}
