// Developer log from the UI side: window errors, rejected promises, `console.error` and
// error toasts go to `logs/annalo.log` (command `devlog_write`). Throttled so a render loop
// cannot flood the file: the same message at most once per 10 s, at most 50 lines a minute.

import { api } from "./api";
import type { DevLogEntry, DevLogLevel } from "./types";

const REPEAT_MS = 10_000;
const PER_MINUTE = 50;

/** Returns a gate that says whether `message` may be written now. */
export function createThrottle(now: () => number = Date.now) {
  const seen = new Map<string, number>();
  let windowStart = 0;
  let count = 0;
  return (message: string): boolean => {
    const t = now();
    const last = seen.get(message);
    if (last !== undefined && t - last < REPEAT_MS) return false;
    if (t - windowStart >= 60_000) {
      windowStart = t;
      count = 0;
    }
    if (count >= PER_MINUTE) return false;
    count++;
    if (seen.size > 200) for (const [k, v] of seen) if (t - v >= REPEAT_MS) seen.delete(k);
    seen.set(message, t);
    return true;
  };
}

const allow = createThrottle();

/** Writes a line from the UI; never throws and never logs its own failure. */
export function logUi(level: DevLogLevel, message: string, source = "ui") {
  const text = message.trim();
  if (!text || !allow(text)) return;
  try {
    api.devlogWrite(level, source, text).catch(() => {});
  } catch {
    /* outside the app (tests): no IPC */
  }
}

/** Text of a thrown value or an `unhandledrejection` reason (with the stack's first frames). */
export function describeError(e: unknown): string {
  if (e instanceof Error) {
    const stack = e.stack?.split("\n").slice(0, 4).join("\n");
    return stack && stack.includes(e.message) ? stack : [e.message, stack].filter(Boolean).join("\n");
  }
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

export type DevLogFilter = "all" | "errors" | "warnings";

export function filterEntries(entries: DevLogEntry[], filter: DevLogFilter): DevLogEntry[] {
  if (filter === "errors") return entries.filter((e) => e.level === "ERROR");
  if (filter === "warnings") return entries.filter((e) => e.level === "WARN");
  return entries;
}

/** Badge tone of a level. */
export const levelTone = (level: string) => (level === "ERROR" ? "danger" : level === "WARN" ? "warning" : "neutral");

/** `24.09.2026 14:05:03` in local time; the raw text when it is no timestamp. */
export function entryTime(time: string): string {
  const d = new Date(time);
  if (!time || Number.isNaN(d.getTime())) return time;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** The entries as plain text for a bug report (oldest first, as in the file). */
export function entriesText(entries: DevLogEntry[]): string {
  return [...entries]
    .reverse()
    .map((e) => [e.time, e.level, e.source && `[${e.source}]`, e.message].filter(Boolean).join(" "))
    .join("\n");
}
