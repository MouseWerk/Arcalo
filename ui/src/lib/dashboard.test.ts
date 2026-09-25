import { describe, expect, it } from "vitest";
import {
  budgetForecast,
  configOf,
  defaultDashboard,
  editBoard,
  exportBoard,
  importBoard,
  loadDashboard,
  migrateLegacy,
  moveBoard,
  newBoard,
  newId,
  partKey,
  partsOf,
  presetWidgets,
  reviewDay,
  sizeFor,
  sizeName,
  taskQueryOf,
  toSaved,
  weekBars,
  WIDGET_KINDS,
  WIDGETS,
} from "./dashboard";
import { overlaps } from "./dashgrid";
import type { Board, DayOverview, GridWidget, LegacyWidget } from "./types";

const noOverlaps = (ws: GridWidget[]) => {
  for (const a of ws) for (const b of ws) if (a !== b) expect(overlaps(a, b), `${a.id}/${b.id}`).toBe(false);
};

describe("catalogue and presets", () => {
  it("knows every widget kind the backend keeps", () => {
    // Same list as WIDGET_KINDS in crates/annalo-core/src/settings.rs.
    expect([...WIDGET_KINDS].sort()).toEqual(["activity", "agenda", "budget", "calendar", "clock", "embed", "favorites", "focus", "links", "note", "pinned", "project", "proposal", "query", "recent", "review", "suggestions", "tasks", "timer", "today", "week"]);
    expect(new Set(WIDGET_KINDS).size).toBe(21);
    for (const k of WIDGET_KINDS) {
      const d = WIDGETS[k];
      expect(d.size.w >= d.min.w && d.size.h >= d.min.h, k).toBe(true);
    }
  });

  it("presets fill the grid without overlaps and with unique ids", () => {
    for (const name of ["start", "lead", "minimal"] as const) {
      const ws = presetWidgets(name);
      noOverlaps(ws);
      expect(ws.every((w) => w.x + w.w <= 12)).toBe(true);
      expect(new Set(ws.map((w) => w.id)).size).toBe(ws.length);
    }
    const again = presetWidgets("start", presetWidgets("start").map((w) => w.id));
    expect(again[0].id).toBe("today-2");
    const d = defaultDashboard();
    expect(d.boards.map((b) => b.id)).toEqual(["heute", "projekte"]);
    const ids = d.boards.flatMap((b) => b.widgets.map((w) => w.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("sizes S to XL respect a widget's minimum", () => {
    expect(sizeFor("clock", "s")).toEqual({ w: 3, h: 5 });
    expect(sizeFor("today", "s")).toEqual({ w: 6, h: 8 });
    expect(sizeName({ kind: "clock", w: 12, h: 9 })).toBe("xl");
    expect(sizeName({ kind: "clock", w: 5, h: 5 })).toBeNull();
  });

  it("fills missing settings from the defaults", () => {
    expect(configOf({ kind: "agenda", config: { days: 3 } })).toEqual({ days: 3, sources: [] });
    expect(configOf({ kind: "agenda" })).toEqual({ days: 1, sources: [] });
    expect(newId("note", ["note", "note-2"])).toBe("note-3");
  });
});

describe("migration of the old widget list", () => {
  const old: LegacyWidget[] = [
    { id: "today", kind: "today", size: "m" },
    { id: "week", kind: "week", size: "m" },
    { id: "timer", kind: "timer", size: "s" },
    { id: "budgets", kind: "budgets", size: "s" },
    { id: "recent", kind: "recent", size: "m" },
  ];

  it("keeps the widgets, their order and widths, and the note", () => {
    const d = migrateLegacy([...old, { id: "note", kind: "note", size: "l" }, { id: "x", kind: "wetter", size: "m" }], "Merkzettel");
    const ws = d.boards[0].widgets;
    expect(ws.map((w) => [w.id, w.kind])).toEqual([
      ["today", "today"],
      ["week", "week"],
      ["timer", "timer"],
      ["budgets", "budget"],
      ["recent", "recent"],
      ["note", "note"],
    ]);
    noOverlaps(ws);
    // Two medium widgets side by side, then the small ones, as the old four-column grid had them.
    expect(ws.slice(0, 2).map((w) => [w.x, w.y, w.w])).toEqual([
      [0, 0, 6],
      [6, 0, 6],
    ]);
    expect(ws[2]).toMatchObject({ x: 0, w: 3 });
    expect(ws[3]).toMatchObject({ x: 3, w: 3, config: expect.objectContaining({ count: 4 }) });
    expect(ws[5]).toMatchObject({ x: 0, w: 12 });
    expect(d.notes).toEqual({ note: "Merkzettel" });
    expect(d.active).toBe("heute");
  });

  it("loads saved boards, moves old lists and gives a new start page the defaults", () => {
    expect(loadDashboard(null).boards).toHaveLength(2);
    expect(loadDashboard({ version: 0, boards: [], active: "", notes: {} }).boards).toHaveLength(2);
    const moved = loadDashboard({ version: 0, boards: [], active: "", notes: {}, widgets: old, note: "" });
    expect(moved.boards[0].widgets).toHaveLength(5);
    // An explicitly emptied old start page stays empty.
    expect(loadDashboard({ version: 0, boards: [], active: "", notes: {}, widgets: [] }).boards[0].widgets).toEqual([]);
    const saved = loadDashboard({ version: 2, boards: [{ id: "a", name: "A", widgets: [{ id: "w", kind: "clock", x: 20, y: 0, w: 1, h: 1 }, { id: "z", kind: "wetter", x: 0, y: 0, w: 1, h: 1 }] }], active: "b", notes: {} });
    expect(saved.active).toBe("a");
    expect(saved.boards[0].widgets).toEqual([{ id: "w", kind: "clock", x: 10, y: 0, w: 2, h: 3 }]);
    expect(toSaved({ ...moved, widgets: old, note: "x" })).not.toHaveProperty("widgets");
  });
});

describe("board edits", () => {
  const boards = (): Board[] => [
    { id: "a", name: "A", widgets: presetWidgets("start") },
    { id: "b", name: "B", widgets: [{ id: "note", kind: "note", x: 0, y: 0, w: 4, h: 6 }] },
  ];

  it("adds with ids unique across boards, removes and closes the gap", () => {
    const bs = boards();
    const added = editBoard(bs[0], bs, { type: "add", kind: "note" });
    expect(added.widgets.at(-1)).toMatchObject({ id: "note-2", kind: "note", x: 0, y: 20 });
    const removed = editBoard(bs[0], bs, { type: "remove", id: "today" });
    expect(removed.widgets.find((w) => w.id === "week")).toMatchObject({ y: 0 });
  });

  it("duplicates next to the original or at the first free place, with its own settings", () => {
    const b: Board = { id: "x", name: "X", widgets: [{ id: "q", kind: "query", x: 0, y: 0, w: 4, h: 4, config: { query: { source: "tasks" } } }] };
    const d = editBoard(b, [b], { type: "duplicate", id: "q" });
    expect(d.widgets[1]).toMatchObject({ id: "query", x: 4, y: 0, w: 4, h: 4 });
    expect(d.widgets[1].config).toEqual(d.widgets[0].config);
    expect(d.widgets[1].config).not.toBe(d.widgets[0].config);
    const full: Board = { id: "x", name: "X", widgets: [{ id: "w", kind: "week", x: 0, y: 0, w: 12, h: 6 }] };
    expect(editBoard(full, [full], { type: "duplicate", id: "w" }).widgets[1]).toMatchObject({ x: 0, y: 6 });
  });

  it("changes settings and title, applies a preset", () => {
    const bs = boards();
    const c = editBoard(bs[1], bs, { type: "config", id: "note", config: { mode: "text" }, title: "Zettel" });
    expect(c.widgets[0]).toMatchObject({ title: "Zettel", config: { mode: "text" } });
    const p = editBoard(bs[1], bs, { type: "preset", name: "minimal" });
    expect(p.widgets.map((w) => w.kind)).toEqual(["clock", "timer", "focus", "tasks", "note"]);
    // Its own ids may be reused; the other board's may not.
    expect(p.widgets.find((w) => w.kind === "note")!.id).toBe("note");
    expect(p.widgets.find((w) => w.kind === "clock")!.id).toBe("clock");
  });

  it("names, orders and ids new boards", () => {
    const bs = boards();
    const n = newBoard(bs, " Mein Board ", "minimal");
    expect(n).toMatchObject({ id: "mein-board", name: "Mein Board" });
    expect(newBoard([...bs, n], "Mein Board", null).id).toBe("mein-board-2");
    expect(moveBoard(bs, "b", -1).map((b) => b.id)).toEqual(["b", "a"]);
    expect(moveBoard(bs, "a", -1)).toBe(bs);
  });

  it("exports and imports a board with new ids and its notes", () => {
    const bs = boards();
    const text = exportBoard(bs[1], { note: "Hallo", other: "nein" });
    const r = importBoard(text, bs);
    if ("error" in r) throw new Error(r.error);
    expect(r.board.name).toBe("B");
    expect(r.board.id).toBe("b-2");
    expect(r.board.widgets[0].id).toBe("note-2");
    expect(r.notes).toEqual({ "note-2": "Hallo" });
    expect(importBoard("{", bs)).toEqual({ error: "dash.import.notJson" });
    expect(importBoard('{"format":"x"}', bs)).toEqual({ error: "dash.import.wrongFormat" });
    expect(importBoard('{"format":"annalo-dashboard","board":{"widgets":[{"kind":"wetter"}]}}', bs)).toEqual({ error: "dash.import.noWidgets" });
    // Out-of-grid positions are clamped and overlaps resolved.
    const odd = importBoard(JSON.stringify({ format: "annalo-dashboard", board: { name: "O", widgets: [{ kind: "clock", x: 99, y: 0, w: 3, h: 4 }, { kind: "clock", x: 9, y: 0, w: 3, h: 4 }] } }), []);
    if ("error" in odd) throw new Error(odd.error);
    noOverlaps(odd.board.widgets);
    expect(odd.board.widgets[0]).toMatchObject({ x: 9, y: 0 });
  });
});

describe("data parts", () => {
  const today = new Date(2026, 8, 23, 10); // Wednesday
  it("asks for what each widget shows", () => {
    expect(partsOf({ kind: "today" }, today)).toEqual([{ kind: "today" }, { kind: "timer_refs" }]);
    expect(partsOf({ kind: "today", config: { blocks: { timer: false } } }, today)).toEqual([{ kind: "today" }]);
    expect(partsOf({ kind: "agenda", config: { days: 99 } }, today)).toEqual([{ kind: "agenda", days: 31 }]);
    expect(partsOf({ kind: "week" }, today)).toEqual([{ kind: "week", week_start: "2026-09-21" }]);
    expect(partsOf({ kind: "project" }, today)).toEqual([{ kind: "project", netzplan_id: null }]);
    expect(partsOf({ kind: "note" }, today)).toEqual([]);
    expect(partsOf({ kind: "note", config: { mode: "page", page: 4 } }, today)).toEqual([{ kind: "page", id: 4 }]);
    expect(partsOf({ kind: "calendar" }, today)).toEqual([{ kind: "month", from: "2026-08-31", to: "2026-10-11" }]);
    expect(partsOf({ kind: "clock" }, today)).toEqual([]);
    const tasks = partsOf({ kind: "tasks", config: { due: "today", tag: "#Kunde", priority: 5 } }, today)[0];
    expect(tasks).toEqual({ kind: "tasks", filter: { status: "open", due: "today", tag: "Kunde", page_id: null, priority: 2 }, limit: 40 });
    expect(taskQueryOf({})).toMatchObject({ due: "any", tag: null, priority: 0 });
    // Two budget widgets with different settings load the budgets once.
    expect(partKey(partsOf({ kind: "budget", config: { count: 2 } }, today)[0])).toBe(partKey(partsOf({ kind: "budget" }, today)[0]));
  });

  it("reviews yesterday or the last workday", () => {
    const monday = new Date(2026, 8, 21, 9);
    expect(reviewDay(monday, [1, 2, 3, 4, 5], true)).toBe("2026-09-18");
    expect(reviewDay(monday, [1, 2, 3, 4, 5], false)).toBe("2026-09-20");
    expect(reviewDay(today, [1, 2, 3, 4, 5], true)).toBe("2026-09-22");
  });
});

describe("budget forecast", () => {
  const today = new Date(2026, 8, 23);
  it("runs out at the pace of the last four weeks", () => {
    // 40 h planned, 30 h booked, 14 h in 28 days: 0.5 h a day, 10 h left, 20 days.
    const f = budgetForecast({ planned_hours: 40, booked_hours: 30 }, 14, 28, today);
    expect(f).toMatchObject({ state: "ok", perDay: 0.5, remaining: 10, days: 20, date: "2026-10-13" });
    const soon = budgetForecast({ planned_hours: 40, booked_hours: 38 }, 28, 28, today);
    expect(soon).toMatchObject({ state: "soon", days: 2, date: "2026-09-25" });
    // Partial days round up.
    expect(budgetForecast({ planned_hours: 10, booked_hours: 9 }, 56, 28, today).date).toBe("2026-09-24");
  });

  it("knows used up, idle and unplanned budgets", () => {
    expect(budgetForecast({ planned_hours: 40, booked_hours: 41 }, 10, 28, today).state).toBe("used");
    expect(budgetForecast({ planned_hours: 40, booked_hours: 40 }, 10, 28, today).state).toBe("used");
    expect(budgetForecast({ planned_hours: 40, booked_hours: 10 }, 0, 28, today)).toMatchObject({ state: "idle", days: null, date: null });
    expect(budgetForecast({ planned_hours: 0, booked_hours: 5 }, 5, 28, today).state).toBe("unplanned");
    expect(budgetForecast({ planned_hours: 10, booked_hours: 0 }, 5, 0, today).state).toBe("idle");
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
