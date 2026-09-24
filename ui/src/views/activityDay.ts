// „Was habe ich am … gemacht?“ from anywhere: opens the activity feed on a day.

import { useApp } from "../store/app";

/** Where the activity view keeps its range and filters. */
export const ACTIVITY_PREF = "annalo.activity";

/** Opens the feed on `iso` („Was habe ich am … gemacht?“). */
export function openActivityDay(iso: string) {
  try {
    localStorage.setItem(ACTIVITY_PREF, JSON.stringify({ preset: "day", from: iso, to: iso }));
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new CustomEvent("annalo:activity-day", { detail: iso }));
  useApp.getState().openTab({ kind: "activity" });
}
