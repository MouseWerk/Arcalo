import { describe, expect, it } from "vitest";
import { autoCheckAllowed, checkIntervalMs, effectiveMode, isManaged, manualUpdate, progressLabel, progressValue, updateHint } from "./updates";
import type { UpdateStatus } from "./types";

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

const auto = (extra: Partial<UpdateStatus> = {}): UpdateStatus => ({
  ...status(true),
  available: { version: "1.9.1", notes: null, date: null, url: "" },
  policy: { mode: "auto", disabled: false, source_url: null, allow_github_fallback: true, pinned_version: null, install_window: null, check_interval_hours: 6, managed: [] },
  ...extra,
});
const info = { version: "1.9.1", notes: null, date: null, url: "" };

describe("policy and modes", () => {
  it("a policy that switches updates off stops automatic checks", () => {
    expect(autoCheckAllowed(auto(), true)).toBe(true);
    expect(autoCheckAllowed(auto({ policy: { ...auto().policy!, mode: "off" } }), true)).toBe(false);
    expect(autoCheckAllowed(auto({ policy: { ...auto().policy!, disabled: true } }), true)).toBe(false);
  });
  it("the interval follows the policy", () => {
    expect(checkIntervalMs(null)).toBe(6 * 3600_000);
    expect(checkIntervalMs(auto({ policy: { ...auto().policy!, check_interval_hours: 24 } }))).toBe(24 * 3600_000);
  });
  it("copies that cannot install themselves only notify", () => {
    expect(effectiveMode(auto())).toBe("auto");
    expect(effectiveMode(auto({ package: true }))).toBe("notify");
    expect(effectiveMode(auto({ portable: true }))).toBe("notify");
    expect(effectiveMode(status(true))).toBe("notify");
  });
  it("managed fields", () => {
    expect(isManaged(auto(), "mode")).toBe(false);
    expect(isManaged(auto({ policy: { ...auto().policy!, managed: ["mode", "source"] } }), "source")).toBe(true);
  });
});

describe("updateHint", () => {
  it("follows the background download to the ready hint", () => {
    expect(updateHint(auto(), info)).toEqual({ kind: "none" });
    expect(updateHint(auto({ download: { phase: "downloading", downloaded: 1, total: 4, percent: 25, error: null } }), info)).toEqual({ kind: "downloading", version: "1.9.1", percent: 25 });
    expect(updateHint(auto({ download: { phase: "paused", downloaded: 1, total: 4, percent: 25, error: null } }), info).kind).toBe("paused");
    expect(updateHint(auto({ download: { phase: "failed", downloaded: 0, total: null, percent: null, error: "x" } }), info)).toEqual({ kind: "failed", version: "1.9.1", error: "x" });
    expect(updateHint(auto({ ready: "1.9.1", install_now: true }), info)).toEqual({ kind: "ready", version: "1.9.1", installNow: true, window: null });
  });
  it("respects the install window, the notify mode and a missing offer", () => {
    const windowed = auto({ ready: "1.9.1", install_now: false, policy: { ...auto().policy!, install_window: "18:00–07:00" } });
    expect(updateHint(windowed, info)).toEqual({ kind: "ready", version: "1.9.1", installNow: false, window: "18:00–07:00" });
    expect(updateHint(auto({ ready: "1.9.1", policy: { ...auto().policy!, mode: "notify" } }), info)).toEqual({ kind: "none" });
    expect(updateHint(auto({ ready: "1.9.1" }), null)).toEqual({ kind: "none" });
    expect(updateHint(auto({ ready: "1.9.0" }), info)).toEqual({ kind: "none" });
  });
});
