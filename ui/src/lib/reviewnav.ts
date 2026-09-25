// Opening the Tagesrückblick on a day, and the Zeiterfassung on the week of a day, from
// anywhere (the views load lazily, so the request waits here until they read it).

import { useApp } from "../store/app";
import { isoDay } from "./format";

export const REVIEW_EVENT = "annalo:day-review";
export const TIMESHEET_DAY_EVENT = "annalo:timesheet-day";

let pendingReview: string | null = null;
let pendingSheet: string | null = null;

/** Opens the Tagesrückblick on `iso` (YYYY-MM-DD, default today). */
export function openDayReview(iso?: string, opts?: { newTab?: boolean }) {
  pendingReview = iso ?? isoDay(new Date());
  useApp.getState().openTab({ kind: "review" }, opts);
  window.dispatchEvent(new Event(REVIEW_EVENT));
}

/** The requested day, once. */
export function takeReviewDay(): string | null {
  const d = pendingReview;
  pendingReview = null;
  return d;
}

/** Opens the Zeiterfassung on the week of `iso`. */
export function openTimesheetDay(iso: string, opts?: { newTab?: boolean }) {
  pendingSheet = iso;
  useApp.getState().openTab({ kind: "timesheet" }, opts);
  window.dispatchEvent(new Event(TIMESHEET_DAY_EVENT));
}

/** The requested day of the Zeiterfassung, once. */
export function takeTimesheetDay(): string | null {
  const d = pendingSheet;
  pendingSheet = null;
  return d;
}
