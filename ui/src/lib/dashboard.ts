// Start-page widgets: catalogue, layout edits (edit mode) and the week bars of the „Woche“ widget.

import { addDays, isoDay } from "./format";
import type { DayOverview, Widget, WidgetKind, WidgetSize } from "./types";

export const WIDGETS: Record<WidgetKind, { label: string; hint: string; size: WidgetSize }> = {
  today: { label: "Heute", hint: "Fällige und überfällige Aufgaben", size: "m" },
  week: { label: "Woche", hint: "Gebuchte Stunden gegen das Tagessoll", size: "m" },
  budgets: { label: "Budgets", hint: "Netzpläne und Vorgänge über der Warnschwelle", size: "s" },
  recent: { label: "Zuletzt bearbeitet", hint: "Die zuletzt geänderten Seiten", size: "m" },
  favorites: { label: "Lesezeichen", hint: "Seiten mit Stern", size: "s" },
  timer: { label: "Timer", hint: "Laufender Timer oder schneller Start", size: "s" },
  note: { label: "Notiz", hint: "Ein Notizzettel für schnelle Gedanken", size: "m" },
  calendar: { label: "Kalender", hint: "Monat mit Tagesnotizen und Buchungen", size: "s" },
  focus: { label: "Fokus", hint: "Fokussitzungen heute und diese Woche, je Vorgang", size: "s" },
  agenda: { label: "Termine", hint: "Die Termine von heute aus dem Kalender", size: "m" },
};

export const WIDGET_KINDS = Object.keys(WIDGETS) as WidgetKind[];

export const SIZE_LABELS: Record<WidgetSize, string> = { s: "Klein", m: "Mittel", l: "Breit" };

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

const WEEKDAY_LABELS = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];

/**
 * Bars for the week starting `monday`: booked minutes per day against the daily target.
 * Gaps count only on past workdays (today is still running, weekends have no target).
 */
export function weekBars(days: DayOverview[], monday: Date, targetHours: number, workdays: number[], today: Date): WeekSummary {
  const byDate = new Map(days.map((d) => [d.date, d.booked_minutes]));
  const target = Math.max(0, targetHours) * 60;
  const todayIso = isoDay(today);
  const raw = WEEKDAY_LABELS.map((label, i) => {
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
