// Merging two versions of a canvas that both started from the same one (the same board open in
// two panes): card by card and connection by connection, never as text. What only one side
// changed is taken from that side; a card both changed keeps this side's version; a card one
// side deleted stays deleted unless the other side changed it since.

import { parseCanvas, serializeCanvas, type CanvasDoc } from "./model";

type Item = { id: string };

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Merges one list (nodes or edges) by id, in `mine`'s order; items `theirs` added go after
 *  the item before them in `theirs`. */
function mergeList<T extends Item>(base: T[], mine: T[], theirs: T[]): T[] {
  const byId = (list: T[]) => new Map(list.map((x) => [x.id, x]));
  const b = byId(base);
  const m = byId(mine);
  const t = byId(theirs);
  const out: T[] = [];
  for (const item of mine) {
    const was = b.get(item.id);
    const other = t.get(item.id);
    if (!was) out.push(item);
    else if (!other) {
      // Deleted there: gone here too, unless changed here since.
      if (!same(item, was)) out.push(item);
    } else out.push(same(item, was) ? other : item);
  }
  // Added there (or deleted here while changed there).
  theirs.forEach((item, i) => {
    if (m.has(item.id)) return;
    const was = b.get(item.id);
    if (was && same(item, was)) return;
    const prev = theirs
      .slice(0, i)
      .reverse()
      .find((x) => out.some((o) => o.id === x.id));
    const at = prev ? out.findIndex((o) => o.id === prev.id) + 1 : 0;
    out.splice(at, 0, item);
  });
  return out;
}

/**
 * `mine` and `theirs`, both changed from `base`, as one board. Fields of the document other
 * than the cards and connections are taken from the side that changed them (this side's when
 * both did). Entries a board cannot show (see `KEPT` in model.ts) go through the file text, so
 * a connection whose card is gone is kept, not dropped.
 */
export function mergeCanvas(base: CanvasDoc, mine: CanvasDoc, theirs: CanvasDoc): CanvasDoc {
  const raw = (d: CanvasDoc) => JSON.parse(serializeCanvas(d)) as Record<string, unknown> & { nodes: Item[]; edges: Item[] };
  const [b, m, t] = [raw(base), raw(mine), raw(theirs)];
  const out: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(m), ...Object.keys(t)])) {
    if (key === "nodes" || key === "edges") out[key] = mergeList(b[key], m[key], t[key]);
    else if (!(key in m)) {
      if (!same(t[key], b[key])) out[key] = t[key];
    } else if (!(key in t)) {
      if (!same(m[key], b[key])) out[key] = m[key];
    } else out[key] = same(m[key], b[key]) ? t[key] : m[key];
  }
  return parseCanvas(JSON.stringify(out));
}
