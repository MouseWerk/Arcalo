// „Zeiterfassung verwenden“ (Settings → Zeiterfassung): one switch for everything about booking
// time. Off, the timesheet, projects, the timer, /zeit, budgets, the week proposal and every
// other trace of SAP booking disappear; the data stays and comes back when it is switched on.
// Components read it with `useTimeTracking()`, code outside React with `timeTrackingEnabled()`.

import { useApp } from "../store/app";
import type { Settings } from "./types";

/** Whether time tracking is on (settings from before the switch count as on). */
export const timeTrackingOn = (s: Settings | null | undefined) => s?.time?.enabled !== false;

/** The switch, live: re-renders when it changes (in this window or, via `settings://changed`, elsewhere). */
export const useTimeTracking = () => useApp((st) => timeTrackingOn(st.settings?.settings));

/** The switch now, for code outside React (editor extensions, shortcuts, event handlers). */
export const timeTrackingEnabled = () => timeTrackingOn(useApp.getState().settings?.settings);

/** Tabs that only make sense with time tracking. */
export const TIME_TABS = new Set(["timesheet", "projects"]);

/** Command palette entries about booking time (the weekly report is written from bookings). */
export const TIME_COMMANDS = ["timer", "timer-pause", "timesheet", "week-proposal", "projects", "weekly-report", "focus-note"];

/** The assistant's tools about booking time (annalo_core::ai::tools::TIME_TOOLS). */
export const TIME_TOOLS = ["log_time", "budget_status", "time_summary"];

/** Shortcuts (`keymap` ids) that do nothing while time tracking is off. */
export const TIME_SHORTCUTS = new Set(["timer", "timer_pause"]);

/** A `/zeit …` (or `/time …`) line. */
export const isZeitLine = (line: string) => /^\s*\/(zeit|time)(\s|$)/i.test(line);

/**
 * The Leistungsart a new booking on `netzplanNr` starts with: the Netzplan's default (Settings →
 * Zeiterfassung, number compared case-insensitively), else DEV while it exists (or the list is
 * not loaded yet), else none.
 */
export function defaultLeistungsart(defaults: Record<string, string> | undefined, netzplanNr: string | undefined, las: [string, string][]): string {
  const own = netzplanNr ? Object.entries(defaults ?? {}).find(([k, v]) => v && k.toLowerCase() === netzplanNr.toLowerCase())?.[1] : undefined;
  if (own) return own;
  return !las.length || las.some(([code]) => code === "DEV") ? "DEV" : "";
}
