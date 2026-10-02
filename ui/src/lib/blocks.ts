// Focus blocks (time blocking): what can be dragged into the Kalender, the 15-minute grid, moving
// and resizing, planned hours per day, and opening the „Im Kalender planen…“ picker from anywhere.

import type { BlockLink, CalendarSettings, FocusBlock } from "./types";
import { time } from "./format";

/** Blocks start and end on this grid (minutes), as in the core. */
export const SNAP = 15;
export const DEFAULT_MINUTES = 60;
/** Drag data of a task, issue or page dropped into the Kalender. */
export const PLAN_MIME = "application/x-annalo-plan";
/** A page dragged from the sidebar. */
export const PAGE_MIME = "application/x-annalo-page";

/** Something to plan: a task, a Jira issue or a page. */
export type PlanItem =
  | { kind: "task"; page_id: number; ordinal: number; text: string; page_title?: string }
  | { kind: "issue"; key: string; summary?: string }
  | { kind: "page"; page_id: number; title?: string };

/** Length of a new block (Settings → Kalender). */
export const blockMinutes = (cal: CalendarSettings | undefined | null) => cal?.block_minutes || DEFAULT_MINUTES;

/** Minutes on the grid (nearest). */
export const snapMinutes = (m: number, step = SNAP) => Math.round(m / step) * step;

/** The minute of the day at `y` pixels in a column of `hourPx` per hour, on the grid, inside the day. */
export function minuteAt(y: number, hourPx: number): number {
  return Math.min(24 * 60 - SNAP, Math.max(0, snapMinutes((y / hourPx) * 60)));
}

/** Start and end of a block of `length` minutes dropped at `minute` of `day` (kept inside the day). */
export function dropRange(day: Date, minute: number, length: number): { start: Date; end: Date } {
  const len = Math.max(SNAP, snapMinutes(length));
  const m = Math.max(0, Math.min(snapMinutes(minute), 24 * 60 - len));
  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, m);
  return { start, end: new Date(start.getTime() + len * 60_000) };
}

/** The block moved by `minutes` (and `days`), its length kept. */
export function moved(b: Pick<FocusBlock, "start" | "end">, minutes: number, days = 0): { start: string; end: string } {
  const d = (snapMinutes(minutes) + days * 24 * 60) * 60_000;
  return { start: new Date(new Date(b.start).getTime() + d).toISOString(), end: new Date(new Date(b.end).getTime() + d).toISOString() };
}

/** The block with its end moved by `minutes`; at least one step long. */
export function resized(b: Pick<FocusBlock, "start" | "end">, minutes: number): { start: string; end: string } {
  const start = new Date(b.start).getTime();
  const end = Math.max(start + SNAP * 60_000, new Date(b.end).getTime() + snapMinutes(minutes) * 60_000);
  return { start: b.start, end: new Date(end).toISOString() };
}

/** Planned minutes of `day` (local), blocks clipped to it. */
export function plannedMinutes(blocks: Pick<FocusBlock, "start" | "end">[], day: Date): number {
  const from = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  const to = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime();
  let ms = 0;
  for (const b of blocks) ms += Math.max(0, Math.min(to, new Date(b.end).getTime()) - Math.max(from, new Date(b.start).getTime()));
  return Math.round(ms / 60_000);
}

export function linkOf(item: PlanItem): BlockLink {
  switch (item.kind) {
    case "task":
      return { kind: "task", page_id: item.page_id, ordinal: item.ordinal, text: item.text };
    case "issue":
      return { kind: "issue", key: item.key };
    case "page":
      return { kind: "page", page_id: item.page_id };
  }
}

/** What the item is called (the picker's heading). */
export function itemTitle(item: PlanItem): string {
  switch (item.kind) {
    case "task":
      return item.text;
    case "issue":
      return item.summary ? `${item.key} ${item.summary}` : item.key;
    case "page":
      return item.title ?? "";
  }
}

/** Puts `item` on a drag (the Kalender reads it on drop). */
export function setPlanData(dt: DataTransfer, item: PlanItem) {
  dt.setData(PLAN_MIME, JSON.stringify(item));
  dt.setData("text/plain", itemTitle(item));
  dt.effectAllowed = "copyMove";
}

/** Whether a drag carries something to plan (types only: the data is readable on drop only). */
export const canPlan = (types: readonly string[]) => types.includes(PLAN_MIME) || types.includes(PAGE_MIME);

/** The item of a drop: our own data, or a page from the sidebar. */
export function readPlanData(dt: Pick<DataTransfer, "getData">): PlanItem | null {
  try {
    const raw = dt.getData(PLAN_MIME);
    if (raw) {
      const v = JSON.parse(raw) as PlanItem;
      if (v && (v.kind === "task" || v.kind === "issue" || v.kind === "page")) return v;
    }
  } catch {
    /* not ours */
  }
  const page = Number(dt.getData(PAGE_MIME));
  return Number.isInteger(page) && page > 0 ? { kind: "page", page_id: page } : null;
}

/** `09:00–10:30`. */
export const blockTime = (b: Pick<FocusBlock, "start" | "end">) => `${time(b.start)}–${time(b.end)}`;

/** The block's link in one line: task text, issue key and summary, page title. */
export function linkLabel(b: FocusBlock): string {
  switch (b.link.kind) {
    case "task":
      return b.link.text;
    case "issue":
      return b.issue_summary ? `${b.link.key} ${b.issue_summary}` : b.link.key;
    case "page":
      return b.page_title ?? "";
    default:
      return "";
  }
}

/** Key of a block in the Kalender's selection (meetings use their event key). */
export const blockKey = (id: number) => `block:${id}`;
export const blockIdOf = (key: string | null) => (key?.startsWith("block:") ? Number(key.slice(6)) : null);

// ---- the picker, opened from tasks and issues (one host renders it)

type Listener = (item: PlanItem) => void;
let listener: Listener | null = null;

/** Opens „Im Kalender planen…“ for `item`. */
export function openPlanPicker(item: PlanItem) {
  listener?.(item);
}
export function onPlanPicker(fn: Listener) {
  listener = fn;
  return () => {
    if (listener === fn) listener = null;
  };
}
