// The work and chart widgets of the start page (1.7): their data types (arcalo_core::dashboard::
// work, arcalo_core::worktime, arcalo_core::mail::flagged), the parts they load, the IPC calls
// of absences and flagged mails, and the mapping of their data to what the widgets draw.

import { invoke } from "@tauri-apps/api/core";
import { isoDay } from "./format";
import { t, type TKey } from "./i18n";
import { heatStart, type Datum } from "./charts";
import type { Mail } from "./mail";

// ------------------------------------------------------------------ data

export type AbsenceKind = "vacation" | "sick" | "comp" | "other";
export const ABSENCE_KINDS: AbsenceKind[] = ["vacation", "sick", "comp", "other"];

export interface Absence {
  date: string;
  kind: AbsenceKind;
  half: boolean;
  note: string;
}
export interface Holiday {
  date: string;
  name: string;
  name_en: string;
}
export interface BalanceData {
  start: string;
  configured: boolean;
  minutes: number;
  opening_minutes: number;
  booked_minutes: number;
  target_minutes: number;
  today_booked: number;
  today_target: number;
  running: boolean;
  weeks: { week_start: string; minutes: number }[];
  week_delta: number;
}
export interface AbsenceBlock {
  from: string;
  to: string;
  kind: AbsenceKind;
  days: number;
}
export interface VacationData {
  year: number;
  entitlement: number;
  carry_over: number;
  taken: number;
  planned: number;
  left: number;
  next_holiday: Holiday | null;
  state: string;
  upcoming: AbsenceBlock[];
}
export interface Deadline {
  key: string;
  source: string;
  title: string;
  detail: string;
  date: string;
  page_id: number | null;
  ordinal: number | null;
  url: string | null;
  priority: number;
}
export interface DeadlinesData {
  today: string;
  until: string;
  items: Deadline[];
  errors: [string, string][];
}
export type Presence = "free" | "tentative" | "elsewhere" | "busy" | "oof";
export interface TeamMember {
  source: string;
  name: string;
  color: string;
  free_busy: boolean;
  state: Presence;
  until: string | null;
  next: Presence | null;
  title: string;
}
export interface TeamData {
  members: TeamMember[];
  available: [string, string][];
}
export interface ChartPoint {
  label: string;
  detail: string;
  value: number;
  color: string | null;
  date: string | null;
}
export interface ChartData {
  unit: "count" | "number" | "minutes";
  points: ChartPoint[];
  total: number;
  ordered: boolean;
}
export interface HeatmapData {
  from: string;
  to: string;
  days: [string, number][];
  max: number;
  total: number;
  active: number;
}
export interface KanbanData {
  page_id: number;
  title: string;
  icon: string | null;
  frontmatter: string;
  rows: { id: number; title: string; icon: string | null; position: number; updated_at: string; frontmatter: string }[];
}
export interface FlaggedMail extends Mail {
  flag_due: string | null;
  flag_request: string;
}

export const workApi = {
  absences: (from: string, to: string) => invoke<{ absences: Absence[]; holidays: Holiday[]; state: string }>("absence_list", { from, to }),
  saveAbsence: (from: string, to: string, kind: AbsenceKind, half: boolean, note: string) => invoke<string[]>("absence_save", { from, to, kind, half, note }),
  removeAbsence: (from: string, to: string) => invoke<number>("absence_remove", { from, to }),
  flagged: () => invoke<{ available: boolean; mails: FlaggedMail[] }>("mail_flagged"),
  flaggedOpen: (entryId: string, storeId: string) => invoke<void>("mail_flagged_open", { entryId, storeId }),
  flaggedAvailable: () => invoke<boolean>("mail_flagged_available"),
};

// ------------------------------------------------------------------ parts

export type ChartSource = "pages" | "bookings";
export type ChartType = "bar" | "line" | "pie";
export interface ChartQuery {
  source: ChartSource;
  page: number | null;
  group: string;
  value: "count" | "sum";
  field: string;
  weeks: number;
}

/** The parts of `arcalo_core::dashboard::work::WorkPart`. */
export type WorkPart =
  | { kind: "balance"; weeks: number }
  | { kind: "vacation" }
  | { kind: "deadlines"; days: number; off: string[] }
  | { kind: "team"; sources: string[] }
  | { kind: "chart"; chart: ChartQuery }
  | { kind: "heatmap"; mode: "notes" | "hours"; from: string; to: string }
  | { kind: "kanban"; page: number };

export const WORK_KINDS = ["balance", "vacation", "deadlines", "mail_flags", "next_meeting", "team", "chart", "heatmap", "kanban"] as const;
export type WorkKind = (typeof WORK_KINDS)[number];

/** Work widgets about booked time: hidden (and not offered) while time tracking is off. */
export const WORK_TIME_KINDS: ReadonlySet<string> = new Set(["balance", "vacation"]);

/** A widget whose settings make it one about booked time (a chart of the bookings). */
export const timeConfig = (kind: string, c: Record<string, unknown> | undefined) => kind === "chart" && (c?.chart as Partial<ChartQuery> | undefined)?.source === "bookings";

const BOOKING_GROUPS = ["netzplan", "vorgang", "activity", "week", "month"] as const;
export type BookingGroup = (typeof BOOKING_GROUPS)[number];
export const bookingGroups = (): readonly BookingGroup[] => BOOKING_GROUPS;

/** A chart's settings with defaults for whatever is missing. */
export function chartQueryOf(c: Record<string, unknown>): ChartQuery {
  const q = (c.chart && typeof c.chart === "object" ? c.chart : {}) as Partial<ChartQuery>;
  const source: ChartSource = q.source === "bookings" ? "bookings" : "pages";
  const group = typeof q.group === "string" && q.group ? q.group : source === "bookings" ? "netzplan" : "status";
  return {
    source,
    page: typeof q.page === "number" ? q.page : null,
    group: source === "bookings" && !BOOKING_GROUPS.includes(group as BookingGroup) ? "netzplan" : group,
    value: q.value === "sum" ? "sum" : "count",
    field: typeof q.field === "string" ? q.field : "",
    weeks: Math.max(1, Math.min(104, Number(q.weeks) || 12)),
  };
}

/** The heatmap's range: 53 weeks up to today (whole weeks from a Monday). */
export function heatRange(today: Date): { from: string; to: string } {
  return { from: isoDay(heatStart(today)), to: isoDay(today) };
}

const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);

/** The parts a work widget loads (`null`: not a work widget). */
export function workParts(kind: string, c: Record<string, unknown>, today: Date, time: boolean): WorkPart[] | { kind: "agenda"; days: number }[] | null {
  switch (kind) {
    case "balance":
      return [{ kind: "balance", weeks: 12 }];
    case "vacation":
      return [{ kind: "vacation" }];
    case "deadlines":
      return [{ kind: "deadlines", days: Math.max(1, Math.min(90, num(c.days, 14))), off: Array.isArray(c.off) ? (c.off as string[]) : [] }];
    case "team":
      return [{ kind: "team", sources: Array.isArray(c.sources) ? (c.sources as string[]) : [] }];
    case "next_meeting":
      // The agenda of the next two weeks, shared with the „Termine“ widget's part.
      return [{ kind: "agenda", days: 14 }];
    case "chart": {
      const q = chartQueryOf(c);
      if (q.source === "bookings" && !time) return [];
      if (q.source === "pages" && q.page == null) return [];
      return [{ kind: "chart", chart: q }];
    }
    case "heatmap":
      return [{ kind: "heatmap", mode: c.mode === "hours" && time ? "hours" : "notes", ...heatRange(today) }];
    case "kanban":
      return typeof c.page === "number" ? [{ kind: "kanban", page: c.page }] : [];
    case "mail_flags":
      return [];
    default:
      return null;
  }
}

/** What reloads a work part. */
export function workTopics(p: WorkPart): ("entries" | "tasks" | "pages" | "calendar" | "absences")[] {
  switch (p.kind) {
    case "balance":
      return ["entries", "absences"];
    case "vacation":
      return ["absences"];
    case "deadlines":
      return ["tasks", "pages"];
    case "team":
      return ["calendar"];
    case "chart":
      return p.chart.source === "bookings" ? ["entries"] : ["pages"];
    case "heatmap":
      return p.mode === "hours" ? ["entries"] : ["pages"];
    case "kanban":
      return ["pages"];
  }
}

// ------------------------------------------------------------------ mapping

/** Colors of select options (`grau` … `rot`) as the property chips show them. */
const OPTION_COLORS: Record<string, string> = {
  grau: "#9ca3af",
  braun: "#b0845c",
  orange: "#f97316",
  gelb: "#eab308",
  grün: "#22c55e",
  blau: "#3b82f6",
  lila: "#a855f7",
  rosa: "#ec4899",
  rot: "#ef4444",
};

/** The label of a chart group: „Ohne Wert“, „Übrige“, ja/nein, a week or month, else as is. */
export function pointLabel(p: Pick<ChartPoint, "label" | "date">, group: string, fmtWeek: (d: string) => string, fmtMonth: (d: string) => string): string {
  if (p.label === "") return t("work.chart.none");
  if (p.label === "__other") return t("work.chart.other");
  if (p.label === "__yes") return t("common.yes");
  if (p.label === "__no") return t("common.no");
  if (p.date && group === "week") return fmtWeek(p.date);
  if (p.date && group === "month") return fmtMonth(p.date);
  if (/^\d{4}-\d{2}$/.test(p.label)) return fmtMonth(`${p.label}-01`);
  return p.label;
}

/** Chart data as the renderer takes it: labels in the UI language, minutes as hours. */
export function chartData(d: ChartData, group: string, fmtWeek: (d: string) => string, fmtMonth: (d: string) => string): Datum[] {
  // Among colored options, „Ohne Wert“ and „Übrige“ are gray.
  const colored = d.points.some((p) => p.color);
  return d.points.map((p) => ({
    key: p.label || "__none",
    label: pointLabel(p, group, fmtWeek, fmtMonth),
    value: d.unit === "minutes" ? p.value / 60 : p.value,
    color: p.color ? OPTION_COLORS[p.color] : colored && (p.label === "" || p.label === "__other") ? "var(--series-rest)" : undefined,
  }));
}

/** Days from `today` to `date` (both YYYY-MM-DD; negative when past). */
export function daysUntil(date: string, today: string): number {
  const a = new Date(`${today}T12:00:00`).getTime();
  const b = new Date(`${date}T12:00:00`).getTime();
  return Math.round((b - a) / 86_400_000);
}

/** „heute“, „morgen“, „in 3 Tagen“, „seit 2 Tagen überfällig“. */
export function countdown(date: string, today: string): { text: string; tone: "overdue" | "today" | "soon" | "later" } {
  const n = daysUntil(date, today);
  if (n < 0) return { text: t("work.dl.overdue", { n: -n }), tone: "overdue" };
  if (n === 0) return { text: t("work.dl.today"), tone: "today" };
  if (n === 1) return { text: t("work.dl.tomorrow"), tone: "soon" };
  return { text: t("work.dl.inDays", { n }), tone: n <= 3 ? "soon" : "later" };
}

/**
 * When a day is, after its label (`dayText`: „Morgen“ or „Fr., 03.10.“): the countdown only
 * next to a date, so „Morgen“ is not followed by „morgen“.
 */
export function dayWithCountdown(date: string, today: string, dayText: string): string {
  return daysUntil(date, today) <= 1 ? dayText : `${dayText} · ${countdown(date, today).text}`;
}

export const PRESENCE_LABEL: Record<Presence, TKey> = {
  free: "work.team.free",
  tentative: "work.team.tentative",
  elsewhere: "work.team.elsewhere",
  busy: "work.team.busy",
  oof: "work.team.oof",
};

/** Sorted: away first, then busy, tentative, elsewhere, free; by name within. */
export function sortTeam(members: TeamMember[]): TeamMember[] {
  const rank: Record<Presence, number> = { oof: 0, busy: 1, tentative: 2, elsewhere: 3, free: 4 };
  return [...members].sort((a, b) => rank[a.state] - rank[b.state] || a.name.localeCompare(b.name));
}

/** The earliest moment a member's state changes (the widget reloads then). */
export function nextChange(members: TeamMember[]): number | null {
  const times = members.map((m) => (m.until ? new Date(m.until).getTime() : Infinity)).filter(Number.isFinite);
  return times.length ? Math.min(...times) : null;
}

/** The heatmap's values by day. */
export const heatValues = (d: HeatmapData) => new Map(d.days.map(([day, v]) => [day, v]));

// ------------------------------------------------------------------ deadline sources in the UI

/**
 * Due dates from sources the UI knows (the backend's providers come with the `deadlines`
 * part, see `DEADLINE_PROVIDERS` in arcalo_core::dashboard::work). A source registers a
 * function returning its items for the days `from..until`; the widget merges them by date.
 */
export type DeadlineSource = (window: { today: string; until: string }) => Promise<Deadline[]>;
const sources = new Map<string, DeadlineSource>();
const listeners = new Set<() => void>();

export function registerDeadlineSource(name: string, source: DeadlineSource): () => void {
  sources.set(name, source);
  listeners.forEach((f) => f());
  return () => {
    sources.delete(name);
    listeners.forEach((f) => f());
  };
}
export const deadlineSources = () => [...sources];
export const onDeadlineSources = (f: () => void) => (listeners.add(f), () => void listeners.delete(f));

/** Backend items and those of the UI sources, by date (then priority, then title). */
export function mergeDeadlines(a: Deadline[], b: Deadline[]): Deadline[] {
  const seen = new Set(a.map((d) => `${d.source}|${d.key}`));
  return [...a, ...b.filter((d) => !seen.has(`${d.source}|${d.key}`))].sort((x, y) => x.date.localeCompare(y.date) || y.priority - x.priority || x.title.localeCompare(y.title));
}

