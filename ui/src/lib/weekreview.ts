// „Wochenrückblick“: the IPC of the week review (weekreview.rs), opening it on a week from
// anywhere (the view loads lazily, so the request waits here until it reads it) and the pure
// helpers of the view and the start page widget: the week's Monday, moving by weeks, its title,
// the share of the target booked and the meetings grouped by day.

import { invoke } from "@tauri-apps/api/core";
import { useApp } from "../store/app";
import { addDays, dateLocale, isoDay, weekStart } from "./format";
import { t } from "./i18n";
import type { ChatOutcome, Page, ReviewMeeting, ReviewWbs } from "./types";

// ------------------------------------------------------------------ types

export interface WeekGap {
  start: string;
  end: string;
  minutes: number;
}
export interface WeekDay {
  date: string;
  target_minutes: number;
  booked_minutes: number;
  running_minutes: number;
  missing_minutes: number;
  future: boolean;
  holiday: string | null;
  /** `vacation`, `sick`, `comp` or `other`. */
  absence: string | null;
  absence_half: boolean;
  gaps: WeekGap[];
  meetings: number;
  pages: number;
  tasks_done: number;
}
export interface WeekTime {
  target_minutes: number;
  target_to_date: number;
  booked_minutes: number;
  running_minutes: number;
  missing_minutes: number;
  items: ReviewWbs[];
  gaps: number;
  gap_minutes: number;
}
export interface WeekTask {
  page_id: number | null;
  page_title: string;
  text: string;
  day: string | null;
  due: string | null;
  repeating: boolean;
}
export interface WeekTasks {
  done: WeekTask[];
  open: WeekTask[];
  overdue: WeekTask[];
  done_total: number;
  open_total: number;
  overdue_total: number;
  added_total: number;
}
export type WeekMeeting = ReviewMeeting & { day: string };
export interface WeekBlock {
  id: number;
  title: string;
  start: string;
  end: string;
  minutes: number;
  task_done: boolean | null;
  focus_minutes: number;
  booked: boolean;
}
export interface WeekPage {
  page_id: number | null;
  title: string;
  icon: string | null;
  gone: boolean;
  created: boolean;
  daily: boolean;
  edits: number;
  minutes: number;
  days: number;
  last_at: string;
  word_delta: number | null;
}
export interface WeekReview {
  monday: string;
  sunday: string;
  week: number;
  year: number;
  from: string;
  to: string;
  days: WeekDay[];
  time: WeekTime;
  tasks: WeekTasks;
  meetings: WeekMeeting[];
  focus: { minutes: number; sessions: number; blocks: WeekBlock[]; planned_minutes: number };
  pages: WeekPage[];
  pages_total: number;
  report_page_id: number | null;
  /** Time tracking is off: no time part or booking states. */
  without_time?: boolean;
}
export interface SavedReport {
  page: Page;
  created: boolean;
}

// -------------------------------------------------------------------- IPC

const call = <R>(cmd: string, args?: Record<string, unknown>) =>
  invoke<R>(cmd, args).catch((e: unknown) => (e === "app-locked" ? new Promise<R>(() => {}) : Promise.reject(e)));

export const weekApi = {
  review: (date: string) => call<WeekReview>("week_review", { date }),
  summary: (requestId: string, date: string, overrideLimit = false) => call<ChatOutcome>("week_review_summary", { requestId, date, overrideLimit }),
  save: (date: string, summary: string | null) => call<SavedReport>("week_report_save", { date, summary }),
  template: () => call<Page>("week_report_template"),
};

// ------------------------------------------------------------- navigation

export const WEEK_REVIEW_EVENT = "arcalo:week-review";
let pending: string | null = null;

/** Opens the Wochenrückblick on the week of `iso` (YYYY-MM-DD, default this week). */
export function openWeekReview(iso?: string, opts?: { newTab?: boolean }) {
  pending = mondayOf(iso ?? isoDay(new Date()));
  useApp.getState().openTab({ kind: "weekreview" }, opts);
  window.dispatchEvent(new Event(WEEK_REVIEW_EVENT));
}

/** The requested week (its Monday), once. */
export function takeWeekReviewDay(): string | null {
  const d = pending;
  pending = null;
  return d;
}

// ---------------------------------------------------------------- helpers

const noon = (iso: string) => new Date(`${iso}T12:00:00`);

/** The Monday of the week of `iso` (the week runs Monday to Sunday, whatever the calendar's first day). */
export const mondayOf = (iso: string) => isoDay(weekStart(noon(iso), 1));

/** The Monday `delta` weeks before or after the week of `iso`. */
export const shiftWeek = (iso: string, delta: number) => isoDay(addDays(noon(mondayOf(iso)), 7 * delta));

/** Whether the week of `monday` is the current one. */
export const isThisWeek = (monday: string, now = new Date()) => mondayOf(monday) === mondayOf(isoDay(now));

/** „5.–11. Oktober 2026“, „28. September – 4. Oktober 2026“ (in the display language). */
export function weekRange(monday: string): string {
  const a = noon(monday);
  const b = addDays(a, 6);
  const loc = dateLocale();
  if (a.getFullYear() !== b.getFullYear()) {
    const full: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" };
    return `${a.toLocaleDateString(loc, full)} – ${b.toLocaleDateString(loc, full)}`;
  }
  const opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "long", year: "numeric" };
  // Intl joins the two days of one month itself („5.–11. Oktober 2026“, „October 5 – 11, 2026“).
  return new Intl.DateTimeFormat(loc, opts).formatRange(a, b);
}

/** The line under the heading: „Diese Woche · KW 41 · 5.–11. Oktober 2026“. */
export function weekSubtitle(r: Pick<WeekReview, "monday" | "week">, now = new Date()): string {
  const parts = [t("time.weekNo", { n: r.week }), weekRange(r.monday)];
  if (isThisWeek(r.monday, now)) parts.unshift(t("week.thisWeek"));
  else if (isThisWeek(r.monday, addDays(now, -7))) parts.unshift(t("week.lastWeek"));
  return parts.join(" · ");
}

/** Short weekday and day: „Mo 5.“. */
export function dayShort(iso: string): string {
  const d = noon(iso);
  return `${d.toLocaleDateString(dateLocale(), { weekday: "short" }).replace(/\.$/, "")} ${d.getDate()}.`;
}

/** Share of the week's target booked, 0..1 (1 without a target once something is booked). */
export function weekProgress(r: Pick<WeekReview, "time">): number {
  const tm = r.time;
  if (tm.target_minutes <= 0) return tm.booked_minutes > 0 ? 1 : 0;
  return Math.min(1, tm.booked_minutes / tm.target_minutes);
}

/** Share of a day's target booked, 0..1 (for its bar). */
export function dayProgress(d: WeekDay): number {
  if (d.target_minutes <= 0) return d.booked_minutes > 0 ? 1 : 0;
  return Math.min(1, d.booked_minutes / d.target_minutes);
}

/** What a day off is: the holiday's name, else the absence („Urlaub“, „Krank (halber Tag)“). */
export function dayOff(d: WeekDay): string | null {
  if (d.holiday) return d.holiday;
  if (!d.absence) return null;
  const key = ({ vacation: "week.absence.vacation", sick: "week.absence.sick", comp: "week.absence.comp" } as const)[d.absence as "vacation" | "sick" | "comp"] ?? "week.absence.other";
  return d.absence_half ? t("week.absence.half", { kind: t(key) }) : t(key);
}

/** The meetings by day, days in order. */
export function meetingsByDay(meetings: WeekMeeting[]): { day: string; meetings: WeekMeeting[] }[] {
  const out: { day: string; meetings: WeekMeeting[] }[] = [];
  for (const m of meetings) {
    const last = out[out.length - 1];
    if (last?.day === m.day) last.meetings.push(m);
    else out.push({ day: m.day, meetings: [m] });
  }
  return out.sort((a, b) => a.day.localeCompare(b.day));
}

/** Meetings over and still to book. */
export const openWeekMeetings = (r: Pick<WeekReview, "meetings">) => r.meetings.filter((m) => m.state === "open");

/** Nothing happened (and nothing was planned) that week. */
export const isEmptyWeek = (r: WeekReview) =>
  !r.pages.length && !r.time.booked_minutes && !r.time.running_minutes && !r.tasks.done.length && !r.meetings.length && !r.focus.sessions && !r.focus.blocks.length;
