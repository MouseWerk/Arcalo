// Task view helpers: due-date groups and [[link]]/#tag segments of a task text.

import { addDays, fmtDate, isoDay, weekdayLabels, weekStart } from "./format";
import { t, type TKey } from "./i18n";
import { MAIL_SCHEME_SOURCE } from "./legacy";
import type { Recurrence, Task } from "./types";

/** What `tasks_compact` answers (`arcalo_core::tasks::TaskTable`): each page once, each task as an array. */
export interface TaskTable {
  pages: Record<string, [string, string | null]>;
  rows: [number, number, number, string, boolean, string | null, number, string, Recurrence | null][];
}

/** The tasks of a {@link TaskTable} as the task objects of `tasks_list`. */
export function fromTaskTable(table: TaskTable): Task[] {
  return table.rows.map(([page_id, ordinal, line, text, done, due, priority, tags, recur]) => {
    const [page_title, page_icon] = table.pages[page_id] ?? ["", null];
    return { page_id, page_title, page_icon, ordinal, line, text, done, due, priority, tags: tags ? tags.split(" ") : [], recur };
  });
}

export type TaskGroup = "overdue" | "today" | "week" | "later" | "none";

const group = (id: TaskGroup, key: TKey) => ({
  id,
  get label() {
    return t(key);
  },
});
export const TASK_GROUPS: { id: TaskGroup; readonly label: string }[] = [
  group("overdue", "tasks.overdue"),
  group("today", "feed.range.today"),
  group("week", "feed.range.week"),
  group("later", "common.later"),
  group("none", "tasks.noDate"),
];

/** Group of a due date (`YYYY-MM-DD`) relative to `now`; the week ends on Sunday. */
export function taskGroup(due: string | null, now: Date): TaskGroup {
  if (!due) return "none";
  const today = isoDay(now);
  if (due < today) return "overdue";
  if (due === today) return "today";
  return due <= isoDay(addDays(weekStart(now), 6)) ? "week" : "later";
}

export type TaskSegment =
  | { kind: "text"; text: string }
  | { kind: "link"; text: string; target: string }
  | { kind: "tag"; text: string; tag: string }
  | { kind: "mail"; text: string; id: string };

/** Splits a task text into plain text, `[[links]]` (alias shown), `#tags` (same rules as the core) and links to e-mails (`[E-Mail: …](arcalo-mail://id)`). */
export function taskSegments(text: string): TaskSegment[] {
  const out: TaskSegment[] = [];
  const push = (t: string) => {
    if (!t) return;
    const last = out[out.length - 1];
    if (last?.kind === "text") last.text += t;
    else out.push({ kind: "text", text: t });
  };
  const re = new RegExp(String.raw`\[\[([^\]]+?)\]\]|\[([^[\]]*)\]\(${MAIL_SCHEME_SOURCE}:\/\/([0-9a-z]+)\/?\)|(^|[\s(])#([\p{L}\p{N}_\-/]+)`, "giu");
  let at = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    push(text.slice(at, m.index));
    at = m.index + m[0].length;
    if (m[1] != null) {
      const inner = m[1];
      const target = inner.split(/[|#]/)[0].trim();
      const alias = inner.includes("|") ? inner.slice(inner.indexOf("|") + 1) : inner;
      if (target) out.push({ kind: "link", text: alias, target });
      else push(m[0]);
      continue;
    }
    if (m[3] != null) {
      out.push({ kind: "mail", text: m[2], id: m[3].toLowerCase() });
      continue;
    }
    push(m[4]);
    const tag = m[5].replace(/[-/]+$/, "");
    if (!tag || /^\d+$/.test(tag)) {
      push(`#${m[5]}`);
      continue;
    }
    out.push({ kind: "tag", text: `#${tag}`, tag: tag.toLowerCase() });
    push(m[5].slice(tag.length));
  }
  push(text.slice(at));
  return out;
}

// ---- repeating tasks and bulk selection (1.13)

/** A short label of a repeat rule: „Wöchentlich · Mo, Mi“, „Alle 3 Tage · bis 31.12.2026“. */
export function recurLabel(r: Recurrence): string {
  const n = Math.max(1, r.interval);
  const key: Record<Recurrence["unit"], TKey> = { day: "tasks.recur.everyDays", week: "tasks.recur.everyWeeks", month: "tasks.recur.everyMonths", year: "tasks.recur.everyYears" };
  const parts = [t(key[r.unit], { n })];
  if (r.unit === "week" && r.weekdays.length) {
    const names = weekdayLabels(1);
    parts.push(r.weekdays.length === 5 && r.weekdays.every((d, i) => d === i) ? t("tasks.recur.workdays") : r.weekdays.map((d) => names[d]).join(", "));
  }
  if ((r.unit === "month" || r.unit === "year") && r.month_day) parts.push(t("tasks.recur.onDay", { d: r.month_day }));
  if (r.when_done) parts.push(t("tasks.recur.whenDone"));
  if (r.until) parts.push(t("tasks.recur.until", { date: fmtDate(`${r.until}T12:00:00`) }));
  return parts.join(" · ");
}

const WEEKDAY_SPEC = ["mo", "tu", "we", "th", "fr", "sa", "su"];

/** The rule as the note shows it (`every:2w,mo,we until:2026-12-31`), as the core writes it. */
export function recurTokens(r: Recurrence): string {
  const n = Math.max(1, r.interval);
  const parts: string[] = [];
  if (r.unit === "day") parts.push(n === 1 ? "daily" : `${n}d`);
  else if (r.unit === "week" && !r.weekdays.length) parts.push(n === 1 ? "weekly" : `${n}w`);
  else if (r.unit === "week") parts.push(...(n > 1 ? [`${n}w`] : []), ...r.weekdays.map((d) => WEEKDAY_SPEC[d]));
  else if (r.unit === "month") parts.push(n === 1 ? "monthly" : `${n}m`, ...(r.month_day ? [String(r.month_day)] : []));
  else parts.push(n === 1 ? "yearly" : `${n}y`, ...(r.month_day ? [String(r.month_day)] : []));
  if (r.when_done) parts.push("done");
  return `every:${parts.join(",")}${r.until ? ` until:${r.until}` : ""}`;
}

/** Monday after the week of `now` (for „Nächste Woche“). */
export const nextMonday = (now: Date) => addDays(weekStart(now, 1), 7);

/**
 * The selection after a click on `key` in the list `order`: plain toggles one, `range` selects
 * from the anchor to it (adding to the selection), as in file managers.
 */
export function selectClick(sel: ReadonlySet<string>, order: readonly string[], key: string, anchor: string | null, range: boolean): Set<string> {
  const next = new Set(sel);
  if (range && anchor != null && order.includes(anchor)) {
    const [a, b] = [order.indexOf(anchor), order.indexOf(key)].sort((x, y) => x - y);
    for (const k of order.slice(a, b + 1)) next.add(k);
    return next;
  }
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}
