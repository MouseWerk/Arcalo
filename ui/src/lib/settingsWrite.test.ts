// Whole-object settings writes (the theme switch, the language, the settings view) apply their
// change to the settings as stored when they run: one never takes back another made meanwhile.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings, SettingsView } from "./types";

type Pending = { settings: Settings; done: () => void };
const pending: Pending[] = [];
let disk: Settings;
vi.mock("./api", async (orig) => ({
  ...(await orig<typeof import("./api")>()),
  api: {
    settings: async () => ({ settings: structuredClone(disk) }),
    // Held until `done()`: a save on its way while another change is made.
    saveSettings: (settings: Settings) =>
      new Promise<SettingsView>((ok) =>
        pending.push({
          settings,
          done: () => {
            disk = structuredClone(settings);
            ok({ settings: structuredClone(settings) } as SettingsView);
          },
        }),
      ),
  },
}));

const { useApp } = await import("../store/app");
const { writeSettings } = await import("./settingsWrite");
const { toggleTheme } = await import("./actions");
const { withPaths } = await import("./settingsApply");

const start = { theme: "light", locale: { language: "de" }, editor: { smart_quotes: false, tab_size: 2 } } as unknown as Settings;
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};
/** Lets every save that is or becomes pending land, in order. */
async function landAll() {
  await settle();
  while (pending.length) {
    pending.shift()!.done();
    await settle();
  }
}

beforeEach(() => {
  pending.length = 0;
  disk = structuredClone(start);
  useApp.setState({ settings: { settings: structuredClone(start) } as SettingsView });
  document.documentElement.dataset.theme = "light";
});

describe("settings writes", () => {
  it("a change saved while another is on its way keeps that one", async () => {
    const editor = writeSettings((cur) => ({ ...cur, editor: { ...cur.editor, smart_quotes: true } }));
    const theme = toggleTheme();
    await landAll();
    await Promise.all([editor, theme]);
    expect(disk.theme).toBe("dark");
    expect(disk.editor.smart_quotes).toBe(true);
    expect(useApp.getState().settings?.settings).toEqual(disk);
  });

  it("the theme switch keeps a change saved right before it", async () => {
    const theme = toggleTheme();
    const editor = writeSettings((cur) => ({ ...cur, editor: { ...cur.editor, tab_size: 4 } }));
    await landAll();
    await Promise.all([theme, editor]);
    expect(disk).toMatchObject({ theme: "dark", editor: { tab_size: 4 } });
  });

  it("only the given paths are taken from the view's copy", () => {
    const stored = { ...start, theme: "dark" } as Settings;
    const stale = { ...start, editor: { ...start.editor, smart_quotes: true } } as Settings;
    expect(withPaths(stored, stale, ["editor.smart_quotes"])).toEqual({ ...start, theme: "dark", editor: { smart_quotes: true, tab_size: 2 } });
  });
});
