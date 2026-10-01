import { describe, expect, it } from "vitest";
import { autoCheckAllowed, manualUpdate, progressLabel, progressValue } from "./updates";

const status = (enabled: boolean) => ({ enabled, current_version: "1.0.0", available: null });

describe("autoCheckAllowed", () => {
  it("needs an update key in the build", () => {
    expect(autoCheckAllowed(null, true)).toBe(false);
    expect(autoCheckAllowed(status(false), true)).toBe(false);
    expect(autoCheckAllowed(status(true), true)).toBe(true);
  });
  it("respects the setting (on by default)", () => {
    expect(autoCheckAllowed(status(true), false)).toBe(false);
    expect(autoCheckAllowed(status(true), undefined)).toBe(true);
  });
});

describe("download progress", () => {
  it("labels known and unknown sizes", () => {
    expect(progressLabel(null)).toMatch(/gestartet/);
    expect(progressLabel({ downloaded: 512, total: null, percent: null })).toBe("512 B geladen");
    expect(progressLabel({ downloaded: 2048, total: 4096, percent: 50 })).toMatch(/^50 % · 2 KB von 4 KB$/);
  });
  it("clamps the bar", () => {
    expect(progressValue(null)).toBe(0);
    expect(progressValue({ downloaded: 1, total: null, percent: null })).toBe(0);
    expect(progressValue({ downloaded: 1, total: 2, percent: 50 })).toBe(0.5);
    expect(progressValue({ downloaded: 3, total: 2, percent: 140 })).toBe(1);
  });
});

describe("manualUpdate", () => {
  it("installs itself unless portable or packaged", () => {
    expect(manualUpdate(null)).toBe(null);
    expect(manualUpdate(status(true))).toBe(null);
    expect(manualUpdate({ ...status(true), package: true })).toBe("package");
    expect(manualUpdate({ ...status(true), portable: true })).toBe("portable");
    expect(manualUpdate({ ...status(true), portable: true, package: true })).toBe("portable");
  });
});
