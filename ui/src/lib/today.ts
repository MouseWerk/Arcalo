// The local day of the window (YYYY-MM-DD), renewed after midnight. The window can stay open for
// days (in the tray overnight); a view that shows „Heute“, overdue tasks or the current week reads
// the day here, so it moves on with the date instead of keeping the day it was opened on. One
// check for every view: every 15 s while something listens, and at once when the window is shown
// again or gets the focus (the computer woke up). Also after a change of the time zone.

import { useSyncExternalStore } from "react";
import { isoDay } from "./format";

const CHECK_MS = 15_000;

let day = isoDay(new Date());
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

/** Takes the current date; tells the listeners when the day changed. */
export function checkDay() {
  const now = isoDay(new Date());
  if (now === day) return;
  day = now;
  listeners.forEach((f) => f());
}

const onVisible = () => {
  if (document.visibilityState !== "hidden") checkDay();
};

function subscribe(f: () => void) {
  listeners.add(f);
  if (timer == null) {
    timer = setInterval(checkDay, CHECK_MS);
    window.addEventListener("focus", checkDay);
    document.addEventListener("visibilitychange", onVisible);
  }
  // A day that changed while nobody listened.
  checkDay();
  return () => {
    listeners.delete(f);
    if (!listeners.size && timer != null) {
      clearInterval(timer);
      timer = null;
      window.removeEventListener("focus", checkDay);
      document.removeEventListener("visibilitychange", onVisible);
    }
  };
}

/** Today's local date (YYYY-MM-DD) as last checked. */
export const today = (): string => day;

/** Today's local date (YYYY-MM-DD); re-renders when the day changes. */
export function useToday(): string {
  return useSyncExternalStore(subscribe, today);
}
