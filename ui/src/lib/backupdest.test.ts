import { describe, expect, it } from "vitest";
import { translate, type TKey } from "./i18n";
import { canAdd, kindKey, mergeBackups, newDestination, problemText, samePath, statusLine, type DestState, type DestView } from "./backupdest";

const de = (key: TKey, vars?: Record<string, string | number>) => translate("de", key, vars);
const en = (key: TKey, vars?: Record<string, string | number>) => translate("en", key, vars);

const state = (p: Partial<DestState> = {}): DestState => ({
  last_ok: null,
  last_file: null,
  last_bytes: null,
  last_ms: null,
  last_error: null,
  last_error_at: null,
  pending_since: null,
  failures: 0,
  missed: 0,
  next_try: null,
  warned: false,
  reached: false,
  ...p,
});

const view = (p: Partial<DestView>): DestView => ({
  id: "d1",
  path: "\\\\nas\\team\\Arcalo",
  enabled: true,
  info: { kind: "unc", server: "nas", share: "team", cloud: null },
  state: state(),
  health: "waiting",
  busy: false,
  folder: "laptop",
  ...p,
});

describe("backup destinations", () => {
  it("adds only new, non-empty folders (separators and case do not matter)", () => {
    const list = [newDestination("\\\\NAS\\Team\\Arcalo\\")];
    expect(list[0]).toMatchObject({ id: "", enabled: true, keep: 14, keep_days: 0, attachments: true, markdown: false });
    expect(samePath("//nas/team/arcalo", "\\\\NAS\\Team\\Arcalo\\")).toBe(true);
    expect(canAdd("//nas/team/arcalo", list)).toBe(false);
    expect(canAdd("   ", list)).toBe(false);
    expect(canAdd("Z:\\Sicherung", list)).toBe(true);
  });

  it("names kinds and problems in both languages", () => {
    expect(de(kindKey({ kind: "unc", server: "a", share: "b", cloud: null }))).toBe("Netzwerkfreigabe");
    expect(en(kindKey({ kind: "cloud", server: null, share: null, cloud: "OneDrive" }))).toBe("Cloud folder");
    const denied = { problem: "denied" as const, message: "Keine Berechtigung", path: "\\\\nas\\team" };
    expect(problemText(de, denied, "windows")).toContain("im Explorer öffnen");
    expect(problemText(de, denied, "windows")).toContain("\\\\nas\\team");
    expect(problemText(en, denied, "mac")).toContain("in Finder");
    expect(problemText(de, denied, "linux")).toContain("Dateimanager");
    expect(problemText(de, { problem: "other", message: "kaputt", path: "/x" }, "linux")).toBe("Fehler: kaputt");
  });

  it("status lines are quiet while pending and warn only when failing", () => {
    const when = (iso: string) => `am ${iso.slice(0, 10)}`;
    const now = new Date("2026-09-25T10:00:00Z");
    const fail = { problem: "unreachable" as const, message: "weg", path: "\\\\nas\\team" };
    expect(statusLine(de, view({ health: "waiting" }), when, "windows", now)).toEqual({ tone: "neutral", text: "Wartet auf die nächste Sicherung" });
    expect(statusLine(de, view({ health: "ok", state: state({ last_ok: "2026-09-25T09:00:00Z" }) }), when, "windows", now)).toEqual({
      tone: "success",
      text: "Zuletzt kopiert am 2026-09-25",
    });
    const pending = statusLine(de, view({ health: "pending", state: state({ failures: 1, last_error: fail, next_try: "2026-09-25T10:15:00Z" }) }), when, "windows", now);
    expect(pending.tone).toBe("info");
    expect(pending.text).toMatch(/^Ausstehend – nicht erreichbar .*Neuer Versuch um \d\d:15\.$/);
    const soon = statusLine(de, view({ health: "pending", state: state({ failures: 1, last_error: fail, next_try: "2026-09-25T09:59:00Z" }) }), when, "windows", now);
    expect(soon.text).toContain("Neuer Versuch in Kürze");
    const failing = statusLine(en, view({ health: "failing", state: state({ failures: 5, missed: 3, last_error: fail, last_ok: "2026-09-22T08:00:00Z" }) }), when, "windows", now);
    expect(failing).toEqual({ tone: "warning", text: "No backup since am 2026-09-22 – not reachable (offline, VPN off or share not connected)" });
    expect(statusLine(de, view({ busy: true, health: "pending" }), when, "windows", now).tone).toBe("busy");
    expect(statusLine(de, view({ health: "off" }), when, "windows", now).text).toBe("Ausgeschaltet");
  });

  it("merges local and destination backups newest first", () => {
    const local = [{ path: "/l/a2", file_name: "arcalo-2.db", created_at: "2026-09-25T10:00:00+02:00", size_bytes: 1 }];
    const remote = [
      { path: "/r/pc/a3", file_name: "arcalo-3.db", created_at: "2026-09-25T11:00:00+02:00", size_bytes: 1, source: "d1", source_path: "/r", host: "pc", has_sum: true },
      { path: "/r/pc/a2", file_name: "arcalo-2.db", created_at: "2026-09-25T10:00:00+02:00", size_bytes: 1, source: "d1", source_path: "/r", host: "pc", has_sum: true },
    ];
    const rows = mergeBackups(local, remote);
    expect(rows.map((r) => r.path)).toEqual(["/r/pc/a3", "/l/a2", "/r/pc/a2"]);
    expect(rows[1]).toMatchObject({ source: "local", has_sum: false });
  });
});
