// Start-page widgets: catalogue, layout edits (edit mode) and the week bars of the „Woche“ widget.

import { addDays, isoDay, weekdayLabels } from "./format";
import type { DayOverview, Widget, WidgetKind, WidgetSize } from "./types";
import { type TKey } from "./i18n";

/** Widget catalogue: `label` and `hint` are catalog keys. */
export const WIDGETS: Record<WidgetKind, { label: TKey; hint: TKey; size: WidgetSize }> = {
  today: { label: "dash.w.today", hint: "dash.w.todayHint", size: "m" },
  week: { label: "dash.w.week", hint: "dash.w.weekHint", size: "m" },
  budgets: { label: "dash.w.budgets", hint: "dash.w.budgetsHint", size: "s" },
  recent: { label: "dash.w.recent", hint: "dash.w.recentHint", size: "m" },
  favorites: { label: "dash.w.favorites", hint: "dash.w.favoritesHint", size: "s" },
  timer: { label: "dash.w.timer", hint: "dash.w.timerHint", size: "s" },
  note: { label: "dash.w.note", hint: "dash.w.noteHint", size: "m" },
  calendar: { label: "dash.w.calendar", hint: "dash.w.calendarHint", size: "s" },
  focus: { label: "dash.w.focus", hint: "dash.w.focusHint", size: "s" },
  agenda: { label: "dash.w.agenda", hint: "dash.w.agendaHint", size: "m" },
};

export const WIDGET_KINDS = Object.keys(WIDGETS) as WidgetKind[];

export const SIZE_LABELS: Record<WidgetSize, TKey> = { s: "dash.size.s", m: "dash.size.m", l: "dash.size.l" };

/** A new id for `kind` not used by `widgets`: `week`, `week-2`, … */
export function newWidgetId(kind: WidgetKind, widgets: Widget[]): string {
  const used = new Set(widgets.map((w) => w.id));
  if (!used.has(kind)) return kind;
  let n = 2;
  while (used.has(`${kind}-${n}`)) n++;
  return `${kind}-${n}`;
}

export type LayoutAction =
  | { type: "add"; kind: WidgetKind }
  | { type: "remove"; id: string }
  /** One step towards the start (-1) or the end (+1). */
  | { type: "move"; id: string; delta: number }
  /** Drag & drop: put `id` in front of `before` (null = at the end). */
  | { type: "drop"; id: string; before: string | null }
  | { type: "resize"; id: string; size: WidgetSize }
  | { type: "reset"; widgets: Widget[] };

/** The widget list after one edit; unknown ids leave it unchanged (same array). */
export function layoutReducer(widgets: Widget[], a: LayoutAction): Widget[] {
  const i = "id" in a ? widgets.findIndex((w) => w.id === a.id) : -1;
  switch (a.type) {
    case "add":
      return [...widgets, { id: newWidgetId(a.kind, widgets), kind: a.kind, size: WIDGETS[a.kind].size }];
    case "remove":
      return i < 0 ? widgets : widgets.filter((w) => w.id !== a.id);
    case "move": {
      const j = i + Math.sign(a.delta);
      if (i < 0 || j < 0 || j >= widgets.length) return widgets;
      const next = [...widgets];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    }
    case "drop": {
      if (i < 0 || a.id === a.before) return widgets;
      const rest = widgets.filter((w) => w.id !== a.id);
      const at = a.before == null ? rest.length : rest.findIndex((w) => w.id === a.before);
      if (at < 0) return widgets;
      const next = [...rest.slice(0, at), widgets[i], ...rest.slice(at)];
      return next.every((w, k) => w === widgets[k]) ? widgets : next;
    }
    case "resize":
      return i < 0 || widgets[i].size === a.size ? widgets : widgets.map((w, k) => (k === i ? { ...w, size: a.size } : w));
    case "reset":
      return a.widgets.map((w) => ({ ...w }));
  }
}

export interface WeekBar {
  /** YYYY-MM-DD */
  date: string;
  /** „Mo“ … „So“ */
  label: string;
  minutes: number;
  /** Bar height, 0..1 of the week's scale (target or the longest day, whichever is larger). */
  fill: number;
  workday: boolean;
  today: boolean;
  future: boolean;
  /** Missing minutes on a past workday (0 otherwise). */
  gap: number;
}

export interface WeekSummary {
  bars: WeekBar[];
  /** Height of the daily target line, 0..1. */
  targetLine: number;
  bookedMinutes: number;
  /** Target of all workdays of the week. */
  targetMinutes: number;
  /** Sum of the gaps of past workdays. */
  gapMinutes: number;
}


/**
 * Bars for the week starting `monday`: booked minutes per day against the daily target.
 * Gaps count only on past workdays (today is still running, weekends have no target).
 */
export function weekBars(days: DayOverview[], monday: Date, targetHours: number, workdays: number[], today: Date): WeekSummary {
  const byDate = new Map(days.map((d) => [d.date, d.booked_minutes]));
  const target = Math.max(0, targetHours) * 60;
  const todayIso = isoDay(today);
  const raw = weekdayLabels(1).map((label, i) => {
    const date = isoDay(addDays(monday, i));
    const minutes = Math.max(0, byDate.get(date) ?? 0);
    const workday = workdays.includes(i + 1);
    const past = date < todayIso;
    const gap = workday && past ? Math.max(0, target - minutes) : 0;
    return { date, label, minutes, workday, today: date === todayIso, future: date > todayIso, gap };
  });
  const scale = Math.max(target, ...raw.map((b) => b.minutes), 1);
  const bars = raw.map((b) => ({ ...b, fill: b.minutes / scale }));
  return {
    bars,
    targetLine: target / scale,
    bookedMinutes: raw.reduce((a, b) => a + b.minutes, 0),
    targetMinutes: target * raw.filter((b) => b.workday).length,
    gapMinutes: raw.reduce((a, b) => a + b.gap, 0),
  };
}
