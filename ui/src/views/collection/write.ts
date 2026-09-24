// Writes the frontmatter of a page that the table/board or a property menu changes: through the
// editor of an open pane when there is one (one writer per page), otherwise straight to the store.
// Only the frontmatter changes; the text of the page stays byte for byte.

import { api } from "../../lib/api";
import { flushAllEditors } from "../../editor/NoteEditor";
import { splitFrontmatter } from "../../editor/extensions";
import { cellInput, parseSchema, setSchema, writeValue, type PropDef } from "../../lib/collection";
import { parseFrontmatter } from "../../lib/frontmatter";

/** A page view that holds a page's frontmatter in its editor. */
export interface FrontmatterOwner {
  get: () => string;
  set: (fm: string) => void;
}

const owners = new Map<number, Set<FrontmatterOwner>>();

/** Registers a page view as the writer of `id`'s frontmatter; returns the removal. */
export function registerFrontmatterOwner(id: number, owner: FrontmatterOwner) {
  let set = owners.get(id);
  if (!set) owners.set(id, (set = new Set()));
  set.add(owner);
  return () => {
    set.delete(owner);
    if (!set.size) owners.delete(id);
  };
}

/** Event other views listen to: `{ id, fm }` right after a change (before the save lands). */
export const FRONTMATTER_EVENT = "annalo:frontmatter-changed";

/** Changes a page's frontmatter; resolves to the new block, `null` when nothing changed. */
export async function updateFrontmatter(id: number, change: (fm: string) => string): Promise<string | null> {
  const owner = owners.get(id)?.values().next().value;
  if (owner) {
    const cur = owner.get();
    const next = change(cur);
    if (next === cur) return null;
    owner.set(next);
    window.dispatchEvent(new CustomEvent(FRONTMATTER_EVENT, { detail: { id, fm: next } }));
    return next;
  }
  // Pending edits of every pane first, so the page is read as the user last saw it.
  await flushAllEditors();
  const doc = await api.page(id);
  const { frontmatter } = splitFrontmatter(doc.content);
  const next = change(frontmatter);
  if (next === frontmatter) return null;
  // The text after the block stays exactly as stored.
  const rest = !frontmatter ? doc.content : doc.content.startsWith(frontmatter) ? doc.content.slice(frontmatter.length) : doc.content.slice(frontmatter.length - 1);
  const content = next && rest && !next.endsWith("\n") ? `${next}\n${rest}` : next + rest;
  await api.savePage(id, content);
  window.dispatchEvent(new CustomEvent(FRONTMATTER_EVENT, { detail: { id, fm: next } }));
  // Open panes of the page take the new content like any other save.
  window.dispatchEvent(new CustomEvent("annalo:page-saved", { detail: { id, content, from: "collection" } }));
  return next;
}

/** Changes the schema in a parent page's frontmatter. */
export function updateSchema(parentId: number, change: (defs: PropDef[]) => PropDef[] | null) {
  return updateFrontmatter(parentId, (fm) => setSchema(fm, change(parseSchema(fm) ?? [])));
}

/** Renamed options: the child pages that use an old name get the new one. */
export async function renameOptionValues(parentId: number, key: string, renames: [string, string][]) {
  const col = await api.pageCollection(parentId);
  const rename = (v: string) => renames.find(([old]) => old.toLowerCase() === v.toLowerCase())?.[1] ?? v;
  for (const r of col.rows) {
    await updateFrontmatter(r.id, (fm) => {
      const input = cellInput(parseFrontmatter(fm), key);
      if (!input || !input.items.some((i) => rename(i) !== i)) return fm;
      const items = input.items.map(rename);
      return writeValue(fm, key, input.list ? items : items[0]);
    });
  }
}
