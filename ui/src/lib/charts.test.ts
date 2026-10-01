import { describe, expect, it } from "vitest";
import { arcs, barPath, bars, heatGrid, heatStart, levelOf, linePoints, niceTicks, pathOf, sparkline } from "./charts";

describe("chart geometry", () => {
  it("picks nice axis steps", () => {
    expect(niceTicks(28, 4)).toEqual([0, 10, 20, 30]);
    expect(niceTicks(7.5, 3)).toEqual([0, 2.5, 5, 7.5]);
    expect(niceTicks(100, 4)).toEqual([0, 25, 50, 75, 100]);
    expect(niceTicks(0.3, 3)).toEqual([0, 0.1, 0.2, 0.3]);
    expect(niceTicks(0)).toEqual([0, 1]);
    expect(niceTicks(Number.NaN)).toEqual([0, 1]);
  });

  it("lays out bars on the baseline with a gap between them", () => {
    const b = bars([10, 5, 0], 300, 100, 10);
    expect(b.map((x) => [x.h, x.y])).toEqual([[100, 0], [50, 50], [0, 100]]);
    expect(b[0].w).toBe(28);
    expect(b[1].x - (b[0].x + b[0].w)).toBeGreaterThanOrEqual(2);
    // Many bars get thinner, never wider than their slot minus the gap.
    const many = bars(Array(50).fill(1), 200, 50, 1);
    expect(many[0].w).toBeLessThanOrEqual(200 / 50 - 2 + 1e-9);
    expect(bars([], 100, 100, 1)).toEqual([]);
    expect(bars([-5], 100, 100, 10)[0].h).toBe(0);
  });

  it("rounds only the data end of a bar", () => {
    expect(barPath({ x: 0, y: 10, w: 20, h: 40, cx: 10 })).toBe("M0 50V14Q0 10 4 10H16Q20 10 20 14V50Z");
    expect(barPath({ x: 0, y: 0, w: 20, h: 0, cx: 10 })).toBe("");
  });

  it("draws lines from left to right", () => {
    const pts = linePoints([0, 5, 10], 100, 50, 10);
    expect(pts).toEqual([[0, 50], [50, 25], [100, 0]]);
    expect(pathOf(pts)).toBe("M0 50L50 25L100 0");
    expect(linePoints([3], 100, 50, 6)).toEqual([[50, 25]]);
  });

  it("splits a donut by share, starting at twelve o'clock", () => {
    const a = arcs([{ key: "a", value: 3 }, { key: "b", value: 1 }, { key: "c", value: 0 }], 50, 30);
    expect(a.map((x) => x.share)).toEqual([0.75, 0.25, 0]);
    expect(a[0].path.startsWith("M")).toBe(true);
    expect(a[0].path).toContain("A50 50 0 1 1"); // more than half: the large arc
    expect(a[1].path).toContain("A50 50 0 0 1");
    expect(a[2].path).toBe("");
    // The middle of the first slice (0..270°, from twelve o'clock) is at the lower right… left.
    expect(a[0].mid[0]).toBeGreaterThan(0);
    const one = arcs([{ key: "x", value: 2 }], 50, 30);
    expect(one[0].share).toBe(1);
    expect(one[0].path.match(/A/g)?.length).toBe(4); // a full ring
    expect(arcs([{ key: "x", value: 0 }], 50, 30)).toEqual([]);
  });

  it("draws a sparkline with the zero line when the balance crosses it", () => {
    const s = sparkline([-60, 0, 120], 200, 44, 2);
    expect(s.path.startsWith("M0 42")).toBe(true);
    expect(s.zero).toBeCloseTo(2 + 40 - (60 / 180) * 40, 1);
    expect(s.last).toEqual([200, 2]);
    expect(sparkline([10, 20], 100, 40).zero).toBeNull();
    expect(sparkline([], 100, 40)).toEqual({ path: "", zero: null, last: null });
  });
});

describe("heatmap grid", () => {
  it("levels by quartiles of the largest value", () => {
    expect([0, 1, 3, 6, 8].map((v) => levelOf(v, 8))).toEqual([0, 1, 2, 3, 4]);
    expect(levelOf(5, 0)).toBe(0);
  });

  it("starts on a Monday 53 weeks back and stops after today's week", () => {
    const today = new Date(2026, 9, 1); // Thursday 1 October 2026
    const start = heatStart(today);
    expect(start.getDay()).toBe(1);
    expect(start.toDateString()).toBe(new Date(2025, 8, 29).toDateString());
    const g = heatGrid(start, today, new Map([["2026-09-30", 4], ["2026-10-01", 2], ["2025-10-01", 1]]));
    expect(g.cols).toBe(53);
    expect(g.cells.length).toBe(53 * 7);
    const wed = g.cells.find((c) => c.date === "2026-09-30")!;
    expect([wed.col, wed.row, wed.level, wed.future]).toEqual([52, 2, 4, false]);
    expect(g.cells.find((c) => c.date === "2026-10-01")!.level).toBe(2);
    expect(g.cells.find((c) => c.date === "2026-10-02")!.future).toBe(true);
    expect(g.max).toBe(4);
    // Month labels: over the first full week of a month, at least three columns apart.
    // September's label (two days of it) gives way to October's, over October's first full week.
    expect(g.months[0]).toEqual({ col: 1, month: 9, year: 2025 });
    const nov = g.months.find((m) => m.month === 10 && m.year === 2025)!;
    expect(g.cells.find((c) => c.date === "2025-11-03")!.col).toBe(nov.col);
    expect(g.months.every((m, i) => i === 0 || m.col - g.months[i - 1].col >= 3)).toBe(true);
  });
});
