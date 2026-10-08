import { describe, expect, it } from "vitest";
import type { Page, SettingsView } from "../lib/types";
import { firstSteps, hideFirstSteps, showFirstSteps, startedOn, useFirstSteps, type Stored } from "./firststeps";
import { weekBars } from "../lib/dashboard";
import { weekGaps } from "../lib/cats";

const since = "2026-10-07T09:00:00.000Z";
const stored: Stored = { since, clicked: [], hidden: false };
const view = (p: { time?: boolean; ai?: boolean; outlook?: boolean; keys?: string[] } = {}) =>
  ({
    settings: {
      time: { enabled: p.time ?? true },
      ai: { enabled: p.ai ?? true },
      calendar: { outlook: p.outlook ?? false, sources: [] },
      providers: [{ id: "ollama", kind: "ollama", enabled: true, local: true, base_url: "http://localhost:11434" }],
    },
    provider_keys: p.keys ?? [],
  }) as unknown as SettingsView;
const page = (title: string, updated: string, daily: string | null = null) => ({ id: title.length, title, updated_at: updated, daily_date: daily }) as unknown as Page;

describe("Erste Schritte", () => {
  it("offers a note, today's note, a task and the calendar for a new workspace", () => {
    const steps = firstSteps(view(), [], stored, "2026-10-07");
    expect(steps.map((s) => s.id)).toEqual(["note", "today", "task", "calendar"]);
    expect(steps.every((s) => !s.done)).toBe(true);
  });

  it("ticks steps off from what happened: a page written, today's note, a followed step", () => {
    const pages = [page("Alt", "2026-10-01T08:00:00.000Z"), page("Neu", "2026-10-07T10:00:00.000Z"), page("2026-10-07", "2026-10-07T10:00:00.000Z", "2026-10-07")];
    const steps = firstSteps(view(), pages, { ...stored, clicked: ["task"] }, "2026-10-07");
    expect(Object.fromEntries(steps.map((s) => [s.id, s.done]))).toEqual({ note: true, today: true, task: true, calendar: false });
    // Only pages changed after the setup count (samples or an import do not).
    expect(firstSteps(view(), [pages[0]], stored, "2026-10-07")[0].done).toBe(false);
  });

  it("with a calendar: time tracking next, else the assistant, else nothing more", () => {
    expect(firstSteps(view({ outlook: true }), [], stored).at(-1)!.id).toBe("time");
    expect(firstSteps(view({ outlook: true, time: false }), [], stored).at(-1)!.id).toBe("ai");
    expect(firstSteps(view({ outlook: true, time: false, ai: false }), [], stored).map((s) => s.id)).toEqual(["note", "today", "task"]);
  });

  it("is shown after the first setup, hidden on request, and remembers the day", () => {
    showFirstSteps(new Date(2026, 9, 7, 11));
    expect(useFirstSteps.getState().stored).toMatchObject({ clicked: [], hidden: false });
    expect(startedOn()).toBe("2026-10-07");
    hideFirstSteps();
    expect(useFirstSteps.getState().stored?.hidden).toBe(true);
  });

  it("does not count the days before the first start as missing time", () => {
    const monday = new Date(2026, 9, 5);
    const days = [0, 1, 2, 3, 4].map((i) => ({ date: `2026-10-0${5 + i}`, booked_minutes: 0 }));
    const now = new Date(2026, 9, 9, 12);
    expect(weekBars(days, monday, 8, [1, 2, 3, 4, 5], now).bars.filter((b) => b.gap > 0).length).toBe(4);
    expect(weekBars(days, monday, 8, [1, 2, 3, 4, 5], now, undefined, "2026-10-07").bars.filter((b) => b.gap > 0).map((b) => b.date)).toEqual(["2026-10-07", "2026-10-08"]);
    const targets = [480, 480, 480, 480, 480, 0, 0];
    expect(weekGaps([], monday, now, targets).length).toBe(4);
    expect(weekGaps([], monday, now, targets, "2026-10-08").length).toBe(1);
  });
});
