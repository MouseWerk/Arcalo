import { beforeEach, describe, expect, it, vi } from "vitest";

// The full app on Android: its updater reports the version the app was updated from.
const seen = vi.fn(async () => ({}));
const desktopSeen = vi.fn(async () => {});
let status = { current: "1.9.0", updated_from: "1.8.2" as string | null };
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: async () => {} }));
vi.mock("../lib/capabilities", async (orig) => ({ ...(await orig<typeof import("../lib/capabilities")>()), onAndroid: () => true }));
vi.mock("../lib/api", () => ({
  api: { androidUpdateStatus: async () => status, androidWhatsNewSeen: seen, updateWhatsNewSeen: desktopSeen },
  on: async () => () => {},
}));

const { showAndroidWhatsNew, useUpdates } = await import("./Updates");

describe("„Neu in Arcalo“ in the full app on Android", () => {
  beforeEach(() => {
    seen.mockClear();
    useUpdates.setState({ whatsNew: null });
  });

  it("shows the highlights after an update of the app, and marks them shown on Android", async () => {
    status = { current: "1.9.0", updated_from: "1.8.2" };
    await showAndroidWhatsNew();
    const w = useUpdates.getState().whatsNew;
    expect(w?.versions.map((v) => v.version)).toEqual(["1.9.0"]);
    expect(w?.seen).toBe("1.9.0");
    expect(seen).not.toHaveBeenCalled();
  });

  it("an update without highlights shows nothing and is marked shown; no update shows nothing", async () => {
    status = { current: "1.9.1", updated_from: "1.9.0" };
    await showAndroidWhatsNew();
    expect(useUpdates.getState().whatsNew).toBeNull();
    expect(seen).toHaveBeenCalledTimes(1);
    status = { current: "1.9.1", updated_from: null };
    await showAndroidWhatsNew();
    expect(useUpdates.getState().whatsNew).toBeNull();
    expect(seen).toHaveBeenCalledTimes(1);
    expect(desktopSeen).not.toHaveBeenCalled();
  });
});
