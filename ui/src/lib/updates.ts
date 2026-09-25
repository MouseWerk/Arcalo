// Pure helpers of the auto-update flow (see components/Updates.tsx).

import { fileSize } from "./format";
import type { UpdateProgress, UpdateStatus } from "./types";
import { t, type TKey } from "./i18n";

/** Automatic checks: shortly after start, then every 6 hours. */
export const FIRST_CHECK_DELAY_MS = 20_000;
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export const NOT_CONFIGURED: TKey = "upd.notConfigured";

/** Checks run on their own only in builds with an update key and when the user wants them. */
export function autoCheckAllowed(status: UpdateStatus | null, autoCheck: boolean | undefined): boolean {
  return !!status?.enabled && autoCheck !== false;
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
