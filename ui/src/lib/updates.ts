// Pure helpers of the auto-update flow (see components/Updates.tsx).

import { fileSize } from "./format";
import type { UpdateProgress, UpdateStatus } from "./types";

/** Automatic checks: shortly after start, then every 6 hours. */
export const FIRST_CHECK_DELAY_MS = 20_000;
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export const NOT_CONFIGURED = "Automatische Updates sind in diesem Build nicht eingerichtet";

/** Checks run on their own only in builds with an update key and when the user wants them. */
export function autoCheckAllowed(status: UpdateStatus | null, autoCheck: boolean | undefined): boolean {
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
  if (!p) return "Download wird gestartet …";
  const done = fileSize(p.downloaded);
  if (p.percent == null || !p.total) return `${done} geladen`;
  return `${p.percent} % · ${done} von ${fileSize(p.total)}`;
}

/** Share of the download for the progress bar (0 while unknown). */
export function progressValue(p: UpdateProgress | null): number {
  return p?.percent == null ? 0 : Math.min(Math.max(p.percent / 100, 0), 1);
}
