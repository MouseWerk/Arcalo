// „Neuer Termin…“ from anywhere (the command palette): whether appointments can be written here
// (Outlook Classic on Windows, asked once per session), and opening the Kalender with a new one.

import { api } from "./api";
import { useApp } from "../store/app";

let available: Promise<boolean> | null = null;

/** Whether appointments can be written to Outlook here (cached for the session). */
export function entriesAvailable(): Promise<boolean> {
  available ??= api
    .calendarStatus()
    .then((st) => !!st.entries_available)
    .catch(() => {
      available = null;
      return false;
    });
  return available;
}

let pending = false;

/** Opens the Kalender with the panel of a new appointment. */
export function newCalendarEntry() {
  pending = true;
  useApp.getState().openTab({ kind: "calendar" });
  // An open Kalender takes it at once, one that opens now when it mounts.
  window.dispatchEvent(new Event("arcalo:calendar-new"));
}

/** Whether a new appointment was asked for (once). */
export function takeNewEntry(): boolean {
  const was = pending;
  pending = false;
  return was;
}
