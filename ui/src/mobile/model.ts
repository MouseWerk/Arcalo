// The companion app's screen state and the pure helpers behind its screens: navigation, what a
// capture stores, the `/zeit` line of the booking form, progress, the week's bookings and the
// note tree. Kept free of React so it can be tested.

import { addDays, fileSize, fmtDate, fmtMinutes, isoDay, parseDurationInput, relative, weekStart } from "../lib/format";
import { parseDue } from "../lib/capture";
import { renderMarkdown } from "../lib/markdown";
import { t } from "../lib/i18n";
import { taskGroup, type TaskGroup } from "../lib/tasks";
import type { GitSyncStatus, PageNode, Task, TimeEntryRow } from "../lib/types";
import type { UpdateStatus } from "./api";

// ------------------------------------------------------------------ navigation

export type Tab = "today" | "tasks" | "time" | "notes";
export const TABS: Tab[] = ["today", "tasks", "time", "notes"];

export type CaptureMode = "note" | "task" | "booking";

/** A screen opened above the tabs (the back button closes it). */
export type Screen =
  | { kind: "capture"; mode: CaptureMode; /** Text to start with (shared from another app). */ text?: string }
  | { kind: "daily"; date: string }
  | { kind: "page"; id: number }
  | { kind: "settings" };

export interface Route {
  tab: Tab;
  stack: Screen[];
}

export type NavAction = { type: "tab"; tab: Tab } | { type: "push"; screen: Screen } | { type: "pop" };

export const START: Route = { tab: "today", stack: [] };

const sameScreen = (a: Screen, b: Screen) => JSON.stringify(a) === JSON.stringify(b);

/** The next route: a tab closes every screen above it, a screen opens once (the same one again
 *  is not stacked), and back closes the top one. */
export function navigate(r: Route, a: NavAction): Route {
  switch (a.type) {
    case "tab":
      return { tab: a.tab, stack: [] };
    case "push": {
      const top = r.stack[r.stack.length - 1];
      if (top && sameScreen(top, a.screen)) return r;
      // A second capture replaces the first (another kind chosen from a list).
      if (top?.kind === "capture" && a.screen.kind === "capture") return { ...r, stack: [...r.stack.slice(0, -1), a.screen] };
      return { ...r, stack: [...r.stack, a.screen] };
    }
    case "pop":
      return r.stack.length ? { ...r, stack: r.stack.slice(0, -1) } : r;
  }
}

/** The screen shown: the top of the stack, else the tab. */
export const current = (r: Route): Screen | Tab => r.stack[r.stack.length - 1] ?? r.tab;

/** What Android's back button does: first close what is open in a screen (an edit mode), then
 *  the top screen, then go to „Heute“, and on „Heute“ send the app to the background (it keeps
 *  its state, as Android apps do since Android 12). It never quits the app. */
export function backAction(r: Route, openLayers: number): "layer" | "pop" | "today" | "background" {
  if (openLayers > 0) return "layer";
  if (r.stack.length) return "pop";
  return r.tab === "today" ? "background" : "today";
}

// --------------------------------------------------------------------- capture

export type DueChoice = "none" | "today" | "tomorrow" | "nextWeek";

/** The due date a quick choice stands for. */
export function dueOf(choice: DueChoice, now = new Date()): string | null {
  if (choice === "none") return null;
  return parseDue(choice === "nextWeek" ? "next week" : choice, now);
}

/** The Markdown a capture stores: a note as written, a task as a checkbox with its due date
 *  (one per line; lines that are tasks already stay). Empty when there is nothing to store. */
export function captureMarkdown(mode: Exclude<CaptureMode, "booking">, text: string, due: string | null): string {
  if (!text.trim()) return "";
  if (mode === "note") return text.trim();
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      const body = l.trim().replace(/^(?:[-*+] \[[ xX]\]|todo:?)\s*/i, "");
      const withDue = due && !/(?<![\p{L}\p{N}_])(due|fällig):\S/iu.test(body) ? `${body} due:${due}` : body;
      return `- [ ] ${withDue}`;
    })
    .join("\n");
}

// ------------------------------------------------------------------- bookings

export interface ZeitDraft {
  /** `NP-8801/1020` or the Netzplan alone. */
  reference: string;
  /** As typed: `1,5`, `1,5h`, `90m`, `1:30`. */
  duration: string;
  /** Leistungsart code, empty for the Netzplan's default. */
  la: string;
  text: string;
  /** YYYY-MM-DD; empty for today. */
  date: string;
}

/** A duration as the `/zeit` line writes it: `2h`, `45m`, `1h30m`. */
export function durationToken(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h && m) return `${h}h${m}m`;
  return h ? `${h}h` : `${m}m`;
}

/** The `/zeit` line of the booking form (the desktop's syntax), or null while the reference or
 *  a valid duration is missing. A description with `#`, `@` or quotes goes in quotes. */
export function zeitLine(d: ZeitDraft, today = isoDay(new Date())): string | null {
  const reference = d.reference.trim().replace(/\s+/g, "");
  const minutes = parseDurationInput(d.duration);
  if (!reference || reference.startsWith("/") || !minutes || minutes < 1 || minutes > 24 * 60) return null;
  const parts = ["/zeit", reference, durationToken(minutes)];
  const la = d.la.trim().replace(/^#/, "");
  if (la) parts.push(`#${la.toUpperCase()}`);
  const text = d.text.trim().replace(/\s+/g, " ");
  if (text) parts.push(/[#@"'„“”‚‘]/.test(text) || /^\d/.test(text) ? `"${text.replace(/["„“”]/g, "")}"` : text);
  if (d.date && d.date !== today) parts.push(`@${d.date}`);
  return parts.join(" ");
}

/** Share of the day's target booked, 0–1 (a day without target counts as full once booked). */
export function progress(booked: number, target: number): number {
  if (target <= 0) return booked > 0 ? 1 : 0;
  return Math.max(0, Math.min(1, booked / target));
}

export interface DayEntries {
  /** YYYY-MM-DD (local). */
  day: string;
  rows: TimeEntryRow[];
  minutes: number;
}

/** This week's bookings (Monday on, or Sunday with `startsOn` 0) per local day, newest day
 *  first and the latest booking first; a running timer is left out. */
export function weekEntries(rows: TimeEntryRow[], now = new Date(), startsOn: 0 | 1 = 1): DayEntries[] {
  const from = isoDay(weekStart(now, startsOn));
  const to = isoDay(now);
  const days = new Map<string, TimeEntryRow[]>();
  for (const r of rows) {
    if (r.status_flag === "running") continue;
    const day = isoDay(new Date(r.start_time));
    if (day < from || day > to) continue;
    days.set(day, [...(days.get(day) ?? []), r]);
  }
  return [...days.entries()]
    .sort(([a], [b]) => (a < b ? 1 : -1))
    .map(([day, list]) => ({
      day,
      rows: list.sort((a, b) => (a.start_time < b.start_time ? 1 : -1)),
      minutes: list.reduce((n, r) => n + (r.duration_minutes ?? 0), 0),
    }));
}

/** `NP-8801/1020` of a booking. */
export const entryReference = (r: Pick<TimeEntryRow, "netzplan_nr" | "vorgang_nr">) => (r.vorgang_nr ? `${r.netzplan_nr}/${r.vorgang_nr}` : r.netzplan_nr);

// ---------------------------------------------------------------------- tasks

export type TaskFilter = "open" | "due" | "done";

export interface TaskSection {
  group: TaskGroup;
  tasks: Task[];
}

/** Open tasks in the groups of the desktop's task view (overdue, today, this week, later,
 *  without date); `due` keeps the groups up to this week. Done tasks come as one section. */
export function taskSections(tasks: Task[], filter: TaskFilter, now = new Date()): TaskSection[] {
  if (filter === "done") return tasks.length ? [{ group: "none", tasks }] : [];
  const order: TaskGroup[] = filter === "due" ? ["overdue", "today", "week"] : ["overdue", "today", "week", "later", "none"];
  const by = new Map<TaskGroup, Task[]>();
  for (const task of tasks) {
    const g = taskGroup(task.due, now);
    if (!order.includes(g)) continue;
    by.set(g, [...(by.get(g) ?? []), task]);
  }
  return order
    .filter((g) => by.has(g))
    .map((group) => ({
      group,
      tasks: (by.get(group) ?? []).sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999") || b.priority - a.priority || a.page_title.localeCompare(b.page_title)),
    }));
}

// ---------------------------------------------------------------------- notes

export interface TreeRow {
  node: PageNode;
  depth: number;
  hasChildren: boolean;
  open: boolean;
}

/** The visible rows of the page tree: the children of open pages below them (trash left out). */
export function treeRows(nodes: PageNode[], open: ReadonlySet<number>, depth = 0): TreeRow[] {
  const out: TreeRow[] = [];
  for (const node of nodes) {
    if (node.deleted_at) continue;
    const hasChildren = node.children.some((c) => !c.deleted_at);
    const isOpen = hasChildren && open.has(node.id);
    out.push({ node, depth, hasChildren, open: isOpen });
    if (isOpen) out.push(...treeRows(node.children, open, depth + 1));
  }
  return out;
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A page's Markdown as HTML for reading: `/zeit` chips as small labels, embedded drawings,
 *  PDFs and other pages as a note that they show on the desktop, the rest as the desktop's
 *  Markdown rendering (sanitized; `[[links]]` clickable). */
export function pageHtml(md: string): string {
  // Properties (front matter) are shown on the desktop; the text starts after them.
  const body = md.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, "");
  const withChips = body.replace(/<time-entry\b([^>]*)>([^<]*)<\/time-entry>/g, (_all, attrs: string, text: string) => {
    const attr = (name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1] ?? "";
    const label = [`${attr("hours")} h`, attr("target"), text.trim()].filter((s) => s && s !== " h").join(" · ");
    return `<span class="m-chip">${escapeHtml(label)}</span>`;
  });
  // Due dates of tasks as a small date label (`due:2026-10-06` is syntax).
  const withDue = withChips.replace(/(^|[\s(])(?:due|fällig):(\d{4}-\d{2}-\d{2})\b/giu, (_all, before: string, day: string) => `${before}<span class="m-chip m-due">${escapeHtml(fmtDate(noonOf(day)))}</span>`);
  const withEmbeds = withDue.replace(/!\[\[([^\]\n]+)\]\]/g, (_all, target: string) => {
    const name = target.split("|")[0].split("#")[0].trim();
    return `\n\n<p class="m-embed">${escapeHtml(t("mob.notes.embed", { name }))}</p>\n\n`;
  });
  // Task boxes can be ticked (A19): enabled, with the page as their label.
  return renderMarkdown(withEmbeds).replace(/<input\b([^>]*)>/g, (tag, attrs: string) => (/type="checkbox"/.test(attrs) ? `<input${attrs.replace(/\s+disabled(="[^"]*")?/, "")}>` : tag));
}

// ------------------------------------------------------------------ tasks in a page (A19)

/** The ticked state of every task box {@link pageHtml} shows, in their order. */
export function taskBoxes(md: string): boolean[] {
  return [...pageHtml(md).matchAll(/<input\b[^>]*type="checkbox"[^>]*>/g)].map((m) => /\schecked\b/.test(m[0]));
}

/** A task line: list marker (also quoted or numbered), the box and its state, the text (with a
 *  Windows line end's `\r`, which `.` would not take). */
const TASK_LINE = /^((?:[ \t]*>[ \t]?)*([ \t]*)(?:[-*+]|\d{1,9}[.)])[ \t]+\[)([ xX])(\](?:[ \t]+|\r?$))([^\n]*)$/;
const FENCE = /^[ \t]*(`{3,}|~{3,})/;

/** Index of each task line of the page's text (front matter and code blocks left out). */
function taskLineIndexes(lines: string[]): number[] {
  const out: number[] = [];
  let i = 0;
  if (/^---\r?$/.test(lines[0] ?? "")) {
    const end = lines.findIndex((l, n) => n > 0 && /^---[ \t]*\r?$/.test(l));
    if (end > 0) i = end + 1;
  }
  let fence: string | null = null;
  for (; i < lines.length; i++) {
    const f = FENCE.exec(lines[i]);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
      continue;
    }
    if (f) fence = f[1];
    else if (TASK_LINE.test(lines[i])) out.push(i);
  }
  return out;
}

export interface TaskToggle {
  md: string;
  /** Line of the task in `md`. */
  line: number;
  done: boolean;
  /** The task's text as the core reads it (no chips): the next date of a repeating one. */
  text: string;
}

/**
 * Ticks off (or opens again) the task of the `index`-th box of the page. The line is found by
 * the boxes the rendering shows: exactly that box changes, or nothing (`null`) when the text no
 * longer has it.
 */
export function toggleTask(md: string, index: number): TaskToggle | null {
  const before = taskBoxes(md);
  if (index < 0 || index >= before.length) return null;
  const lines = md.split("\n");
  const candidates = taskLineIndexes(lines);
  // The line of the same position first; another one only when Markdown counted differently.
  const order = [candidates[index], ...candidates.filter((_, n) => n !== index)].filter((n) => n !== undefined);
  for (const line of order) {
    const m = TASK_LINE.exec(lines[line])!;
    const done = m[3] === " ";
    const next = [...lines];
    next[line] = lines[line].replace(TASK_LINE, (_all, head: string, _indent: string, _state: string, tail: string, rest: string) => `${head}${done ? "x" : " "}${tail}${rest}`);
    const md2 = next.join("\n");
    const after = taskBoxes(md2);
    if (after.length === before.length && after.every((v, n) => (n === index ? v === done && v !== before[n] : v === before[n]))) {
      return { md: md2, line, done, text: taskText(m[5]) };
    }
  }
  return null;
}

/** A task's text without its `/zeit` chips and line end. */
const taskText = (rest: string) => rest.replace(/<time-entry\b[^>]*>[^<]*<\/time-entry>/g, "").replace(/\r$/, "").replace(/ {2,}/g, " ").trim();

/** Only tasks that may have a repeat rule ask the core (as in the desktop's editor, recurTasks.ts). */
export const mayRepeat = (text: string) => /(?:^|\s)(?:every|wdh):|\u{1F501}/iu.test(text);

const DUE_DATE_RE = /((?:due|fällig):|\u{1F4C5}\s?)(\d{4}-\d{2}-\d{2})/iu;

/**
 * Adds the next occurrence of the repeating task on `line` (ticked off) below it and its
 * subtasks, as the desktop's editor does: open, with the date `due` in place of the old one (or
 * added), without its bookings, its block id and an Obsidian done date.
 */
export function withNextOccurrence(md: string, line: number, due: string): string {
  const lines = md.split("\n");
  const m = TASK_LINE.exec(lines[line] ?? "");
  if (!m) return md;
  const cr = lines[line].endsWith("\r") ? "\r" : "";
  let text = m[5].replace(/\r$/, "").replace(/<time-entry\b[^>]*>[^<]*<\/time-entry>/g, "");
  const dated = DUE_DATE_RE.test(text);
  text = text.replace(DUE_DATE_RE, (_all, prefix: string) => `${prefix}${due}`);
  text = text.replace(/\s*\u{2705}\s?\d{4}-\d{2}-\d{2}/gu, "").replace(/\s+\^[A-Za-z0-9-]+\s*$/, "").replace(/ {2,}/g, " ").trimEnd();
  if (!dated) text = `${text} due:${due}`;
  const item = `${m[1]} ]${text.trim() ? ` ${text.trim()}` : ""}${cr}`;
  // Below its subtasks: the lines indented deeper (blank lines between them included).
  const width = (l: string) => /^[ \t]*/.exec(l)![0].replace(/\t/g, "    ").length;
  const own = width(lines[line]);
  let at = line + 1;
  for (let n = line + 1; n < lines.length; n++) {
    if (!lines[n].trim()) continue;
    if (width(lines[n]) <= own) break;
    at = n + 1;
  }
  return [...lines.slice(0, at), item, ...lines.slice(at)].join("\n");
}

// ----------------------------------------------------------------------- sync

export type SyncState = "off" | "never" | "ok" | "error";

/** How the sync stands, for the settings and the start screen. */
export function syncState(enabled: boolean, remote: string, status: GitSyncStatus | null): SyncState {
  if (!enabled || !remote.trim()) return "off";
  if (status?.last_error) return "error";
  return status?.last_at ? "ok" : "never";
}

/** Whether the app syncs again when it comes back to the front (at most every two minutes). */
export function syncDue(lastAt: number | null, now: number, minGapMs = 120_000): boolean {
  return lastAt === null || now - lastAt >= minGapMs;
}

// --------------------------------------------------------------------- updates

/** The line under „Updates“ and in the banner: what the app's updater is doing. */
export function updateLine(s: UpdateStatus): { text: string; detail: string | null } {
  const v = s.offered?.version ?? "";
  const checked = s.last_check ? t("mob.upd.lastCheck", { when: relative(s.last_check) }) : t("mob.upd.never");
  switch (s.phase) {
    case "checking":
      return { text: t("mob.upd.checking"), detail: null };
    case "downloading":
      return { text: t("mob.upd.downloading", { version: v }), detail: s.total ? t("mob.upd.progress", { done: fileSize(s.downloaded), total: fileSize(s.total) }) : fileSize(s.downloaded) };
    case "waiting":
      return { text: s.metered ? t("mob.upd.waitingWifi", { version: v }) : t("mob.upd.waitingOffline", { version: v }), detail: s.offered?.size ? fileSize(s.offered.size) : null };
    case "ready":
      return { text: t("mob.upd.ready", { version: v }), detail: t("mob.upd.readyHint") };
    case "blocked":
      return { text: t("mob.upd.blocked", { version: v }), detail: s.blocked };
    case "error":
      return { text: t("mob.upd.failed"), detail: s.error };
    default:
      return s.offered ? { text: t("mob.upd.available", { version: v }), detail: checked } : { text: t("mob.upd.upToDate"), detail: checked };
  }
}

/** Share of the download, 0–1 (0 while the size is unknown). */
export const updateProgress = (s: UpdateStatus) => (s.total ? Math.max(0, Math.min(1, s.downloaded / s.total)) : 0);

/** A computed CSS color (`rgb(…)`, `rgba(…)`, `#rgb`, `#rrggbb`) as `#rrggbb` for Android's
 *  window; null for anything else. */
export function cssHex(color: string): string | null {
  const c = color.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(c);
  if (hex) return hex[1].length === 3 ? `#${[...hex[1]].map((x) => x + x).join("")}` : c;
  const rgb = /^rgba?\(\s*(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)/.exec(c);
  if (!rgb) return null;
  return `#${rgb
    .slice(1, 4)
    .map((n) => Math.max(0, Math.min(255, Math.round(Number(n)))).toString(16).padStart(2, "0"))
    .join("")}`;
}

/** Days for the booking form's day choice: today and yesterday. */
export const bookingDays = (now = new Date()) => ({ today: isoDay(now), yesterday: isoDay(addDays(now, -1)) });

/** Minutes as hours with the unit, in the style of the settings: „1,50 h“ or „1:30 h“. */
export const hours = (minutes: number) => `${fmtMinutes(minutes)} h`;

/** A local day (YYYY-MM-DD) as a date at its noon, so formatting never slips to another day. */
export const noonOf = (day: string) => new Date(`${day}T12:00:00`);
