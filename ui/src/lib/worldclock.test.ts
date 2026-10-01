import { describe, expect, it } from "vitest";
import { cityOf, offsetLabel, uses12h, zoneTime } from "./worldclock";

describe("world clock", () => {
  it("names, offsets and the day in another zone", () => {
    expect(cityOf("America/New_York")).toBe("New York");
    expect(cityOf("UTC")).toBe("UTC");
    expect(uses12h("en-US")).toBe(true);
    expect(uses12h("de-DE") || uses12h("en-GB")).toBe(false);
    // 23:30 in Berlin (summer time) is 17:30 in New York and 06:30 tomorrow in Tokyo.
    const now = new Date("2026-07-01T21:30:00Z");
    const ny = zoneTime(now, "America/New_York", "de-DE", false, "Europe/Berlin");
    expect([ny.time, ny.offset, ny.dayShift]).toEqual(["17:30", -360, 0]);
    const tokyo = zoneTime(now, "Asia/Tokyo", "en-US", true, "Europe/Berlin");
    expect([tokyo.time.replace(/\s/g, " "), tokyo.offset, tokyo.dayShift]).toEqual(["6:30 AM", 420, 1]);
    expect(zoneTime(now, "Asia/Kolkata", "de-DE", false, "Europe/Berlin").offset).toBe(210);
    expect([offsetLabel(-360), offsetLabel(210), offsetLabel(0)]).toEqual(["−6 h", "+3:30 h", "±0 h"]);
  });
});
