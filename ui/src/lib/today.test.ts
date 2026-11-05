import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkDay, today } from "./today";

// The store is shared by the module; subscribing goes through React's useSyncExternalStore, so
// the tests drive it through `checkDay` and the timer the first subscriber starts.
describe("today", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] }));
  afterEach(() => vi.useRealTimers());

  it("moves to the new day after midnight", () => {
    vi.setSystemTime(new Date(2026, 10, 5, 23, 59, 50));
    checkDay();
    expect(today()).toBe("2026-11-05");
    vi.setSystemTime(new Date(2026, 10, 6, 0, 0, 5));
    checkDay();
    expect(today()).toBe("2026-11-06");
  });

  it("stays on the day over the clock change", () => {
    vi.setSystemTime(new Date(2026, 9, 25, 1, 59));
    checkDay();
    expect(today()).toBe("2026-10-25");
    vi.setSystemTime(new Date(2026, 9, 25, 3, 30));
    checkDay();
    expect(today()).toBe("2026-10-25");
  });
});
