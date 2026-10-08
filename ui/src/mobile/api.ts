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
};
