// A ```query block in a note, rendered live: the dashboard's query engine (arcalo_core::dashboard::
// query) as list, table, count or chart, refreshed on the change events, tasks tickable. Under the
// result: the number of hits, „Quelltext bearbeiten“ and what could not be read. HTML share and
// PDF get a static table (`queryStaticHtml`). Loaded on the first query block only.

import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { AlertTriangle, ListFilter, Pencil } from "lucide-react";
import { api, on } from "../lib/api";
import { useApp } from "../store/app";
import { useTimeTracking, timeTrackingEnabled } from "../lib/timetracking";
import { fmtDate, h1, isoDay, numberLocale, time } from "../lib/format";
import { currentLang, t, useT } from "../lib/i18n";
import { groupLabel } from "../lib/dashquery";
import { backendQuery, parseNoteQuery, sortRows, type NoteQuery } from "../lib/noteQuery";
import type { QueryResult, QueryRow } from "../lib/dashtypes";
import { escapeHtml } from "../lib/htmlExport";
import { BarChart } from "../components/dashboard/tools";
import { PageIcon } from "../components/icons";
import { track } from "./lazyRender";

/** Runs a parsed block: the backend's result with the rows in the block's order. */
export async function runNoteQuery(nq: NoteQuery): Promise<QueryResult> {
  const res = await api.dashboardData(isoDay(new Date()), [{ key: "q", part: { kind: "query", query: backendQuery(nq) } }]);
  const v = res.parts.q as (QueryResult & { error?: string }) | undefined;
  if (!v || typeof v.error === "string") throw new Error(v?.error ?? "query");
  return { ...v, rows: sortRows(nq, v.rows) };
}

/** A task's text without its #tags (as in the dashboard's task lists). */
export const taskText = (text: string) => text.replace(/\s#[\p{L}\p{N}_/-]+/gu, "").trim() || text;

const dateText = (d: string | null) => (d ? fmtDate(d.length === 10 ? `${d}T12:00:00` : d) : "");

/** Header and cells of the table of a result. */
export function queryTable(nq: NoteQuery, rows: QueryRow[]): { head: string[]; cells: (r: QueryRow) => string[] } {
  const q = nq.query;
  switch (q.source) {
    case "pages":
      return q.columns.length
        ? { head: [t("dash.q.col.title"), ...q.columns], cells: (r) => [r.title, ...q.columns.map((c) => r.cells[c] ?? "")] }
        : { head: [t("dash.q.col.title"), t("query.col.changed")], cells: (r) => [r.title, dateText(r.date)] };
    case "tasks":
      return { head: [t("dash.q.col.task"), t("dash.q.col.page"), t("dash.q.col.due")], cells: (r) => [taskText(r.title), r.detail, dateText(r.date)] };
    case "entries":
      return { head: [t("dash.q.col.date"), t("dash.q.col.wbs"), t("dash.q.col.text"), "h"], cells: (r) => [dateText(r.date), r.detail, r.title, r.minutes != null ? h1(r.minutes / 60) : ""] };
    case "events":
      void rows;
      return { head: [t("dash.q.col.date"), t("dash.q.col.title"), t("dash.q.col.place")], cells: (r) => [`${dateText(r.date)} ${r.date ? time(r.date) : ""}`.trim(), r.title, r.detail] };
  }
}

function unitOf(nq: NoteQuery, n: number): string {
  switch (nq.query.source) {
    case "tasks":
      return n === 1 ? t("dash.q.unit.task") : t("dash.q.unit.tasks");
    case "events":
      return n === 1 ? t("dash.q.unit.meeting") : t("dash.q.unit.meetings");
    case "entries":
      return "h";
    default:
      return n === 1 ? t("dash.q.unit.page") : t("dash.q.unit.pages");
  }
}

/** The result as static HTML (HTML share): always a table; counts and charts as their numbers. */
export async function queryStaticHtml(src: string): Promise<string> {
  const nq = parseNoteQuery(src);
  if (nq.query.source === "entries" && !timeTrackingEnabled()) return `<p class="query-note">${escapeHtml(t("query.timeOff"))}</p>`;
  let res: QueryResult;
  try {
    res = await runNoteQuery(nq);
  } catch (e) {
    return `<p class="missing">${escapeHtml(t("query.failed"))}: ${escapeHtml(e instanceof Error ? e.message : String(e))}</p>`;
  }
  const table = (head: string[], rows: string[][]) =>
    `<table class="query"><thead><tr>${head.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  if (nq.display === "count") {
    const value = nq.query.source === "entries" ? h1((res.minutes ?? 0) / 60) : res.total.toLocaleString(numberLocale());
    return table([t("query.count")], [[`${value} ${unitOf(nq, res.total)}`]]);
  }
  if (nq.display === "chart") return table([nq.query.group, nq.query.source === "entries" ? "h" : t("query.count")], res.groups.map((g) => [groupLabel(g.label, nq.query.group, currentLang()), g.value.toLocaleString(numberLocale())]));
  if (!res.rows.length) return `<p class="query-note">${escapeHtml(t("dash.q.none"))}</p>`;
  const { head, cells } = queryTable(nq, res.rows);
  const status = nq.query.source === "tasks" ? (r: QueryRow) => (r.done ? "[x] " : "[ ] ") : () => "";
  return table(head, res.rows.map((r) => cells(r).map((c, i) => (i === 0 ? status(r) + c : c))));
}

// ------------------------------------------------------------------ live view

function TaskBox({ row, onChanged }: { row: QueryRow; onChanged: () => void }) {
  const [done, setDone] = useState(!!row.done);
  const [busy, setBusy] = useState(false);
  useEffect(() => setDone(!!row.done), [row.done]);
  const toggle = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (row.page_id == null || row.ordinal == null) return;
    setBusy(true);
    try {
      await api.setTaskDone(row.page_id, row.ordinal, !done, row.title);
      setDone(!done);
      onChanged();
    } catch (err) {
      useApp.getState().error(t("dash.taskFailed"), err);
    } finally {
      setBusy(false);
    }
  };
  return <button type="button" role="checkbox" aria-checked={done} aria-label={t("dash.taskDone", { text: row.title })} className={`qb-check${done ? " done" : ""}`} disabled={busy} onClick={toggle} />;
}

const openRow = (r: QueryRow, e: React.MouseEvent | React.KeyboardEvent) => {
  if (r.page_id != null) useApp.getState().openPage(r.page_id, { newTab: e.ctrlKey || e.metaKey });
};

function Result({ nq, res, reload }: { nq: NoteQuery; res: QueryResult; reload: () => void }) {
  const tasks = nq.query.source === "tasks";
  if (nq.display === "count") {
    const hours = nq.query.source === "entries";
    return (
      <div className="qb-count">
        <span className="num qb-count-value">{hours ? h1((res.minutes ?? 0) / 60) : res.total.toLocaleString(numberLocale())}</span>
        <span className="muted">{unitOf(nq, res.total)}</span>
        {hours && <span className="faint small">{t("dash.q.entries", { n: res.total })}</span>}
      </div>
    );
  }
  if (!res.total)
    return (
      <div className="qb-empty muted">
        <ListFilter size={14} /> {t("dash.q.none")}
      </div>
    );
  if (nq.display === "chart") return <BarChart groups={res.groups.map((g) => ({ ...g, label: groupLabel(g.label, nq.query.group, currentLang()) }))} unit={nq.query.source === "entries" ? "h" : ""} label={t("query.title")} />;
  if (nq.display === "table") {
    const { head, cells } = queryTable(nq, res.rows);
    return (
      <div className="qb-table-wrap">
        <table className="qb-table">
          <thead>
            <tr>
              {tasks && <th aria-label={t("query.done")} />}
              {head.map((h, i) => (
                <th key={i} scope="col">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {res.rows.map((r) => (
              <tr key={r.key} className={r.done ? "done" : ""}>
                {tasks && (
                  <td className="qb-check-cell">
                    <TaskBox row={r} onChanged={reload} />
                  </td>
                )}
                {cells(r).map((c, i) => (
                  <td
                    key={i}
                    className={i === 0 ? "qb-main" : "faint"}
                    onClick={i === 0 ? (e) => openRow(r, e) : undefined}
                    tabIndex={i === 0 && r.page_id != null ? 0 : undefined}
                    onKeyDown={i === 0 ? (e) => e.key === "Enter" && openRow(r, e) : undefined}
                  >
                    {c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  return (
    <ul className="qb-list">
      {res.rows.map((r) => (
        <li key={r.key} className={r.done ? "done" : ""}>
          {tasks && <TaskBox row={r} onChanged={reload} />}
          {nq.query.source === "pages" && <PageIcon name={r.icon} size={14} />}
          <button type="button" className="qb-row" onClick={(e) => openRow(r, e)}>
            <span className="ellipsis">{nq.query.source === "tasks" ? taskText(r.title) : r.title}</span>
          </button>
          {r.detail && nq.query.source !== "pages" && <span className="faint small ellipsis qb-detail">{r.detail}</span>}
          {r.minutes != null && nq.query.source === "entries" && <span className="num small">{h1(r.minutes / 60)} h</span>}
          {r.date && <span className="faint small num qb-when">{dateText(r.date)}</span>}
        </li>
      ))}
    </ul>
  );
}

export interface QueryBlockProps {
  source: string;
  /** Shows the source (the caret goes into the code block); null outside the editor. */
  onEdit: (() => void) | null;
  editing: boolean;
}

export function QueryBlock({ source, onEdit, editing }: QueryBlockProps) {
  useT();
  const timeOn = useTimeTracking();
  const [nq, setNq] = useState(() => parseNoteQuery(source));
  const [state, setState] = useState<{ res?: QueryResult; error?: string; loading: boolean }>({ loading: true });
  const seq = useRef(0);
  // Typing in the source: parse again after a short pause.
  useEffect(() => {
    const id = window.setTimeout(() => setNq((cur) => (JSON.stringify(cur) === JSON.stringify(parseNoteQuery(source)) ? cur : parseNoteQuery(source))), 300);
    return () => window.clearTimeout(id);
  }, [source]);
  const blocked = nq.query.source === "entries" && !timeOn;
  const load = useCallback(() => {
    if (blocked) return;
    const n = ++seq.current;
    void track(
      runNoteQuery(nq).then(
        (res) => n === seq.current && setState({ res, loading: false }),
        (e) => n === seq.current && setState({ error: e instanceof Error ? e.message : String(e), loading: false }),
      ),
    );
  }, [nq, blocked]);
  useEffect(load, [load]);
  // Refresh on the change events (debounced).
  useEffect(() => {
    let timer = 0;
    const soon = (ms = 400) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(load, ms);
    };
    const events = nq.query.source === "entries" ? ["data://entries"] : nq.query.source === "events" ? ["calendar://synced", "data://entries"] : ["data://tasks", "data://pages", "gitsync://pulled"];
    const un = events.map((ev) => on(ev, () => soon()));
    const saved = () => soon(700);
    window.addEventListener("arcalo:page-saved", saved);
    return () => {
      window.clearTimeout(timer);
      un.forEach((u) => u.then((f) => f()));
      window.removeEventListener("arcalo:page-saved", saved);
    };
  }, [load, nq.query.source]);

  const hits = state.res ? (nq.display === "count" || nq.display === "chart" ? null : state.res.total) : null;
  return (
    <div className={`qb${state.loading ? " is-loading" : ""}`} data-display={nq.display} data-source={nq.query.source}>
      {blocked ? (
        <div className="qb-empty muted">{t("query.timeOff")}</div>
      ) : state.error ? (
        <div className="rich-error" role="alert">
          <AlertTriangle size={14} /> <span>{t("query.failed")}</span>
          <pre>{state.error}</pre>
        </div>
      ) : state.res ? (
        <Result nq={nq} res={state.res} reload={load} />
      ) : (
        <div className="qb-empty faint">{t("query.loading")}</div>
      )}
      <div className="rich-foot">
        <ListFilter size={13} aria-hidden />
        <span className="rich-kind">{t(`dash.q.src.${nq.query.source}`)}</span>
        {hits != null && <span className="faint">· {t("dash.q.hits", { n: hits })}</span>}
        {nq.problems.length > 0 && (
          <span className="rich-problem" title={nq.problems.join("\n")}>
            <AlertTriangle size={12} /> {t("query.problems", { what: nq.problems.join(", ") })}
          </span>
        )}
        <span className="grow" />
        {onEdit && (
          <button type="button" className="rich-btn" onClick={onEdit} aria-pressed={editing}>
            <Pencil size={12} /> {editing ? t("rich.done") : t("query.edit")}
          </button>
        )}
      </div>
    </div>
  );
}

/** Mounts a live query block into `host`; the returned handle updates and removes it. */
export function mountQuery(host: HTMLElement, props: QueryBlockProps) {
  const root = createRoot(host);
  let cur = props;
  root.render(<QueryBlock {...cur} />);
  return {
    update(next: Partial<QueryBlockProps>) {
      cur = { ...cur, ...next };
      root.render(<QueryBlock {...cur} />);
    },
    destroy() {
      // Unmounting while React renders warns; the next tick is safe.
      setTimeout(() => root.unmount(), 0);
    },
  };
}
