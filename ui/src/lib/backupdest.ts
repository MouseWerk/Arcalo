// Backup destinations (Settings → Sicherung → „Weitere Sicherungsziele“): types of the shell's
// answers and the texts derived from them. The shell reports problems as codes; the words
// (German or English) are chosen here.

import type { TKey } from "./i18n";
import type { BackupInfo } from "./types";

export interface BackupDestination {
  /** Stable id; empty for a new one (the shell derives it from the path). */
  id: string;
  path: string;
  enabled: boolean;
  keep: number;
  /** Backups older than this many days are deleted too; 0 = only `keep` counts. */
  keep_days: number;
  attachments: boolean;
  markdown: boolean;
}

export interface BackupTargets {
  destinations: BackupDestination[];
  /** Keep only the newest backup locally once every active destination has it. */
  local_latest_only: boolean;
}

export type DestProblem = "unreachable" | "denied" | "read_only" | "full" | "timeout" | "checksum" | "busy" | "invalid" | "unc_unsupported" | "other";

export interface DestFailure {
  problem: DestProblem;
  /** German text of the shell (log, fallback). */
  message: string;
  path: string;
}

export type PathKind = "unc" | "drive" | "mount" | "cloud" | "local";

export interface PathInfo {
  kind: PathKind;
  server: string | null;
  share: string | null;
  cloud: string | null;
}

export interface DestState {
  last_ok: string | null;
  last_file: string | null;
  last_bytes: number | null;
  last_ms: number | null;
  last_error: DestFailure | null;
  last_error_at: string | null;
  pending_since: string | null;
  failures: number;
  missed: number;
  next_try: string | null;
  warned: boolean;
  reached: boolean;
}

export type DestHealth = "ok" | "waiting" | "pending" | "failing" | "off";

export interface DestView {
  id: string;
  path: string;
  enabled: boolean;
  info: PathInfo;
  state: DestState;
  health: DestHealth;
  busy: boolean;
  /** This computer's subfolder in the destination. */
  folder: string;
}

export interface DestTest {
  ok: boolean;
  probe: { path: string; info: PathInfo; write_ms: number; delete_ms: number; bytes: number; existing: number } | null;
  failure: DestFailure | null;
  info: PathInfo;
}

export interface SourcedBackup extends BackupInfo {
  /** Destination id, or `local`. */
  source: string;
  source_path: string;
  host: string;
  has_sum: boolean;
}

export interface RemoteBackups {
  backups: SourcedBackup[];
  offline: DestFailure[];
}

export interface RestoreStaged {
  ok: boolean;
  verified: boolean;
  failure: DestFailure | null;
}

/** A new destination with the defaults of the shell. */
export function newDestination(path: string): BackupDestination {
  return { id: "", path: path.trim(), enabled: true, keep: 14, keep_days: 0, attachments: true, markdown: false };
}

/** Paths that name the same folder (separators and case aside), like the shell compares them. */
export function samePath(a: string, b: string): boolean {
  const key = (p: string) => p.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return key(a) === key(b);
}

/** Whether `path` can be added: not empty and not already there. */
export function canAdd(path: string, existing: BackupDestination[]): boolean {
  return path.trim().length > 0 && !existing.some((d) => samePath(d.path, path));
}

/** The label of a destination's kind. */
export function kindKey(info: PathInfo): TKey {
  switch (info.kind) {
    case "unc":
      return "bdest.kind.unc";
    case "drive":
      return "bdest.kind.drive";
    case "mount":
      return "bdest.kind.mount";
    case "cloud":
      return "bdest.kind.cloud";
    default:
      return "bdest.kind.local";
  }
}

/** The words for a problem code. */
export function problemKey(p: DestProblem): TKey {
  const keys: Record<DestProblem, TKey> = {
    unreachable: "bdest.p.unreachable",
    denied: "bdest.p.denied",
    read_only: "bdest.p.read_only",
    full: "bdest.p.full",
    timeout: "bdest.p.timeout",
    checksum: "bdest.p.checksum",
    busy: "bdest.p.busy",
    invalid: "bdest.p.invalid",
    unc_unsupported: "bdest.p.unc_unsupported",
    other: "bdest.p.other",
  };
  return keys[p] ?? "bdest.p.other";
}

type Translate = (key: TKey, vars?: Record<string, string | number>) => string;

/** The file manager named in the „open it once“ advice. */
export function fileManagerName(t: Translate, platform: "windows" | "mac" | "linux"): string {
  return platform === "windows" ? "Explorer" : platform === "mac" ? "Finder" : t("bdest.app.files");
}

/** A problem as a sentence part: „kein Zugriff auf \\nas\team – den Ordner einmal im Explorer öffnen …“. */
export function problemText(t: Translate, f: DestFailure, platform: "windows" | "mac" | "linux"): string {
  return t(problemKey(f.problem), { path: f.path, app: fileManagerName(t, platform), msg: f.message });
}

export type Tone = "success" | "neutral" | "info" | "warning" | "busy";

/** The status line of a destination: tone and text. `when` formats a time stamp. */
export function statusLine(
  t: Translate,
  d: DestView,
  when: (iso: string) => string,
  platform: "windows" | "mac" | "linux",
  now = new Date(),
): { tone: Tone; text: string } {
  const s = d.state;
  if (d.health === "off") return { tone: "neutral", text: t("bdest.st.off") };
  if (d.busy && d.health !== "failing") return { tone: "busy", text: t("bdest.st.copying") };
  const reason = s.last_error ? problemText(t, s.last_error, platform) : t("bdest.p.unreachable");
  if (d.health === "failing") return { tone: "warning", text: t("bdest.st.failing", { since: when(s.last_ok ?? s.pending_since ?? now.toISOString()), reason }) };
  if (d.health === "pending") {
    const next = s.next_try && new Date(s.next_try).getTime() > now.getTime() ? t("bdest.nextAt", { time: timeOfDay(s.next_try) }) : t("bdest.nextSoon");
    return { tone: "info", text: t("bdest.st.pending", { reason, next }) };
  }
  if (d.health === "ok" && s.last_ok) return { tone: "success", text: t("bdest.st.ok", { when: when(s.last_ok) }) };
  return { tone: "neutral", text: t("bdest.st.waiting") };
}

/** „14:05“ in local time. */
export function timeOfDay(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Local and destination backups in one list, newest first. */
export function mergeBackups(local: BackupInfo[], remote: SourcedBackup[]): SourcedBackup[] {
  const own: SourcedBackup[] = local.map((b) => ({ ...b, source: "local", source_path: "", host: "", has_sum: false }));
  return [...own, ...remote].sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : a.source === "local" ? -1 : 1));
}
