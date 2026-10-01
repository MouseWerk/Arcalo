// Widgets of the booked time: Zeit diese Woche, Timer, Budget, Projekt and Wochenvorschlag.

import type { CSSProperties } from "react";
import { CalendarCheck, FolderKanban, Gauge, WandSparkles } from "lucide-react";
import { useApp } from "../../store/app";
import { useTimeTracking } from "../../lib/timetracking";
import { fmtDate, h1, isoDay, weekStart } from "../../lib/format";
import { t, type TKey } from "../../lib/i18n";
import { hoursLabel } from "../../lib/calendar";
import { timeRange } from "../../lib/agenda";
import { openCalendarView } from "../../lib/calnav";
import { useHiddenCalendars, visibleEvents } from "../../lib/calvisibility";
import { openTimesheetDay } from "../../lib/reviewnav";
import { requestWeekProposal } from "../../lib/weekplan";
import { budgetForecast, configOf, weekBars, type Forecast } from "../../lib/dashboard";
import type { AlertLevel, TimeEntryRow } from "../../lib/types";
import type { BudgetRow, BudgetsData, ProjectData, ProposalData, WeekData } from "../../lib/dashtypes";
import { Badge, Button, Progress, type Tone } from "../ui";
import { PageIcon } from "../icons";
import { useDash, useWidgetData } from "./data";
import { dayLabel, Empty, fmt, hhmm, hrs, Loadable, More, s, TaskRow, TimerBlock } from "./common";
import type { WidgetProps } from "./registry";

const weekdayShort = (iso: string) => fmt(new Date(`${iso}T12:00:00`), { weekday: "short" }).replace(/\.$/, "").slice(0, 2);

// ------------------------------------------------------------------ Zeit diese Woche

export function WeekWidget({ widget }: WidgetProps) {
  const { data, error, loading } = useWidgetData<WeekData>(widget);
  const settings = useApp((st) => st.settings?.settings);
  const mode = configOf(widget).mode === "wbs" ? "wbs" : "day";
  return (
    <Loadable loading={loading} error={error}>
      {() => {
        const d = data!;
        const monday = new Date(`${d.week_start}T00:00:00`);
        const labels = d.days.map((x) => weekdayShort(x.date));
        const week = weekBars(
          d.days.map((x) => ({ date: x.date, booked_minutes: x.minutes })),
          monday,
          settings?.daily_target_hours ?? 8,
          settings?.workdays ?? [1, 2, 3, 4, 5],
          new Date(),
          labels,
        );
        const gaps = week.bars.filter((b) => b.gap > 0);
        const max = Math.max(1, ...d.wbs.map((w) => w.minutes));
        return (
          <div className="dw-week">
            <button type="button" className="dw-week-sum" onClick={() => openTimesheetDay(isoDay(new Date()))} aria-label={t("dash.weekOpen")}>
              <span className="num dw-big">{h1(week.bookedMinutes / 60)}</span>
              <span className="faint num">{t("dash.ofHours", { h: h1(week.targetMinutes / 60) })}</span>
              <span className="grow" />
              {gaps.length > 0 ? <Badge tone="warning">{t("dash.gapBadge", { h: h1(week.gapMinutes / 60) })}</Badge> : <Badge tone="success">{t("dash.noGaps")}</Badge>}
            </button>
            {mode === "day" ? (
              <div className="dw-bars" style={{ "--target": week.targetLine } as CSSProperties} role="list" aria-label={t("dash.perDay")}>
                {week.bars.map((b) => (
                  <button
                    key={b.date}
                    type="button"
                    role="listitem"
                    className={`dw-bar-col ${b.workday ? "" : "weekend"} ${b.today ? "today" : ""} ${b.gap > 0 ? "gap" : ""}`}
                    title={`${b.label}: ${hoursLabel(b.minutes) || "0"} h${b.gap > 0 ? ` · ${t("dash.missing", { h: h1(b.gap / 60) })}` : ""}`}
                    aria-label={`${b.label}: ${hoursLabel(b.minutes) || "0"} h${b.gap > 0 ? `, ${t("dash.missing", { h: h1(b.gap / 60) })}` : ""}`}
                    onClick={() => openTimesheetDay(b.date)}
                  >
                    <span className="dw-bar-h num">{hoursLabel(b.minutes)}</span>
                    <span className="dw-bar-track">
                      {b.workday && week.targetLine > 0 && <span className="dw-bar-target" aria-hidden />}
                      <span className="dw-bar-fill" style={{ height: `${b.fill * 100}%` }} />
                    </span>
                    <span className="dw-bar-day">{b.label}</span>
                  </button>
                ))}
              </div>
            ) : d.wbs.length === 0 ? (
              <Empty icon={Gauge}>{t("dash.weekEmpty")}</Empty>
            ) : (
              <ul className="dw-list dw-wbs" aria-label={t("dash.perWbs")}>
                {d.wbs.slice(0, 6).map((w) => (
                  <li key={w.label} className="dw-wbs-row" title={w.title}>
                    <span className="dw-wbs-label">
                      <span className="mono">{w.label}</span>
                      <span className="faint ellipsis">{w.title}</span>
                    </span>
                    <span className="dw-wbs-bar" aria-hidden>
                      {w.by_day.map((m, i) => (m > 0 ? <span key={i} style={{ width: `${(m / max) * 100}%` }} className={i % 2 ? "odd" : ""} /> : null))}
                    </span>
                    <span className="num dw-wbs-h">{hrs(w.minutes)}</span>
                  </li>
                ))}
              </ul>
            )}
            {gaps.length > 0 && (
              <div className="dw-gaps">
                <span className="faint">{t("dash.gaps")}</span>
                {gaps.map((g) => (
                  <button key={g.date} type="button" className="dw-gap" onClick={() => openTimesheetDay(g.date)}>
                    {g.label} <span className="num">{h1(g.gap / 60)} h</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      }}
    </Loadable>
  );
}

// ------------------------------------------------------------------ Timer

export function TimerWidget({ widget }: WidgetProps) {
  const { data } = useWidgetData<TimeEntryRow[]>(widget);
  return <TimerBlock refs={data} />;
}

// ------------------------------------------------------------------ Budget

export const LEVEL: Record<AlertLevel, { tone: Tone; label: TKey; rank: number }> = {
  ok: { tone: "success", label: "dash.lvl.ok", rank: 0 },
  warning: { tone: "warning", label: "dash.lvl.warning", rank: 1 },
  critical: { tone: "danger", label: "dash.lvl.critical", rank: 2 },
  exceeded: { tone: "danger", label: "dash.lvl.exceeded", rank: 3 },
};

/** The worst budgets first (level, then consumption). */
export const byRisk = (a: BudgetRow, b: BudgetRow) => LEVEL[b.level].rank - LEVEL[a.level].rank || b.consumed - a.consumed;

function forecastText(f: Forecast): { text: string; tone: "" | "warn" | "bad" } {
  switch (f.state) {
    case "unplanned":
      return { text: t("dash.fc.unplanned"), tone: "" };
    case "used":
      return { text: t("dash.fc.used"), tone: "bad" };
    case "idle":
      return { text: t("dash.fc.idle"), tone: "" };
    case "soon":
      return { text: t("dash.fc.soon", { n: Math.max(1, Math.ceil(f.days ?? 0)), date: fmtDate(`${f.date}T12:00:00`), rate: h1(f.perDay) }), tone: "warn" };
    case "ok":
      return { text: t("dash.fc.ok", { date: fmtDate(`${f.date}T12:00:00`), rate: h1(f.perDay) }), tone: "" };
  }
}

export function BudgetRowView({ b, burnDays, forecast, onOpen }: { b: BudgetRow; burnDays: number; forecast: boolean; onOpen: () => void }) {
  const f = budgetForecast(b, b.recent_hours, burnDays, new Date());
  const fc = forecastText(f);
  return (
    <button type="button" className={`dw-budget lvl-${b.level}`} onClick={onOpen} title={`${t("dash.budgetTitle", { booked: h1(b.booked_hours), planned: h1(b.planned_hours), eac: h1(b.eac_hours) })}${forecast ? `\n${fc.text}` : ""}`}>
      <span className="dw-budget-head">
        <span className="mono">{b.label}</span>
        <span className="faint ellipsis grow">{b.title}</span>
        <Badge tone={LEVEL[b.level].tone}>{t(LEVEL[b.level].label)}</Badge>
      </span>
      <span className="dw-budget-bar">
        <Progress value={b.consumed} tone={LEVEL[b.level].tone} marker={b.planned_hours > 0 ? b.eac_hours / b.planned_hours : undefined} />
        <span className="num faint dw-budget-h">
          {h1(b.booked_hours)} / {h1(b.planned_hours)} h
        </span>
      </span>
      {forecast && <span className={`dw-budget-fc ellipsis ${fc.tone}`}>{fc.text}</span>}
    </button>
  );
}

export function BudgetWidget({ widget }: WidgetProps) {
  const { data, error, loading } = useWidgetData<BudgetsData>(widget);
  const c = configOf(widget);
  const open = () => s().openTab({ kind: "projects" });
  return (
    <Loadable loading={loading} error={error}>
      {() => {
        const d = data!;
        const refs = Array.isArray(c.refs) ? (c.refs as string[]) : [];
        const count = Math.max(1, Math.min(12, Number(c.count) || 4));
        const rows = c.mode === "selected" ? refs.map((r) => d.budgets.find((b) => b.label === r)).filter((b): b is BudgetRow => !!b) : [...d.budgets].filter((b) => b.planned_hours > 0 || b.booked_hours > 0).sort(byRisk);
        if (!d.budgets.length) return <Empty icon={Gauge}>{t("dash.budgetNone")}</Empty>;
        if (!rows.length) return <Empty icon={Gauge}>{t("dash.budgetPick")}</Empty>;
        const shown = c.mode === "selected" ? rows : rows.slice(0, count);
        const fine = c.mode !== "selected" && shown.every((b) => b.level === "ok");
        return (
          <div className="dw-budgets">
            {fine && <div className="dw-quiet">{t("dash.budgetsFine")}</div>}
            <ul className="dw-list">
              {shown.map((b) => (
                <li key={b.label}>
                  <BudgetRowView b={b} burnDays={d.burn_days} forecast={c.forecast !== false} onOpen={open} />
                </li>
              ))}
              {c.mode !== "selected" && <More n={rows.filter((b) => b.level !== "ok").length - shown.filter((b) => b.level !== "ok").length} onClick={open} />}
            </ul>
          </div>
        );
      }}
    </Loadable>
  );
}

// ------------------------------------------------------------------ Projekt

export function ProjectWidget({ widget, openSettings }: WidgetProps) {
  const hidden = useHiddenCalendars();
  const { data, error, loading } = useWidgetData<ProjectData>(widget);
  const { refresh } = useDash();
  const today = isoDay(new Date());
  // Time tracking off: the project's notes, tasks and meetings, without budgets.
  const timeOn = useTimeTracking();
  return (
    <Loadable loading={loading} error={error}>
      {() => {
        // Without a choice the Netzplan booked last is shown; none at all: the empty state.
        if (!data)
          return (
            <Empty icon={FolderKanban} action={<Button size="sm" onClick={openSettings}>{t("dash.pickNetzplan")}</Button>}>
              {t("dash.projectEmpty")}
            </Empty>
          );
        const p = { ...data, events: visibleEvents(data.events, hidden) };
        const total = timeOn ? p.budget[0] : undefined;
        const vorgaenge = timeOn ? p.budget.slice(1).sort(byRisk).slice(0, 3) : [];
        return (
          <div className="dw-project">
            <div className="dw-project-head">
              <span className="mono dw-strong">{p.netzplan_nr}</span>
              <span className="ellipsis grow">{p.description}</span>
              <span className="faint small ellipsis">
                {p.project_code} · {p.project_name}
              </span>
            </div>
            {total && <BudgetRowView b={total} burnDays={p.burn_days} forecast onOpen={() => s().openTab({ kind: "projects" })} />}
            {vorgaenge.length > 0 && (
              <ul className="dw-list dw-project-vg">
                {vorgaenge.map((v) => (
                  <li key={v.label} className="dw-row static">
                    <span className="mono small">{v.vorgang_nr}</span>
                    <span className="ellipsis grow small">{v.title}</span>
                    <span className="dw-mini" aria-hidden>
                      <span className={`lvl-${v.level}`} style={{ width: `${Math.min(1, v.consumed) * 100}%` }} />
                    </span>
                    <span className="num faint small">{Math.round(v.consumed * 100)} %</span>
                  </li>
                ))}
              </ul>
            )}
            <div className="dw-project-cols">
              <section>
                <h3 className="dw-sub">{t("dash.notes")}</h3>
                {p.pages.length ? (
                  <ul className="dw-list">
                    {p.pages.slice(0, 4).map((pg) => (
                      <li key={pg.id}>
                        <button type="button" className="dw-row dw-page" onClick={(e) => s().openPage(pg.id, { newTab: e.ctrlKey || e.metaKey })}>
                          <PageIcon name={pg.icon} size={14} />
                          <span className="grow ellipsis">{pg.title}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="dw-quiet small">{t("dash.projectNoNotes")}</div>
                )}
              </section>
              <section>
                <h3 className="dw-sub">
                  {t("dash.openTasks")} {p.tasks_total > 0 && <span className="faint num">{p.tasks_total}</span>}
                </h3>
                {p.tasks.length ? (
                  <ul className="dw-list">
                    {p.tasks.slice(0, 4).map((task) => (
                      <TaskRow key={`${task.page_id}:${task.ordinal}`} task={task} today={today} page={false} onDone={() => refresh(["tasks"])} />
                    ))}
                  </ul>
                ) : (
                  <div className="dw-quiet small">{t("dash.projectNoTasks")}</div>
                )}
              </section>
              <section>
                <h3 className="dw-sub">{t("dash.nextMeetings")}</h3>
                {p.events.length ? (
                  <ul className="dw-list">
                    {p.events.map((e) => (
                      <li key={e.key}>
                        <button type="button" className="dw-row" onClick={() => openCalendarView({ date: isoDay(new Date(e.start)), key: e.key })}>
                          <span className="num faint small dw-when">
                            {dayLabel(isoDay(new Date(e.start)))} {e.all_day ? "" : hhmm(e.start)}
                          </span>
                          <span className="ellipsis grow" title={timeRange(e)}>
                            {e.title}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="dw-quiet small">{t("dash.projectNoMeetings")}</div>
                )}
              </section>
            </div>
          </div>
        );
      }}
    </Loadable>
  );
}

// ------------------------------------------------------------------ Wochenvorschlag

export function ProposalWidget({ widget }: WidgetProps) {
  const { data, error, loading } = useWidgetData<ProposalData>(widget);
  const open = () => {
    s().openTab({ kind: "timesheet" });
    requestWeekProposal();
  };
  return (
    <Loadable loading={loading} error={error}>
      {() => {
        const p = data!;
        const share = p.target_minutes > 0 ? p.booked_minutes / p.target_minutes : 0;
        const complete = p.missing_minutes === 0 && p.unbooked_meetings === 0;
        const monday = weekStart(new Date(), 1);
        return (
          <div className="dw-proposal">
            <div className="dw-review-hours">
              <span className="num dw-big">{h1(p.booked_minutes / 60)}</span>
              <span className="faint num">{t("dash.ofHours", { h: h1(p.target_minutes / 60) })}</span>
              <span className="grow" />
              {complete ? <Badge tone="success">{t("dash.prop.complete")}</Badge> : <Badge tone="warning">{t("dash.gapShort", { h: hrs(p.missing_minutes) })}</Badge>}
            </div>
            <div className="dw-meter" aria-hidden>
              <span style={{ width: `${Math.min(1, share) * 100}%` }} />
            </div>
            {p.open_days.length > 0 && (
              <ul className="dw-list">
                {p.open_days.slice(0, 4).map((d) => (
                  <li key={d.date}>
                    <button type="button" className="dw-row" onClick={() => openTimesheetDay(d.date)}>
                      <span className="grow ellipsis">{fmt(new Date(`${d.date}T12:00:00`), { weekday: "short", day: "2-digit", month: "2-digit" })}</span>
                      <span className="num warn small">{t("dash.missing", { h: hrs(d.missing_minutes).replace(/ h$/, "") })}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {p.unbooked_meetings > 0 && (
              <div className="dw-quiet">
                <CalendarCheck size={14} aria-hidden /> {t("dash.prop.meetings", { n: p.unbooked_meetings, h: hrs(p.unbooked_minutes) })}
              </div>
            )}
            {complete && p.open_days.length === 0 && <div className="dw-quiet">{t("dash.prop.nothing", { kw: `${fmtDate(monday)}` })}</div>}
            <div className="dw-foot">
              <Button size="sm" variant={complete ? "secondary" : "primary"} icon={WandSparkles} onClick={open}>
                {t("dash.act.week")}
              </Button>
            </div>
          </div>
        );
      }}
    </Loadable>
  );
}
