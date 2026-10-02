import { describe, expect, it } from "vitest";
import { compactStep } from "./layout";

describe("side panel in compact windows", () => {
  it("closes when the window gets (or starts) compact and comes back when it gets wide", () => {
    expect(compactStep(null, 900, true, false)).toBe("close");
    expect(compactStep(1480, 990, true, false)).toBe("close");
    expect(compactStep(990, 950, true, false)).toBeNull(); // opened again by hand: stays
    expect(compactStep(950, 1200, false, true)).toBe("reopen");
    expect(compactStep(950, 1200, false, false)).toBeNull(); // closed by the user
    expect(compactStep(null, 1480, true, false)).toBeNull();
  });
});
