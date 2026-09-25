import { describe, expect, it } from "vitest";
import { cellAt, clampRect, columnsFor, compact, findFree, grow, layoutRows, moveTo, nudge, overlaps, readingOrder, rectPx, reflow, resizeTo, rowsPx, settle, type GridItem } from "./dashgrid";

const it_ = (id: string, x: number, y: number, w: number, h: number): GridItem => ({ id, x, y, w, h });
const pos = (items: GridItem[]) => Object.fromEntries(items.map((i) => [i.id, [i.x, i.y, i.w, i.h]]));
const noOverlaps = (items: GridItem[]) => {
  for (const a of items) for (const b of items) if (a !== b) expect(overlaps(a, b), `${a.id} / ${b.id}`).toBe(false);
};

// Two rows: a wide „today“ next to „agenda“, below them three small ones.
const board = () => [it_("today", 0, 0, 8, 10), it_("agenda", 8, 0, 4, 10), it_("week", 0, 10, 6, 6), it_("budget", 6, 10, 3, 6), it_("recent", 9, 10, 3, 6)];

describe("dashgrid", () => {
  it("detects collisions and sorts in reading order", () => {
    expect(overlaps(it_("a", 0, 0, 2, 2), it_("b", 1, 1, 2, 2))).toBe(true);
    expect(overlaps(it_("a", 0, 0, 2, 2), it_("b", 2, 0, 2, 2))).toBe(false);
    expect(overlaps(it_("a", 0, 0, 2, 2), it_("b", 0, 2, 2, 2))).toBe(false);
    expect(readingOrder([it_("c", 0, 5, 1, 1), it_("b", 3, 0, 1, 1), it_("a", 0, 0, 1, 1)]).map((i) => i.id)).toEqual(["a", "b", "c"]);
  });

  it("clamps into the grid and to a minimum size", () => {
    expect(clampRect(it_("a", 10, -3, 5, 0))).toMatchObject({ x: 7, y: 0, w: 5, h: 1 });
    expect(clampRect(it_("a", 0, 0, 1, 1), 12, { w: 3, h: 4 })).toMatchObject({ w: 3, h: 4 });
    expect(clampRect(it_("a", 0, 0, 20, 2), 6)).toMatchObject({ x: 0, w: 6 });
  });

  it("compacts upwards without overlaps and keeps an unchanged layout identical", () => {
    const b = board();
    expect(compact(b)).toBe(b);
    const holes = [it_("a", 0, 4, 6, 2), it_("b", 6, 9, 6, 3), it_("c", 0, 12, 12, 2)];
    expect(pos(compact(holes))).toEqual({ a: [0, 0, 6, 2], b: [6, 0, 6, 3], c: [0, 3, 12, 2] });
  });

  it("settles overlaps: the fixed item stays, others go below and float up", () => {
    const layout = settle([it_("a", 0, 0, 6, 4), it_("b", 0, 0, 12, 2)], ["b"]);
    expect(pos(layout)).toEqual({ a: [0, 2, 6, 4], b: [0, 0, 12, 2] });
    noOverlaps(layout);
  });

  it("moves an item and pushes what it hits below it", () => {
    // „recent“ dragged to the top left: today and agenda make room.
    const moved = moveTo(board(), "recent", 0, 0);
    noOverlaps(moved);
    expect(pos(moved).recent).toEqual([0, 0, 3, 6]);
    expect(pos(moved).today[1]).toBe(6);
    // Dropped far below everything, it floats up to the first free row.
    const down = moveTo(board(), "budget", 6, 40);
    expect(pos(down).budget).toEqual([6, 10, 3, 6]);
    // Unknown ids change nothing.
    const b = board();
    expect(moveTo(b, "nope", 0, 0)).toBe(b);
    // Out of the grid: kept inside.
    expect(pos(moveTo(board(), "recent", 11, 10)).recent).toEqual([9, 10, 3, 6]);
  });

  it("resizes inside the grid and pushes the widgets below", () => {
    const wide = resizeTo(board(), "week", 12, 6);
    noOverlaps(wide);
    expect(pos(wide).week).toEqual([0, 10, 12, 6]);
    expect(pos(wide).budget[1]).toBe(16);
    // Growing past the right edge moves it left.
    const right = resizeTo(board(), "recent", 6, 6);
    expect(pos(right).recent).toEqual([6, 10, 6, 6]);
    // Not below the minimum.
    expect(pos(resizeTo(board(), "budget", 1, 1, 12, { w: 3, h: 4 })).budget).toEqual([6, 10, 3, 4]);
  });

  it("keyboard: up and down swap with the neighbour in the column", () => {
    const up = nudge(board(), "week", 0, -1);
    noOverlaps(up);
    expect(pos(up).week).toEqual([0, 0, 6, 6]);
    expect(pos(up).today[1]).toBe(6);
    const down = nudge(board(), "today", 0, 1);
    noOverlaps(down);
    expect(pos(down).week[1]).toBe(0);
    expect(pos(down).today[1]).toBe(6);
    // Nothing above: unchanged.
    const b = board();
    expect(nudge(b, "today", 0, -1)).toBe(b);
    // Down and up again restores the layout.
    expect(pos(nudge(nudge(board(), "today", 0, 1), "today", 0, -1))).toEqual(pos(board()));
  });

  it("keyboard: left and right swap with the neighbour in the row, else step a column", () => {
    const left = nudge(board(), "recent", -1, 0);
    expect(pos(left).recent).toEqual([6, 10, 3, 6]);
    expect(pos(left).budget).toEqual([9, 10, 3, 6]);
    const right = nudge(board(), "today", 1, 0);
    expect(pos(right).agenda).toEqual([0, 0, 4, 10]);
    expect(pos(right).today).toEqual([4, 0, 8, 10]);
    // A lone widget steps one column; at the edge nothing happens.
    const lone = [it_("a", 3, 0, 4, 2)];
    expect(pos(nudge(lone, "a", 1, 0)).a).toEqual([4, 0, 4, 2]);
    const edge = [it_("a", 0, 0, 4, 2)];
    expect(nudge(edge, "a", -1, 0)).toBe(edge);
  });

  it("keyboard: grow and shrink by one column or row", () => {
    const b = board();
    expect(pos(grow(b, "week", 0, 1)).week).toEqual([0, 10, 6, 7]);
    const wider = grow(b, "week", 1, 0);
    noOverlaps(wider);
    expect(pos(wider).week).toEqual([0, 10, 7, 6]);
    expect(grow([it_("a", 0, 0, 3, 4)], "a", -1, 0, 12, { w: 3, h: 4 })[0]).toMatchObject({ w: 3 });
  });

  it("finds the first free place for a new widget", () => {
    expect(findFree(board(), 4, 4)).toEqual({ x: 0, y: 16 });
    expect(findFree([it_("a", 0, 0, 6, 4)], 6, 4)).toEqual({ x: 6, y: 0 });
    expect(findFree([], 20, 2)).toEqual({ x: 0, y: 0 });
    expect(layoutRows(board())).toBe(16);
  });

  it("reflows to six columns and to one, in reading order and without overlaps", () => {
    const six = reflow(board(), 6);
    noOverlaps(six);
    expect(six.every((i) => i.x + i.w <= 6)).toBe(true);
    // Nothing narrower than half the grid: „today“ gives up columns so „agenda“ still fits beside it.
    expect(pos(six).today).toEqual([0, 0, 3, 10]);
    expect(pos(six).agenda).toEqual([3, 0, 3, 10]);
    const order = readingOrder(six).map((i) => i.id);
    expect(order).toEqual(["today", "agenda", "week", "budget", "recent"]);
    // Minimum widths (given in 12 columns) are kept.
    const minWide = reflow(board(), 6, (i) => ({ w: i.id === "agenda" ? 12 : 1, h: 1 }));
    expect(pos(minWide).agenda).toEqual([0, 10, 6, 10]);
    // Three narrow widgets: two share a row, the third fills the next one.
    const shared = reflow(board(), 6, () => ({ w: 3, h: 1 }));
    noOverlaps(shared);
    expect(["week", "budget", "recent"].map((id) => pos(shared)[id])).toEqual([
      [0, 10, 3, 6],
      [3, 10, 3, 6],
      [0, 16, 6, 6],
    ]);
    // A small widget next to a wide one: two halves.
    const two = reflow([it_("a", 0, 0, 8, 4), it_("b", 8, 0, 4, 4)], 8);
    expect(pos(two)).toEqual({ a: [0, 0, 4, 4], b: [4, 0, 4, 4] });
    const one = reflow(board(), 1);
    expect(one.map((i) => [i.x, i.w])).toEqual(board().map(() => [0, 1]));
    expect(pos(one)).toMatchObject({ today: [0, 0, 1, 10], agenda: [0, 10, 1, 10], week: [0, 20, 1, 6] });
    const b = board();
    expect(reflow(b, 12)).toBe(b);
  });

  it("maps pixels to cells and back", () => {
    expect(columnsFor(1100)).toBe(12);
    expect(columnsFor(760)).toBe(12);
    expect(columnsFor(600)).toBe(6);
    expect(columnsFor(400)).toBe(1);
    expect(rowsPx(1)).toBe(28);
    expect(rowsPx(5)).toBe(5 * 28 + 4 * 12);
    // 12 columns in 1188 px: 88 px each with 12 px gaps.
    expect(rectPx(it_("a", 1, 2, 3, 1), 1188)).toEqual({ left: 100, top: 80, width: 288, height: 28 });
    expect(cellAt(105, 85, 1188)).toEqual({ col: 1, row: 2 });
    expect(cellAt(-20, -20, 1188)).toEqual({ col: 0, row: 0 });
    expect(cellAt(5000, 0, 1188).col).toBe(11);
  });
});
