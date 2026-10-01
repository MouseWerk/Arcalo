// Start page: the widget catalogue, the boards (tabs) with their presets, the move of the
// widget list of 1.3–1.5 onto a board, export and import of a board, the parts of
// `dashboard_data` each widget needs, the budget forecast and the week bars.

import { addDays, isoDay, weekStart, weekdayLabels } from "./format";
import { t, type TKey } from "./i18n";
import { COLS, clampRect, findFree, settle, type MinSize } from "./dashgrid";
import { emptyQuery, normalizeQuery, type WidgetQuery } from "./dashquery";
import type { Board, Dashboard, DayOverview, GridWidget, LegacyWidget } from "./types";

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
  | "calendar";

export type WidgetGroup = "day" | "time" | "pages" | "tools";

export interface WidgetDef {
  label: TKey;
  hint: TKey;
  group: WidgetGroup;
  size: { w: number; h: number };
  min: MinSize;
  /** Settings a new widget starts with. */
  config: () => Record<string, unknown>;
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
};

export const WIDGET_KINDS = Object.keys(WIDGETS) as WidgetKind[];
export const isKind = (k: string): k is WidgetKind => k in WIDGETS;

export const GROUP_LABELS: Record<WidgetGroup, TKey> = { day: "dash.g.day", time: "dash.g.time", pages: "dash.g.pages", tools: "dash.g.tools" };

/** The blocks of „Heute“ that can be switched off. */
export const TODAY_BLOCKS = ["timeline", "hours", "timer", "tasks", "focus", "actions"] as const;
export type TodayBlock = (typeof TODAY_BLOCKS)[number];
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

export type SizeName = "s" | "m" | "l" | "xl";
export const SIZES: Record<SizeName, { w: number; h: number }> = { s: { w: 3, h: 5 }, m: { w: 6, h: 6 }, l: { w: 8, h: 9 }, xl: { w: 12, h: 9 } };
export const SIZE_NAMES = Object.keys(SIZES) as SizeName[];

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

/** A new widget of `kind` at the first free place of `widgets`. */
export function makeWidget(kind: WidgetKind, widgets: GridWidget[], usedIds: Iterable<string>, at?: { x: number; y: number }): GridWidget {
  const { w, h } = WIDGETS[kind].size;
  const spot = at ?? findFree(widgets, w, h);
  return { id: newId(kind, usedIds), kind, ...spot, w, h, config: WIDGETS[kind].config() };
}

export type PresetName = "start" | "lead" | "minimal";
export const PRESETS: { name: PresetName; label: TKey; hint: TKey }[] = [
  { name: "start", label: "dash.preset.start", hint: "dash.preset.startHint" },
  { name: "lead", label: "dash.preset.lead", hint: "dash.preset.leadHint" },
  { name: "minimal", label: "dash.preset.minimal", hint: "dash.preset.minimalHint" },
];

type Spec = [WidgetKind, number, number, number, number, Record<string, unknown>?];

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
};

/** The widgets of a preset, with ids not in `used`. */
export function presetWidgets(name: PresetName, used: Iterable<string> = []): GridWidget[] {
  const taken = new Set(used);
  return PRESET_SPECS[name].map(([kind, x, y, w, h, extra]) => {
    const id = newId(kind, taken);
    taken.add(id);
    return { id, kind, x, y, w, h, config: { ...WIDGETS[kind].config(), ...extra } };
  });
}

/** The boards of a new start page: „Heute“ and „Projekte“. */
export function defaultDashboard(): Dashboard {
  const today = presetWidgets("start");
  const lead = presetWidgets("lead", today.map((w) => w.id));
  return {
    version: 2,
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
  return { version: 2, boards: [{ id: "heute", name: t("dash.board.today"), widgets: even }], active: "heute", notes };
}

/**
 * The start page as the UI shows it: boards as saved; the old widget list moved onto a board;
 * a start page never saved gets the default boards. Unknown kinds are dropped.
 */
export function loadDashboard(d: Dashboard | null | undefined): Dashboard {
  if (!d || (!d.boards?.length && d.widgets == null)) return defaultDashboard();
  if (!d.boards?.length) return migrateLegacy(d.widgets ?? [], d.note ?? "");
  const boards = d.boards.map((b) => ({ ...b, widgets: b.widgets.filter((w) => isKind(w.kind)).map((w) => clampRect(w, COLS, minOf(w))) }));
  const active = boards.some((b) => b.id === d.active) ? d.active : boards[0].id;
  return { version: 2, boards, active, notes: { ...(d.notes ?? {}) } };
}

/** What `dashboard_save` gets: the boards, without the old list. */
export const toSaved = (d: Dashboard): Dashboard => ({ version: 2, boards: d.boards, active: d.active, notes: d.notes });

// ------------------------------------------------------------------ board edits

export type BoardAction =
  | { type: "add"; kind: WidgetKind }
  | { type: "remove"; id: string }
  | { type: "duplicate"; id: string }
  | { type: "layout"; widgets: GridWidget[] }
  | { type: "config"; id: string; config: Record<string, unknown>; title?: string }
  | { type: "preset"; name: PresetName };

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
      return { ...board, widgets: presetWidgets(a.name, used.filter((id) => !board.widgets.some((w) => w.id === id))) };
  }
}

/** A new board named `name` (unique id), empty or from a preset. */
export function newBoard(boards: Board[], name: string, preset: PresetName | null): Board {
  const base = name.trim().toLowerCase().replace(/[^a-z0-9äöüß]+/g, "-").replace(/^-|-$/g, "") || "board";
  return { id: newId(base, boards.map((b) => b.id)), name: name.trim() || t("dash.board.new"), widgets: preset ? presetWidgets(preset, allWidgetIds(boards)) : [] };
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

/** A board as a file: its name, widgets and the texts of its notes. */
export function exportBoard(board: Board, notes: Record<string, string>): string {
  const own = Object.fromEntries(board.widgets.filter((w) => notes[w.id] != null).map((w) => [w.id, notes[w.id]]));
  return JSON.stringify({ format: BOARD_FORMAT, version: 1, board: { name: board.name, widgets: board.widgets }, notes: own }, null, 2) + "\n";
}

export type ImportResult = { board: Board; notes: Record<string, string> } | { error: TKey };

/** Reads a board file; the board gets a new id and widget ids not in use on `boards`. */
export function importBoard(text: string, boards: Board[]): ImportResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { error: "dash.import.notJson" };
  }
  const r = raw as { format?: unknown; board?: { name?: unknown; widgets?: unknown }; notes?: unknown };
  if (!r || r.format !== BOARD_FORMAT || !r.board || !Array.isArray(r.board.widgets)) return { error: "dash.import.wrongFormat" };
  const used = new Set(allWidgetIds(boards));
  const notesIn = r.notes && typeof r.notes === "object" ? (r.notes as Record<string, unknown>) : {};
  const notes: Record<string, string> = {};
  const widgets: GridWidget[] = [];
  for (const w of r.board.widgets as Partial<GridWidget>[]) {
    if (!w || typeof w.kind !== "string" || !isKind(w.kind)) continue;
    const id = newId(typeof w.id === "string" && w.id.trim() ? w.id.trim() : w.kind, used);
    used.add(id);
    const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
    const def = WIDGETS[w.kind];
    const r0 = clampRect({ x: num(w.x, 0), y: num(w.y, 0), w: num(w.w, def.size.w), h: num(w.h, def.size.h) }, COLS, def.min);
    const config = w.config && typeof w.config === "object" && !Array.isArray(w.config) ? (w.config as Record<string, unknown>) : def.config();
    widgets.push({ id, kind: w.kind, ...r0, title: typeof w.title === "string" ? w.title.slice(0, 60) : undefined, config });
    const note = typeof w.id === "string" ? notesIn[w.id] : undefined;
    if (typeof note === "string") notes[id] = note;
  }
  if (!widgets.length && (r.board.widgets as unknown[]).length) return { error: "dash.import.noWidgets" };
  const name = typeof r.board.name === "string" && r.board.name.trim() ? r.board.name.trim().slice(0, 40) : t("dash.board.imported");
  const board = newBoard(boards, name, null);
  return { board: { ...board, widgets: settle(widgets) }, notes };
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
  | { kind: "suggestions" };

export interface TaskQuery {
  status?: "open" | "done" | "all";
  due?: string;
  tag?: string | null;
  page_id?: number | null;
  priority?: number;
  text?: string;
}

/** What invalidates a part: time entries, tasks, pages, the calendar, focus sessions, the WBS. */
export type DataTopic = "entries" | "tasks" | "pages" | "calendar" | "focus" | "wbs";

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
export function partsOf(w: Pick<GridWidget, "kind" | "config">, today: Date, workdays: number[] = [1, 2, 3, 4, 5]): Part[] {
  const c = configOf(w);
  const monday = isoDay(weekStart(today, 1));
  switch (w.kind as WidgetKind) {
    case "today": {
      const blocks = (c.blocks ?? {}) as Partial<Record<TodayBlock, boolean>>;
      return blocks.timer === false ? [{ kind: "today" }] : [{ kind: "today" }, { kind: "timer_refs" }];
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
      return [];
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
