// The Kalender view's logic: visible ranges, the overlap layout of the time grid, month cells,
// booking prefill and whether an appointment is already booked.

import { addDays, formatPrefs, isoDay, isoWeek, weekStart } from "./format";
import { addMonths, monthGrid } from "./calendar";
import type { CalendarEvent, CalendarSettings, TimeEntryRow, WbsHint } from "./types";

export type CalView = "day" | "workweek" | "week" | "month" | "agenda";

export const CAL_VIEWS: CalView[] = ["day", "workweek", "week", "month", "agenda"];

export interface Range {
  /** 00:00 local of the first day. */
  from: Date;
  /** 00:00 local after the last day. */
  to: Date;
  days: Date[];
}

const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const isoWeekday = (d: Date) => ((d.getDay() + 6) % 7) + 1;
/** Days of the agenda list. */
export const AGENDA_DAYS = 14;

/** The days a view shows around `anchor`. The work week keeps the configured workdays (Mo–Fr without any). */
export function viewRange(view: CalView, anchor: Date, startsOn: 0 | 1 = formatPrefs().weekStartsOn, workdays: number[] = [1, 2, 3, 4, 5]): Range {
  const day = midnight(anchor);
  let days: Date[];
  switch (view) {
    case "day":
      days = [day];
      break;
    case "week":
    case "workweek": {
      const first = weekStart(day, startsOn);
      days = Array.from({ length: 7 }, (_, i) => addDays(first, i));
      if (view === "workweek") {
        const wd = workdays.length ? workdays : [1, 2, 3, 4, 5];
        const kept = days.filter((d) => wd.includes(isoWeekday(d)));
        days = kept.length ? kept : days;
      }
      break;
    }
    case "month":
      days = monthGrid(day.getFullYear(), day.getMonth(), startsOn).flat();
      break;
    case "agenda":
      days = Array.from({ length: AGENDA_DAYS }, (_, i) => addDays(day, i));
      break;
  }
  return { from: days[0], to: addDays(days[days.length - 1], 1), days };
}

/** The anchor one step back (-1) or ahead (+1). */
export function step(view: CalView, anchor: Date, dir: -1 | 1): Date {
  switch (view) {
    case "day":
      return addDays(midnight(anchor), dir);
    case "week":
    case "workweek":
      return addDays(midnight(anchor), 7 * dir);
    case "month":
      return addMonths(midnight(anchor), dir);
    case "agenda":
      return addDays(midnight(anchor), AGENDA_DAYS * dir);
  }
}

const locale = () => (formatPrefs().lang === "en" ? "en-GB" : "de-DE");

/** Heading of the range: „Freitag, 25. September 2026“, „21.–27. September 2026“, „September 2026“. */
export function rangeTitle(view: CalView, range: Range, anchor: Date): string {
  const l = locale();
  if (view === "day") return anchor.toLocaleDateString(l, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  if (view === "month") return anchor.toLocaleDateString(l, { month: "long", year: "numeric" });
  const a = range.days[0];
  const b = range.days[range.days.length - 1];
  const long = (d: Date) => d.toLocaleDateString(l, { day: "numeric", month: "long", year: "numeric" });
  if (a.getFullYear() !== b.getFullYear()) return `${long(a)} – ${long(b)}`;
  if (a.getMonth() !== b.getMonth()) return `${a.toLocaleDateString(l, { day: "numeric", month: "long" })} – ${long(b)}`;
  return `${a.getDate()}.–${long(b)}`;
}

/** „KW 39“ (or „KW 39–40“ when the range spans two weeks). */
export function weekLabel(range: Range): string {
  const a = isoWeek(range.days[0]);
  const b = isoWeek(range.days[range.days.length - 1]);
  return a === b ? `KW ${a}` : `KW ${a}–${b}`;
}

interface Timed {
  start: string;
  end: string;
}

export interface Placed<T> {
  item: T;
  /** Minutes after the day's midnight. */
  top: number;
  height: number;
  /** Column in its group of overlapping items, and the group's column count. */
  col: number;
  cols: number;
  /** The item started the day before / goes on after this day. */
  clippedStart: boolean;
  clippedEnd: boolean;
}

/**
 * Side-by-side layout of timed items on one day: overlapping items form a group; each takes the
 * first free column; all items of a group share its column count. Items shorter than
 * `minMinutes` count (and are drawn) as that long, so short meetings stay readable.
 */
export function layoutDay<T extends Timed>(items: T[], day: Date, minMinutes = 20): Placed<T>[] {
  const dayStart = midnight(day).getTime();
  const dayEnd = addDays(midnight(day), 1).getTime();
  const rows = items
    .map((item) => {
      const s = new Date(item.start).getTime();
      const e = Math.max(new Date(item.end).getTime(), s);
      return { item, s, e };
    })
    .filter((r) => r.s < dayEnd && (r.e > dayStart || (r.e === r.s && r.s >= dayStart)))
    .map((r) => {
      const from = Math.max(r.s, dayStart);
      const to = Math.min(r.e, dayEnd);
      const top = (from - dayStart) / 60000;
      const height = Math.max((to - from) / 60000, minMinutes);
      return { item: r.item, top: Math.min(top, 24 * 60 - minMinutes), height, clippedStart: r.s < dayStart, clippedEnd: r.e > dayEnd };
    })
    .sort((a, b) => a.top - b.top || b.height - a.height);

  const out: Placed<T>[] = [];
  let group: Placed<T>[] = [];
  let colEnds: number[] = [];
  let groupEnd = -1;
  const flush = () => {
    for (const p of group) p.cols = colEnds.length;
    out.push(...group);
    group = [];
    colEnds = [];
  };
  for (const r of rows) {
    if (group.length && r.top >= groupEnd) flush();
    let col = colEnds.findIndex((end) => end <= r.top);
    if (col < 0) {
      col = colEnds.length;
      colEnds.push(0);
    }
    colEnds[col] = r.top + r.height;
    groupEnd = group.length ? Math.max(groupEnd, r.top + r.height) : r.top + r.height;
    group.push({ ...r, col, cols: 1 });
  }
  flush();
  return out;
}

/** Whether an item covers (part of) the local day. */
export function onDay(item: Timed, day: Date): boolean {
  const s = new Date(item.start).getTime();
  const e = new Date(item.end).getTime();
  const a = midnight(day).getTime();
  const b = addDays(midnight(day), 1).getTime();
  return s < b && (e > a || (e === s && s >= a));
}

/** All-day row: all-day appointments and those lasting 24 hours or more. */
export const isAllDayLike = (e: CalendarEvent) => e.all_day || new Date(e.end).getTime() - new Date(e.start).getTime() >= 24 * 3600 * 1000;

export interface DayCell {
  shown: CalendarEvent[];
  /** Not shown („+3 weitere“). */
  more: number;
  all: CalendarEvent[];
}

/** Month cells by day (YYYY-MM-DD): all-day first, then by start; at most `max` lines incl. the „weitere“ line. */
export function monthCells(events: CalendarEvent[], days: Date[], max = 3): Map<string, DayCell> {
  const out = new Map<string, DayCell>();
  for (const d of days) {
    const all = events
      .filter((e) => onDay(e, d))
      .sort((a, b) => Number(isAllDayLike(b)) - Number(isAllDayLike(a)) || a.start.localeCompare(b.start) || a.title.localeCompare(b.title));
    const overflow = all.length > max;
    const shown = overflow ? all.slice(0, max - 1) : all;
    out.set(isoDay(d), { shown, more: all.length - shown.length, all });
  }
  return out;
}

const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

/** „10:00–11:30“, or „ganztägig“. */
export function timeRange(e: CalendarEvent): string {
  if (e.all_day) return "ganztägig";
  return `${hhmm(new Date(e.start))}–${hhmm(new Date(e.end))}`;
}

/** Minutes of an appointment. */
export const durationMinutes = (e: Timed) => Math.max(0, Math.round((new Date(e.end).getTime() - new Date(e.start).getTime()) / 60000));

export interface BookingPrefill {
  day: string;
  from: string;
  minutes: number;
  description: string;
  netzplanId: number | null;
  vorgangNr: string | null;
  leistungsart: string | null;
}

/**
 * The time entry for an appointment: its day, start and length (all-day: the daily target from
 * 09:00), its subject as the text and the WBS last used for the same series or subject.
 */
export function bookingPrefill(e: CalendarEvent, hint: WbsHint | null, targetHours = 8): BookingPrefill {
  const start = new Date(e.start);
  const minutes = e.all_day ? Math.round(targetHours * 60) : Math.min(24 * 60, Math.max(1, durationMinutes(e)));
  return {
    day: isoDay(start),
    from: e.all_day ? "09:00" : hhmm(start),
    minutes,
    description: e.private && e.title === "Privater Termin" ? "Termin" : e.title,
    netzplanId: hint?.netzplan_id ?? null,
    vorgangNr: hint?.vorgang_nr ?? null,
    leistungsart: hint?.leistungsart ?? null,
  };
}

const norm = (s: string) => s.normalize("NFC").trim().toLowerCase().replace(/\s+/g, " ");

/**
 * The time entry that books this appointment: the one linked when it was booked from here, or
 * a finished entry that overlaps it and carries its subject.
 */
export function bookedEntry(e: CalendarEvent, entries: TimeEntryRow[]): TimeEntryRow | { id: number } | null {
  if (e.entry_id != null) return entries.find((x) => x.id === e.entry_id) ?? { id: e.entry_id };
  const s = new Date(e.start).getTime();
  const end = new Date(e.end).getTime();
  const title = norm(e.title);
  if (!title) return null;
  return (
    entries.find((x) => {
      if (x.status_flag === "running" || x.duration_minutes == null) return false;
      const xs = new Date(x.start_time).getTime();
      const xe = xs + x.duration_minutes * 60000;
      const overlaps = e.all_day ? isoDay(new Date(xs)) >= isoDay(new Date(s)) && xs < end : xs < end && xe > s;
      const text = norm(x.description);
      return overlaps && !!text && (text === title || text.includes(title) || title.includes(text));
    }) ?? null
  );
}

/**
 * Appointments to offer for booking: over (or running), not all-day, not free/out of office,
 * not marked „nicht buchen“ and not booked yet.
 */
export function unbooked(events: CalendarEvent[], entries: TimeEntryRow[], now = new Date()): CalendarEvent[] {
  return events.filter(
    (e) =>
      !e.all_day &&
      !e.skip &&
      e.busy !== "free" &&
      e.busy !== "oof" &&
      !(e.private && e.title === "Privater Termin") &&
      new Date(e.start).getTime() <= now.getTime() &&
      durationMinutes(e) > 0 &&
      !bookedEntry(e, entries),
  );
}

/** Color of a source (Settings → Kalender). */
export function sourceColor(source: string, cal: CalendarSettings | undefined): string {
  if (!cal) return "var(--accent)";
  if (source === "outlook") return cal.outlook_color || "var(--accent)";
  const id = source.replace(/^ics:/, "");
  return cal.sources.find((s) => s.id === id)?.color ?? "var(--accent)";
}

/** Name of a source for the detail panel. */
export function sourceName(source: string, cal: CalendarSettings | undefined): string {
  if (source === "outlook") return "Outlook";
  const id = source.replace(/^ics:/, "");
  return cal?.sources.find((s) => s.id === id)?.name ?? "Kalender";
}

/** Whether any source is configured (else the view shows its empty state). */
export function hasSources(cal: CalendarSettings | undefined, outlookAvailable: boolean): boolean {
  return !!cal && ((cal.outlook && outlookAvailable) || cal.sources.some((s) => s.enabled));
}

/** Local time of day in minutes, for the „now“ line. */
export const minutesOfDay = (d: Date) => d.getHours() * 60 + d.getMinutes();

/** The keyboard: arrows move, T today, D/W/M/A the views (A = Arbeitswoche, L = Liste). */
export function keyAction(key: string): { move?: -1 | 1; today?: true; view?: CalView } | null {
  switch (key) {
    case "ArrowLeft":
    case "PageUp":
      return { move: -1 };
    case "ArrowRight":
    case "PageDown":
      return { move: 1 };
    case "t":
    case "T":
      return { today: true };
    case "d":
    case "D":
      return { view: "day" };
    case "a":
    case "A":
      return { view: "workweek" };
    case "w":
    case "W":
      return { view: "week" };
    case "m":
    case "M":
      return { view: "month" };
    case "l":
    case "L":
      return { view: "agenda" };
    default:
      return null;
  }
}
