// Pure helpers for the `/zeit` autocomplete: where the caret is in the command,
// which Netzplan/Vorgang or Leistungsart options match, and in which order.

import type { ProjectTree, TimeEntryRow } from "../lib/types";
import { t } from "../lib/i18n";

/** The token being completed: the reference (first argument) or a `#Leistungsart`. */
export interface ZeitToken {
  kind: "ref" | "la";
  /** Text typed so far, without the `#`. */
  query: string;
  /** Offset of the token (including `#`) in the text before the caret. */
  from: number;
}

const ZEIT_PREFIX = /^\s*\/(?:zeit|time)\s+/i;
/** A duration as first argument (`1.5h`, `90min`, `1:30`): the page's own Vorgang is booked. */
export const DURATION_RE = /^\d+([.,]\d+)?(h|std|m|min)$|^\d{1,2}:\d{2}$/i;

/** Finds the token at the caret, given the paragraph text before it; null when nothing is to complete. */
export function zeitToken(before: string): ZeitToken | null {
  const m = ZEIT_PREFIX.exec(before);
  if (!m) return null;
  const rest = before.slice(m[0].length);
  // No reference to complete when the command starts with the duration (linked pages).
  if (!/\s/.test(rest)) return DURATION_RE.test(rest) ? null : { kind: "ref", query: rest, from: m[0].length };
  const word = /\S*$/.exec(rest)![0];
  if (word.startsWith("#")) return { kind: "la", query: word.slice(1), from: before.length - word.length };
  return null;
}

export interface RefOption {
  /** `NP-8801/1020`, or `NP-8801` for a Netzplan without Vorgänge. */
  ref: string;
  title: string;
  /** `PRJ-2026-X · Rollout` */
  project: string;
  /** Netzplan description, searched as well. */
  context: string;
  planned: number;
  booked: number | null;
}

/** One option per Vorgang; a Netzplan without Vorgänge is an option itself. */
export function refOptions(wbs: ProjectTree[], booked: (ref: string) => number | null = () => null): RefOption[] {
  const out: RefOption[] = [];
  for (const p of wbs)
    for (const n of p.netzplaene) {
      const project = `${p.project_code} · ${p.name}`;
      const context = n.description;
      if (!n.vorgaenge.length) out.push({ ref: n.netzplan_nr, title: n.description || n.wbs_element, project, context, planned: n.planned_hours, booked: booked(n.netzplan_nr) });
      for (const v of n.vorgaenge) {
        const ref = `${n.netzplan_nr}/${v.vorgang_nr}`;
        out.push({ ref, title: v.description, project, context, planned: v.planned_hours, booked: booked(ref) });
      }
    }
  return out;
}

/** Distinct references of the given entries, most recently started first. */
export function recentRefs(entries: Pick<TimeEntryRow, "netzplan_nr" | "vorgang_nr" | "start_time">[], limit = 5): string[] {
  const out: string[] = [];
  for (const e of [...entries].sort((a, b) => b.start_time.localeCompare(a.start_time))) {
    const ref = e.vorgang_nr ? `${e.netzplan_nr}/${e.vorgang_nr}` : e.netzplan_nr;
    if (!out.some((r) => r.toLowerCase() === ref.toLowerCase())) out.push(ref);
    if (out.length >= limit) break;
  }
  return out;
}

/** Lower case without diacritics; umlauts also as ae/oe/ue. */
function fold(s: string) {
  const lower = s.toLowerCase();
  return `${lower.normalize("NFD").replace(/[\u0300-\u036f]/g, "")} ${lower.replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")}`;
}

const compactRef = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Score of one query word against an option (0 = no match). */
function wordScore(o: RefOption, w: string): number {
  const ref = o.ref.toLowerCase();
  if (ref.startsWith(w)) return 4;
  if (ref.includes(w)) return 3;
  const plain = w.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const text = fold(`${o.title} ${o.context} ${o.project}`);
  if (text.includes(w) || text.includes(plain)) return 2;
  const c = compactRef(w);
  return c && compactRef(o.ref).includes(c) ? 1 : 0;
}

/**
 * Options matching every word of `query` (reference, description, project; umlaut-tolerant,
 * `np8801` finds `NP-8801/…`). Recently used references come first, in recency order.
 */
export function rankRefs(options: RefOption[], query: string, recent: string[] = []): RefOption[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const recentIdx = (ref: string) => {
    const i = recent.findIndex((r) => r.toLowerCase() === ref.toLowerCase());
    return i < 0 ? Infinity : i;
  };
  return options
    .map((o) => {
      let score = 0;
      for (const w of words) {
        const s = wordScore(o, w);
        if (!s) return null;
        score += s;
      }
      return { o, score, r: recentIdx(o.ref) };
    })
    .filter((x): x is { o: RefOption; score: number; r: number } => x !== null)
    .sort((a, b) => a.r - b.r || b.score - a.score || a.o.ref.localeCompare(b.o.ref, "de", { numeric: true }))
    .map((x) => x.o);
}

/** Leistungsarten `[code, description]` whose code starts with, or whose text contains, the query. */
export function rankLeistungsarten(las: [string, string][], query: string): [string, string][] {
  const q = query.toLowerCase().trim();
  if (!q) return las;
  const hit = las.filter(([code, desc]) => code.toLowerCase().includes(q) || fold(desc).includes(q));
  return hit.sort(([a], [b]) => Number(!a.toLowerCase().startsWith(q)) - Number(!b.toLowerCase().startsWith(q)) || a.localeCompare(b));
}

/**
 * `/zeit 2h habe am Mapping gearbeitet`: the first argument is a duration, so the line names
 * no reference (smart /zeit asks the AI, unless the page is linked to a Vorgang).
 */
export function lacksReference(line: string): boolean {
  const m = ZEIT_PREFIX.exec(line);
  if (!m) return false;
  const first = line.slice(m[0].length).trim().split(/\s+/)[0] ?? "";
  return DURATION_RE.test(first);
}

/** Offset in `text` right after `/zeit ` (where a reference goes), or -1. */
export function referenceOffset(text: string): number {
  const m = ZEIT_PREFIX.exec(text);
  return m ? m[0].length : -1;
}

/** Label of a suggestion's confidence (0..1). */
export function confidenceLabel(c: number): string {
  return c >= 0.75 ? t("zeit.conf.high") : c >= 0.45 ? t("zeit.conf.medium") : t("zeit.conf.low");
}

/** Hint text for the remaining plan hours of an option. */
export function remainingHint(o: RefOption, fmt: (h: number) => string): string | undefined {
  if (o.booked == null || o.planned <= 0) return undefined;
  const rest = o.planned - o.booked;
  return rest >= 0 ? t("zeit.hoursOpen", { h: fmt(rest) }) : t("zeit.hoursOver", { h: fmt(-rest) });
}
