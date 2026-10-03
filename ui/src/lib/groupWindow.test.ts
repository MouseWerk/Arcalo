import { describe, expect, it } from "vitest";
import { groupWindow } from "./groupWindow";

describe("groupWindow", () => {
  const rows = Array.from({ length: 1000 }, () => 40);

  it("renders the rows in view plus the margin, with spacers for the others", () => {
    // The group starts at 100 px; the view shows 2000..2800 with 400 px margin.
    const w = groupWindow(rows, 100, 2000, 800, 400);
    expect(w.from).toBe(37); // (2000 - 100 - 400) / 40 = 37.5
    expect(w.to).toBe(78); // rows starting before 2000 - 100 + 800 + 400 = 3100
    expect(w.before).toBe(37 * 40);
    expect(w.before + (w.to - w.from) * 40 + w.after).toBe(1000 * 40);
  });

  it("renders nothing of a group that is not placed yet, or far away", () => {
    expect(groupWindow(rows, null, 0, 800, 400)).toEqual({ from: 0, to: 0, before: 0, after: 40000 });
    const below = groupWindow(rows, 100_000, 0, 800, 400);
    expect(below.to - below.from).toBe(0);
    expect(below.before + below.after).toBe(40000);
  });

  it("uses measured heights", () => {
    const mixed = [40, 400, 40, 40];
    const w = groupWindow(mixed, 0, 0, 100, 0);
    expect([w.from, w.to]).toEqual([0, 2]);
    expect(w.after).toBe(80);
  });
});
