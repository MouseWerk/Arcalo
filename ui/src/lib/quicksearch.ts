// Results of the quick-search window (global shortcut, tray „Suchen…“): pages and passages from
// the full-text search, time entries and a few quick actions. Pure, so it can be tested.

import type { Page, SearchHit } from "./types";
import { stripMarkdown } from "./plaintext";
import { t } from "./i18n";

export type QsAction =
  | { type: "page"; pageId: number }
  | { type: "new_page"; title: string }
  | { type: "daily" }
  | { type: "timer_start" }
  | { type: "timer_stop" }
  | { type: "zeit"; line: string }
  | { type: "timesheet" }
  | { type: "issues" }
  | { type: "graph" }
  | { type: "issue"; key: string };

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
  /** „Zeiterfassung verwenden“ (default on): off, no timer, timesheet, `/zeit` or time entries. */
  time?: boolean;
  /** A Jira site is set up: „Issues“ and issue keys are offered. */
  jira?: boolean;
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
  const section = t("qs.actions");
  if (all || matches(q, ["tagesnotiz", "heute", "journal", "daily", "today"]))
    out.push({ id: "daily", section, title: t("capture.daily"), subtitle: t("qs.dailySub"), action: { type: "daily" } });
  if (ctx.jira && !all && matches(q, ["issues", "jira", "tickets"]))
    out.push({ id: "issues", section, title: t("tabs.issues"), subtitle: t("qs.issuesSub"), action: { type: "issues" } });
  if (!all && matches(q, ["graph", "graphansicht", "netz", "links"]))
    out.push({ id: "graph", section, title: t("tabs.graph"), subtitle: t("qs.graphSub"), action: { type: "graph" } });
  if (ctx.jira && /^[A-Z][A-Z0-9_]{1,11}-[1-9][0-9]{0,6}$/.test(q.trim().toUpperCase()))
    out.push({ id: "issue", section, title: t("qs.issue", { key: q.trim().toUpperCase() }), subtitle: t("qs.issueSub"), action: { type: "issue", key: q.trim().toUpperCase() } });
  if (ctx.time === false) return out;
  if (ctx.timerRunning) {
    if (all || matches(q, ["timer", "stoppen", "stop"]))
      out.push({ id: "timer", section, title: t("cmd.stopTimer"), subtitle: t("qs.stopSub"), action: { type: "timer_stop" } });
  } else if ((all || matches(q, ["timer", "starten", "start"])) && ctx.lastRef) {
    out.push({ id: "timer", section, title: t("cmd.startTimer"), subtitle: t("qs.startSub", { ref: ctx.lastRef }), action: { type: "timer_start" } });
  }
  if (!all && matches(q, ["zeiterfassung", "stunden", "woche", "timesheet", "time", "hours", "week"]))
    out.push({ id: "timesheet", section, title: t("ribbon.timesheet"), subtitle: t("qs.timesheetSub"), action: { type: "timesheet" } });
  return out;
}

/** Items for `query`, in display order. */
export function quickItems(query: string, ctx: QsContext): QsItem[] {
  const q = query.trim();
  const time = ctx.time !== false;
  if (time && isZeit(q)) {
    const rest = q.replace(/^\/(zeit|time)\s*/i, "");
    return [{ id: "zeit", section: t("ribbon.timesheet"), title: t("qs.book", { rest: rest || "…" }), subtitle: t("qs.bookSyntax"), action: { type: "zeit", line: q } }];
  }
  if (!q) {
    const recent = ctx.recent.slice(0, 6).map<QsItem>((p) => ({ id: `page-${p.id}`, section: t("dash.w.recent"), title: p.title, icon: p.icon, action: { type: "page", pageId: p.id } }));
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
      const it: QsItem = { id: `page-${h.page_id}`, section: h.kind === "page" ? t("qs.pages") : t("qs.content"), title: h.title, icon: h.icon, snippet: h.kind === "note" ? h.snippet : undefined, action: { type: "page", pageId: h.page_id } };
      byPage.set(h.page_id, it);
      (h.kind === "page" ? pages : passages).push(it);
    } else if (time) {
      entries.push({ id: `te-${h.id}`, section: t("qs.entries"), title: `${h.netzplan_nr}${h.vorgang_nr ? "/" + h.vorgang_nr : ""}`, snippet: h.snippet, action: { type: "timesheet" } });
    }
  }
  const out = [...pages, ...actions(q, ctx), ...passages, ...entries.slice(0, 4)];
  if (!pages.some((p) => p.title.toLowerCase() === q.toLowerCase()))
    out.push({ id: "new", section: t("qs.new"), title: t("qs.newPage", { title: q }), action: { type: "new_page", title: q } });
  return out;
}

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** FTS snippets wrap hits in STX/ETX control characters: escaped HTML with <mark>. */
export const snippetHtml = (sn: string) => esc(stripMarkdown(sn)).replace(/\u0002([^\u0003]*)\u0003/g, "<mark>$1</mark>");
