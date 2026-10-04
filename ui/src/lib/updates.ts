// Pure helpers of the auto-update flow (see components/Updates.tsx).

import { fileSize } from "./format";
import type { UpdateInfo, UpdateManagedField, UpdateMode, UpdateProgress, UpdateStatus } from "./types";
import { t, type TKey } from "./i18n";

/** Automatic checks: shortly after start, then every 6 hours. */
export const FIRST_CHECK_DELAY_MS = 20_000;
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export const NOT_CONFIGURED: TKey = "upd.notConfigured";

/** Checks run on their own only in builds with an update key and when the user wants them (never in the Store build). */
export function autoCheckAllowed(status: UpdateStatus | null, autoCheck: boolean | undefined): boolean {
  if (status?.store) return false;
  if (status?.policy && (status.policy.disabled || status.policy.mode === "off")) return false;
  return !!status?.enabled && autoCheck !== false;
}

/** Why this copy does not install updates itself: a portable folder or a system package (both get the release page). */
export function manualUpdate(status: UpdateStatus | null): "portable" | "package" | null {
  if (status?.portable) return "portable";
  if (status?.package) return "package";
  return null;
}

/** „12 %“ with the downloaded size, or only the size while the total is unknown. */
export function progressLabel(p: UpdateProgress | null): string {
  if (!p) return t("upd.starting");
  const done = fileSize(p.downloaded);
  if (p.percent == null || !p.total) return t("upd.loaded", { done });
  return t("upd.progress", { percent: p.percent, done, total: fileSize(p.total) });
}

/** Share of the download for the progress bar (0 while unknown). */
export function progressValue(p: UpdateProgress | null): number {
  return p?.percent == null ? 0 : Math.min(Math.max(p.percent / 100, 0), 1);
}

/** Hours between automatic checks (the setting, or the organization's policy). */
export function checkIntervalMs(status: UpdateStatus | null): number {
  const hours = status?.policy?.check_interval_hours;
  return hours && hours > 0 ? hours * 60 * 60 * 1000 : CHECK_INTERVAL_MS;
}

/** The mode that applies; builds and copies that cannot install themselves only notify. */
export function effectiveMode(status: UpdateStatus | null): UpdateMode {
  const mode = status?.policy?.mode ?? "notify";
  return mode === "auto" && manualUpdate(status) ? "notify" : mode;
}

/** What the status bar shows about a background update (mode „automatisch“). */
export type UpdateHint =
  | { kind: "none" }
  | { kind: "downloading"; version: string; percent: number | null }
  | { kind: "paused"; version: string }
  | { kind: "failed"; version: string; error: string | null }
  | { kind: "ready"; version: string; installNow: boolean; window: string | null };

export function updateHint(status: UpdateStatus | null, available: UpdateInfo | null): UpdateHint {
  if (!status?.enabled || effectiveMode(status) !== "auto" || !available) return { kind: "none" };
  const version = available.version;
  if (status.ready === version) return { kind: "ready", version, installNow: status.install_now !== false, window: status.policy?.install_window ?? null };
  const d = status.download;
  if (d?.phase === "downloading") return { kind: "downloading", version, percent: d.percent };
  if (d?.phase === "paused") return { kind: "paused", version };
  if (d?.phase === "failed") return { kind: "failed", version, error: d.error };
  return { kind: "none" };
}

/** A field the organization manages (Settings shows it locked). */
export const isManaged = (status: UpdateStatus | null, field: UpdateManagedField) => !!status?.policy?.managed.includes(field);

/** „Später erinnern“: the days of „morgen“ and „nächste Woche“. */
export const REMIND_DAYS = { tomorrow: 1, nextWeek: 7 } as const;

/** Intervals offered in Settings (hours). */
export const INTERVALS = [1, 2, 4, 6, 12, 24, 48, 168];
