import { afterEach, describe, expect, it } from "vitest";
import { ANDROID, DESKTOP, caps, onAndroid, setCapabilities } from "./capabilities";
import { navFor } from "../views/SettingsView";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ids = (c: typeof DESKTOP) => navFor(c).flatMap((g) => g.items.map((x) => x.id));
const labelOf = (c: typeof DESKTOP, id: string) =>
  navFor(c)
    .flatMap((g) => g.items)
    .find((x) => x.id === id)?.label;

describe("what the app shows where it runs", () => {
  afterEach(() => setCapabilities(DESKTOP));

  it("is the desktop until the backend answered", () => {
    expect(caps()).toEqual(DESKTOP);
    expect(onAndroid()).toBe(false);
  });

  it("marks the page on Android and tells the real one from the simulation", () => {
    setCapabilities(ANDROID);
    expect(document.documentElement.classList.contains("platform-android")).toBe(true);
    expect(onAndroid()).toBe(true);
    setCapabilities({ ...ANDROID, simulated: true });
    expect(onAndroid()).toBe(false);
    setCapabilities(DESKTOP);
    expect(document.documentElement.classList.contains("platform-android")).toBe(false);
  });

  it("keeps every settings section on the desktop", () => {
    const desk = ids(DESKTOP);
    for (const id of ["voice", "security", "desktop", "backup", "about", "keyboard"]) expect(desk, id).toContain(id);
    expect(labelOf(DESKTOP, "desktop")).toBe("nav.desktop");
  });

  it("drops the sections Android does not have and names the desktop one after what is left", () => {
    const android = ids(ANDROID);
    expect(android).not.toContain("voice");
    expect(android).not.toContain("security");
    // Git sync, quick capture, the reminder and the keyboard stay.
    for (const id of ["backup", "desktop", "keyboard", "appearance", "about"]) expect(android, id).toContain(id);
    expect(labelOf(ANDROID, "desktop")).toBe("nav.captureReminders");
    expect(navFor(ANDROID).every((g) => g.items.length > 0)).toBe(true);
  });

  it("agrees with the backend's Android capabilities", () => {
    // src-tauri/src/platform.rs, Capabilities::android(): the same flags, camelCase.
    const src = readFileSync(join(__dirname, "../../../src-tauri/src/platform.rs"), "utf8");
    const body = src.slice(src.indexOf("pub fn android() -> Capabilities"), src.indexOf("pub fn current() -> Capabilities"));
    const flags = Object.fromEntries([...body.matchAll(/^\s+([a-z_]+): (true|false),$/gm)].map((m) => [m[1].replace(/_([a-z])/g, (_, c) => c.toUpperCase()), m[2] === "true"]));
    const ours = Object.fromEntries(Object.entries(ANDROID).filter(([, v]) => typeof v === "boolean"));
    expect(Object.keys(flags).length).toBeGreaterThan(10);
    expect(flags).toEqual(ours);
  });
});
