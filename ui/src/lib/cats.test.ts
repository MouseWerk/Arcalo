import { afterEach, describe, expect, it } from "vitest";
import { catsDecimalSep, catsGrid, dayIsOver, undeletableReason, weekGaps } from "./cats";
import { formatPrefs, setFormatPrefs } from "./format";
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

  it("writes the decimal separator set for CATS", () => {
    const { text } = catsGrid([row(1, 0, 90, "1020", "DEV")], week, ".");
    expect(text).toBe("NP-1\t1020\tDEV\t1.50\t\t\t\t\t\t\r\n");
  });
});

describe("catsDecimalSep", () => {
  const before = { ...formatPrefs() };
  afterEach(() => setFormatPrefs(before));
  it("keeps the comma by default and can follow the number format", () => {
    expect(catsDecimalSep(undefined)).toBe(",");
    expect(catsDecimalSep("comma")).toBe(",");
    expect(catsDecimalSep("point")).toBe(".");
    setFormatPrefs({ lang: "en", numberFormat: "auto" });
    expect(catsDecimalSep("number")).toBe(".");
    expect(catsDecimalSep("comma")).toBe(",");
    setFormatPrefs({ lang: "en", numberFormat: "comma" });
    expect(catsDecimalSep("number")).toBe(",");
  });
});

describe("dayIsOver", () => {
  it("counts past days, and today from 18:00 on", () => {
    expect(dayIsOver("2026-09-23", new Date(2026, 8, 24, 10))).toBe(true);
    expect(dayIsOver("2026-09-24", new Date(2026, 8, 24, 17, 59))).toBe(false);
    expect(dayIsOver("2026-09-24", new Date(2026, 8, 24, 18))).toBe(true);
    expect(dayIsOver("2026-09-25", new Date(2026, 8, 24, 23))).toBe(false);
  });
});

describe("weekGaps", () => {
  it("flags days that are over below their target, not days without one or the running day", () => {
    const now = new Date(2026, 8, 24, 10); // Thursday morning
    const gaps = weekGaps([row(1, 0, 480, "1", null), row(2, 1, 360, "1", null)], week, now, [480, 480, 480, 480, 480, 0, 0]);
    expect(gaps.map((g) => [g.day.getDate(), g.missingMinutes])).toEqual([
      [22, 120],
      [23, 480],
    ]);
  });

  it("takes the backend's targets as they are (a holiday or absence 0, a half day half, a Saturday with own hours)", () => {
    const now = new Date(2026, 8, 27, 10); // Sunday
    const targets = [0, 240, 0, 480, 480, 120, 0];
    const gaps = weekGaps([row(1, 1, 240, "1", null), row(2, 3, 480, "1", null), row(3, 4, 480, "1", null)], week, now, targets);
    expect(gaps.map((g) => [g.day.getDate(), g.missingMinutes])).toEqual([[26, 120]]);
    expect(weekGaps([], week, now, [])).toEqual([]);
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
