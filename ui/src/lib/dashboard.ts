// Start page: the widget catalogue (built in, plus widgets registered from their own files, see
// `registerWidgetDef` and docs/ARCHITECTURE.md „Start page widgets“), the boards (tabs) with
// their presets, the move of older layouts onto boards, export and import of a board, the parts
// of `dashboard_data` each widget needs, the budget forecast and the week bars.

import { addDays, isoDay, weekStart, weekdayLabels } from "./format";
import { t, type TKey } from "./i18n";
import { COLS, clampRect, compact, findFree, resizeTo, settle, type MinSize } from "./dashgrid";
import { emptyQuery, normalizeQuery, type WidgetQuery } from "./dashquery";
import type { Board, Dashboard, DayOverview, GridWidget, LegacyWidget } from "./types";
import { timeConfig, WORK_TIME_KINDS, workParts, workTopics, type WorkKind, type WorkPart } from "./workwidgets";

// ------------------------------------------------------------------ catalogue

export type WidgetKind =
  | "today"
  | "agenda"
  | "tasks"
  | "week"
  | "budget"
  | "project"
  | "recent"
  | "favorites"
  | "pinned"
  | "note"
  | "embed"
  | "query"
  | "activity"
  | "focus"
  | "links"
  | "proposal"
  | "clock"
  | "review"
  | "suggestions"
  | "timer"
  | "calendar"
  | WorkKind
  | "jira"
  | "jira_query"
  | "jira_sprint";

export type WidgetGroup = "day" | "time" | "pages" | "tools" | "charts";

export interface WidgetDef {
  label: TKey;
  hint: TKey;
  group: WidgetGroup;
  size: { w: number; h: number };
  min: MinSize;
  /** Settings a new widget starts with. */
  config: () => Record<string, unknown>;
  /** About booking time: hidden on the boards and not offered while time tracking is off. */
  time?: boolean;
  /**
   * The `dashboard_data` parts the widget shows, loaded in the batched call once it scrolls
   * into view (built-in kinds are listed in `partsOf`). Widgets without parts read what the UI
   * already has, or load lazily with `useLazyData` (components/dashboard/data.tsx).
   */
  parts?: (config: Record<string, unknown>, ctx: PartContext) => Part[];
  /**
   * Settings keys that hold credentials or point at them (a token, an account of the credential
   * store): never written into an exported board and dropped on import. Keys that look like
   * secrets (token, password, api key, …) are dropped for every widget anyway.
   */
  secrets?: string[];
}

/** What `WidgetDef.parts` gets besides the settings. */
export interface PartContext {
  today: Date;
  /** Monday of this week (YYYY-MM-DD). */
  monday: string;
  workdays: number[];
  /** „Zeiterfassung verwenden“. */
  time: boolean;
}

export const WIDGETS: Record<WidgetKind, WidgetDef> = {
  today: {
    label: "dash.w.today",
    hint: "dash.w.todayHint",
    group: "day",
    size: { w: 8, h: 12 },
    min: { w: 6, h: 8 },
    config: () => ({ blocks: { ...TODAY_BLOCKS_ON } }),
  },
  agenda: { label: "dash.w.agenda", hint: "dash.w.agendaHint", group: "day", size: { w: 4, h: 10 }, min: { w: 3, h: 4 }, config: () => ({ days: 1, sources: [] }) },
  tasks: {
    label: "dash.w.tasks",
    hint: "dash.w.tasksHint",
    group: "day",
    size: { w: 4, h: 8 },
    min: { w: 3, h: 4 },
    config: () => ({ due: "any", tag: "", page: null, priority: 0, add: true }),
  },
  focus: { label: "dash.w.focus", hint: "dash.w.focusHint", group: "day", size: { w: 4, h: 6 }, min: { w: 3, h: 4 }, config: () => ({ week: true }) },
  clock: { label: "dash.w.clock", hint: "dash.w.clockHint", group: "day", size: { w: 3, h: 4 }, min: { w: 2, h: 3 }, config: () => ({ seconds: false, week: true }) },
  review: { label: "dash.w.review", hint: "dash.w.reviewHint", group: "day", size: { w: 4, h: 6 }, min: { w: 3, h: 4 }, config: () => ({ workday: true }) },
  calendar: { label: "dash.w.calendar", hint: "dash.w.calendarHint", group: "day", size: { w: 3, h: 8 }, min: { w: 3, h: 7 }, config: () => ({}) },
  week: { label: "dash.w.week", hint: "dash.w.weekHint", group: "time", size: { w: 6, h: 6 }, min: { w: 3, h: 5 }, config: () => ({ mode: "day" }) },
  timer: { label: "dash.w.timer", hint: "dash.w.timerHint", group: "time", size: { w: 3, h: 5 }, min: { w: 3, h: 3 }, config: () => ({}) },
  budget: {
    label: "dash.w.budget",
    hint: "dash.w.budgetHint",
    group: "time",
    size: { w: 4, h: 6 },
    min: { w: 3, h: 4 },
    config: () => ({ mode: "worst", count: 4, refs: [], forecast: true }),
  },
  project: { label: "dash.w.project", hint: "dash.w.projectHint", group: "time", size: { w: 6, h: 9 }, min: { w: 4, h: 6 }, config: () => ({ netzplan: null }) },
  proposal: { label: "dash.w.proposal", hint: "dash.w.proposalHint", group: "time", size: { w: 4, h: 5 }, min: { w: 3, h: 4 }, config: () => ({}) },
  recent: { label: "dash.w.recent", hint: "dash.w.recentHint", group: "pages", size: { w: 4, h: 6 }, min: { w: 3, h: 3 }, config: () => ({ limit: 8 }) },
  favorites: { label: "dash.w.favorites", hint: "dash.w.favoritesHint", group: "pages", size: { w: 3, h: 6 }, min: { w: 2, h: 3 }, config: () => ({}) },
  pinned: { label: "dash.w.pinned", hint: "dash.w.pinnedHint", group: "pages", size: { w: 3, h: 6 }, min: { w: 2, h: 3 }, config: () => ({ pages: [] }) },
  note: { label: "dash.w.note", hint: "dash.w.noteHint", group: "pages", size: { w: 4, h: 6 }, min: { w: 2, h: 3 }, config: () => ({ mode: "text", page: null }) },
  embed: { label: "dash.w.embed", hint: "dash.w.embedHint", group: "pages", size: { w: 6, h: 8 }, min: { w: 3, h: 3 }, config: () => ({ page: null }) },
  activity: { label: "dash.w.activity", hint: "dash.w.activityHint", group: "pages", size: { w: 4, h: 8 }, min: { w: 3, h: 4 }, config: () => ({ limit: 8 }) },
  query: {
    label: "dash.w.query",
    hint: "dash.w.queryHint",
    group: "tools",
    size: { w: 4, h: 7 },
    min: { w: 2, h: 3 },
    config: () => ({ query: emptyQuery("tasks"), display: "list" }),
  },
  links: { label: "dash.w.links", hint: "dash.w.linksHint", group: "tools", size: { w: 4, h: 4 }, min: { w: 2, h: 3 }, config: () => ({ group: -1 }) },
  suggestions: { label: "dash.w.suggestions", hint: "dash.w.suggestionsHint", group: "tools", size: { w: 4, h: 6 }, min: { w: 3, h: 3 }, config: () => ({ count: 5 }) },
  // 1.7: work and chart widgets (components/dashboard/work.tsx, charts.tsx).
  balance: { label: "work.w.balance", hint: "work.w.balanceHint", group: "time", size: { w: 4, h: 6 }, min: { w: 3, h: 4 }, config: () => ({}) },
  vacation: { label: "work.w.vacation", hint: "work.w.vacationHint", group: "time", size: { w: 4, h: 6 }, min: { w: 3, h: 5 }, config: () => ({}) },
  deadlines: { label: "work.w.deadlines", hint: "work.w.deadlinesHint", group: "day", size: { w: 4, h: 8 }, min: { w: 3, h: 4 }, config: () => ({ days: 14, off: [] }) },
  mail_flags: { label: "work.w.mailFlags", hint: "work.w.mailFlagsHint", group: "day", size: { w: 4, h: 8 }, min: { w: 3, h: 4 }, config: () => ({}) },
  next_meeting: { label: "work.w.nextMeeting", hint: "work.w.nextMeetingHint", group: "day", size: { w: 4, h: 6 }, min: { w: 3, h: 5 }, config: () => ({ sources: [] }) },
  team: { label: "work.w.team", hint: "work.w.teamHint", group: "day", size: { w: 4, h: 7 }, min: { w: 3, h: 4 }, config: () => ({ sources: [] }) },
  chart: {
    label: "work.w.chart",
    hint: "work.w.chartHint",
    group: "charts",
    size: { w: 6, h: 8 },
    min: { w: 3, h: 5 },
    config: () => ({ type: "bar", chart: { source: "pages", page: null, group: "status", value: "count", field: "", weeks: 12 } }),
  },
  heatmap: { label: "work.w.heatmap", hint: "work.w.heatmapHint", group: "charts", size: { w: 8, h: 6 }, min: { w: 4, h: 5 }, config: () => ({ mode: "notes" }) },
  kanban: { label: "work.w.kanban", hint: "work.w.kanbanHint", group: "charts", size: { w: 8, h: 9 }, min: { w: 4, h: 5 }, config: () => ({ page: null }) },
  // Jira (components/dashboard/jira.tsx).
  jira: { label: "dash.w.jira", hint: "dash.w.jiraHint", group: "tools", size: { w: 5, h: 7 }, min: { w: 3, h: 4 }, config: () => ({ limit: 8, columns: ["status"], site: "" }) },
  jira_query: { label: "dash.w.jiraQuery", hint: "dash.w.jiraQueryHint", group: "tools", size: { w: 5, h: 7 }, min: { w: 3, h: 4 }, config: () => ({ query: "", limit: 8, columns: ["status", "assignee"] }) },
  jira_sprint: { label: "dash.w.jiraSprint", hint: "dash.w.jiraSprintHint", group: "tools", size: { w: 5, h: 10 }, min: { w: 3, h: 6 }, config: () => ({ site: "", project: "" }) },
};

/** The built-in kinds (the same list as `WIDGET_KINDS` in crates/annalo-core/src/settings.rs). */
export const WIDGET_KINDS = Object.keys(WIDGETS) as WidgetKind[];

/** Kinds added by `registerWidgetDef`, in the order they registered. */
const REGISTERED: string[] = [];
/** A widget kind: lower case letters, digits and dashes (the backend keeps any such kind). */
export const KIND_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

/**
 * Adds a widget kind to the catalogue (usually through `defineWidget` in
 * components/dashboard/define.ts, which also registers its component). Registering a kind
 * again replaces its definition.
 */
export function registerWidgetDef(kind: string, def: WidgetDef): void {
  if (!KIND_PATTERN.test(kind)) throw new Error(`invalid widget kind: ${kind}`);
  if (!Object.prototype.hasOwnProperty.call(WIDGETS, kind)) REGISTERED.push(kind);
  (WIDGETS as Record<string, WidgetDef>)[kind] = def;
}

/** Built-in and registered kinds. */
export const allKinds = (): WidgetKind[] => [...WIDGET_KINDS, ...(REGISTERED as WidgetKind[])];
export const isKind = (k: string): k is WidgetKind => Object.prototype.hasOwnProperty.call(WIDGETS, k);

// ------------------------------------------------------------------ time tracking off

/**
 * Widgets about booking time („Zeiterfassung verwenden“ off): not offered and not shown. They
 * stay on their boards (hidden), so switching time tracking on brings them back in place.
 */
export const TIME_WIDGETS: ReadonlySet<WidgetKind> = new Set<WidgetKind>(["week", "budget", "timer", "proposal", ...(WORK_TIME_KINDS as ReadonlySet<WidgetKind>)]);
/** Not offered either: the project widget lives on a Netzplan (on a board it stays, without budgets). */
const GALLERY_TIME: ReadonlySet<WidgetKind> = new Set<WidgetKind>([...TIME_WIDGETS, "project"]);

const isTimeKind = (kind: WidgetKind) => TIME_WIDGETS.has(kind) || WIDGETS[kind].time === true;

/**
 * Whether a widget of `kind` (with settings `config`: a chart of the bookings) shows: not a time
 * widget while time tracking is off, and a kind this version knows (widgets of a newer version
 * or a feature not built in stay on the board, hidden, so nothing is lost).
 */
export const widgetShown = (kind: string, time: boolean, config?: Record<string, unknown>) => isKind(kind) && (time || (!isTimeKind(kind) && !timeConfig(kind, config)));

/** The kinds the gallery offers (flagged mails only where Outlook can be asked). */
export const galleryKinds = (time: boolean, mailFlags = false): WidgetKind[] => allKinds().filter((k) => (time || !(GALLERY_TIME.has(k) || isTimeKind(k))) && (mailFlags || k !== "mail_flags"));

/** The widgets a board shows: without hidden ones (see `widgetShown`), closed up (no holes). */
export function shownWidgets(widgets: GridWidget[], time: boolean): GridWidget[] {
  const shown = widgets.filter((w) => widgetShown(w.kind, time, w.config));
  return shown.length === widgets.length ? widgets : compact(shown);
}

/**
 * A layout edited while widgets were hidden, with the hidden ones put back: the edited widgets
 * keep their places, the hidden ones go below whatever they would hit.
 */
export function withHidden(all: GridWidget[], edited: GridWidget[], time: boolean): GridWidget[] {
  const hidden = all.filter((w) => !widgetShown(w.kind, time, w.config) && !edited.some((e) => e.id === w.id));
  return hidden.length ? settle([...edited, ...hidden], edited.map((w) => w.id)) : edited;
}

export const GROUP_LABELS: Record<WidgetGroup, TKey> = { day: "dash.g.day", time: "dash.g.time", pages: "dash.g.pages", tools: "dash.g.tools", charts: "work.g.charts" };

/** The blocks of „Heute“ that can be switched off. */
export const TODAY_BLOCKS = ["timeline", "hours", "timer", "tasks", "focus", "actions"] as const;
export type TodayBlock = (typeof TODAY_BLOCKS)[number];
/** Blocks of „Heute“ about booking time (hidden, and not offered, while time tracking is off). */
export const TODAY_TIME_BLOCKS: ReadonlySet<TodayBlock> = new Set<TodayBlock>(["hours", "timer"]);
const TODAY_BLOCKS_ON: Record<TodayBlock, boolean> = { timeline: true, hours: true, timer: true, tasks: true, focus: true, actions: true };

/** A widget's settings with the kind's defaults for whatever is missing. */
export function configOf(w: Pick<GridWidget, "kind" | "config">): Record<string, unknown> {
  const def = isKind(w.kind) ? WIDGETS[w.kind].config() : {};
  const own = w.config && typeof w.config === "object" ? w.config : {};
  return { ...def, ...own };
}

/** The title a widget shows: its own, else the kind's name. */
export const titleOf = (w: Pick<GridWidget, "kind" | "title">) => w.title?.trim() || (isKind(w.kind) ? t(WIDGETS[w.kind].label) : w.kind);

// ------------------------------------------------------------------ sizes

/**
 * Preset sizes on the 12 columns: small, medium (a third of the width), wide (two thirds),
 * tall (twice as high) and wide and tall. Any other size is set with the handle or the keys.
 */
export type SizeName = "s" | "m" | "w" | "t" | "wt";
export const SIZES: Record<SizeName, { w: number; h: number }> = { s: { w: 3, h: 4 }, m: { w: 4, h: 7 }, w: { w: 8, h: 7 }, t: { w: 4, h: 14 }, wt: { w: 8, h: 14 } };
export const SIZE_NAMES = Object.keys(SIZES) as SizeName[];
export const SIZE_LABELS: Record<SizeName, TKey> = { s: "dash.size.s", m: "dash.size.m", w: "dash.size.w", t: "dash.size.t", wt: "dash.size.wt" };

/** The preset size `name` for a widget of `kind` (at least its minimum). */
export function sizeFor(kind: string, name: SizeName): { w: number; h: number } {
  const min = isKind(kind) ? WIDGETS[kind].min : { w: 1, h: 1 };
  return { w: Math.max(min.w, SIZES[name].w), h: Math.max(min.h, SIZES[name].h) };
}

/** Which preset size a widget has, if any. */
export function sizeName(w: Pick<GridWidget, "kind" | "w" | "h">): SizeName | null {
  return SIZE_NAMES.find((n) => {
    const s = sizeFor(w.kind, n);
    return s.w === w.w && s.h === w.h;
  }) ?? null;
}

export const minOf = (w: Pick<GridWidget, "kind">): MinSize => (isKind(w.kind) ? WIDGETS[w.kind].min : { w: 1, h: 1 });

/** The minimum in a narrow pane: „Heute“ takes the whole width there. */
export const narrowMinOf = (w: Pick<GridWidget, "kind">): MinSize => (w.kind === "today" ? { w: COLS, h: minOf(w).h } : minOf(w));

// ------------------------------------------------------------------ ids and boards

/** `kind`, else `kind-2`, `kind-3`, … not in `used`. */
export function newId(base: string, used: Iterable<string>): string {
  const taken = new Set(used);
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/** Every widget id on every board (widget ids are kept unique across boards: notes use them). */
export const allWidgetIds = (boards: Board[]) => boards.flatMap((b) => b.widgets.map((w) => w.id));

/** The board after widget `id` took the preset size `name` (the others make room). */
export function resizeToPreset(widgets: GridWidget[], id: string, name: SizeName): GridWidget[] {
  const w = widgets.find((x) => x.id === id);
  if (!w) return widgets;
  const sz = sizeFor(w.kind, name);
  return resizeTo(widgets, id, sz.w, sz.h, COLS, minOf(w));
}

/** A new widget of `kind` at the first free place of `widgets`. */
export function makeWidget(kind: WidgetKind, widgets: GridWidget[], usedIds: Iterable<string>, at?: { x: number; y: number }): GridWidget {
  const { w, h } = WIDGETS[kind].size;
  const spot = at ?? findFree(widgets, w, h);
  return { id: newId(kind, usedIds), kind, ...spot, w, h, config: WIDGETS[kind].config() };
}

export type PresetName = "start" | "lead" | "minimal" | "sprint" | "personal";
export const PRESETS: { name: PresetName; label: TKey; hint: TKey }[] = [
  { name: "start", label: "dash.preset.start", hint: "dash.preset.startHint" },
  { name: "lead", label: "dash.preset.lead", hint: "dash.preset.leadHint" },
  { name: "sprint", label: "dash.preset.sprint", hint: "dash.preset.sprintHint" },
  { name: "personal", label: "dash.preset.personal", hint: "dash.preset.personalHint" },
  { name: "minimal", label: "dash.preset.minimal", hint: "dash.preset.minimalHint" },
];

type Spec = [WidgetKind, number, number, number, number, Record<string, unknown>?];

// Registered kinds (components/dashboard/widgets/*) in the presets; a kind that is not
// registered is left out of a preset.
const k = (kind: string) => kind as WidgetKind;

/** The week's tasks, a focus timer, the meetings, a checklist and what colleagues changed. */
const SPRINT: Spec[] = [
  ["tasks", 0, 0, 8, 8, { due: "week" }],
  [k("pomodoro"), 8, 0, 4, 8],
  ["agenda", 0, 8, 4, 7, { days: 7 }],
  [k("checklist"), 4, 8, 4, 7],
  [k("synced"), 8, 8, 4, 7],
];
/** Notes: a scratchpad, the inbox, what was a year ago, writing and a checklist. */
const PERSONAL: Spec[] = [
  ["clock", 0, 0, 4, 4],
  [k("scratchpad"), 0, 4, 4, 10],
  [k("inbox"), 4, 0, 4, 7],
  [k("resurface"), 8, 0, 4, 7],
  [k("writing"), 4, 7, 8, 7],
  [k("checklist"), 0, 14, 4, 7],
];

const PRESET_SPECS: Record<PresetName, Spec[]> = {
  // A day at a glance: Heute and Termine on top, the week, budgets and recent pages below.
  start: [
    ["today", 0, 0, 8, 13],
    ["agenda", 8, 0, 4, 13, { days: 2 }],
    ["week", 0, 13, 6, 7],
    ["budget", 6, 13, 3, 7, { count: 3 }],
    ["recent", 9, 13, 3, 7, { limit: 6 }],
  ],
  // Budgets and bookings per WBS, one project, tasks of the week, meetings, activity.
  lead: [
    ["budget", 0, 0, 6, 8, { count: 5 }],
    ["week", 6, 0, 6, 8, { mode: "wbs" }],
    ["project", 0, 8, 6, 9],
    ["tasks", 6, 8, 6, 9, { due: "week" }],
    ["agenda", 0, 17, 4, 7, { days: 7 }],
    ["activity", 4, 17, 4, 7],
    ["proposal", 8, 17, 4, 7],
  ],
  // Just the essentials.
  minimal: [
    ["clock", 0, 0, 4, 4],
    ["timer", 4, 0, 4, 4],
    ["focus", 8, 0, 4, 4, { week: false }],
    ["tasks", 0, 4, 7, 7, { due: "today" }],
    ["note", 7, 4, 5, 7],
  ],
  sprint: SPRINT,
  personal: PERSONAL,
};

/** The presets without time tracking: the same ideas with tasks, meetings, pages and focus. */
const PRESET_SPECS_NO_TIME: Record<PresetName, Spec[]> = {
  start: [
    ["today", 0, 0, 8, 13],
    ["agenda", 8, 0, 4, 13, { days: 2 }],
    ["tasks", 0, 13, 6, 7, { due: "week" }],
    ["recent", 6, 13, 6, 7, { limit: 6 }],
  ],
  // „Projektleitung“ without budgets: the week's tasks and meetings, what happened, the pages.
  lead: [
    ["tasks", 0, 0, 6, 9, { due: "week" }],
    ["agenda", 6, 0, 6, 9, { days: 7 }],
    ["activity", 0, 9, 4, 8],
    ["recent", 4, 9, 4, 8, { limit: 8 }],
    ["review", 8, 9, 4, 8],
  ],
  minimal: [
    ["clock", 0, 0, 6, 4],
    ["focus", 6, 0, 6, 4, { week: false }],
    ["tasks", 0, 4, 7, 7, { due: "today" }],
    ["note", 7, 4, 5, 7],
  ],
  sprint: SPRINT,
  personal: PERSONAL,
};

/** The widgets of a preset, with ids not in `used` (without time widgets while time tracking is off). */
export function presetWidgets(name: PresetName, used: Iterable<string> = [], time = true): GridWidget[] {
  const taken = new Set(used);
  const specs = (time ? PRESET_SPECS : PRESET_SPECS_NO_TIME)[name].filter(([kind]) => isKind(kind));
  const widgets = specs.map(([kind, x, y, w, h, extra]): GridWidget => {
    const id = newId(kind, taken);
    taken.add(id);
    return { id, kind, x, y, w, h, config: { ...WIDGETS[kind].config(), ...extra } };
  });
  return specs.length === (time ? PRESET_SPECS : PRESET_SPECS_NO_TIME)[name].length ? widgets : settle(widgets);
}

/** The boards of a new start page: „Heute“ and „Projekte“. */
export function defaultDashboard(time = true): Dashboard {
  const today = presetWidgets("start", [], time);
  const lead = presetWidgets("lead", today.map((w) => w.id), time);
  return {
    version: DASHBOARD_VERSION,
    boards: [
      { id: "heute", name: t("dash.board.today"), widgets: today },
      { id: "projekte", name: t("dash.board.projects"), widgets: lead },
    ],
    active: "heute",
    notes: {},
  };
}

// ------------------------------------------------------------------ migration

const LEGACY_WIDTH: Record<LegacyWidget["size"], number> = { s: 3, m: 6, l: 12 };
const LEGACY_KIND: Record<string, WidgetKind> = {
  today: "today",
  week: "week",
  budgets: "budget",
  recent: "recent",
  favorites: "favorites",
  timer: "timer",
  note: "note",
  calendar: "calendar",
  focus: "focus",
  agenda: "agenda",
};

/** The widget list of 1.3–1.5 as one board of the grid: same widgets, same order, same widths. */
export function migrateLegacy(list: LegacyWidget[], note = ""): Dashboard {
  const widgets: GridWidget[] = [];
  const notes: Record<string, string> = {};
  // Row by row like the old grid: a widget that does not fit next to the others starts a row
  // below the tallest one of the current row.
  let x = 0;
  let y = 0;
  let rowH = 0;
  for (const old of list) {
    const kind = LEGACY_KIND[old.kind];
    if (!kind) continue;
    const def = WIDGETS[kind];
    const w = Math.max(def.min.w, LEGACY_WIDTH[old.size] ?? 6);
    const h = def.size.h;
    const config = def.config();
    if (kind === "budget") config.count = old.size === "s" ? 4 : 8;
    if (kind === "recent") config.limit = old.size === "l" ? 8 : old.size === "m" ? 6 : 5;
    const id = newId(old.id || kind, widgets.map((x) => x.id));
    if (x + w > COLS) (x = 0), (y += rowH), (rowH = 0);
    widgets.push({ id, kind, x, y, w, h, config });
    x += w;
    rowH = Math.max(rowH, h);
    if (kind === "note" && note && !Object.keys(notes).length) notes[id] = note;
  }
  // Widgets of a row are equally tall, as they were.
  const rowHeight = new Map<number, number>();
  for (const w of widgets) rowHeight.set(w.y, Math.max(rowHeight.get(w.y) ?? 0, w.h));
  const even = widgets.map((w) => ({ ...w, h: rowHeight.get(w.y)! }));
  return { version: DASHBOARD_VERSION, boards: [{ id: "heute", name: t("dash.board.today"), widgets: even }], active: "heute", notes };
}

/**
 * Version of the saved start page: 0 the one list of 1.3–1.5, 2 boards (1.6), 3 boards whose
 * widgets may be of kinds this version does not know (kept, hidden) and registered kinds (1.7).
 */
export const DASHBOARD_VERSION = 3;

/**
 * The start page as the UI shows it: boards (start pages) as saved with the one last used
 * active; the old widget list moved onto the first board; a start page never saved gets the
 * default boards. Widgets of unknown kinds are kept (hidden by `shownWidgets`), so a layout
 * of a newer version or with a widget of a feature not present survives a save.
 */
export function loadDashboard(d: Dashboard | null | undefined, time = true): Dashboard {
  if (!d || (!d.boards?.length && d.widgets == null)) return defaultDashboard(time);
  if (!d.boards?.length) return migrateLegacy(d.widgets ?? [], d.note ?? "");
  const boards = d.boards.map((b) => ({ ...b, widgets: (b.widgets ?? []).map((w) => (isKind(w.kind) ? clampRect(w, COLS, minOf(w)) : w)) }));
  const active = boards.some((b) => b.id === d.active) ? d.active : boards[0].id;
  return { version: DASHBOARD_VERSION, boards, active, notes: { ...(d.notes ?? {}) } };
}

/** What `dashboard_save` gets: the boards, without the old list. */
export const toSaved = (d: Dashboard): Dashboard => ({ version: DASHBOARD_VERSION, boards: d.boards, active: d.active, notes: d.notes });

// ------------------------------------------------------------------ board edits

export type BoardAction =
  | { type: "add"; kind: WidgetKind }
  | { type: "remove"; id: string }
  | { type: "duplicate"; id: string }
  | { type: "layout"; widgets: GridWidget[] }
  | { type: "config"; id: string; config: Record<string, unknown>; title?: string }
  | { type: "preset"; name: PresetName; time?: boolean };

/** The widgets of `board` after one edit (ids stay unique across `boards`). */
export function editBoard(board: Board, boards: Board[], a: BoardAction): Board {
  const used = allWidgetIds(boards);
  switch (a.type) {
    case "add":
      return { ...board, widgets: [...board.widgets, makeWidget(a.kind, board.widgets, used)] };
    case "remove":
      return { ...board, widgets: settle(board.widgets.filter((w) => w.id !== a.id)) };
    case "duplicate": {
      const src = board.widgets.find((w) => w.id === a.id);
      if (!src) return board;
      const id = newId(src.kind, used);
      // Right next to the original when there is room, else the first free place.
      const right = { x: src.x + src.w, y: src.y };
      const fits = right.x + src.w <= COLS && !board.widgets.some((o) => o.x < right.x + src.w && right.x < o.x + o.w && o.y < src.y + src.h && src.y < o.y + o.h);
      const at = fits ? right : findFree(board.widgets, src.w, src.h);
      const copy: GridWidget = { ...src, id, ...at, config: structuredClone(src.config ?? {}) };
      return { ...board, widgets: settle([...board.widgets, copy], [id]) };
    }
    case "layout":
      return { ...board, widgets: a.widgets };
    case "config":
      return { ...board, widgets: board.widgets.map((w) => (w.id === a.id ? { ...w, config: a.config, title: a.title ?? w.title } : w)) };
    case "preset":
      return { ...board, widgets: presetWidgets(a.name, used.filter((id) => !board.widgets.some((w) => w.id === id)), a.time !== false) };
  }
}

/** A new board named `name` (unique id), empty or from a preset. */
export function newBoard(boards: Board[], name: string, preset: PresetName | null, time = true): Board {
  const base = name.trim().toLowerCase().replace(/[^a-z0-9äöüß]+/g, "-").replace(/^-|-$/g, "") || "board";
  return { id: newId(base, boards.map((b) => b.id)), name: name.trim() || t("dash.board.new"), widgets: preset ? presetWidgets(preset, allWidgetIds(boards), time) : [] };
}

/** Boards with `id` moved one place left (-1) or right (1). */
export function moveBoard(boards: Board[], id: string, delta: -1 | 1): Board[] {
  const i = boards.findIndex((b) => b.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= boards.length) return boards;
  const next = [...boards];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

// ------------------------------------------------------------------ export / import

export const BOARD_FORMAT = "annalo-dashboard";
/** Version of the board file: 1 (1.6), 2 adds `app` and `exported` and leaves out secrets. */
export const BOARD_FILE_VERSION = 2;
/** Extension of a board file (plain JSON; any `.json` file imports too). */
export const BOARD_EXT = "dashboard.json";
/** Most widgets a board (and a board file) holds, as in the backend. */
export const MAX_BOARD_WIDGETS = 40;
const MAX_CONFIG_CHARS = 16_000;
const MAX_NOTE_CHARS = 20_000;

/** Settings keys that look like credentials: never exported or imported, for any widget. */
const SECRET_KEY = /(token|secret|passw|api[-_]?key|apikey|credential|bearer|cookie|session|auth|private[-_]?key)/i;

/** A widget's settings without credentials (see `WidgetDef.secrets`), nested objects included. */
export function publicConfig(kind: string, config: Record<string, unknown> | undefined): Record<string, unknown> {
  const own = new Set(isKind(kind) ? (WIDGETS[kind].secrets ?? []) : []);
  const clean = (v: unknown, top: boolean): unknown => {
    if (Array.isArray(v)) return v.map((x) => clean(x, false));
    if (!v || typeof v !== "object") return v;
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .filter(([key]) => !SECRET_KEY.test(key) && !(top && own.has(key)))
        .map(([key, x]) => [key, clean(x, false)]),
    );
  };
  return clean(config ?? {}, true) as Record<string, unknown>;
}

/** A board as a file: its name, widgets (settings without credentials) and the texts of its notes. */
export function exportBoard(board: Board, notes: Record<string, string>, now = new Date()): string {
  const own = Object.fromEntries(board.widgets.filter((w) => notes[w.id] != null).map((w) => [w.id, notes[w.id]]));
  const widgets = board.widgets.map((w) => ({ ...w, config: publicConfig(w.kind, w.config) }));
  return JSON.stringify({ format: BOARD_FORMAT, version: BOARD_FILE_VERSION, app: "annalo", exported: now.toISOString(), board: { name: board.name, widgets }, notes: own }, null, 2) + "\n";
}

/** File name of an exported board: `annalo-arbeit-2026-10-01.dashboard.json`. */
export function boardFileName(board: Board, now = new Date()): string {
  const slug = board.name.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/ß/g, "ss").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "board";
  return `annalo-${slug}-${isoDay(now)}.${BOARD_EXT}`;
}

/** An imported board, the notes of its widgets and the kinds this version does not know (left out). */
export type ImportResult = { board: Board; notes: Record<string, string>; dropped: string[] } | { error: TKey };

/**
 * Reads and checks a board file: the format and its version, at most `MAX_BOARD_WIDGETS`
 * widgets with a kind, numbers for the place, settings as an object of sensible size and
 * without credentials, titles and notes as text. Unknown kinds are left out and named in
 * `dropped`. The board gets a new id and widget ids not in use on `boards`.
 */
export function importBoard(text: string, boards: Board[]): ImportResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { error: "dash.import.notJson" };
  }
  const r = raw as { format?: unknown; version?: unknown; board?: { name?: unknown; widgets?: unknown }; notes?: unknown };
  if (!r || typeof r !== "object" || r.format !== BOARD_FORMAT || !r.board || typeof r.board !== "object" || !Array.isArray(r.board.widgets)) return { error: "dash.import.wrongFormat" };
  if (r.version != null && (typeof r.version !== "number" || r.version > BOARD_FILE_VERSION)) return { error: "dash.import.newer" };
  if (r.board.widgets.length > MAX_BOARD_WIDGETS) return { error: "dash.import.tooMany" };
  const used = new Set(allWidgetIds(boards));
  const notesIn = r.notes && typeof r.notes === "object" && !Array.isArray(r.notes) ? (r.notes as Record<string, unknown>) : {};
  const notes: Record<string, string> = {};
  const widgets: GridWidget[] = [];
  const dropped: string[] = [];
  for (const w of r.board.widgets as Partial<GridWidget>[]) {
    if (!w || typeof w !== "object" || typeof w.kind !== "string") continue;
    if (!isKind(w.kind)) {
      if (!dropped.includes(w.kind)) dropped.push(w.kind.slice(0, 32));
      continue;
    }
    const wanted = typeof w.id === "string" ? w.id.trim().slice(0, 40) : "";
    const id = newId(wanted || w.kind, used);
    used.add(id);
    const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
    const def = WIDGETS[w.kind];
    const r0 = clampRect({ x: num(w.x, 0), y: num(w.y, 0), w: num(w.w, def.size.w), h: num(w.h, def.size.h) }, COLS, def.min);
    const given = w.config && typeof w.config === "object" && !Array.isArray(w.config) && JSON.stringify(w.config).length <= MAX_CONFIG_CHARS ? (w.config as Record<string, unknown>) : def.config();
    const title = typeof w.title === "string" && w.title.trim() ? w.title.trim().slice(0, 60) : undefined;
    widgets.push({ id, kind: w.kind, ...r0, ...(title ? { title } : {}), config: publicConfig(w.kind, given) });
    const note = typeof w.id === "string" ? notesIn[w.id] : undefined;
    if (typeof note === "string") notes[id] = note.slice(0, MAX_NOTE_CHARS);
  }
  if (!widgets.length && (r.board.widgets as unknown[]).length) return dropped.length ? { error: "dash.import.onlyUnknown" } : { error: "dash.import.noWidgets" };
  const name = typeof r.board.name === "string" && r.board.name.trim() ? r.board.name.trim().slice(0, 40) : t("dash.board.imported");
  const board = newBoard(boards, name, null);
  return { board: { ...board, widgets: settle(widgets) }, notes, dropped };
}

// ------------------------------------------------------------------ data parts

/** One part of a `dashboard_data` request (see annalo_core::dashboard::Part). */
export type Part =
  | { kind: "today" }
  | { kind: "agenda"; days: number }
  | { kind: "tasks"; filter: TaskQuery; limit: number }
  | { kind: "week"; week_start: string }
  | { kind: "budgets" }
  | { kind: "project"; netzplan_id: number | null }
  | { kind: "recent"; limit: number }
  | { kind: "page"; id: number }
  | { kind: "query"; query: WidgetQuery }
  | { kind: "feed"; limit: number }
  | { kind: "focus"; week_start: string }
  | { kind: "proposal"; week_start: string }
  | { kind: "review"; date: string }
  | { kind: "timer_refs" }
  | { kind: "month"; from: string; to: string }
  | { kind: "suggestions" }
  | { kind: "resurface"; seed: number }
  | { kind: "writing"; days: number }
  | { kind: "pulled"; limit: number }
  | { kind: "inbox"; limit: number }
  | WorkPart;

export interface TaskQuery {
  status?: "open" | "done" | "all";
  due?: string;
  tag?: string | null;
  page_id?: number | null;
  priority?: number;
  text?: string;
}

/** What invalidates a part: time entries, tasks, pages, the calendar, focus sessions, the WBS, a Git sync, absences. */
export type DataTopic = "entries" | "tasks" | "pages" | "calendar" | "focus" | "wbs" | "sync" | "absences";

/** A stable key for a part (same settings, same key: loaded once for several widgets). */
export const partKey = (p: Part) => JSON.stringify(p);

export function partTopics(p: Part): DataTopic[] {
  switch (p.kind) {
    case "today":
      return ["entries", "tasks", "pages", "calendar", "focus"];
    case "agenda":
      return ["calendar", "entries"];
    case "tasks":
      return ["tasks", "pages"];
    case "week":
    case "timer_refs":
      return ["entries"];
    case "budgets":
      return ["entries", "wbs"];
    case "project":
      return ["entries", "wbs", "pages", "tasks", "calendar"];
    case "recent":
    case "page":
      return ["pages"];
    case "query":
      return p.query.source === "entries" ? ["entries"] : p.query.source === "events" ? ["calendar", "entries"] : p.query.source === "tasks" ? ["tasks", "pages"] : ["pages"];
    case "feed":
      return ["pages", "tasks", "entries", "focus"];
    case "focus":
      return ["focus", "entries"];
    case "proposal":
      return ["entries", "calendar"];
    case "review":
      return ["entries", "pages", "tasks"];
    case "month":
      return ["entries", "pages", "tasks"];
    case "suggestions":
      return ["entries", "tasks", "pages", "wbs"];
    case "resurface":
    case "writing":
    case "inbox":
      return ["pages"];
    case "pulled":
      return ["sync", "pages"];
    default:
      return workTopics(p);
  }
}

const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);

/** The day of the review widget: yesterday, or the last workday before today. */
export function reviewDay(today: Date, workdays: number[], lastWorkday: boolean): string {
  let d = addDays(today, -1);
  if (lastWorkday && workdays.length) {
    for (let i = 0; i < 7 && !workdays.includes(((d.getDay() + 6) % 7) + 1); i++) d = addDays(d, -1);
  }
  return isoDay(d);
}

/** The parts a widget shows (none for widgets that live on what the UI already has). */
export function partsOf(w: Pick<GridWidget, "kind" | "config">, today: Date, workdays: number[] = [1, 2, 3, 4, 5], time = true): Part[] {
  const c = configOf(w);
  const monday = isoDay(weekStart(today, 1));
  // Time tracking off: nothing is loaded for the hidden time widgets.
  if (!widgetShown(w.kind, time, c)) return [];
  switch (w.kind as WidgetKind) {
    case "today": {
      const blocks = (c.blocks ?? {}) as Partial<Record<TodayBlock, boolean>>;
      return blocks.timer === false || !time ? [{ kind: "today" }] : [{ kind: "today" }, { kind: "timer_refs" }];
    }
    case "agenda":
      return [{ kind: "agenda", days: Math.max(1, Math.min(31, num(c.days, 1))) }];
    case "tasks":
      return [{ kind: "tasks", filter: taskQueryOf(c), limit: 40 }];
    case "week":
      return [{ kind: "week", week_start: monday }];
    case "budget":
      return [{ kind: "budgets" }];
    case "project":
      return [{ kind: "project", netzplan_id: typeof c.netzplan === "number" ? c.netzplan : null }];
    case "recent":
      return [{ kind: "recent", limit: Math.max(1, Math.min(30, num(c.limit, 8))) }];
    case "note":
      return c.mode === "page" && typeof c.page === "number" ? [{ kind: "page", id: c.page }] : [];
    case "embed":
      return typeof c.page === "number" ? [{ kind: "page", id: c.page }] : [];
    case "query":
      return [{ kind: "query", query: normalizeQuery(c.query) }];
    case "activity":
      return [{ kind: "feed", limit: Math.max(1, Math.min(50, num(c.limit, 8))) }];
    case "focus":
      return [{ kind: "focus", week_start: monday }];
    case "proposal":
      return [{ kind: "proposal", week_start: monday }];
    case "review":
      return [{ kind: "review", date: reviewDay(today, workdays, c.workday !== false) }];
    case "timer":
      return [{ kind: "timer_refs" }];
    case "calendar": {
      const first = new Date(today.getFullYear(), today.getMonth(), 1);
      const start = weekStart(first, 1);
      return [{ kind: "month", from: isoDay(start), to: isoDay(addDays(start, 41)) }];
    }
    case "suggestions":
      return [{ kind: "suggestions" }];
    default:
      return (workParts(w.kind, c, today, time) as Part[] | null) ?? (isKind(w.kind) ? (WIDGETS[w.kind].parts?.(c, { today, monday, workdays, time }) ?? []) : []);
  }
}

/** The task filter of an „Aufgaben“ widget's settings. */
export function taskQueryOf(c: Record<string, unknown>): TaskQuery {
  const tag = typeof c.tag === "string" ? c.tag.trim().replace(/^#/, "") : "";
  return {
    status: "open",
    due: typeof c.due === "string" ? c.due : "any",
    tag: tag || null,
    page_id: typeof c.page === "number" ? c.page : null,
    priority: Math.max(0, Math.min(2, num(c.priority, 0))),
  };
}

// ------------------------------------------------------------------ budget forecast

export type ForecastState = "unplanned" | "used" | "idle" | "soon" | "ok";

export interface Forecast {
  state: ForecastState;
  /** Hours per day at the pace of the last weeks. */
  perDay: number;
  /** Planned minus booked (hours). */
  remaining: number;
  /** Days until the rest is used up at that pace. */
  days: number | null;
  /** The day it runs out (YYYY-MM-DD). */
  date: string | null;
}

/**
 * When a budget runs out at the current pace: the hours of the last `burnDays` days per
 * calendar day, applied to what is left. „soon“ within `soonDays`.
 */
export function budgetForecast(b: { planned_hours: number; booked_hours: number }, recentHours: number, burnDays: number, today: Date, soonDays = 14): Forecast {
  const remaining = b.planned_hours - b.booked_hours;
  const perDay = burnDays > 0 ? Math.max(0, recentHours) / burnDays : 0;
  if (b.planned_hours <= 0) return { state: "unplanned", perDay, remaining, days: null, date: null };
  if (remaining <= 1e-9) return { state: "used", perDay, remaining, days: 0, date: null };
  if (perDay <= 1e-9) return { state: "idle", perDay, remaining, days: null, date: null };
  const days = remaining / perDay;
  const date = isoDay(addDays(today, Math.ceil(days)));
  return { state: days <= soonDays ? "soon" : "ok", perDay, remaining, days, date };
}

// ------------------------------------------------------------------ week bars

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
export function weekBars(days: Pick<DayOverview, "date" | "booked_minutes">[], monday: Date, targetHours: number, workdays: number[], today: Date, labels = weekdayLabels(1)): WeekSummary {
  const byDate = new Map(days.map((d) => [d.date, d.booked_minutes]));
  const target = Math.max(0, targetHours) * 60;
  const todayIso = isoDay(today);
  const raw = labels.map((label, i) => {
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
