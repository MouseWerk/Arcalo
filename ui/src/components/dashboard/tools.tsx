// Tool widgets: Abfrage (a saved query as list, table, number or bar chart), Links and
// KI-Vorschläge.

import { useMemo, useState } from "react";
import { Link2, ListFilter, Sparkles } from "lucide-react";
import { useApp } from "../../store/app";
import { useTimeTracking } from "../../lib/timetracking";
import { fmtDate, h1, isoDay, numberLocale, relative, weekStart } from "../../lib/format";
import { currentLang, t } from "../../lib/i18n";
import { configOf, weekBars } from "../../lib/dashboard";
import { bars, displayProblem, groupLabel, normalizeQuery, type QueryDisplay, type WidgetQuery } from "../../lib/dashquery";
import { buildSuggestions } from "../../lib/suggestions";
import { openCalendarView } from "../../lib/calnav";
import { kindOf, normalizeLinks } from "../../lib/quicklinks";
import type { QueryResult, QueryRow, SuggestionData } from "../../lib/dashtypes";
import { Badge } from "../ui";
import { PageIcon } from "../icons";
import { iconOf } from "../LinkDialogs";
import { openQuickLinkAt, useQuickLinks } from "../QuickLinks";
import { useDash, useWidgetData } from "./data";
import { dayLabel, Empty, hhmm, hrs, Loadable, s, TaskRow } from "./common";
import type { WidgetProps } from "./registry";

// ------------------------------------------------------------------ Abfrage

function openRow(q: WidgetQuery, r: QueryRow, newTab: boolean) {
  if (q.source === "events" && r.event_key) return openCalendarView({ date: r.date ? isoDay(new Date(r.date)) : undefined, key: r.event_key });
  if (q.source === "entries" && r.page_id == null) return s().openTab({ kind: "timesheet" });
  if (r.page_id != null) s().openPage(r.page_id, { newTab });
}

function rowWhen(q: WidgetQuery, r: QueryRow): string {
  if (!r.date) return "";
  if (q.source === "pages") return relative(r.date);
  if (q.source === "tasks") return dayLabel(r.date);
  const d = new Date(r.date);
  return q.source === "events" ? `${dayLabel(isoDay(d))} ${hhmm(d)}` : dayLabel(isoDay(d));
}

function QueryList({ q, res }: { q: WidgetQuery; res: QueryResult }) {
  const { refresh } = useDash();
  const today = isoDay(new Date());
  return (
    <ul className="dw-list">
      {res.rows.map((r) =>
        q.source === "tasks" && r.page_id != null && r.ordinal != null && !r.done ? (
          <TaskRow key={r.key} task={{ page_id: r.page_id, page_title: r.detail, ordinal: r.ordinal, text: r.title, due: r.date, priority: r.priority ?? 0 }} today={today} onDone={() => refresh(["tasks"])} />
        ) : (
          <li key={r.key}>
            <button type="button" className="dw-row" onClick={(e) => openRow(q, r, e.ctrlKey || e.metaKey)}>
              {q.source === "pages" && <PageIcon name={r.icon} size={14} />}
              <span className="ellipsis grow">{r.title}</span>
              {r.detail && q.source !== "pages" && <span className="faint ellipsis small dw-q-detail">{r.detail}</span>}
              {r.minutes != null && q.source === "entries" && <span className="num small">{hrs(r.minutes)}</span>}
              {q.source === "events" && r.done && <Badge tone="success">{t("dash.booked")}</Badge>}
              <span className="faint dw-when">{rowWhen(q, r)}</span>
            </button>
          </li>
        ),
      )}
      {res.total > res.rows.length && <li className="faint small dw-q-more">{t("dash.q.moreRows", { n: res.total - res.rows.length })}</li>}
    </ul>
  );
}

function QueryTable({ q, res }: { q: WidgetQuery; res: QueryResult }) {
  const head: string[] =
    q.source === "pages"
      ? [t("dash.q.col.title"), ...q.columns]
      : q.source === "tasks"
        ? [t("dash.q.col.task"), t("dash.q.col.page"), t("dash.q.col.due")]
        : q.source === "entries"
          ? [t("dash.q.col.date"), t("dash.q.col.wbs"), t("dash.q.col.text"), "h"]
          : [t("dash.q.col.date"), t("dash.q.col.title"), t("dash.q.col.place")];
  const cells = (r: QueryRow): string[] => {
    const when = r.date ? fmtDate(r.date.length === 10 ? `${r.date}T12:00:00` : r.date) : "";
    switch (q.source) {
      case "pages":
        return [r.title, ...q.columns.map((c) => r.cells[c] ?? "")];
      case "tasks":
        return [r.title, r.detail, when];
      case "entries":
        return [when, r.detail, r.title, r.minutes != null ? h1(r.minutes / 60) : ""];
      case "events":
        return [`${when} ${r.date ? hhmm(r.date) : ""}`, r.title, r.detail];
    }
  };
  return (
    <div className="dw-table-wrap">
      <table className="dw-table">
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={i} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {res.rows.map((r) => (
            <tr key={r.key} onClick={(e) => openRow(q, r, e.ctrlKey || e.metaKey)} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && openRow(q, r, false)}>
              {cells(r).map((c, i) => (
                <td key={i} className={i === 0 ? "" : "faint"}>
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

function QueryNumber({ q, res }: { q: WidgetQuery; res: QueryResult }) {
  const hours = q.source === "entries";
  const unit = hours ? "h" : q.source === "tasks" ? (res.total === 1 ? t("dash.q.unit.task") : t("dash.q.unit.tasks")) : q.source === "events" ? (res.total === 1 ? t("dash.q.unit.meeting") : t("dash.q.unit.meetings")) : res.total === 1 ? t("dash.q.unit.page") : t("dash.q.unit.pages");
  return (
    <div className="dw-number">
      <span className="num dw-number-value">{hours ? h1((res.minutes ?? 0) / 60) : res.total.toLocaleString(numberLocale())}</span>
      <span className="muted">{unit}</span>
      {hours && <span className="faint small">{t("dash.q.entries", { n: res.total })}</span>}
    </div>
  );
}

/** Horizontal bars (one series, accent), labels and values in text colors, a tooltip per bar. */
export function BarChart({ groups, unit, label }: { groups: { label: string; value: number }[]; unit: string; label: string }) {
  const rows = bars(groups);
  const fmt = (v: number) => (unit === "h" ? h1(v) : v.toLocaleString(numberLocale()));
  const withUnit = (v: number) => (unit ? `${fmt(v)} ${unit}` : fmt(v));
  const rowH = 22;
  const summary = rows.map((r) => `${r.label}: ${withUnit(r.value)}`).join(", ");
  return (
    <figure className="dw-chart" aria-label={label}>
      <svg width="100%" height={rows.length * rowH} role="img" aria-label={`${label}: ${summary}`}>
        {rows.map((r, i) => (
          <g key={r.label} transform={`translate(0 ${i * rowH})`} className="dw-chart-row">
            <title>{`${r.label}: ${withUnit(r.value)}`}</title>
            <rect className="dw-chart-hit" x="0" y="0" width="100%" height={rowH} />
            <text className="dw-chart-label" x="0" y={rowH / 2} dominantBaseline="central">
              {r.label.length > 22 ? `${r.label.slice(0, 21)}…` : r.label}
            </text>
            <rect className="dw-chart-track" x="40%" y={rowH / 2 - 4} width="46%" height="8" rx="4" />
            <rect className="dw-chart-bar" x="40%" y={rowH / 2 - 4} width={`${Math.max(r.share > 0 ? 1.5 : 0, r.share * 46)}%`} height="8" rx="4" />
            <text className="dw-chart-value num" x="100%" y={rowH / 2} dominantBaseline="central" textAnchor="end">
              {fmt(r.value)}
            </text>
          </g>
        ))}
      </svg>
      <table className="sr-only">
        <tbody>
          {rows.map((r) => (
            <tr key={r.label}>
              <th scope="row">{r.label}</th>
              <td>{withUnit(r.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

export function QueryWidget({ widget, openSettings }: WidgetProps) {
  const c = configOf(widget);
  const q = normalizeQuery(c.query);
  const display = (["list", "table", "number", "bar"].includes(c.display as string) ? c.display : "list") as QueryDisplay;
  const { data, error, loading } = useWidgetData<QueryResult>(widget);
  return <Loadable loading={loading} error={error}>{() => <QueryView q={q} display={display} res={data!} onSettings={openSettings} title={widget.title || t("dash.w.query")} />}</Loadable>;
}

/** A query result as the widget (and the preview in its settings) shows it. */
export function QueryView({ q, display, res, onSettings, title }: { q: WidgetQuery; display: QueryDisplay; res: QueryResult; onSettings?: () => void; title: string }) {
  const problem = displayProblem(q, display);
  if (problem)
    return (
      <Empty icon={ListFilter} action={onSettings && <button type="button" className="dw-link" onClick={onSettings}>{t("dash.settings")}</button>}>
        {t(problem)}
      </Empty>
    );
  if (display === "number") return <QueryNumber q={q} res={res} />;
  if (!res.total) return <Empty icon={ListFilter}>{t("dash.q.none")}</Empty>;
  if (display === "bar") return <BarChart groups={res.groups.map((g) => ({ ...g, label: groupLabel(g.label, q.group, currentLang()) }))} unit={q.source === "entries" ? "h" : ""} label={title} />;
  if (display === "table") return <QueryTable q={q} res={res} />;
  return <QueryList q={q} res={res} />;
}

// ------------------------------------------------------------------ Links

export function LinksWidget({ widget }: WidgetProps) {
  const all = useQuickLinks();
  const c = configOf(widget);
  const group = typeof c.group === "number" ? c.group : -1;
  const items = useMemo(() => {
    const g = group >= 0 ? normalizeLinks(all)[group] : undefined;
    if (group >= 0 && g && kindOf(g) === "group") return (g.items ?? []).map((item, index) => ({ item, at: { group, index } }));
    return all.map((item, index) => ({ item, at: { group: null, index } })).filter((x) => kindOf(x.item) !== "group");
  }, [all, group]);
  if (!items.length) return <Empty icon={Link2}>{t("dash.linksEmpty")}</Empty>;
  return (
    <ul className="dw-links">
      {items.map(({ item, at }) => (
        <li key={`${at.group}-${at.index}`}>
          <button type="button" className="dw-link-tile" onClick={() => openQuickLinkAt(at)} title={item.url}>
            <PageIcon name={iconOf(item)} size={16} />
            <span className="ellipsis">{item.name}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

// ------------------------------------------------------------------ KI-Vorschläge

export function SuggestionsWidget({ widget }: WidgetProps) {
  const { data, error, loading } = useWidgetData<SuggestionData>(widget);
  const settings = useApp((st) => st.settings?.settings);
  const [asked, setAsked] = useState<string | null>(null);
  const timeOn = useTimeTracking();
  const c = configOf(widget);
  return (
    <Loadable loading={loading} error={error}>
      {() => {
        const d = data!;
        const now = new Date();
        const monday = weekStart(now, 1);
        const week = weekBars(
          d.week_minutes.map((m, i) => ({ date: isoDay(new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i)), booked_minutes: m })),
          monday,
          settings?.daily_target_hours ?? 8,
          settings?.workdays ?? [1, 2, 3, 4, 5],
          now,
        );
        const list = buildSuggestions({
          now,
          page: null,
          overdue: d.overdue,
          dueToday: d.due_today,
          openTasks: d.open_tasks,
          gapDays: week.bars.filter((b) => b.gap > 0).map((b) => b.label),
          budget: d.worst_budget,
          hasBookings: week.bookedMinutes > 0,
          time: timeOn,
        });
        const ask = (text: string) => {
          setAsked(text);
          s().set({ panelOpen: true, panelTab: "assistant", pendingAsk: text });
        };
        return (
          <div className="dw-suggest">
            <ul className="dw-list">
              {list.slice(0, Number(c.count) || 5).map((q) => (
                <li key={q.text}>
                  <button type="button" className={`dw-row dw-suggest-row ${asked === q.text ? "asked" : ""}`} onClick={() => ask(q.text)}>
                    <Sparkles size={13} className="dw-suggest-icon" aria-hidden />
                    <span className="grow">{q.text}</span>
                  </button>
                </li>
              ))}
            </ul>
            <div className="faint small dw-suggest-note">{t("dash.suggestNote")}</div>
          </div>
        );
      }}
    </Loadable>
  );
}
