// Layout engine of the start page's grid: widgets are rectangles in 12 columns and rows of a
// fixed height. Moves and resizes push what they hit downwards, and everything then floats up
// as far as it can (no holes). Narrow panes show the same layout in fewer columns (`reflow`);
// only the 12-column layout is stored.

export const COLS = 12;
/** Height of a row and the gap between rows and columns (px). */
export const ROW_H = 28;
export const GAP = 12;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface GridItem extends Rect {
  id: string;
}
export interface MinSize {
  w: number;
  h: number;
}

/** Height in px of `h` rows. */
export const rowsPx = (h: number) => h * ROW_H + (h - 1) * GAP;

export const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Row, then column (the order screen readers and the Tab key follow). */
export function readingOrder<T extends GridItem>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.y - b.y || a.x - b.x || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The rectangle inside `cols` columns, at least `min` large. */
export function clampRect<T extends Rect>(r: T, cols = COLS, min: MinSize = { w: 1, h: 1 }): T {
  const w = Math.max(Math.min(min.w, cols), Math.min(cols, Math.round(r.w)));
  const h = Math.max(min.h, Math.round(r.h), 1);
  const x = Math.max(0, Math.min(cols - w, Math.round(r.x)));
  const y = Math.max(0, Math.round(r.y));
  return { ...r, x, y, w, h };
}

/** The lowest row at or below `y` where `r` hits nothing of `placed`. */
function firstFreeBelow(r: Rect, placed: readonly Rect[]): number {
  let y = r.y;
  for (;;) {
    const hit = placed.find((p) => overlaps({ ...r, y }, p));
    if (!hit) return y;
    y = hit.y + hit.h;
  }
}

/** Moves `r` up while it hits nothing of `placed`. */
function floatUp(r: Rect, placed: readonly Rect[]): number {
  let y = r.y;
  while (y > 0 && !placed.some((p) => overlaps({ ...r, y: y - 1 }, p))) y--;
  return y;
}

/**
 * Places `fixed` items where they are (in the given order; a later one that hits an earlier
 * one goes below it), then the others in reading order: each below what it hits, then as far
 * up as it goes. Finally everything floats up. The result has no overlaps and no holes a
 * widget could fall into; the order of `items` is kept.
 */
export function settle<T extends GridItem>(items: readonly T[], fixed: string[] = []): T[] {
  const placed: GridItem[] = [];
  const out = new Map<string, T>();
  const put = (it: T, float: boolean) => {
    const y0 = firstFreeBelow(it, placed);
    const y = float ? floatUp({ ...it, y: y0 }, placed) : y0;
    const next = y === it.y ? it : { ...it, y };
    placed.push(next);
    out.set(it.id, next);
  };
  for (const id of fixed) {
    const it = items.find((i) => i.id === id);
    if (it && !out.has(id)) put(it, false);
  }
  for (const it of readingOrder(items)) if (!out.has(it.id)) put(it, true);
  return compact(items.map((i) => out.get(i.id)!));
}

/** Everything floats up as far as it goes (in reading order). */
export function compact<T extends GridItem>(items: readonly T[]): T[] {
  const placed: GridItem[] = [];
  const out = new Map<string, T>();
  for (const it of readingOrder(items)) {
    const y = floatUp(it, placed);
    const next = y === it.y ? it : { ...it, y };
    placed.push(next);
    out.set(it.id, next);
  }
  const res = items.map((i) => out.get(i.id)!);
  return res.every((r, k) => r === items[k]) ? (items as T[]) : res;
}

const replace = <T extends GridItem>(items: readonly T[], id: string, patch: Partial<Rect>) => items.map((i) => (i.id === id ? { ...i, ...patch } : i));

/** `id` moved to column `x`, row `y`; what it hits makes room below it. */
export function moveTo<T extends GridItem>(items: readonly T[], id: string, x: number, y: number, cols = COLS): T[] {
  const it = items.find((i) => i.id === id);
  if (!it) return items as T[];
  const r = clampRect({ ...it, x, y }, cols, { w: it.w, h: it.h });
  return settle(replace(items, id, { x: r.x, y: r.y }), [id]);
}

/** `id` with a new size (kept inside the grid, at least `min`). */
export function resizeTo<T extends GridItem>(items: readonly T[], id: string, w: number, h: number, cols = COLS, min: MinSize = { w: 1, h: 1 }): T[] {
  const it = items.find((i) => i.id === id);
  if (!it) return items as T[];
  const r = clampRect({ ...it, w, h }, cols, min);
  // Growing past the right edge moves the widget left instead of cutting it.
  return settle(replace(items, id, { x: r.x, w: r.w, h: r.h }), [id]);
}

/** Horizontal neighbors: the item `r` touches on its left (dir -1) or right (1) in its row. */
function besideOf<T extends GridItem>(items: readonly T[], r: T, dir: -1 | 1): T | undefined {
  return items.find((o) => o.id !== r.id && o.y === r.y && (dir < 0 ? o.x + o.w === r.x : o.x === r.x + r.w));
}

/** The nearest item above (dir -1) or below (1) that shares a column with `r`. */
function stackedOf<T extends GridItem>(items: readonly T[], r: T, dir: -1 | 1): T | undefined {
  const cols = (o: Rect) => o.x < r.x + r.w && r.x < o.x + o.w;
  const cands = items.filter((o) => o.id !== r.id && cols(o) && (dir < 0 ? o.y < r.y : o.y > r.y));
  return cands.sort((a, b) => (dir < 0 ? b.y - a.y : a.y - b.y))[0];
}

/**
 * One keyboard step of `id`. Up and down swap it with the widget above or below; left and
 * right move it one column, or swap it with a widget right next to it in its row.
 */
export function nudge<T extends GridItem>(items: readonly T[], id: string, dx: number, dy: number, cols = COLS): T[] {
  const it = items.find((i) => i.id === id);
  if (!it) return items as T[];
  if (dy !== 0) {
    const other = stackedOf(items, it, dy < 0 ? -1 : 1);
    if (!other) return items as T[];
    // The upper one of the two ends up where the pair started.
    const top = Math.min(it.y, other.y);
    const [first, second] = dy < 0 ? [it, other] : [other, it];
    const next = replace(replace(items, first.id, { y: top }), second.id, { y: top + first.h });
    return settle(next, [first.id, second.id]);
  }
  if (dx !== 0) {
    const dir = dx < 0 ? -1 : 1;
    const other = besideOf(items, it, dir);
    if (other) {
      const [left, right] = dir < 0 ? [it, other] : [other, it];
      const x0 = Math.min(it.x, other.x);
      const next = replace(replace(items, left.id, { x: x0 }), right.id, { x: x0 + left.w });
      return settle(next, [it.id, other.id]);
    }
    const x = Math.max(0, Math.min(cols - it.w, it.x + dir));
    if (x === it.x) return items as T[];
    return moveTo(items, id, x, it.y, cols);
  }
  return items as T[];
}

/** One keyboard step of the size of `id` (columns with dx, rows with dy). */
export function grow<T extends GridItem>(items: readonly T[], id: string, dx: number, dy: number, cols = COLS, min: MinSize = { w: 1, h: 1 }): T[] {
  const it = items.find((i) => i.id === id);
  if (!it) return items as T[];
  const w = Math.max(min.w, Math.min(cols, it.w + dx));
  const h = Math.max(min.h, it.h + dy);
  if (w === it.w && h === it.h) return items as T[];
  return resizeTo(items, id, w, h, cols, min);
}

/** The first place (top to bottom, left to right) where a `w`×`h` widget fits. */
export function findFree(items: readonly Rect[], w: number, h: number, cols = COLS): { x: number; y: number } {
  const ww = Math.min(w, cols);
  const bottom = items.reduce((m, i) => Math.max(m, i.y + i.h), 0);
  for (let y = 0; y <= bottom; y++) {
    for (let x = 0; x + ww <= cols; x++) {
      if (!items.some((i) => overlaps({ x, y, w: ww, h }, i))) return { x, y };
    }
  }
  return { x: 0, y: bottom };
}

/** Rows the layout takes. */
export const layoutRows = (items: readonly Rect[]) => items.reduce((m, i) => Math.max(m, i.y + i.h), 0);

/**
 * The 12-column layout in `cols` columns for narrow panes: widths scale with the columns
 * (at least `min`, at most all), and the widgets are placed in reading order where they fit
 * first. In one column they simply stack.
 */
export function reflow<T extends GridItem>(items: readonly T[], cols: number, minOf: (it: T) => MinSize = () => ({ w: 1, h: 1 })): T[] {
  if (cols >= COLS) return items as T[];
  const ordered = readingOrder(items);
  if (cols <= 1) {
    let y = 0;
    const out = new Map(ordered.map((it) => {
      const r = { ...it, x: 0, w: 1, y };
      y += it.h;
      return [it.id, r] as const;
    }));
    return items.map((i) => out.get(i.id)!);
  }
  const placed: GridItem[] = [];
  const out = new Map<string, T>();
  // Widgets starting in the same row share it in the narrow grid too: their widths are scaled
  // (largest remainder, at least their minimum) so that the row still fits.
  const rows = new Map<number, T[]>();
  for (const it of ordered) rows.set(it.y, [...(rows.get(it.y) ?? []), it]);
  let row = 0;
  for (const group of rows.values()) {
    // In a narrow grid nothing gets narrower than half of it (a sliver helps nobody).
    const mins = group.map((it) => Math.min(cols, Math.max(Math.ceil((minOf(it).w * cols) / COLS), Math.ceil(cols / 2))));
    const exact = group.map((it) => (it.w * cols) / COLS);
    const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
    let ws = exact.map((e, i) => Math.max(mins[i], Math.min(cols, Math.floor(e))));
    if (sum(mins) <= cols) {
      const target = Math.min(cols, Math.round(sum(exact)));
      const byFraction = exact.map((e, i) => [e - Math.floor(e), i] as const).sort((a, b) => b[0] - a[0]);
      for (const [, i] of byFraction) if (sum(ws) < target && ws[i] < cols) ws[i]++;
      // Too wide for the row: take from the widest above their minimum.
      while (sum(ws) > cols) {
        let k = -1;
        ws.forEach((w, i) => (w > mins[i] && (k < 0 || w - mins[i] > ws[k] - mins[k]) ? (k = i) : 0));
        if (k < 0) break;
        ws[k]--;
      }
    } else {
      // The row does not fit: split it into rows of equal widgets, the last row filled up.
      const lines = Math.ceil(sum(mins) / cols);
      const perLine = Math.ceil(group.length / lines);
      const last = group.length - perLine * (lines - 1);
      ws = group.map((_, i) => Math.max(mins[i], Math.floor(cols / (i >= group.length - last ? last : perLine))));
    }
    let want = Math.min(cols - ws[0], Math.round((group[0].x * cols) / COLS));
    group.forEach((it, i) => {
      const w = ws[i];
      want = Math.min(want, cols - w);
      // The free spot nearest to where it belongs, in the first row that has one.
      const xs = Array.from({ length: cols - w + 1 }, (_, x) => x).sort((a, b) => Math.abs(a - want) - Math.abs(b - want) || a - b);
      let spot: { x: number; y: number } | null = null;
      for (let y = row; !spot; y++) {
        const x = xs.find((cx) => !placed.some((p) => overlaps({ x: cx, y, w, h: it.h }, p)));
        if (x !== undefined) spot = { x, y };
      }
      const r = { ...it, w, ...spot };
      placed.push(r);
      out.set(it.id, r);
      want = r.x + w;
    });
    row = out.get(group[0].id)!.y;
  }
  return items.map((i) => out.get(i.id)!);
}

/** Columns for a grid `width` px wide. */
export function columnsFor(width: number): number {
  if (width >= 700) return COLS;
  if (width >= 480) return 6;
  return 1;
}

/** Grid cell under a point: `px`/`py` relative to the grid's top left. */
export function cellAt(px: number, py: number, width: number, cols = COLS): { col: number; row: number } {
  const colW = (width - GAP * (cols - 1)) / cols;
  return { col: Math.max(0, Math.min(cols - 1, Math.floor(px / (colW + GAP)))), row: Math.max(0, Math.floor(py / (ROW_H + GAP))) };
}

/** Left, top, width and height in px of `r` in a grid `width` px wide. */
export function rectPx(r: Rect, width: number, cols = COLS) {
  const colW = (width - GAP * (cols - 1)) / cols;
  return { left: r.x * (colW + GAP), top: r.y * (ROW_H + GAP), width: r.w * colW + (r.w - 1) * GAP, height: rowsPx(r.h) };
}
