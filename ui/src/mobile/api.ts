// The commands only the Android companion app uses (src-tauri/src/mobile/mod.rs); the shared
// ones (pages, tasks, timer, Git sync) come from lib/api.ts.

import { invoke } from "@tauri-apps/api/core";
import type * as T from "../lib/types";
import { noteSystemLang } from "../lib/i18n";

/** The running timer as the start screen shows it. */
export interface RunningTimer {
  entry: T.TimeEntry;
  reference: string;
  worked_minutes: number;
  paused_since: string | null;
  paused_seconds: number;
}

/** What „Heute“ shows (`companion::today`). */
export interface Today {
  /** YYYY-MM-DD */
  date: string;
  booked_minutes: number;
  target_minutes: number;
  week_minutes: number;
  timer: RunningTimer | null;
  tasks: T.Task[];
  events: T.CalendarEvent[];
  /** When the meetings were last taken over from the desktop (RFC 3339). */
  events_from: string | null;
  time_tracking: boolean;
}

export interface RecentTarget {
  netzplan_nr: string;
  vorgang_nr: string | null;
  leistungsart: string | null;
  reference: string;
  label: string;
  last_text: string;
}

export interface ReferenceImport {
  projects: number;
  netzplaene: number;
  vorgaenge: number;
  leistungsarten: number;
  events: number;
  skipped: string | null;
}

export interface MobileSync extends T.GitSyncOutcome {
  reference: ReferenceImport;
}

/** The app's own updates (`src-tauri/src/mobile/apkupdate.rs`). */
export type UpdatePhase = "idle" | "checking" | "downloading" | "waiting" | "ready" | "blocked" | "error";

export interface UpdateStatus {
  /** This build checks for updates (release builds). */
  configured: boolean;
  current: string;
  phase: UpdatePhase;
  offered: { version: string; notes: string | null; size: number | null; pub_date: string | null; page: string } | null;
  downloaded: number;
  total: number | null;
  /** Waiting because the network is mobile data (not offline). */
  metered: boolean;
  error: string | null;
  /** Why the offered version cannot be installed over this app. */
  blocked: string | null;
  last_check: string | null;
  allow_mobile_data: boolean;
}

export type InstallOutcome = "started" | "needs_permission";

export const mobileApi = {
  settings: () => invoke<T.SettingsView>("mobile_settings_get").then((v) => (noteSystemLang(v.system_language), v)),
  saveSettings: (settings: T.Settings) => invoke<T.SettingsView>("mobile_settings_save", { settings }),
  today: () => invoke<Today>("mobile_today"),
  /** The daily note of `date` (YYYY-MM-DD, today without); created only with `create`. */
  daily: (date: string | null, create: boolean) => invoke<T.Page | null>("mobile_daily", { date, create }),
  /** Books a `/zeit` line; its chip goes into the daily note. */
  book: (line: string) => invoke<T.LogOutcome>("mobile_book", { line }),
  capture: (text: string, inbox: boolean) => invoke<T.Page>("mobile_capture", { text, inbox }),
  timerStop: () => invoke<T.TimeEntry[]>("mobile_timer_stop"),
  recentTargets: () => invoke<RecentTarget[]>("mobile_recent_targets"),
  sync: (allowDeletions = false) => invoke<MobileSync>("mobile_sync", { allowDeletions, afterRestore: null }),
  /** Text shared to the app from another one, once (null when there is none). */
  sharedText: () => invoke<string | null>("mobile_shared_text"),
  /** The colors behind the status bar (`top`) and the navigation bar (`bottom`), as `#rrggbb`. */
  bars: (dark: boolean, top: string, bottom: string) => invoke<void>("mobile_bars", { dark, top, bottom }),
  /** The back button on the start screen: the app goes to the background. */
  toBackground: () => invoke<void>("mobile_to_background"),
  update: {
    status: () => invoke<UpdateStatus | null>("apk_update_status"),
    check: (manual: boolean) => invoke<UpdateStatus>("apk_update_check", { manual }),
    /** Downloads the offered version now, also on mobile data. */
    download: () => invoke<UpdateStatus>("apk_update_download"),
    install: () => invoke<InstallOutcome>("apk_update_install"),
    /** Opens Android's „Unbekannte Apps installieren“ for Arcalo; whether it is allowed now. */
    allowInstall: () => invoke<boolean>("apk_update_allow_install"),
    setMobileData: (allow: boolean) => invoke<UpdateStatus>("apk_update_set_mobile_data", { allow }),
  },
};
