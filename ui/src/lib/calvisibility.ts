// Which calendars the Kalender view and the dashboard's „Termine“ show. A view setting only:
// hiding a calendar does not change what syncs (Settings → Kalender). Kept per computer
// (localStorage) and shared by every view of the window, so the dashboard follows the Kalender.

import { useSyncExternalStore } from "react";
import type { CalendarSourceInfo, CalendarStatus } from "./types";

const KEY = "arcalo.calendar.hidden";

function load(): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

let hidden: ReadonlySet<string> = load();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((f) => f());

if (typeof window !== "undefined") {
  // Another window changed it.
  window.addEventListener("storage", (e) => {
    if (e.key !== KEY) return;
    hidden = load();
    notify();
  });
}

export const hiddenCalendars = (): ReadonlySet<string> => hidden;

/** Hides a calendar in the views (or shows it again). */
export function setCalendarHidden(id: string, hide: boolean) {
  const next = new Set(hidden);
  if (hide) next.add(id);
  else next.delete(id);
  hidden = next;
  try {
    localStorage.setItem(KEY, JSON.stringify([...next]));
  } catch {
    /* ignore */
  }
  notify();
}

const subscribe = (f: () => void) => {
  listeners.add(f);
  return () => {
    listeners.delete(f);
  };
};

/** The hidden calendars; re-renders when they change. */
export function useHiddenCalendars(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, hiddenCalendars);
}

/** The events of calendars that are not hidden. */
export function visibleEvents<T extends { source: string }>(events: T[], hide: ReadonlySet<string>): T[] {
  return hide.size ? events.filter((e) => !hide.has(e.source)) : events;
}

/** The calendars of the legend: every source that syncs, in the order of the status. */
export function legendSources(status: CalendarStatus | null): CalendarSourceInfo[] {
  return status?.sources.filter((s) => s.enabled) ?? [];
}
