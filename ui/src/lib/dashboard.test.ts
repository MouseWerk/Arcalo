import { describe, expect, it } from "vitest";
import { layoutReducer, newWidgetId, weekBars, WIDGET_KINDS } from "./dashboard";
import type { DayOverview, Widget } from "./types";

const W = (id: string, kind: Widget["kind"] = "note", size: Widget["size"] = "s"): Widget => ({ id, kind, size });
const ids = (ws: Widget[]) => ws.map((w) => w.id);

describe("dashboard layout", () => {
  const base = [W("today", "today", "m"), W("week", "week", "m"), W("timer", "timer")];

  it("adds widgets with unique ids and the kind's default size", () => {
    let ws = layoutReducer(base, { type: "add", kind: "week" });
    expect(ws.at(-1)).toEqual({ id: "week-2", kind: "week", size: "m" });
    ws = layoutReducer(ws, { type: "add", kind: "week" });
    expect(ws.at(-1)!.id).toBe("week-3");
    expect(layoutReducer([], { type: "add", kind: "budgets" })).toEqual([W("budgets", "budgets", "s")]);
    expect(newWidgetId("note", [W("note"), W("note-3")])).toBe("note-2");
    expect(WIDGET_KINDS).toHaveLength(10);
  });

  it("removes and resizes by id, leaving unknown ids alone", () => {
    expect(ids(layoutReducer(base, { type: "remove", id: "week" }))).toEqual(["today", "timer"]);
    expect(layoutReducer(base, { type: "remove", id: "nope" })).toBe(base);
    const r = layoutReducer(base, { type: "resize", id: "timer", size: "l" });
    expect(r[2].size).toBe("l");
    expect(base[2].size).toBe("s");
    expect(layoutReducer(base, { type: "resize", id: "timer", size: "s" })).toBe(base);
  });

  it("moves one step with the arrow buttons, clamped at the ends", () => {
    expect(ids(layoutReducer(base, { type: "move", id: "timer", delta: -1 }))).toEqual(["today", "timer", "week"]);
    expect(ids(layoutReducer(base, { type: "move", id: "today", delta: 1 }))).toEqual(["week", "today", "timer"]);
    expect(layoutReducer(base, { type: "move", id: "today", delta: -1 })).toBe(base);
    expect(layoutReducer(base, { type: "move", id: "timer", delta: 1 })).toBe(base);
  });

  it("drops a dragged widget in front of another or at the end", () => {
    expect(ids(layoutReducer(base, { type: "drop", id: "timer", before: "today" }))).toEqual(["timer", "today", "week"]);
    expect(ids(layoutReducer(base, { type: "drop", id: "today", before: null }))).toEqual(["week", "timer", "today"]);
    expect(ids(layoutReducer(base, { type: "drop", id: "today", before: "timer" }))).toEqual(["week", "today", "timer"]);
    // No-ops keep the same array (no re-render, nothing to save).
    expect(layoutReducer(base, { type: "drop", id: "today", before: "week" })).toBe(base);
    expect(layoutReducer(base, { type: "drop", id: "week", before: "week" })).toBe(base);
    expect(layoutReducer(base, { type: "drop", id: "timer", before: null })).toBe(base);
    expect(layoutReducer(base, { type: "drop", id: "x", before: "week" })).toBe(base);
  });

  it("reset copies the given widgets", () => {
    const r = layoutReducer([], { type: "reset", widgets: base });
    expect(r).toEqual(base);
    expect(r[0]).not.toBe(base[0]);
  });
});

describe("week bars", () => {
  const monday = new Date(2026, 8, 21); // Mo 21.09.2026
  const day = (date: string, booked_minutes: number): DayOverview => ({ date, booked_minutes, note_id: null, has_note: false, open_tasks: 0 });
  const days = [day("2026-09-21", 480), day("2026-09-22", 360), day("2026-09-23", 600), day("2026-09-24", 120), day("2026-09-26", 60)];

  it("scales to the longest day and counts gaps on past workdays only", () => {
    const w = weekBars(days, monday, 8, [1, 2, 3, 4, 5], new Date(2026, 8, 24, 15, 0));
    expect(w.bars.map((b) => b.label)).toEqual(["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"]);
    expect(w.bars.map((b) => b.minutes)).toEqual([480, 360, 600, 120, 0, 60, 0]);
    // 10 h on Wednesday sets the scale; the 8 h target line sits at 80 %.
    expect(w.targetLine).toBeCloseTo(0.8);
    expect(w.bars[2].fill).toBe(1);
    expect(w.bars[0].fill).toBeCloseTo(0.8);
    // Tuesday misses 2 h; today (Thursday) and the future do not count yet.
    expect(w.bars.map((b) => b.gap)).toEqual([0, 120, 0, 0, 0, 0, 0]);
    expect(w.gapMinutes).toBe(120);
    expect(w.bookedMinutes).toBe(1620);
    expect(w.targetMinutes).toBe(5 * 480);
    expect(w.bars[3].today).toBe(true);
    expect([w.bars[4].future, w.bars[5].workday, w.bars[5].future]).toEqual([true, false, true]);
  });

  it("counts a whole past week and handles no target", () => {
    const w = weekBars(days, monday, 8, [1, 2, 3, 4, 5], new Date(2026, 9, 1));
    // Thu 6 h and Fri 8 h missing, plus Tue 2 h; Saturday has no target.
    expect(w.gapMinutes).toBe(120 + 360 + 480);
    const none = weekBars([], monday, 0, [1, 2, 3, 4, 5], new Date(2026, 9, 1));
    expect(none.gapMinutes).toBe(0);
    expect(none.bars.every((b) => b.fill === 0)).toBe(true);
    expect(none.targetLine).toBe(0);
  });
});
