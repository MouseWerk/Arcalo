import { describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { useApp } from "../store/app";
import type { Settings, SettingsView } from "./types";
import { TIME_COMMANDS, TIME_SHORTCUTS, TIME_TABS, TIME_TOOLS, isZeitLine, timeTrackingEnabled, timeTrackingOn, useTimeTracking } from "./timetracking";
import { COMMANDS } from "./keymap";
import {
  WIDGET_KINDS,
  defaultDashboard,
  editBoard,
  galleryKinds,
  newBoard,
  partsOf,
  presetWidgets,
  shownWidgets,
  widgetShown,
  withHidden,
  PRESETS,
} from "./dashboard";
import { overlaps } from "./dashgrid";
import { buildSuggestions } from "./suggestions";
import { quickItems } from "./quicksearch";
import { slashItems } from "../editor/extensions";
import type { GridWidget } from "./types";

const withTime = (on: boolean | undefined) => ({ settings: { time: { enabled: on } } }) as unknown as SettingsView;

describe("time tracking switch", () => {
  it("is on unless switched off (older settings without the field count as on)", () => {
    expect(timeTrackingOn(null)).toBe(true);
    expect(timeTrackingOn({} as Settings)).toBe(true);
    expect(timeTrackingOn({ time: {} } as Settings)).toBe(true);
    expect(timeTrackingOn({ time: { enabled: true } } as Settings)).toBe(true);
    expect(timeTrackingOn({ time: { enabled: false } } as Settings)).toBe(false);
  });

  it("follows the store, also for the hook, and re-renders when it changes", async () => {
    useApp.setState({ settings: withTime(false) });
    expect(timeTrackingEnabled()).toBe(false);
    const seen: boolean[] = [];
    const Probe = () => {
      seen.push(useTimeTracking());
      return null;
    };
    const el = document.createElement("div");
    const root = createRoot(el);
    await act(async () => root.render(createElement(Probe)));
    await act(async () => useApp.setState({ settings: withTime(true) }));
    expect(seen.at(0)).toBe(false);
    expect(seen.at(-1)).toBe(true);
    expect(timeTrackingEnabled()).toBe(true);
    await act(async () => root.unmount());
  });

  it("names what it hides", () => {
    expect([...TIME_TABS]).toEqual(["timesheet", "projects"]);
    expect(TIME_COMMANDS).toEqual(expect.arrayContaining(["timer", "timesheet", "week-proposal", "projects"]));
    expect(COMMANDS.some((c) => TIME_SHORTCUTS.has(c.id))).toBe(true);
    expect(TIME_TOOLS).toEqual(["log_time", "budget_status", "time_summary"]);
    expect(isZeitLine("/zeit NP-1 1h")).toBe(true);
    expect(isZeitLine("  /time 2h")).toBe(true);
    expect(isZeitLine("/zeitplan")).toBe(false);
  });

  it("drops /zeit from the slash menu", () => {
    const on = () => {};
    const opts = { onTemplate: on, onImage: on, onAi: on, onSummary: on, onDrawing: on, onFile: on };
    expect(slashItems(opts, true).some((i) => i.id === "zeit")).toBe(true);
    expect(slashItems(opts, false).some((i) => i.id === "zeit")).toBe(false);
  });

  it("leaves bookings, budgets and the weekly report out of the suggestions", () => {
    const base = { now: new Date(2026, 8, 25, 9), page: { title: "Kunde", openTasks: 2, reference: "NP-8801/1020" }, overdue: 0, dueToday: 0, openTasks: 3, gapDays: ["Mo"], budget: "NP-8801", hasBookings: true };
    expect(buildSuggestions(base).some((x) => x.kind === "budget" || x.kind === "time")).toBe(true);
    const off = buildSuggestions({ ...base, time: false });
    expect(off.some((x) => x.kind === "budget" || x.kind === "time" || x.kind === "report")).toBe(false);
    expect(off.some((x) => x.text.includes("Offene Aufgaben in „Kunde“"))).toBe(true);
  });

  it("quick search offers no timer, timesheet, /zeit or time entries", () => {
    const hits = [{ kind: "time_entry", id: 1, netzplan_nr: "NP-1", vorgang_nr: null, snippet: "x" }] as never;
    const ctx = { hits, recent: [], timerRunning: true, lastRef: "NP-1" };
    expect(quickItems("/zeit NP-1 1h", ctx)[0].action.type).toBe("zeit");
    expect(quickItems("/zeit NP-1 1h", { ...ctx, time: false }).some((i) => i.action.type === "zeit")).toBe(false);
    expect(quickItems("", ctx).some((i) => i.action.type === "timer_stop")).toBe(true);
    expect(quickItems("", { ...ctx, time: false }).some((i) => i.action.type.startsWith("timer"))).toBe(false);
    expect(quickItems("np", { ...ctx, time: false }).some((i) => i.action.type === "timesheet")).toBe(false);
  });
});

describe("dashboard without time tracking", () => {
  const TIME = ["week", "budget", "timer", "proposal"];

  it("the gallery offers no time widgets (nor the project widget)", () => {
    expect(galleryKinds(true)).toEqual(WIDGET_KINDS);
    const off = galleryKinds(false);
    for (const k of [...TIME, "project"]) expect(off).not.toContain(k);
    expect(off).toEqual(expect.arrayContaining(["today", "agenda", "tasks", "review", "focus", "note"]));
    expect(widgetShown("project", false)).toBe(true);
    expect(widgetShown("budget", false)).toBe(false);
  });

  it("boards keep the time widgets but show the rest without holes", () => {
    const board = defaultDashboard().boards[0];
    expect(board.widgets.some((w) => TIME.includes(w.kind))).toBe(true);
    expect(shownWidgets(board.widgets, true)).toBe(board.widgets);
    const shown = shownWidgets(board.widgets, false);
    expect(shown.some((w) => TIME.includes(w.kind))).toBe(false);
    expect(shown.length).toBe(board.widgets.filter((w) => !TIME.includes(w.kind)).length);
    for (const a of shown) for (const b of shown) if (a !== b) expect(overlaps(a, b)).toBe(false);
  });

  it("a layout edited while hidden gets the time widgets back without overlaps", () => {
    const all = defaultDashboard().boards[0].widgets;
    const shown = shownWidgets(all, false);
    // Move „Heute“ to the bottom: whatever was hidden must not overlap anything afterwards.
    const edited = shown.map((w) => (w.kind === "today" ? { ...w, y: 30 } : w));
    const back = withHidden(all, edited, false);
    expect(back.map((w) => w.id).sort()).toEqual(all.map((w) => w.id).sort());
    for (const a of back) for (const b of back) if (a.id !== b.id) expect(overlaps(a, b)).toBe(false);
    expect(withHidden(all, edited, true)).toBe(edited);
  });

  it("presets fall back to widgets without time; „Projektleitung“ becomes tasks, meetings, activity", () => {
    for (const p of PRESETS) {
      const on = presetWidgets(p.name, [], true);
      const off = presetWidgets(p.name, [], false);
      expect(off.length).toBeGreaterThan(2);
      expect(off.some((w) => TIME.includes(w.kind) || w.kind === "project")).toBe(false);
      for (const a of off) for (const b of off) if (a !== b) expect(overlaps(a, b)).toBe(false);
      for (const w of off) expect(w.x + w.w).toBeLessThanOrEqual(12);
      expect(on).not.toEqual(off);
    }
    const lead = presetWidgets("lead", [], false).map((w) => w.kind);
    expect(lead).toEqual(expect.arrayContaining(["tasks", "agenda", "activity"]));
    const fresh = defaultDashboard(false);
    expect(fresh.boards.flatMap((b) => b.widgets).some((w) => TIME.includes(w.kind))).toBe(false);
    const b = newBoard(fresh.boards, "Leitung", "lead", false);
    expect(b.widgets.some((w) => TIME.includes(w.kind))).toBe(false);
    const reset = editBoard(fresh.boards[0], fresh.boards, { type: "preset", name: "start", time: false });
    expect(reset.widgets.some((w) => TIME.includes(w.kind))).toBe(false);
  });

  it("loads nothing for hidden widgets and no timer for „Heute“", () => {
    const today = new Date(2026, 8, 24);
    const w = (kind: string): GridWidget => ({ id: kind, kind, x: 0, y: 0, w: 4, h: 4, config: {} });
    expect(partsOf(w("budget"), today, undefined, false)).toEqual([]);
    expect(partsOf(w("budget"), today)).toEqual([{ kind: "budgets" }]);
    expect(partsOf(w("today"), today).map((p) => p.kind)).toEqual(["today", "timer_refs"]);
    expect(partsOf(w("today"), today, undefined, false).map((p) => p.kind)).toEqual(["today"]);
  });
});
