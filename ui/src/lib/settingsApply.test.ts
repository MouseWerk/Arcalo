import { beforeEach, describe, expect, it } from "vitest";
import { BURST_GAP, waitsForField, changedKeys, checkProxy, checkTime, checkUrl, continueBurst, isDestructive, loadCollapsed, pick, saveCollapsed, toggled, undoTimeout, workHoursOrder } from "./settingsApply";
import type { Settings } from "./types";

const base = {
  theme: "system",
  editor: { tab_size: 2 },
  time: { enabled: true },
  git_sync: { enabled: true },
  providers: [{ id: "a" }, { id: "b" }],
  backup_targets: { destinations: [{ id: "nas" }], local_latest_only: false },
  markdown_mirror: true,
} as unknown as Settings;

describe("instant apply", () => {
  it("finds the changed keys and restores them", () => {
    const next = { ...base, theme: "dark", editor: { tab_size: 4 } } as unknown as Settings;
    expect(changedKeys(base, next).sort()).toEqual(["editor", "theme"]);
    const undo = pick(base, ["theme", "editor"]);
    expect({ ...next, ...undo }).toEqual(base);
    // A copy: changing the restored value does not touch the original.
    (undo.editor as { tab_size: number }).tab_size = 9;
    expect((base.editor as unknown as { tab_size: number }).tab_size).toBe(2);
  });

  it("keystrokes in one field are one change, another field starts a new one", () => {
    const a = continueBurst(null, { assistant_instructions: "d" }, base, 1000, 1);
    const b = continueBurst(a, { assistant_instructions: "da" }, base, 1000 + BURST_GAP - 1, 2);
    expect(b).toBe(a);
    expect(b.before).toBe(base);
    const c = continueBurst(b, { pernr: "1" }, base, 1600, 3);
    expect(c).not.toBe(b);
    expect(c.id).toBe(3);
    const d = continueBurst(c, { pernr: "12" }, base, 1600 + BURST_GAP + 1, 4);
    expect(d).not.toBe(c);
  });

  it("switching time tracking or the Git sync off and removing things are destructive", () => {
    const off = (p: object) => isDestructive(base, { ...base, ...p } as Settings);
    expect(off({ time: { enabled: false } })).toBe(true);
    expect(off({ git_sync: { enabled: false } })).toBe(true);
    expect(off({ providers: [{ id: "a" }] })).toBe(true);
    expect(off({ backup_targets: { destinations: [], local_latest_only: false } })).toBe(true);
    expect(off({ markdown_mirror: false })).toBe(true);
    expect(off({ theme: "dark" })).toBe(false);
    expect(isDestructive({ ...base, time: { enabled: false } } as unknown as Settings, base)).toBe(false);
    expect(undoTimeout(true)).toBeGreaterThan(undoTimeout(false));
  });
});

describe("fields that apply on blur or Enter", () => {
  it("checks addresses", () => {
    expect(checkUrl("https://updates.firma.de/arcalo")).toBeNull();
    expect(checkUrl("http://[::1]:8080/x")).toBeNull();
    expect(checkUrl("")).toBeNull();
    expect(checkUrl("", { empty: false })).toBe("url");
    expect(checkUrl("updates.firma.de")).toBe("url");
    expect(checkUrl("ftp://x.de")).toBe("url");
    expect(checkUrl("https://x y.de")).toBe("url");
    expect(checkUrl("file:///C:/proxy.pac", { schemes: ["file"] })).toBe("url");
  });
  it("checks proxies", () => {
    expect(checkProxy("proxy.firma.de:8080")).toBeNull();
    expect(checkProxy("http://proxy.firma.de:8080")).toBeNull();
    expect(checkProxy("socks5://s.firma.de:1080", ["socks5"])).toBeNull();
    expect(checkProxy("proxy firma")).toBe("url");
    expect(checkProxy("socks5://s.firma.de:1080")).toBe("url");
  });
  it("checks times", () => {
    expect(checkTime("17:30")).toBeNull();
    expect(checkTime("7:05")).toBeNull();
    expect(checkTime("24:00")).toBe("time");
    expect(checkTime("17.30")).toBe("time");
  });
});

describe("menu groups", () => {
  beforeEach(() => localStorage.clear());
  it("remembers collapsed groups", () => {
    expect(loadCollapsed().size).toBe(0);
    const c = toggled(loadCollapsed(), "work");
    saveCollapsed(c);
    expect([...loadCollapsed()]).toEqual(["work"]);
    saveCollapsed(toggled(c, "work"));
    expect(loadCollapsed().size).toBe(0);
    localStorage.setItem("annalo.settings.navCollapsed", "{kaputt");
    expect(loadCollapsed().size).toBe(0);
  });
});

describe("states that wait for a field", () => {
  const net = (p: object) =>
    ({ network: { profiles: [{ id: "standard", mode: "system" }, { id: "firma", mode: "none", http_proxy: "", https_proxy: "", socks_proxy: "", pac_url: "", ...p }] } }) as unknown as Settings;
  it("a manual proxy or PAC without an address, a filing rule without tag or folder", () => {
    expect(waitsForField(net({ mode: "manual" }))).toBe("network");
    expect(waitsForField(net({ mode: "manual", socks_proxy: "socks5://s:1" }))).toBeNull();
    expect(waitsForField(net({ mode: "pac" }))).toBe("network");
    const rule = (key: string, folder: string) => ({ ...net({}), filing: { rules: [{ key, folder }] } }) as unknown as Settings;
    expect(waitsForField(rule("", "Kunden"))).toBe("filing");
    expect(waitsForField(rule("#", "Kunden"))).toBe("filing");
    expect(waitsForField(rule("kunde-x", " "))).toBe("filing");
    expect(waitsForField(rule("kunde-x", "Kunden/X"))).toBeNull();
    expect(waitsForField({ ...net({}), prices: [{ model: " " }] } as unknown as Settings)).toBe("prices");
  });
});


describe("workHoursOrder", () => {
  it.each([
    ["08:00", "18:00", null],
    ["7:30", "16:00", null],
    ["18:00", "08:00", "order"],
    ["09:00", "09:00", "order"],
    ["9 Uhr", "17:00", null],
  ])("%s – %s", (a, b, want) => expect(workHoursOrder(a, b)).toBe(want));
});
