import { describe, expect, it } from "vitest";
import { copyLegacyStorage, currentThemeId, mailLinkId, STORAGE_COPIED } from "./legacy";
import { taskSegments } from "./tasks";
import { findTheme } from "./themes";
import { exportBoard, importBoard } from "./dashboard";
import { parseSettingsImport } from "./settingsio";
import type { Board, Settings } from "./types";

/** A Storage in memory (the test environment has none). */
function memoryStorage(entries: Record<string, string> = {}): Storage {
  const m = new Map(Object.entries(entries));
  return {
    get length() {
      return m.size;
    },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
  };
}

describe("names of 1.14 and earlier", () => {
  it("copies the localStorage keys of 1.14 once, keeping newer values and the old keys", () => {
    const s = memoryStorage({
      "annalo.sidebar": "true",
      "annalo.panel-w": "320",
      "annalo.calendar.view": "week",
      "arcalo.panel-w": "400",
      "fremd.key": "x",
    });
    expect(copyLegacyStorage(s)).toBe(2);
    expect(s.getItem("arcalo.sidebar")).toBe("true");
    expect(s.getItem("arcalo.calendar.view")).toBe("week");
    expect(s.getItem("arcalo.panel-w")).toBe("400");
    expect(s.getItem("annalo.sidebar")).toBe("true");
    expect(s.getItem(STORAGE_COPIED)).toBe("1");
    // Once: a later change under the old name (an older version started again) is not copied.
    s.setItem("annalo.sidebar", "false");
    s.setItem("annalo.tabs", "[]");
    expect(copyLegacyStorage(s)).toBe(0);
    expect(s.getItem("arcalo.sidebar")).toBe("true");
    expect(s.getItem("arcalo.tabs")).toBeNull();
    // No storage (blocked): nothing happens.
    expect(copyLegacyStorage(undefined)).toBe(0);
  });

  it("reads links to e-mails of both schemes", () => {
    expect(mailLinkId("annalo-mail://k3v9x2qa")).toBe("k3v9x2qa");
    expect(mailLinkId("arcalo-mail://K3V9/")).toBe("k3v9");
    expect(mailLinkId("annalo-mail://../x")).toBeNull();
    expect(mailLinkId("https://example.com")).toBeNull();
    const segs = taskSegments("Prüfen [E-Mail: Alt](annalo-mail://old1) und [E-Mail: Neu](arcalo-mail://new2)");
    expect(segs.filter((s) => s.kind === "mail").map((s) => (s as { id: string }).id)).toEqual(["old1", "new2"]);
  });

  it("maps the built-in themes' old ids", () => {
    expect(currentThemeId("annalo-dark")).toBe("arcalo-dark");
    expect(currentThemeId("nord-light")).toBe("nord-light");
    expect(findTheme("annalo-dark", undefined, true).id).toBe("arcalo-dark");
    expect(findTheme("annalo-light", undefined, false).id).toBe("arcalo-light");
  });

  it("imports settings and boards exported by 1.14", () => {
    const current = { theme: "system", git_sync: { enabled: false } } as unknown as Settings;
    const r = parseSettingsImport(JSON.stringify({ format: "annalo-settings", version: 1, settings: { theme: "dark" } }), current);
    expect(r.error).toBeFalsy();
    expect(r.settings?.theme).toBe("dark");
    const board: Board = { id: "b", name: "Alt", widgets: [{ id: "note", kind: "note", x: 0, y: 0, w: 4, h: 3 }] } as unknown as Board;
    const old = exportBoard(board, { note: "Hallo" }).replace('"arcalo-dashboard"', '"annalo-dashboard"').replace('"app": "arcalo"', '"app": "annalo"');
    const imported = importBoard(old, []);
    if ("error" in imported) throw new Error(imported.error);
    expect(imported.board.name).toBe("Alt");
    expect(imported.notes).toEqual({ [imported.board.widgets[0].id]: "Hallo" });
  });
});
