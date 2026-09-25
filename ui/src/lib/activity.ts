// Activity feed („Aktivität“): date ranges, what an event says, and the rows of the timeline
// (day headers and events, for the virtualized list).

import { addDays, dateLocale, decimal, int, isoDay, weekStart } from "./format";
import type { Activity, ActivityKind } from "./types";
import { t, type TKey } from "./i18n";

export type KindGroup = "pages" | "tasks" | "time" | "files" | "focus" | "system";

export const KIND_GROUPS: { id: KindGroup; label: TKey; kinds: ActivityKind[] }[] = [
  { id: "pages", label: "feed.group.pages", kinds: ["page_created", "page_edited"] },
  { id: "tasks", label: "feed.group.tasks", kinds: ["task_added", "task_done"] },
  { id: "time", label: "feed.group.time", kinds: ["entry_created", "entry_changed", "entry_released", "entry_exported"] },
  { id: "files", label: "feed.group.files", kinds: ["file_added"] },
  { id: "focus", label: "feed.group.focus", kinds: ["focus_session"] },
  { id: "system", label: "feed.group.system", kinds: ["backup", "sync"] },
];

export const groupOf = (kind: ActivityKind): KindGroup => KIND_GROUPS.find((g) => g.kinds.includes(kind))?.id ?? "system";

export type RangePreset = "today" | "yesterday" | "week" | "last7" | "month" | "day" | "custom";

export const RANGE_LABELS: Record<Exclude<RangePreset, "day">, TKey> = {
  today: "feed.range.today",
  yesterday: "feed.range.yesterday",
  week: "feed.range.week",
  last7: "feed.range.last7",
  month: "feed.range.month",
  custom: "feed.range.custom",
};

/** Local days `from..=to` (YYYY-MM-DD) of a preset. */
export function presetDays(p: Exclude<RangePreset, "day" | "custom">, now = new Date()): { from: string; to: string } {
  const today = isoDay(now);
  switch (p) {
    case "today":
      return { from: today, to: today };
    case "yesterday": {
      const y = isoDay(addDays(now, -1));
      return { from: y, to: y };
    }
    case "week":
      return { from: isoDay(weekStart(now)), to: today };
    case "last7":
      return { from: isoDay(addDays(now, -6)), to: today };
    case "month":
      return { from: isoDay(addDays(now, -29)), to: today };
  }
}

/** UTC instants of local midnight of `from` and of the day after `to` (exclusive end). */
export function dayBounds(from: string, to: string): { from: string; to: string } {
  const a = new Date(`${from}T00:00:00`);
  const b = new Date(`${to}T00:00:00`);
  b.setDate(b.getDate() + 1);
  return { from: a.toISOString(), to: b.toISOString() };
}

/** „Dienstag, 22. September 2026“. */
export function dayTitle(iso: string, now = new Date()): string {
  const d = new Date(`${iso}T12:00:00`);
  const today = isoDay(now);
  const prefix = iso === today ? `${t("feed.range.today")} · ` : iso === isoDay(addDays(now, -1)) ? `${t("feed.range.yesterday")} · ` : "";
  return prefix + d.toLocaleDateString(dateLocale(), { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

const hours = (minutes: number) => `${decimal(minutes / 60)} h`;
/** „3 Einträge“ (stored by earlier versions) or „3“: the number of entries. */
const entryCount = (title: string) => t("time.entriesCount", { n: Number(/^\d+/.exec(title)?.[0] ?? 1) });
/** The kind of a stored file: a code (`drawing`, `image`, `file`) or the German word of earlier versions. */
function fileKind(detail: string): string {
  const k = detail.toLowerCase();
  if (k === "drawing" || k === "zeichnung") return t("feed.kind.drawing");
  if (k === "image" || k === "bild") return t("feed.kind.image");
  return t("feed.kind.file");
}

/** What an event says: a verb line and the details below it. */
export function describe(a: Activity): { verb: string; title: string; detail: string } {
  const page = a.page_title ?? a.title;
  switch (a.kind) {
    case "page_created":
      return { verb: t("feed.pageCreated"), title: page, detail: a.count > 1 ? `${t("feed.changes", { n: a.count - 1 })} · ~${t("feed.chars", { n: a.amount, count: int(a.amount) })}` : "" };
    case "page_edited":
      return { verb: t("feed.pageEdited"), title: page, detail: `${t("feed.changes", { n: a.count })} · ~${t("feed.chars", { n: a.amount, count: int(a.amount) })}` };
    case "task_added":
      return { verb: t("feed.taskAdded"), title: a.title, detail: a.page_title ?? a.detail };
    case "task_done":
      return { verb: t("feed.taskDone"), title: a.title, detail: a.page_title ?? a.detail };
    case "entry_created":
      return { verb: t("feed.booked", { h: hours(a.amount) }), title: a.title || t("time.noDescription"), detail: [a.reference, sourceLabel(a.detail)].filter(Boolean).join(" · ") };
    case "entry_changed":
      return { verb: t("feed.entryChanged"), title: a.title || a.detail || t("time.entries"), detail: [a.reference, a.amount ? hours(a.amount) : ""].filter(Boolean).join(" · ") };
    case "entry_released":
      return { verb: t("feed.released", { what: entryCount(a.title) }), title: a.detail, detail: a.amount ? hours(a.amount) : "" };
    case "entry_exported":
      return { verb: t("feed.exported", { what: entryCount(a.title) }), title: a.detail, detail: a.amount ? hours(a.amount) : "" };
    case "file_added":
      return { verb: t("feed.fileAdded", { kind: fileKind(a.detail) }), title: a.title, detail: "" };
    case "focus_session":
      return {
        verb: a.detail === "aborted" ? t("feed.focusAborted") : t("feed.focus"),
        title: a.title || a.reference || t("feed.noGoal"),
        detail: [a.reference, t("feed.minutes", { n: a.amount })].filter(Boolean).join(" · "),
      };
    case "backup":
      return { verb: t("set.backup.created"), title: a.title, detail: "" };
    case "sync":
      return { verb: t("set.git.title"), title: a.title, detail: a.detail ? a.detail.slice(0, 10) : "" };
  }
}

function sourceLabel(s: string): string {
  return ({ manual: t("feed.source.manual"), timer: t("feed.source.timer"), slash: "/zeit", auto: t("feed.source.auto") } as Record<string, string>)[s] ?? "";
}

export type FeedRow = { type: "day"; key: string; day: string; count: number } | { type: "item"; key: string; item: Activity };

/** Day headers (local days) followed by their events, newest first as delivered. */
export function feedRows(items: Activity[]): FeedRow[] {
  const rows: FeedRow[] = [];
  let header: Extract<FeedRow, { type: "day" }> | null = null;
  for (const a of items) {
    const day = isoDay(new Date(a.at));
    if (!header || header.day !== day) {
      header = { type: "day", key: `d-${day}`, day, count: 0 };
      rows.push(header);
    }
    header.count++;
    rows.push({ type: "item", key: `a-${a.id}`, item: a });
  }
  return rows;
}

export const DAY_ROW = 44;
export const ITEM_ROW = 56;
export const rowHeight = (r: FeedRow) => (r.type === "day" ? DAY_ROW : ITEM_ROW);

/** The rows to render for a scroll position (with `overscan` extra rows around the view). */
export function visibleRange(offsets: number[], total: number, scrollTop: number, height: number, overscan = 6): [number, number] {
  if (!offsets.length) return [0, 0];
  let lo = 0;
  let hi = offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= scrollTop) lo = mid;
    else hi = mid - 1;
  }
  let end = lo;
  while (end < offsets.length && offsets[end] < Math.min(total, scrollTop + height)) end++;
  return [Math.max(0, lo - overscan), Math.min(offsets.length, end + overscan)];
}

/** Start offset of each row. */
export function rowOffsets(rows: FeedRow[]): { offsets: number[]; total: number } {
  const offsets: number[] = [];
  let y = 0;
  for (const r of rows) {
    offsets.push(y);
    y += rowHeight(r);
  }
  return { offsets, total: y };
}
