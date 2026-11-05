// Whole-object settings writes (the theme switch, the language, the settings view) apply their
// change to the settings as stored when they run: one never takes back another made meanwhile.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings, SettingsView } from "./types";

type Pending = { settings: Settings; base?: Settings; done: () => void };
const pending: Pending[] = [];
let disk: Settings;
vi.mock("./api", async (orig) => ({
  ...(await orig<typeof import("./api")>()),
  api: {
    settings: async () => ({ settings: structuredClone(disk) }),
    // Held until `done()`: a save on its way while another change is made.
    saveSettings: (settings: Settings, base?: Settings) =>
      new Promise<SettingsView>((ok) =>
        pending.push({
          settings,
          base,
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

  it("a write names the copy it changed, so the core keeps what it stored meanwhile", async () => {
    const write = writeSettings((cur) => ({ ...cur, theme: "dark" }));
    await settle();
    expect(pending[0].base).toEqual(start);
    expect(pending[0].settings.theme).toBe("dark");
    await landAll();
    await write;
  });

  it("only the given paths are taken from the view's copy", () => {
    const stored = { ...start, theme: "dark" } as Settings;
    const stale = { ...start, editor: { ...start.editor, smart_quotes: true } } as Settings;
    expect(withPaths(stored, stale, ["editor.smart_quotes"])).toEqual({ ...start, theme: "dark", editor: { smart_quotes: true, tab_size: 2 } });
  });
});

// R5D-3: a save of the whole settings object without the copy it was made from takes back what
// the core stored meanwhile (a calendar discovery, „Termine in Outlook eintragen“, a save of the
// settings page while the PAC script is read at the start). Every save goes through `writeSettings`.
describe("every settings save of the desktop names the copy it changed", () => {
  it("api.saveSettings is called only by writeSettings and the setup's writer", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = path.resolve(__dirname, "..");
    const files = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) return e.name === "mobile" ? [] : files(p);
        return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
      });
    const callers = files(src)
      .filter((f) => /\bapi\.saveSettings\(/.test(fs.readFileSync(f, "utf8")))
      .map((f) => path.relative(src, f).split(path.sep).join("/"))
      .sort();
    expect(callers).toEqual(["lib/settingsWrite.ts", "onboarding/write.ts"]);
  });
});
