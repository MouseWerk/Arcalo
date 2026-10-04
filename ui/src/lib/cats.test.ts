import { describe, expect, it } from "vitest";
import { catsGrid, dayTargets, undeletableReason, weekGaps } from "./cats";
import type { TimeEntryRow } from "./types";

const week = new Date(2026, 8, 21); // Monday
const row = (id: number, day: number, minutes: number, vg: string | null, la: string | null, status = "draft"): TimeEntryRow =>
  ({
    id,
    netzplan_id: 1,
    vorgang_nr: vg,
    leistungsart: la,
    start_time: new Date(2026, 8, 21 + day, 9).toISOString(),
    end_time: null,
    duration_minutes: minutes,
    description: "",
    status_flag: status,
    source: "manual",
    project_code: "P",
    netzplan_nr: "NP-1",
    wbs_element: "W",
  }) as unknown as TimeEntryRow;

describe("catsGrid", () => {
  it("groups per Vorgang/LA with one column per weekday", () => {
    const { text, ids } = catsGrid([row(1, 0, 90, "1020", "DEV"), row(2, 2, 60, "1020", "DEV"), row(3, 0, 30, null, null), row(4, 1, 60, "1020", "DEV", "running"), row(5, 3, 60, "1020", "DEV", "exported")], week);
    expect(text).toBe("NP-1\t\t\t0,50\t\t\t\t\t\t\r\nNP-1\t1020\tDEV\t1,50\t\t1,00\t\t\t\t\r\n");
    expect(ids).toEqual([1, 2, 3]);
  });

  it("rounds so that every day adds up to its hours", () => {
    // Three lines of 20 minutes on Monday: 0,33 + 0,34 + 0,33 = 1,00 (not 0,99).
    const { text } = catsGrid([row(1, 0, 20, "1", "A"), row(2, 0, 20, "2", "A"), row(3, 0, 20, "3", "A"), row(4, 1, 50, "1", "A")], week);
    const cells = text.trim().split("\r\n").map((l) => l.split("\t")[3]);
    expect(cells).toEqual(["0,33", "0,34", "0,33"]);
    expect(text.split("\r\n")[0].split("\t")[4]).toBe("0,83");
  });
});

describe("dayTargets", () => {
  it("takes own weekday targets, holidays and absences into account", () => {
    const base = { daily: 8, workdays: [1, 2, 3, 4, 5] };
    expect(dayTargets(week, base)).toEqual([480, 480, 480, 480, 480, 0, 0]);
    // Friday 5 h, a holiday on Tuesday, vacation on Wednesday, half a day on Thursday.
    const t = dayTargets(week, { ...base, weekdayHours: [8, 8, 8, 8, 5, 4, 0], holidays: new Set(["2026-09-22"]), absences: [{ date: "2026-09-23", half: false }, { date: "2026-09-24", half: true }] });
    // Saturday has hours but is no workday.
    expect(t).toEqual([480, 0, 0, 240, 300, 0, 0]);
    // A week starting on Sunday.
    expect(dayTargets(new Date(2026, 8, 20), base)).toEqual([0, 480, 480, 480, 480, 480, 0]);
  });
});

describe("weekGaps", () => {
  it("flags past workdays below target, not weekends or the running day", () => {
    const now = new Date(2026, 8, 24, 10); // Thursday morning
    const gaps = weekGaps([row(1, 0, 480, "1", null), row(2, 1, 360, "1", null)], week, now, dayTargets(week, { daily: 8, workdays: [1, 2, 3, 4, 5] }));
    expect(gaps.map((g) => [g.day.getDate(), g.missingMinutes])).toEqual([
      [22, 120],
      [23, 480],
    ]);
  });

  it("does not flag holidays or absence days, and a half day by half", () => {
    const now = new Date(2026, 8, 26, 10); // Saturday
    const targets = dayTargets(week, { daily: 8, workdays: [1, 2, 3, 4, 5], holidays: new Set(["2026-09-21"]), absences: [{ date: "2026-09-22", half: true }, { date: "2026-09-23", half: false }] });
    const gaps = weekGaps([row(1, 1, 240, "1", null), row(2, 3, 480, "1", null), row(3, 4, 480, "1", null)], week, now, targets);
    expect(gaps).toEqual([]);
  });
});

describe("undeletableReason", () => {
  it("blocks exported and running entries only", () => {
    expect(undeletableReason("exported")).toBe("bereits exportiert");
    expect(undeletableReason("running")).toContain("stoppen");
    expect(undeletableReason("draft")).toBeNull();
    expect(undeletableReason("released")).toBeNull();
  });
});
