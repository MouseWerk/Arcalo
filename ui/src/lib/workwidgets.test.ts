import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setLang } from "./i18n";
import { configOf, galleryKinds, partsOf, partTopics, shownWidgets, widgetShown, WIDGET_KINDS } from "./dashboard";
import { chartData, chartQueryOf, countdown, dayWithCountdown, daysUntil, deadlineSources, heatRange, mergeDeadlines, nextChange, pointLabel, registerDeadlineSource, sortTeam, workParts, type ChartData, type Deadline, type TeamMember } from "./workwidgets";
import type { GridWidget } from "./types";

beforeEach(() => setLang("en"));
afterEach(() => setLang("en"));

const W = (kind: string, config: Record<string, unknown> = {}, x = 0, y = 0): GridWidget => ({ id: kind, kind, x, y, w: 4, h: 4, config });
const today = new Date(2026, 9, 1, 10, 0);

describe("work widget parts", () => {
  it("maps each widget to its backend part", () => {
    expect(partsOf(W("balance"), today)).toEqual([{ kind: "balance", weeks: 12 }]);
    expect(partsOf(W("vacation"), today)).toEqual([{ kind: "vacation" }]);
    expect(partsOf(W("deadlines", { days: 30, off: ["tasks"] }), today)).toEqual([{ kind: "deadlines", days: 30, off: ["tasks"] }]);
    expect(partsOf(W("deadlines"), today)).toEqual([{ kind: "deadlines", days: 14, off: [] }]);
    expect(partsOf(W("team", { sources: ["outlook:a"] }), today)).toEqual([{ kind: "team", sources: ["outlook:a"] }]);
    expect(partsOf(W("next_meeting"), today)).toEqual([{ kind: "agenda", days: 14 }]);
    expect(partsOf(W("mail_flags"), today)).toEqual([]);
    expect(partsOf(W("kanban"), today)).toEqual([]);
    expect(partsOf(W("kanban", { page: 7 }), today)).toEqual([{ kind: "kanban", page: 7 }]);
    expect(partsOf(W("heatmap", { mode: "hours" }), today)).toEqual([{ kind: "heatmap", mode: "hours", from: "2025-09-29", to: "2026-10-01" }]);
    expect(heatRange(today)).toEqual({ from: "2025-09-29", to: "2026-10-01" });
    // A new chart has no page yet: nothing to load.
    expect(partsOf(W("chart", configOf({ kind: "chart", config: {} })), today)).toEqual([]);
    expect(partsOf(W("chart", { chart: { source: "pages", page: 3, group: "status" } }), today)).toEqual([
      { kind: "chart", chart: { source: "pages", page: 3, group: "status", value: "count", field: "", weeks: 12 } },
    ]);
    expect(workParts("today", {}, today, true)).toBeNull();
  });

  it("knows what reloads them", () => {
    expect(partTopics({ kind: "balance", weeks: 12 })).toEqual(["entries", "absences"]);
    expect(partTopics({ kind: "chart", chart: chartQueryOf({ chart: { source: "bookings" } }) })).toEqual(["entries"]);
    expect(partTopics({ kind: "heatmap", mode: "notes", from: "", to: "" })).toEqual(["pages"]);
    expect(partTopics({ kind: "team", sources: [] })).toEqual(["calendar"]);
  });

  it("hides time widgets and charts of the bookings while time tracking is off", () => {
    expect(widgetShown("balance", false)).toBe(false);
    expect(widgetShown("vacation", false)).toBe(false);
    expect(widgetShown("deadlines", false)).toBe(true);
    expect(widgetShown("chart", false, { chart: { source: "bookings" } })).toBe(false);
    expect(widgetShown("chart", false, { chart: { source: "pages" } })).toBe(true);
    expect(partsOf(W("balance"), today, [1, 2, 3, 4, 5], false)).toEqual([]);
    expect(partsOf(W("heatmap", { mode: "hours" }), today, [1, 2, 3, 4, 5], false)[0]).toMatchObject({ mode: "notes" });
    const board = [W("chart", { chart: { source: "bookings" } }, 0, 0), W("deadlines", {}, 0, 4)];
    expect(shownWidgets(board, false).map((w) => [w.kind, w.y])).toEqual([["deadlines", 0]]);
    // The gallery: no time widgets, and flagged mails only where Outlook can be asked.
    expect(galleryKinds(false, true)).not.toContain("balance");
    expect(galleryKinds(true)).not.toContain("mail_flags");
    expect(galleryKinds(true, true)).toEqual(WIDGET_KINDS);
  });

  it("normalizes chart settings", () => {
    expect(chartQueryOf({})).toEqual({ source: "pages", page: null, group: "status", value: "count", field: "", weeks: 12 });
    expect(chartQueryOf({ chart: { source: "bookings", group: "status", weeks: 500 } })).toMatchObject({ group: "netzplan", weeks: 104 });
    expect(chartQueryOf({ chart: { source: "bookings", group: "week", weeks: 8 } })).toMatchObject({ group: "week", weeks: 8 });
  });
});

describe("work widget data", () => {
  const week = (d: string) => `CW ${d}`;
  const month = (d: string) => `M ${d.slice(0, 7)}`;

  it("maps chart points: labels in the UI language, minutes as hours, option colors", () => {
    const d: ChartData = {
      unit: "minutes",
      total: 300,
      ordered: true,
      points: [
        { label: "2026-09-21", detail: "", value: 120, color: null, date: "2026-09-21" },
        { label: "2026-09-28", detail: "", value: 180, color: null, date: "2026-09-28" },
      ],
    };
    expect(chartData(d, "week", week, month)).toEqual([
      { key: "2026-09-21", label: "CW 2026-09-21", value: 2, color: undefined },
      { key: "2026-09-28", label: "CW 2026-09-28", value: 3, color: undefined },
    ]);
    const pages: ChartData = {
      unit: "count",
      total: 3,
      ordered: true,
      points: [
        { label: "Offen", detail: "", value: 2, color: "grün", date: null },
        { label: "", detail: "", value: 1, color: null, date: null },
      ],
    };
    expect(chartData(pages, "status", week, month)).toEqual([
      { key: "Offen", label: "Offen", value: 2, color: "#22c55e" },
      { key: "__none", label: "No value", value: 1, color: "var(--series-rest)" },
    ]);
    setLang("de");
    expect(pointLabel({ label: "", date: null }, "status", week, month)).toBe("Ohne Wert");
    expect(pointLabel({ label: "__other", date: null }, "status", week, month)).toBe("Übrige");
    expect(pointLabel({ label: "__yes", date: null }, "fertig", week, month)).toBe("Ja");
    expect(pointLabel({ label: "2026-09", date: null }, "fällig", week, month)).toBe("M 2026-09");
  });

  it("counts down to due dates", () => {
    expect(daysUntil("2026-10-04", "2026-10-01")).toBe(3);
    expect(daysUntil("2026-10-26", "2026-10-24")).toBe(2); // across the change to winter time
    expect(countdown("2026-10-04", "2026-10-01")).toEqual({ text: "in 3 days", tone: "soon" });
    expect(countdown("2026-10-11", "2026-10-01")).toEqual({ text: "in 10 days", tone: "later" });
    expect(countdown("2026-10-02", "2026-10-01").text).toBe("tomorrow");
    expect(countdown("2026-10-01", "2026-10-01")).toEqual({ text: "today", tone: "today" });
    expect(dayWithCountdown("2026-10-02", "2026-10-01", "Tomorrow")).toBe("Tomorrow");
    expect(dayWithCountdown("2026-10-04", "2026-10-01", "Sun, 04.10.")).toBe("Sun, 04.10. · in 3 days");
    expect(countdown("2026-09-29", "2026-10-01")).toEqual({ text: "2 days overdue", tone: "overdue" });
    setLang("de");
    expect(countdown("2026-10-04", "2026-10-01").text).toBe("in 3 Tagen");
    expect(countdown("2026-09-30", "2026-10-01").text).toBe("seit 1 Tag überfällig");
  });

  it("merges due dates of UI sources by date", async () => {
    const d = (key: string, date: string, source = "tasks", priority = 0): Deadline => ({ key, source, title: key, detail: "", date, page_id: null, ordinal: null, url: null, priority });
    const off = registerDeadlineSource("jira", async () => [d("ABC-1", "2026-10-02", "jira")]);
    expect(deadlineSources().map((s) => s[0])).toEqual(["jira"]);
    const ui = await deadlineSources()[0][1]({ today: "2026-10-01", until: "2026-10-15" });
    const merged = mergeDeadlines([d("a", "2026-10-03"), d("b", "2026-10-02", "tasks", 2)], [...ui, d("a", "2026-10-03")]);
    expect(merged.map((x) => x.key)).toEqual(["b", "ABC-1", "a"]);
    off();
    expect(deadlineSources()).toEqual([]);
  });

  it("sorts the team and finds the next change", () => {
    const m = (name: string, state: TeamMember["state"], until: string | null = null): TeamMember => ({ source: name, name, color: "", free_busy: false, state, until, next: null, title: "" });
    const team = [m("Zoe", "free"), m("Anna", "busy", "2026-10-01T09:30:00Z"), m("Jörg", "oof", "2026-10-03T00:00:00Z"), m("Ben", "free", "2026-10-01T11:00:00Z")];
    expect(sortTeam(team).map((x) => x.name)).toEqual(["Jörg", "Anna", "Ben", "Zoe"]);
    expect(nextChange(team)).toBe(Date.parse("2026-10-01T09:30:00Z"));
    expect(nextChange([m("x", "free")])).toBeNull();
  });
});
