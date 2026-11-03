import { describe, expect, it } from "vitest";
import { addMonths, dayTone, hoursLabel, monthGrid, weekNumber } from "./calendar";
import { isoDay } from "./format";

describe("calendar", () => {
  it("builds six Monday-first weeks around the month", () => {
    const g = monthGrid(2026, 8); // September 2026 starts on a Tuesday
    expect(g).toHaveLength(6);
    expect(isoDay(g[0][0])).toBe("2026-08-31");
    expect(isoDay(g[0][1])).toBe("2026-09-01");
    expect(isoDay(g[5][6])).toBe("2026-10-11");
    expect(weekNumber(g[0][0])).toBe(36);
    // A month starting on Monday begins in the first row.
    expect(isoDay(monthGrid(2026, 5)[0][0])).toBe("2026-06-01");
  });

  it("moves by months and clamps the day", () => {
    expect(isoDay(addMonths(new Date(2026, 0, 31), 1))).toBe("2026-02-28");
    expect(isoDay(addMonths(new Date(2026, 0, 15), -1))).toBe("2025-12-15");
  });

  it("tints past days below their own target", () => {
    const today = new Date(2026, 8, 24);
    expect(dayTone(new Date(2026, 8, 23), 300, 480, today)).toBe("below");
    expect(dayTone(new Date(2026, 8, 23), 480, 480, today)).toBe("met");
    expect(dayTone(new Date(2026, 8, 24), 0, 480, today)).toBe("none");
    // A day without a target (weekend, public holiday, vacation) is never below it.
    expect(dayTone(new Date(2026, 8, 20), 0, 0, today, "2026-09-01")).toBe("none");
    expect(dayTone(new Date(2026, 8, 21), 120, 0, today, "2026-09-01")).toBe("none");
    // A half vacation day or a short Friday: its own target counts, not the daily one.
    expect(dayTone(new Date(2026, 8, 18), 240, 240, today)).toBe("met");
    expect(dayTone(new Date(2026, 8, 18), 200, 240, today)).toBe("below");
    // Empty workdays count only from the first booking on.
    expect(dayTone(new Date(2026, 8, 22), 0, 480, today)).toBe("none");
    expect(dayTone(new Date(2026, 8, 22), 0, 480, today, "2026-09-21")).toBe("below");
    expect(dayTone(new Date(2026, 8, 18), 0, 480, today, "2026-09-21")).toBe("none");
  });

  it("formats hours as everywhere else (Settings → Zeiterfassung „Stunden als“)", () => {
    expect(hoursLabel(0)).toBe("");
    expect(hoursLabel(450)).toBe("7,50");
    expect(hoursLabel(480)).toBe("8,00");
    expect(hoursLabel(2)).toBe("0,03");
  });
});
