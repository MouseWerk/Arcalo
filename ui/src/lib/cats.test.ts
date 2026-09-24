import { describe, expect, it } from "vitest";
import { catsGrid, undeletableReason, weekGaps } from "./cats";
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
});

describe("weekGaps", () => {
  it("flags past workdays below target, not weekends or the running day", () => {
    const now = new Date(2026, 8, 24, 10); // Thursday morning
    const gaps = weekGaps([row(1, 0, 480, "1", null), row(2, 1, 360, "1", null)], week, now, 8, [1, 2, 3, 4, 5]);
    expect(gaps.map((g) => [g.day.getDate(), g.missingMinutes])).toEqual([
      [22, 120],
      [23, 480],
    ]);
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
