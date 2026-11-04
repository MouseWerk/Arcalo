// Month grid and day status for the daily-note calendar.

import { fmtMinutes, formatPrefs, isoDay, isoWeek } from "./format";

/** Six weeks (Monday- or Sunday-first per the settings) covering the month of `year`/`month` (0-based). */
export function monthGrid(year: number, month: number, startsOn: 0 | 1 = formatPrefs().weekStartsOn): Date[][] {
  const first = new Date(year, month, 1);
  const start = new Date(year, month, 1 - ((first.getDay() + 7 - startsOn) % 7));
  return Array.from({ length: 6 }, (_, w) =>
    Array.from({ length: 7 }, (_, d) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + w * 7 + d)),
  );
}

/** Calendar week (ISO) shown in the KW column. */
export const weekNumber = (monday: Date) => isoWeek(monday);

/** Same day `n` months later, clamped to the month's last day (31 Jan + 1 → 28/29 Feb). */
export function addMonths(d: Date, n: number): Date {
  const target = new Date(d.getFullYear(), d.getMonth() + n, 1);
  const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  return new Date(target.getFullYear(), target.getMonth(), Math.min(d.getDate(), last));
}

export type DayTone = "none" | "met" | "below";

/**
 * How a day's booked time compares with its target (`target_minutes` of the day overview: the
 * weekday's target, none on a public holiday, half on a half absence, none on a full one, as
 * every view counts missing time): `below` only on past days with a target (today is still
 * running), `met` whenever the target is reached. Empty days before `trackedSince` (the first
 * booking in view) stay neutral, so months before time tracking started are not all flagged.
 */
export function dayTone(day: Date, minutes: number, targetMinutes: number, today: Date, trackedSince?: string): DayTone {
  if (targetMinutes > 0 && minutes >= targetMinutes) return "met";
  const iso = isoDay(day);
  const past = iso < isoDay(today);
  if (minutes <= 0 && (!trackedSince || iso < trackedSince)) return "none";
  if (past && targetMinutes > 0) return "below";
  return "none";
}

/** Hours for the cell, as set in the settings („7,50“ or „7:30“); empty without bookings. */
export function hoursLabel(minutes: number): string {
  return minutes > 0 ? fmtMinutes(minutes) : "";
}
