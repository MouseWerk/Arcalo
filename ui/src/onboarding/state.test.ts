import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings, SettingsView } from "../lib/types";

// The IPC layer is replaced by a fake that keeps one settings object.
const stored: { view: SettingsView; saves: Settings[]; status: Record<string, unknown>; completed: number; hints: number; resets: number; rebrands: number; opened: string[] } = {
  view: { settings: { locale: { language: "de" }, daily_target_hours: 8 } } as unknown as SettingsView,
  saves: [],
  status: {},
  completed: 0,
  hints: 0,
  resets: 0,
  rebrands: 0,
  opened: [],
};
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: async (url: string) => void stored.opened.push(url) }));
vi.mock("../lib/api", () => ({
  api: {
    settings: async () => stored.view,
    saveSettings: async (s: Settings) => {
      stored.saves.push(s);
      stored.view = { ...stored.view, settings: s };
      return stored.view;
    },
    onboardingStatus: async () => stored.status,
    onboardingHintShown: async () => void stored.hints++,
    rebrandNoticeShown: async () => void stored.rebrands++,
    onboardingComplete: async () => {
      stored.completed++;
      stored.view = { ...stored.view, settings: { ...stored.view.settings, onboarding: { completed_version: "1.6.0", completed_at: "2026-09-25T08:00:00Z" } } };
      return stored.view;
    },
    onboardingReset: async () => {
      stored.resets++;
      return stored.view;
    },
  },
  on: async () => () => {},
}));

const { useApp } = await import("../store/app");
const { writeSettings, settled } = await import("./write");
const { checkFirstRun, finishFirstRun, pauseForSettings, resetOnboarding, resumeFirstRun, startFirstRun, useFirstRun } = await import("./state");

beforeEach(() => {
  stored.saves = [];
  stored.completed = stored.hints = stored.resets = stored.rebrands = 0;
  stored.opened = [];
  useApp.setState({ settings: stored.view, toasts: [] });
  useFirstRun.setState({ phase: "off", paused: false, step: "language", workspace: null });
});

describe("first-run settings writes", () => {
  it("saves each answer on top of the newest settings, in order", async () => {
    const a = writeSettings((s) => ({ ...s, daily_target_hours: 7 }));
    const b = writeSettings((s) => ({ ...s, locale: { ...s.locale, language: "en" } }));
    await Promise.all([a, b]);
    await settled();
    expect(stored.saves).toHaveLength(2);
    // The second write saw the first one.
    expect(stored.saves[1].daily_target_hours).toBe(7);
    expect(stored.saves[1].locale.language).toBe("en");
    expect(useApp.getState().settings?.settings.locale.language).toBe("en");
  });
});

describe("first-run start and end", () => {
  it("plays the intro on a fresh install", async () => {
    stored.status = { intro: true, whats_new: false, existing: false };
    expect(await checkFirstRun()).toBe("intro");
    expect(useFirstRun.getState()).toMatchObject({ phase: "intro", mode: "fresh", step: "language" });
    expect(stored.hints).toBe(0);
  });

  it("after a reset the intro plays with the stored choices", async () => {
    stored.status = { intro: true, whats_new: false, existing: true };
    expect(await checkFirstRun()).toBe("intro");
    expect(useFirstRun.getState()).toMatchObject({ phase: "intro", mode: "rerun" });
  });

  it("shows the upgrade hint once and marks it shown", async () => {
    stored.status = { intro: false, whats_new: true };
    expect(await checkFirstRun()).toBe("hint");
    expect(stored.hints).toBe(1);
    expect(useFirstRun.getState().phase).toBe("off");
    const toast = useApp.getState().toasts.at(-1)!;
    expect(toast.title).toMatch(/1\.6/);
    toast.action!.run();
    expect(useFirstRun.getState()).toMatchObject({ phase: "intro", mode: "upgrade" });
  });

  it("tells an upgraded workspace once that Annalo is now Arcalo", async () => {
    stored.status = { intro: false, whats_new: false, rebrand_notice: true };
    expect(await checkFirstRun()).toBeNull();
    expect(stored.rebrands).toBe(1);
    const toasts = useApp.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].title).toMatch(/Annalo.*Arcalo/);
    toasts[0].action!.run();
    await Promise.resolve();
    expect(stored.opened).toEqual(["https://github.com/MouseWerk/Arcalo/releases/tag/v1.7.0"]);
    // Together with the 1.6 hint: both, the rename first.
    useApp.setState({ toasts: [] });
    stored.status = { intro: false, whats_new: true, rebrand_notice: true };
    expect(await checkFirstRun()).toBe("hint");
    expect(useApp.getState().toasts.map((x) => x.title)).toEqual([expect.stringMatching(/Arcalo/), expect.stringMatching(/1\.6/)]);
  });

  it("does nothing when completed", async () => {
    stored.status = { intro: false, whats_new: false };
    expect(await checkFirstRun()).toBeNull();
    expect(useFirstRun.getState().phase).toBe("off");
  });

  it("finishing stores the completion; a rerun can open the setup directly", async () => {
    startFirstRun("rerun", { intake: true, step: "backup" });
    expect(useFirstRun.getState()).toMatchObject({ phase: "intake", step: "backup" });
    await finishFirstRun();
    expect(stored.completed).toBe(1);
    expect(useFirstRun.getState().phase).toBe("off");
    expect(useApp.getState().settings?.settings.onboarding?.completed_version).toBe("1.6.0");
  });

  it("pauses for a settings section and resumes on the same step", () => {
    startFirstRun("fresh", { intake: true, step: "ai" });
    pauseForSettings("ai");
    expect(useFirstRun.getState()).toMatchObject({ paused: true, step: "ai", phase: "intake" });
    expect(useApp.getState().tabs.some((t) => t.kind === "settings")).toBe(true);
    expect(useApp.getState().toasts.some((t) => t.persistent)).toBe(true);
    resumeFirstRun();
    expect(useFirstRun.getState().paused).toBe(false);
    expect(useApp.getState().toasts.some((t) => t.persistent)).toBe(false);
  });

  it("reset asks first and only then clears the flags", async () => {
    useApp.setState({ confirm: async () => false } as never);
    await resetOnboarding();
    expect(stored.resets).toBe(0);
    useApp.setState({ confirm: async () => true } as never);
    await resetOnboarding();
    expect(stored.resets).toBe(1);
  });
});
