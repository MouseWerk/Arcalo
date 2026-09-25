// Quick capture: what a line becomes (mirrors annalo_core::desktop::classify), targets, the
// page picker, due dates in plain words, pasted links and the draft. Pure where possible, so
// it can be tested.

import { isoDay, parseDayInput } from "./format";
import type { CaptureTarget, Page } from "./types";

export type CaptureKind = "zeit" | "task" | "note";

export function captureKind(line: string): CaptureKind {
  const t = line.trim();
  const first = t.split(/\s+/)[0]?.toLowerCase() ?? "";
  if (first === "/zeit" || first === "/time") return "zeit";
  if (/^[-*+] \[ \]/.test(t) || /^todo:?\s+\S/i.test(t)) return "task";
  return "note";
}

/** Hint for one line; `where` names the target („in der heutigen Tagesnotiz“, „in „Kunde X““). */
export function captureHint(kind: CaptureKind, where = "in der heutigen Tagesnotiz"): string {
  if (kind === "zeit") return "Enter bucht die Zeit";
  if (kind === "task") return `Enter legt eine Aufgabe ${where} an`;
  return where === "in der heutigen Tagesnotiz" ? "Enter hängt die Notiz an die heutige Tagesnotiz an" : `Enter speichert die Notiz ${where}`;
}

export const CAPTURE_HINTS: Record<CaptureKind, string> = {
  zeit: captureHint("zeit"),
  task: captureHint("task"),
  note: captureHint("note"),
};

// ------------------------------------------------------------------ targets

/** A target with what the chip shows. */
export interface TargetChoice {
  target: CaptureTarget;
  label: string;
}

export const DAILY: TargetChoice = { target: { kind: "daily" }, label: "Tagesnotiz" };

export const inboxChoice = (title: string): TargetChoice => ({ target: { kind: "inbox" }, label: title || "Posteingang" });

export const sameTarget = (a: CaptureTarget, b: CaptureTarget) => JSON.stringify(a) === JSON.stringify(b);

/** „in der heutigen Tagesnotiz“ / „in „Kunde X““ for hints. */
export function targetPhrase(c: TargetChoice): string {
  if (c.target.kind === "daily") return "in der heutigen Tagesnotiz";
  if (c.target.kind === "meeting") return `in der Besprechungsnotiz „${c.label}“`;
  return `in „${c.label}“`;
}

/**
 * The targets Tab cycles through: daily note, the meeting running now, the page chosen last
 * (when it is none of the others), the inbox.
 */
export function quickTargets(o: { inbox: string; meeting?: TargetChoice | null; last?: TargetChoice | null }): TargetChoice[] {
  const out = [DAILY];
  if (o.meeting) out.push(o.meeting);
  if (o.last && !["daily", "inbox"].includes(o.last.target.kind) && !(o.meeting && sameTarget(o.meeting.target, o.last.target))) out.push(o.last);
  out.push(inboxChoice(o.inbox));
  return out;
}

/** The next quick target after `current` (`dir` -1 goes back); the first when `current` is none of them. */
export function cycleTarget(list: TargetChoice[], current: CaptureTarget, dir: 1 | -1 = 1): TargetChoice {
  const i = list.findIndex((c) => sameTarget(c.target, current));
  if (i < 0) return list[0];
  return list[(i + dir + list.length) % list.length];
}

// ------------------------------------------------------------------- picker

/** Lower case without diacritics (ü → u), for matching. */
export const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/**
 * How well `query` matches `title` (higher is better; null = no match): exact, prefix, a word
 * starting with it, contained, then the letters in order (fuzzy, fewer gaps first).
 */
export function fuzzyScore(query: string, title: string): number | null {
  const q = fold(query.trim());
  const t = fold(title);
  if (!q) return 0;
  if (t === q) return 1000;
  if (t.startsWith(q)) return 900;
  const at = t.indexOf(q);
  if (at >= 0) return (/[\s\-_/.(]/.test(t[at - 1]) ? 700 : 500) - Math.min(at, 99);
  let pos = -1;
  let gaps = 0;
  for (const ch of q) {
    if (ch === " ") continue;
    const next = t.indexOf(ch, pos + 1);
    if (next < 0) return null;
    if (pos >= 0) gaps += next - pos - 1;
    pos = next;
  }
  return Math.max(1, 300 - gaps * 4 - Math.min(t.length, 60));
}

/** Pages for the picker: best matches, recently edited first among equals (all recent ones for an empty query). */
export function rankPages(query: string, pages: Page[], recentIds: number[], limit = 8): Page[] {
  const recency = new Map(recentIds.map((id, i) => [id, i]));
  const rank = (p: Page) => recency.get(p.id) ?? 1000;
  const scored: [Page, number][] = [];
  for (const p of pages) {
    if (p.deleted_at) continue;
    const s = fuzzyScore(query, p.title);
    if (s != null) scored.push([p, s]);
  }
  scored.sort(([a, sa], [b, sb]) => sb - sa || rank(a) - rank(b) || b.updated_at.localeCompare(a.updated_at));
  return scored.slice(0, limit).map(([p]) => p);
}

/** `Neue Seite: Titel` in the picker: the title of the page to create. */
export function newPageTitle(query: string): string | null {
  const m = /^\s*neue seite\s*:\s*(.+)$/i.exec(query);
  return m ? m[1].trim() || null : null;
}

// --------------------------------------------------------------- due dates

const WEEKDAYS: [string[], number][] = [
  [["mo", "montag", "mon", "monday"], 1],
  [["di", "dienstag", "tue", "tuesday"], 2],
  [["mi", "mittwoch", "wed", "wednesday"], 3],
  [["do", "donnerstag", "thu", "thursday"], 4],
  [["fr", "freitag", "fri", "friday"], 5],
  [["sa", "samstag", "sat", "saturday"], 6],
  [["so", "sonntag", "sun", "sunday"], 7],
];

const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

/**
 * A due date in plain words as YYYY-MM-DD: „heute“, „morgen“, „übermorgen“, a weekday („Fr“,
 * „freitag“ – the next one, a week ahead when it is today), „+3“ (days), „+2w“ (weeks), or a
 * date („3.10.“, „03.10.2026“, „2026-10-03“). null when it is none.
 */
export function parseDue(word: string, now = new Date()): string | null {
  const w = fold(word.trim()).replace(/[,;!?]+$/, "");
  if (!w) return null;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (w === "heute" || w === "today") return isoDay(today);
  if (w === "morgen" || w === "tomorrow") return isoDay(addDays(today, 1));
  if (w === "ubermorgen" || w === "uebermorgen") return isoDay(addDays(today, 2));
  const rel = /^\+(\d{1,3})([dtw]?)$/.exec(w);
  if (rel) return isoDay(addDays(today, +rel[1] * (rel[2] === "w" ? 7 : 1)));
  const day = w.replace(/\.$/, "");
  for (const [names, iso] of WEEKDAYS) {
    if (names.includes(day)) {
      const cur = ((today.getDay() + 6) % 7) + 1;
      return isoDay(addDays(today, ((iso - cur + 7) % 7) || 7));
    }
  }
  return parseDayInput(w, now);
}

const DAY_WORDS = String.raw`[Hh]eute|[Mm]orgen|[ÜüUu]e?bermorgen|[Mm]ontag|[Dd]ienstag|[Mm]ittwoch|[Dd]onnerstag|[Ff]reitag|[Ss]amstag|[Ss]onntag|\+\d{1,3}[dtw]?|\d{1,2}\.\d{1,2}\.(?:\d{2}|\d{4})?`;
// Two-letter weekdays only capitalized („Fr“), or after „bis“/„am“: „so“ and „do“ are words too.
const SHORT_DAYS = String.raw`Mo|Di|Mi|Do|Fr|Sa|So`;
const TRAILING_DUE = new RegExp(
  String.raw`\s+(?:(?:(?:bis|am|zum|fällig)\s+((?:${DAY_WORDS}|${SHORT_DAYS}|mo|di|mi|do|fr|sa|so)))|(${DAY_WORDS}|${SHORT_DAYS}))\.?$`,
);

/**
 * One line as it is stored: `due:<words>` becomes `due:YYYY-MM-DD`, and a task ending in a day
 * („todo Angebot senden bis Fr“) gets it as its due date (`… due:2026-09-25`).
 */
export function normalizeLine(line: string, now = new Date()): string {
  if (captureKind(line) === "zeit") return line;
  let out = line.replace(/\bdue:(\S+)/gi, (all, v: string) => {
    const iso = parseDue(v, now);
    return iso ? `due:${iso}` : all;
  });
  if (captureKind(out) === "task" && !/\bdue:\S/i.test(out)) {
    const m = TRAILING_DUE.exec(out);
    const iso = m && parseDue(m[1] ?? m[2], now);
    // Only the words after the task text: "todo Fr" alone stays a task named „Fr“.
    const rest = m ? out.slice(0, m.index).replace(/^\s*(?:[-*+] \[ \]|todo:?)\s*/i, "") : "";
    if (m && iso && rest.trim()) out = `${out.slice(0, m.index)} due:${iso}`;
  }
  return out;
}

/** The whole text as it is stored: lines outside code blocks through [`normalizeLine`]. */
export function normalizeCapture(text: string, now = new Date()): string {
  let fence = false;
  return text
    .split("\n")
    .map((l) => {
      if (/^\s*(```|~~~)/.test(l)) {
        fence = !fence;
        return l;
      }
      return fence ? l : normalizeLine(l, now);
    })
    .join("\n");
}

/** The first due date the text will get, for the chip under the field. */
export function firstDue(text: string, now = new Date()): string | null {
  const m = /\bdue:(\d{4}-\d{2}-\d{2})/.exec(normalizeCapture(text, now));
  return m ? m[1] : null;
}

// -------------------------------------------------------- tags, links, paste

/** `[[query` right before the caret (not yet closed): the query and where `[[` starts. */
export function wikiToken(before: string): { from: number; query: string } | null {
  const at = before.lastIndexOf("[[");
  if (at < 0) return null;
  const query = before.slice(at + 2);
  if (query.includes("]]") || query.includes("\n") || query.length > 80) return null;
  return { from: at, query };
}

/** `#tag` being typed right before the caret (at a word start, at least one letter). */
export function tagToken(before: string): { from: number; query: string } | null {
  const m = /(^|\s)#([\p{L}\p{N}_/-]+)$/u.exec(before);
  if (!m) return null;
  return { from: before.length - m[2].length - 1, query: m[2] };
}

const URL_RE = /^https?:\/\/[^\s<>"]+$/i;

/** A pasted web address alone (no other text). */
export const pastedUrl = (text: string): string | null => {
  const t = text.trim();
  return URL_RE.test(t) ? t : null;
};

/** `[Titel](url)`; brackets in the title are escaped, a missing title keeps the bare address. */
export function markdownLink(title: string | null | undefined, url: string): string {
  const t = (title ?? "").replace(/\s+/g, " ").trim();
  if (!t || t === url) return url;
  return `[${t.replace(/([[\]\\])/g, "\\$1")}](${url.replace(/\)/g, "%29")})`;
}

/** Inserts `snippet` at the caret on a line of its own (images, files): returns text and caret. */
export function insertBlock(text: string, caret: number, snippet: string): { text: string; caret: number } {
  const before = text.slice(0, caret);
  const after = text.slice(caret);
  const pre = before && !before.endsWith("\n") ? "\n" : "";
  const post = after && !after.startsWith("\n") ? "\n" : "";
  const head = before + pre + snippet;
  return { text: head + post + after, caret: head.length };
}

// -------------------------------------------------------------------- draft

const DRAFT_KEY = "annalo.capture.draft";

export interface Draft {
  text: string;
  target: TargetChoice | null;
}

/** The text typed before the window was closed without saving (also across restarts). */
export function loadDraft(): Draft | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    const d = raw ? (JSON.parse(raw) as Draft) : null;
    return d && typeof d.text === "string" ? d : null;
  } catch {
    return null;
  }
}

export function saveDraft(d: Draft | null) {
  try {
    if (!d || !d.text.trim()) localStorage.removeItem(DRAFT_KEY);
    else localStorage.setItem(DRAFT_KEY, JSON.stringify(d));
  } catch {
    /* storage unavailable: the draft lives only while the window does */
  }
}
