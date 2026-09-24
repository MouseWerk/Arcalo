// Results of the quick-search window (global shortcut, tray „Suchen…“): pages and passages from
// the full-text search, time entries and a few quick actions. Pure, so it can be tested.

import type { Page, SearchHit } from "./types";
import { stripMarkdown } from "./plaintext";

export type QsAction =
  | { type: "page"; pageId: number }
  | { type: "new_page"; title: string }
  | { type: "daily" }
  | { type: "timer_start" }
  | { type: "timer_stop" }
  | { type: "zeit"; line: string }
  | { type: "timesheet" };

export interface QsItem {
  id: string;
  section: string;
  title: string;
  subtitle?: string;
  /** FTS snippet with STX/ETX around the hits (see `snippetHtml`). */
  snippet?: string;
  /** Page icon name for page results. */
  icon?: string | null;
  action: QsAction;
}

export interface QsContext {
  hits: SearchHit[];
  recent: Page[];
  timerRunning: boolean;
  /** `NP-8801/1020` of the last booking, shown on „Timer starten“. */
  lastRef?: string | null;
}

/** The last query is kept when the window comes back within this time. */
export const KEEP_QUERY_MS = 60_000;

/** Whether the query typed before the window was hidden at `hiddenAt` is still offered at `now`. */
export const keepQuery = (hiddenAt: number | null, now: number) => hiddenAt != null && now - hiddenAt <= KEEP_QUERY_MS;

export const isZeit = (q: string) => /^\/(zeit|time)\b/i.test(q.trim());

const matches = (q: string, words: string[]) => {
  const l = q.toLowerCase();
  return words.some((w) => w.startsWith(l) || (l.length >= 3 && w.includes(l)));
};

function actions(q: string, ctx: QsContext): QsItem[] {
  const out: QsItem[] = [];
  const all = !q;
  if (all || matches(q, ["tagesnotiz", "heute", "journal", "daily"]))
    out.push({ id: "daily", section: "Aktionen", title: "Tagesnotiz", subtitle: "Heutige Tagesnotiz öffnen", action: { type: "daily" } });
  if (ctx.timerRunning) {
    if (all || matches(q, ["timer", "stoppen", "stop"]))
      out.push({ id: "timer", section: "Aktionen", title: "Timer stoppen", subtitle: "Im Hauptfenster buchen", action: { type: "timer_stop" } });
  } else if ((all || matches(q, ["timer", "starten", "start"])) && ctx.lastRef) {
    out.push({ id: "timer", section: "Aktionen", title: "Timer starten", subtitle: `${ctx.lastRef} · zuletzt gebucht`, action: { type: "timer_start" } });
  }
  if (!all && matches(q, ["zeiterfassung", "stunden", "woche", "timesheet"]))
    out.push({ id: "timesheet", section: "Aktionen", title: "Zeiterfassung", subtitle: "Woche und Buchungen", action: { type: "timesheet" } });
  return out;
}

/** Items for `query`, in display order. */
export function quickItems(query: string, ctx: QsContext): QsItem[] {
  const q = query.trim();
  if (isZeit(q)) {
    const rest = q.replace(/^\/(zeit|time)\s*/i, "");
    return [{ id: "zeit", section: "Zeiterfassung", title: `Buchen: ${rest || "…"}`, subtitle: "Netzplan/Vorgang Dauer #Leistungsart Beschreibung", action: { type: "zeit", line: q } }];
  }
  if (!q) {
    const recent = ctx.recent.slice(0, 6).map<QsItem>((p) => ({ id: `page-${p.id}`, section: "Zuletzt bearbeitet", title: p.title, icon: p.icon, action: { type: "page", pageId: p.id } }));
    return [...recent, ...actions(q, ctx)];
  }
  const pages: QsItem[] = [];
  const passages: QsItem[] = [];
  const entries: QsItem[] = [];
  const byPage = new Map<number, QsItem>();
  for (const h of ctx.hits) {
    if (h.kind === "page" || h.kind === "note") {
      const known = byPage.get(h.page_id);
      if (known) {
        if (h.kind === "note") known.snippet ??= h.snippet;
        continue;
      }
      const it: QsItem = { id: `page-${h.page_id}`, section: h.kind === "page" ? "Seiten" : "Inhalte", title: h.title, icon: h.icon, snippet: h.kind === "note" ? h.snippet : undefined, action: { type: "page", pageId: h.page_id } };
      byPage.set(h.page_id, it);
      (h.kind === "page" ? pages : passages).push(it);
    } else {
      entries.push({ id: `te-${h.id}`, section: "Zeiteinträge", title: `${h.netzplan_nr}${h.vorgang_nr ? "/" + h.vorgang_nr : ""}`, snippet: h.snippet, action: { type: "timesheet" } });
    }
  }
  const out = [...pages, ...actions(q, ctx), ...passages, ...entries.slice(0, 4)];
  if (!pages.some((p) => p.title.toLowerCase() === q.toLowerCase()))
    out.push({ id: "new", section: "Neu", title: `Neue Seite „${q}“`, action: { type: "new_page", title: q } });
  return out;
}

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** FTS snippets wrap hits in STX/ETX control characters: escaped HTML with <mark>. */
export const snippetHtml = (sn: string) => esc(stripMarkdown(sn)).replace(/\u0002([^\u0003]*)\u0003/g, "<mark>$1</mark>");
