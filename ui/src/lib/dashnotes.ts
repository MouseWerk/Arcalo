// Logic of the notes and helper widgets of the start page (components/dashboard/widgets):
// checkboxes of the scratchpad, the items of a checklist, inbox timestamps, the writing bars,
// the seed of the random note and the status lines of backup and Git sync.

/** Line numbers of the task lines (`- [ ]`, `* [x]`, `1. [ ]`) outside code blocks, in order. */
export function taskLines(md: string): number[] {
  const out: number[] = [];
  let fence = false;
  md.split("\n").forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    else if (!fence && /^\s*(?:[-*+]|\d+[.)])\s+\[[ xX]\]/.test(line)) out.push(i);
  });
  return out;
}

/** `md` with task number `n` (counted as `taskLines`) ticked or unticked. */
export function toggleTask(md: string, n: number, done?: boolean): string {
  const line = taskLines(md)[n];
  if (line == null) return md;
  const lines = md.split("\n");
  lines[line] = lines[line].replace(/\[([ xX])\]/, (_, c: string) => ((done ?? c === " ") ? "[x]" : "[ ]"));
  return lines.join("\n");
}

/** Rendered task list items: enabled checkboxes that know their task number. */
export function interactiveTasks(html: string): string {
  let n = 0;
  return html.replace(/<input([^>]*?)type="checkbox"([^>]*)>/g, (_m, a: string, b: string) => {
    const checked = /checked/.test(a + b);
    return `<input type="checkbox" class="dw-scratch-check" data-task="${n++}"${checked ? " checked" : ""}>`;
  });
}

// ------------------------------------------------------------------ checklist

export interface CheckItem {
  id: string;
  text: string;
  done: boolean;
}

/** Most items a checklist keeps (its settings stay small). */
export const MAX_CHECK_ITEMS = 60;

/** The items of a checklist's settings, cleaned up (ids unique, text trimmed and capped). */
export function checkItems(raw: unknown): CheckItem[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: CheckItem[] = [];
  for (const x of raw) {
    if (!x || typeof x !== "object") continue;
    const r = x as Partial<CheckItem>;
    const text = typeof r.text === "string" ? r.text.trim().slice(0, 200) : "";
    if (!text) continue;
    let id = typeof r.id === "string" && r.id ? r.id : `i${out.length + 1}`;
    while (seen.has(id)) id = `${id}x`;
    seen.add(id);
    out.push({ id, text, done: r.done === true });
    if (out.length >= MAX_CHECK_ITEMS) break;
  }
  return out;
}

/** A new item at the end (empty text adds nothing). */
export function addItem(items: CheckItem[], text: string, now = Date.now()): CheckItem[] {
  const tx = text.trim().slice(0, 200);
  if (!tx || items.length >= MAX_CHECK_ITEMS) return items;
  return [...items, { id: now.toString(36) + items.length.toString(36), text: tx, done: false }];
}

export const toggleItem = (items: CheckItem[], id: string) => items.map((i) => (i.id === id ? { ...i, done: !i.done } : i));
export const removeItem = (items: CheckItem[], id: string) => items.filter((i) => i.id !== id);
/** Without the ticked items. */
export const clearDone = (items: CheckItem[]) => items.filter((i) => !i.done);

/** `id` moved one place up (-1) or down (1). */
export function moveItem(items: CheckItem[], id: string, delta: -1 | 1): CheckItem[] {
  const i = items.findIndex((x) => x.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= items.length) return items;
  const next = [...items];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

// ------------------------------------------------------------------ inbox

/** The time of an inbox entry: „23.09.2026, 14:30“ as quick capture writes it. */
export function inboxDate(stamp: string): Date | null {
  const m = /^(\d{2})\.(\d{2})\.(\d{4}), (\d{2}):(\d{2})$/.exec(stamp.trim());
  if (!m) return null;
  const d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]), Number(m[4]), Number(m[5]));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The first line of a capture as plain text (list and task marks, emphasis and links removed). */
export function firstLine(md: string): string {
  const line = md.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("```")) ?? "";
  return line
    .replace(/^(?:[-*+]|\d+[.)])\s+/, "")
    .replace(/^\[[ xX]\]\s*/, "")
    .replace(/^#+\s*/, "")
    .replace(/\*\*|__|`/g, "")
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, a: string, b?: string) => b ?? a)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1");
}

// ------------------------------------------------------------------ writing

export interface WritingBar {
  date: string;
  words: number;
  created: number;
  /** 0..1 of the busiest day. */
  fill: number;
  today: boolean;
}

/** Bars of the writing statistics: one per day, scaled to the busiest one. */
export function writingBars(days: { date: string; words: number; created: number }[], today: string): WritingBar[] {
  const max = Math.max(1, ...days.map((d) => d.words));
  return days.map((d) => ({ ...d, fill: d.words / max, today: d.date === today }));
}

/** The random note of a day: the same all day, another one with „Mischen“. */
// Counted on the calendar (UTC dates), not in hours: the day after the clock change is a day of its own.
export const daySeed = (d: Date) => d.getFullYear() * 1000 + Math.round((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(d.getFullYear(), 0, 1)) / 86_400_000);

// ------------------------------------------------------------------ backup and Git sync

export type Health = "ok" | "warn" | "error" | "off";

/** How old the last backup may be before the widget warns (hours). */
export const BACKUP_STALE_HOURS = 48;

/** The state of the backups: none yet, too old, a destination failing, or fine. */
export function backupHealth(lastAt: string | null, destinations: { health: string; enabled: boolean }[], now = Date.now()): Health {
  if (destinations.some((d) => d.enabled && d.health === "failing")) return "error";
  if (!lastAt) return "warn";
  if (now - new Date(lastAt).getTime() > BACKUP_STALE_HOURS * 3_600_000) return "warn";
  if (destinations.some((d) => d.enabled && d.health === "pending")) return "warn";
  return "ok";
}

/** The state of Git sync: off, failing, waiting with changes, or fine. */
export function syncHealth(s: { enabled: boolean; last_error: string | null; last_at: string | null } | null): Health {
  if (!s || !s.enabled) return "off";
  if (s.last_error) return "error";
  if (!s.last_at) return "warn";
  return "ok";
}
