import { describe, expect, it, vi } from "vitest";

// A fake backend: the automatic check is held open until `finishAuto` is called.
const calls: (boolean | undefined)[] = [];
let finishAuto: (() => void) | null = null;
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: async () => {} }));
vi.mock("../lib/api", () => ({
  api: {
    updateStatus: async () => ({ enabled: true, current_version: "1.11.0" }),
    updateCheck: (manual?: boolean) => {
      calls.push(manual);
      if (manual) return Promise.resolve(null);
      return new Promise((ok) => (finishAuto = () => ok(null)));
    },
  },
  on: async () => () => {},
}));

const { checkForUpdates, useUpdates } = await import("./Updates");
const { useApp } = await import("../store/app");

describe("checkForUpdates", () => {
  it("a click during an automatic check waits for it, then checks itself and reports", async () => {
    const auto = checkForUpdates(false);
    await vi.waitFor(() => expect(finishAuto).not.toBeNull());
    expect(useUpdates.getState()).toMatchObject({ phase: "checking", manualCheck: false });

    const manual = checkForUpdates(true);
    // The button shows the click is being handled.
    expect(useUpdates.getState().manualCheck).toBe(true);
    finishAuto!();
    await auto;
    await manual;

    expect(calls).toEqual([false, true]);
    expect(useApp.getState().toasts.map((t) => t.title)).toContain("Arcalo ist aktuell");
    expect(useUpdates.getState()).toMatchObject({ phase: "idle", manualCheck: false });
  });
});
