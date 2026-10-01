// Widgets of the day: Heute (the daily overview), Termine, Aufgaben, Fokus, Uhr,
// Tagesrückblick and Kalender.

import { lazy, Suspense, useEffect, useMemo, useState, type CSSProperties } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { CalendarDays, CalendarPlus, CheckCircle2, ChevronLeft, ChevronRight, Coffee, NotebookPen, PenLine, Play, Sunset, Target, Timer, Video, WandSparkles } from "lucide-react";
import { api } from "../../lib/api";
import { useApp } from "../../store/app";
import { addDays, isoDay, isoWeek, weekStart } from "../../lib/format";
import { t } from "../../lib/i18n";
import { bookingPrefill, isAllDayLike, sourceColor, sourceName, timeRange } from "../../lib/agenda";
import { addMonths, dayTone, hoursLabel, monthGrid } from "../../lib/calendar";
import { openCalendarView, openSettingsSection } from "../../lib/calnav";
import { useHiddenCalendars, visibleEvents } from "../../lib/calvisibility";
import { openDayReview } from "../../lib/reviewnav";
import { requestWeekProposal } from "../../lib/weekplan";
import { configOf, type TodayBlock } from "../../lib/dashboard";
import type { CalendarEvent, TimeEntryRow, WbsHint } from "../../lib/types";
import type { AgendaData, FocusData, MonthData, ReviewData, TasksData, TodayData } from "../../lib/dashtypes";
import { Badge, Button, IconButton } from "../ui";
import { PageIcon } from "../icons";
import { openDailyNote } from "../CalendarPopover";
import { openFocusDialog } from "../Focus";
import { useWbs } from "../../views/wbs";
import { useDash, useWidgetData } from "./data";
import { dayLabel, Empty, fmt, hhmm, hrs, Loadable, More, Ring, s, TaskRow, TimerBlock, until, useNow } from "./common";
import type { WidgetProps } from "./registry";

const EntryDialog = lazy(() => import("../../views/TimesheetView").then((m) => ({ default: m.EntryDialog })));

// ------------------------------------------------------------------ Heute

function greeting(hour: number) {
  return hour < 11 ? t("dash.greet.morning") : hour < 18 ? t("dash.greet.day") : t("dash.greet.evening");
}

/** The appointment running now, else the next one of today (not all-day). */
export function nextMeeting(events: CalendarEvent[], now: number): { event: CalendarEvent; running: boolean } | null {
  const timed = events.filter((e) => !isAllDayLike(e) && e.busy !== "free");
  const running = timed.find((e) => new Date(e.start).getTime() <= now && new Date(e.end).getTime() > now);
  if (running) return { event: running, running: true };
  const next = timed.filter((e) => new Date(e.start).getTime() > now).sort((a, b) => a.start.localeCompare(b.start))[0];
  return next ? { event: next, running: false } : null;
}

/** Hours shown on the timeline: from 8 to 18, widened to the day's meetings (and now). */
export function timelineWindow(events: CalendarEvent[], now: Date): [number, number] {
  let from = 8;
  let to = 18;
  for (const e of events) {
    if (isAllDayLike(e)) continue;
    const s0 = new Date(e.start);
    const e0 = new Date(e.end);
    const sameDay = isoDay(s0) === isoDay(now);
    from = Math.min(from, sameDay ? s0.getHours() : 0);
    to = Math.max(to, isoDay(e0) === isoDay(now) ? e0.getHours() + (e0.getMinutes() > 0 ? 1 : 0) : 24);
  }
  const h = now.getHours();
  from = Math.min(from, h);
  to = Math.max(to, Math.min(24, h + 1));
  return [Math.max(0, from), Math.min(24, to)];
}

/** Lanes for overlapping meetings (at most three rows). */
export function lanes(events: CalendarEvent[]): Map<string, number> {
  const ends: number[] = [];
  const out = new Map<string, number>();
  for (const e of [...events].sort((a, b) => a.start.localeCompare(b.start))) {
    const st = new Date(e.start).getTime();
    let lane = ends.findIndex((end) => end <= st);
    if (lane < 0) lane = ends.length;
    ends[lane] = new Date(e.end).getTime();
    out.set(e.key, Math.min(lane, 2));
  }
  return out;
}

function Timeline({ events, now }: { events: CalendarEvent[]; now: number }) {
  const cal = useApp((st) => st.settings?.settings.calendar);
  const date = new Date(now);
  const [from, to] = timelineWindow(events, date);
  const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const span = (to - from) * 3600_000;
  const pos = (ms: number) => Math.max(0, Math.min(100, ((ms - dayStart - from * 3600_000) / span) * 100));
  const timed = events.filter((e) => !isAllDayLike(e));
  const allDay = events.filter(isAllDayLike);
  const lane = lanes(timed);
  const nLanes = Math.max(1, ...[...lane.values()].map((l) => l + 1));
  const hours = [];
  const step = to - from > 12 ? 3 : 2;
  for (let h = Math.ceil(from / step) * step; h <= to; h += step) hours.push(h);
  return (
    <div className="dw-tl" style={{ "--lanes": nLanes } as CSSProperties}>
      {allDay.length > 0 && (
        <div className="dw-tl-allday">
          {allDay.map((e) => (
            <button key={e.key} type="button" className="dw-chip" style={{ "--ev": sourceColor(e.source, cal) } as CSSProperties} onClick={() => openCalendarView({ date: isoDay(date), key: e.key })}>
              {e.title}
            </button>
          ))}
        </div>
      )}
      <div className="dw-tl-track" role="list" aria-label={t("dash.timeline")}>
        {hours.map((h) => (
          <span key={h} className="dw-tl-hour" style={{ left: `${((h - from) / (to - from)) * 100}%` }} aria-hidden>
            {h < to && <span className="num">{String(h).padStart(2, "0")}</span>}
          </span>
        ))}
        {timed.map((e) => {
          const a = pos(new Date(e.start).getTime());
          const b = pos(new Date(e.end).getTime());
          const past = new Date(e.end).getTime() <= now;
          const live = !past && new Date(e.start).getTime() <= now;
          return (
            <button
              key={e.key}
              type="button"
              role="listitem"
              className={`dw-tl-ev ${past ? "past" : ""} ${live ? "live" : ""}`}
              style={{ left: `${a}%`, width: `max(4px, ${b - a}%)`, top: `calc(${lane.get(e.key) ?? 0} * var(--lane-h))`, "--ev": sourceColor(e.source, cal) } as CSSProperties}
              title={`${timeRange(e)} ${e.title}`}
              aria-label={`${timeRange(e)} ${e.title}`}
              onClick={() => openCalendarView({ date: isoDay(date), key: e.key })}
            >
              <span className="ellipsis">{e.title}</span>
            </button>
          );
        })}
        <span className="dw-tl-now" style={{ left: `${pos(now)}%` }} aria-label={t("dash.nowAt", { time: hhmm(date) })} role="img" />
      </div>
    </div>
  );
}

function NextMeeting({ events, now, configured }: { events: CalendarEvent[]; now: number; configured: boolean }) {
  const next = nextMeeting(events, now);
  if (!configured)
    return (
      <div className="dw-next muted">
        <CalendarDays size={14} aria-hidden />
        <span className="grow">{t("dash.noCalendar")}</span>
        <button type="button" className="dw-link" onClick={() => openSettingsSection("calendar")}>
          {t("dash.setup")}
        </button>
      </div>
    );
  if (!next)
    return (
      <div className="dw-next muted">
        <Coffee size={14} aria-hidden />
        <span className="grow">{events.length ? t("dash.noMoreMeetings") : t("dash.noMeetingsToday")}</span>
      </div>
    );
  const e = next.event;
  const ms = next.running ? new Date(e.end).getTime() - now : new Date(e.start).getTime() - now;
  return (
    <div className={`dw-next ${next.running ? "live" : ""}`}>
      <span className="dw-next-dot" aria-hidden />
      <span className="dw-next-when">{next.running ? t("dash.runningLeft", { left: until(ms).replace(/^in /, "") }) : until(ms)}</span>
      <button type="button" className="dw-next-title ellipsis" onClick={() => openCalendarView({ date: isoDay(new Date(e.start)), key: e.key })}>
        {e.title}
      </button>
      <span className="faint num dw-next-range">{timeRange(e)}</span>
      {e.link && (
        <Button size="sm" variant={next.running || ms < 15 * 60000 ? "primary" : "secondary"} icon={Video} onClick={() => openUrl(e.link!).catch((err) => s().error(t("dash.joinFailed"), err))}>
          {t("dash.join")}
        </Button>
      )}
    </div>
  );
}

function AddTask({ target, onAdded }: { target?: number | null; onAdded: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const add = async () => {
    const v = text.trim();
    if (!v || busy) return;
    setBusy(true);
    try {
      await api.captureSubmit(`- [ ] ${v}`, target ? { kind: "page", page_id: target } : undefined);
      setText("");
      await s().refreshTree();
      onAdded();
    } catch (e) {
      s().error(t("dash.taskAddFailed"), e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <input
      className="input dw-add"
      value={text}
      placeholder={target ? t("dash.addTaskPage") : t("dash.addTaskToday")}
      aria-label={target ? t("dash.addTaskPageLabel") : t("dash.addTaskTodayLabel")}
      disabled={busy}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.nativeEvent.isComposing) {
          e.preventDefault();
          void add();
        }
      }}
    />
  );
}

export function TodayWidget({ widget }: WidgetProps) {
  const { data, error, loading } = useWidgetData<TodayData>(widget);
  const refs = useWidgetData<TimeEntryRow[]>(widget, 1).data;
  const { refresh } = useDash();
  const now = useNow(30_000);
  // Calendars hidden in the Kalender's legend are hidden here too.
  const hidden = useHiddenCalendars();
  const blocks = (configOf(widget).blocks ?? {}) as Partial<Record<TodayBlock, boolean>>;
  const on = (b: TodayBlock) => blocks[b] !== false;
  const date = new Date(now);
  const todayIso = isoDay(date);
  return (
    <Loadable loading={loading} error={error}>
      {() => {
        const d = data!;
        const events = visibleEvents(d.events, hidden);
        const target = d.target_minutes;
        const share = target > 0 ? d.booked_minutes / target : 0;
        const missing = Math.max(0, target - d.booked_minutes);
        return (
          <div className="dw-today">
            <div className="dw-today-head">
              <div className="dw-today-hello">
                <div className="dw-today-greet">{greeting(date.getHours())}</div>
                <div className="muted dw-today-date">
                  {fmt(date, { weekday: "long", day: "numeric", month: "long" })} · {t("dash.kw", { n: isoWeek(date) })}
                </div>
              </div>
              {on("hours") && (
                <button type="button" className="dw-today-hours" onClick={() => s().openTab({ kind: "timesheet" })} aria-label={t("dash.hoursLabel", { booked: hrs(d.booked_minutes), target: hrs(target) })}>
                  <Ring value={share} size={48} stroke={5} tone={target > 0 && missing === 0 ? "success" : "accent"} label={`${Math.round(share * 100)} %`}>
                    <span className="num">{target > 0 ? `${Math.min(999, Math.round(share * 100))}%` : "–"}</span>
                  </Ring>
                  <span className="dw-today-hours-text">
                    <span className="num dw-strong">
                      {hrs(d.booked_minutes)} <span className="faint">/ {target > 0 ? hrs(target) : "–"}</span>
                    </span>
                    <span className={`small ${missing > 0 && date.getHours() >= 15 ? "warn" : "faint"}`}>{!d.workday ? t("dash.noWorkday") : missing > 0 ? t("dash.gapLeft", { h: hrs(missing) }) : t("dash.targetMet")}</span>
                  </span>
                </button>
              )}
            </div>
            {on("timeline") && (
              <div className="dw-today-sec">
                {d.calendar_configured && events.length > 0 && <Timeline events={events} now={now} />}
                <NextMeeting events={events} now={now} configured={d.calendar_configured} />
              </div>
            )}
            <div className="dw-today-cols">
              {on("tasks") && (
                <section className="dw-today-sec dw-today-tasks" aria-label={t("dash.dueTasks")}>
                  <h3 className="dw-sub">
                    {t("dash.dueTasks")} {d.tasks_total > 0 && <span className="faint num">{d.tasks_total}</span>}
                  </h3>
                  {d.tasks.length === 0 ? (
                    <div className="dw-quiet">
                      <CheckCircle2 size={14} aria-hidden /> {t("dash.nothingDue")}
                    </div>
                  ) : (
                    <ul className="dw-list" aria-label={t("dash.dueTasks")}>
                      {d.tasks.slice(0, 5).map((task) => (
                        <TaskRow key={`${task.page_id}:${task.ordinal}`} task={task} today={todayIso} page={task.page_id !== d.daily_note_id} onDone={() => refresh(["tasks"])} />
                      ))}
                      <More n={d.tasks_total - 5} onClick={() => s().openTab({ kind: "tasks" })} />
                    </ul>
                  )}
                  <AddTask onAdded={() => refresh(["tasks", "pages"])} />
                </section>
              )}
              {(on("timer") || on("focus")) && (
                <div className="dw-today-side">
                  {on("timer") && (
                    <section className="dw-today-sec" aria-label={t("dash.w.timer")}>
                      <h3 className="dw-sub">{t("dash.w.timer")}</h3>
                      <TimerBlock refs={refs} compact />
                    </section>
                  )}
                  {on("focus") && <FocusLine sessions={d.focus.sessions} minutes={d.focus.minutes} />}
                </div>
              )}
            </div>
            {on("actions") && (
              <div className="dw-actions" role="group" aria-label={t("dash.quickActions")}>
                <Button size="sm" variant="ghost" icon={NotebookPen} onClick={() => openDailyNote(todayIso)}>
                  {t("dash.act.daily")}
                </Button>
                <Button size="sm" variant="ghost" icon={PenLine} onClick={() => api.captureShow().catch((e) => s().error(t("dash.captureFailed"), e))}>
                  {t("dash.act.capture")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={WandSparkles}
                  onClick={() => {
                    s().openTab({ kind: "timesheet" });
                    requestWeekProposal();
                  }}
                >
                  {t("dash.act.week")}
                </Button>
                <Button size="sm" variant="ghost" icon={Sunset} onClick={() => openDayReview()}>
                  {t("dash.act.review")}
                </Button>
              </div>
            )}
          </div>
        );
      }}
    </Loadable>
  );
}

function FocusLine({ sessions, minutes }: { sessions: number; minutes: number }) {
  const focus = useApp((st) => st.focus);
  return (
    <section className="dw-today-sec dw-focusline" aria-label={t("dash.w.focus")}>
      <h3 className="dw-sub">{t("dash.w.focus")}</h3>
      <div className="dw-focusline-row">
        <Target size={15} className="faint" aria-hidden />
        <span className="grow ellipsis">{focus ? (focus.phase === "work" ? t("dash.focusRunning") : t("dash.focusBreak")) : sessions ? t("dash.focusToday", { n: sessions, h: hrs(minutes) }) : t("dash.focusNoneShort")}</span>
        {!focus && <IconButton icon={Play} size="sm" label={t("dash.focusStart")} onClick={() => openFocusDialog()} />}
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ Termine

/** Books a meeting through the time entry dialog, prefilled like the Kalender does it. */
export function useBooking(onBooked: () => void) {
  const { wbs, las } = useWbs();
  const target = useApp((st) => st.settings?.settings.daily_target_hours ?? 8);
  const [booking, setBooking] = useState<{ event: CalendarEvent; hint: WbsHint | null } | null>(null);
  const book = async (e: CalendarEvent) => {
    if (!wbs.some((p) => p.netzplaene.length)) {
      s().toast({ tone: "warning", title: t("dash.noNetzplan"), action: { label: t("dash.projects"), run: () => s().openTab({ kind: "projects" }) } });
      return;
    }
    const hint = await api.calendarWbsHint(e.key).catch(() => null);
    setBooking({ event: e, hint });
  };
  const dialog = booking ? (
    <Suspense fallback={null}>
      <EntryDialog
        entry={null}
        wbs={wbs}
        las={las}
        defaultDay={new Date(booking.event.start)}
        prefill={bookingPrefill(booking.event, booking.hint, target)}
        note={
          <div className="calv-book-note">
            <CalendarPlus size={14} aria-hidden />
            <span>{t("dash.bookFrom", { title: booking.event.title, time: timeRange(booking.event) })}</span>
          </div>
        }
        onClose={() => setBooking(null)}
        onSaved={(id) => {
          void api
            .calendarLinkEntry(booking.event.key, id)
            .then(onBooked)
            .catch((err) => s().error(t("dash.linkFailed"), err));
        }}
      />
    </Suspense>
  ) : null;
  return { book, dialog };
}

export function AgendaWidget({ widget }: WidgetProps) {
  const { data, error, loading } = useWidgetData<AgendaData>(widget);
  const cal = useApp((st) => st.settings?.settings.calendar);
  const { refresh } = useDash();
  const now = useNow(30_000);
  const c = configOf(widget);
  const only = Array.isArray(c.sources) ? (c.sources as string[]) : [];
  // The widget's own choice of calendars, and those hidden in the Kalender's legend.
  const hidden = useHiddenCalendars();
  const { book, dialog } = useBooking(() => refresh(["calendar"]));
  return (
    <Loadable loading={loading} error={error}>
      {() => {
        const d = data!;
        if (!d.configured)
          return (
            <Empty icon={CalendarDays} action={<Button size="sm" onClick={() => openSettingsSection("calendar")}>{t("dash.setup")}</Button>}>
              {t("dash.noCalendar")}
            </Empty>
          );
        const events = visibleEvents(d.events, hidden).filter((e) => !only.length || only.includes(e.source));
        if (!events.length) return <Empty icon={Coffee}>{Number(c.days) > 1 ? t("dash.noMeetingsDays") : t("dash.noMeetingsToday")}</Empty>;
        const byDay = new Map<string, CalendarEvent[]>();
        for (const e of events) {
          const day = isoDay(new Date(Math.max(new Date(e.start).getTime(), new Date(d.from).getTime())));
          byDay.set(day, [...(byDay.get(day) ?? []), e]);
        }
        const multi = byDay.size > 1 || Number(c.days) > 1;
        return (
          <div className="dw-agenda">
            {[...byDay].map(([day, list]) => (
              <section key={day} className="dw-agenda-day">
                {multi && <h3 className="dw-sub">{dayLabel(day)}</h3>}
                <ul className="dw-list" aria-label={t("dash.meetingsOf", { day: dayLabel(day) })}>
                  {list.map((e) => {
                    const end = new Date(e.end).getTime();
                    const start = new Date(e.start).getTime();
                    const past = end <= now;
                    const live = !past && start <= now;
                    const canBook = past && !e.all_day && !e.skip && e.entry_id == null && e.busy !== "free" && e.busy !== "oof";
                    return (
                      <li key={e.key} className={`dw-agenda-item ${past ? "past" : ""} ${live ? "live" : ""}`} style={{ "--ev": sourceColor(e.source, cal) } as CSSProperties}>
                        <button type="button" className="dw-agenda-row" onClick={() => openCalendarView({ date: day, key: e.key })} title={`${timeRange(e)} · ${sourceName(e.source, cal)}`}>
                          <span className="dw-agenda-time num">{isAllDayLike(e) ? t("dash.allDay") : hhmm(e.start)}</span>
                          <span className="dw-agenda-bar" aria-hidden />
                          <span className="dw-agenda-main">
                            <span className="ellipsis dw-agenda-title">{e.title}</span>
                            {e.location && <span className="ellipsis faint small">{e.location}</span>}
                          </span>
                        </button>
                        <span className="dw-agenda-actions">
                          {live && <Badge tone="accent">{t("dash.live")}</Badge>}
                          {e.entry_id != null && <Badge tone="success">{t("dash.booked")}</Badge>}
                          {e.link && !past && <IconButton icon={Video} size="sm" label={t("dash.joinTitle", { title: e.title })} onClick={() => openUrl(e.link!).catch((err) => s().error(t("dash.joinFailed"), err))} />}
                          {canBook && (
                            <Button size="sm" variant="ghost" icon={Timer} onClick={() => void book(e)} aria-label={t("dash.bookTitle", { title: e.title })}>
                              {t("dash.book")}
                            </Button>
                          )}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
            {dialog}
          </div>
        );
      }}
    </Loadable>
  );
}

// ------------------------------------------------------------------ Aufgaben

export function TasksWidget({ widget }: WidgetProps) {
  const { data, error, loading } = useWidgetData<TasksData>(widget);
  const { refresh } = useDash();
  const c = configOf(widget);
  const today = isoDay(new Date());
  return (
    <Loadable loading={loading} error={error}>
      {() => {
        const d = data!;
        return (
          <div className="dw-tasks">
            {d.tasks.length === 0 ? (
              <Empty icon={CheckCircle2}>{t("dash.tasksEmpty")}</Empty>
            ) : (
              <ul className="dw-list" aria-label={t("dash.w.tasks")}>
                {d.tasks.slice(0, 30).map((task) => (
                  <TaskRow key={`${task.page_id}:${task.ordinal}`} task={task} today={today} page={typeof c.page !== "number"} onDone={() => refresh(["tasks"])} />
                ))}
                <More n={d.total - Math.min(30, d.tasks.length)} onClick={() => s().openTab({ kind: "tasks" })} />
              </ul>
            )}
            {c.add !== false && <AddTask target={typeof c.page === "number" ? c.page : null} onAdded={() => refresh(["tasks", "pages"])} />}
          </div>
        );
      }}
    </Loadable>
  );
}

// ------------------------------------------------------------------ Fokus

export function FocusWidget({ widget }: WidgetProps) {
  const { data, error, loading } = useWidgetData<FocusData>(widget);
  const focus = useApp((st) => st.focus);
  const c = configOf(widget);
  const [writing, setWriting] = useState(false);
  const toNote = async () => {
    setWriting(true);
    try {
      const id = await api.focusDailyLine();
      await s().refreshTree();
      s().toast({ tone: "success", title: t("dash.focusNoted"), action: { label: t("dash.open"), run: () => s().openPage(id) } });
    } catch (e) {
      s().error(t("dash.focusNoteFailed"), e);
    } finally {
      setWriting(false);
    }
  };
  return (
    <Loadable loading={loading} error={error}>
      {() => {
        const { today, week } = data!;
        const max = Math.max(1, ...today.by_reference.map((r) => r.minutes));
        return (
          <div className="dw-focus">
            <div className="dw-focus-sum">
              <div>
                <span className="num dw-big">{today.sessions}</span>
                <span className="faint">
                  {today.sessions === 1 ? t("dash.sessionToday") : t("dash.sessionsToday")} · {hrs(today.minutes)}
                </span>
              </div>
              {c.week !== false && (
                <span className="faint small num">
                  {t("dash.focusWeek", { n: week.sessions, h: hrs(week.minutes) })}
                </span>
              )}
            </div>
            {focus ? (
              <div className={`dw-focus-live ${focus.phase}`}>
                <Target size={15} aria-hidden />
                <span className="faint ellipsis grow">{focus.phase === "work" ? focus.session.goal || focus.session.reference || t("dash.w.focus") : t("dash.focusBreak")}</span>
              </div>
            ) : today.by_reference.length === 0 ? (
              <div className="dw-quiet">{t("dash.focusNone")}</div>
            ) : null}
            {today.by_reference.length > 0 && (
              <ul className="dw-list dw-focus-list" aria-label={t("dash.focusByRef")}>
                {today.by_reference.slice(0, 4).map((r) => (
                  <li key={r.reference || "-"}>
                    <span className="mono ellipsis">{r.reference || t("dash.noRef")}</span>
                    <span className="dw-focus-bar" aria-hidden>
                      <span style={{ width: `${(r.minutes / max) * 100}%` }} />
                    </span>
                    <span className="num faint">{hrs(r.minutes)}</span>
                  </li>
                ))}
              </ul>
            )}
            <div className="dw-focus-actions">
              {!focus && (
                <Button size="sm" icon={Target} onClick={() => openFocusDialog()}>
                  {t("dash.focusStart")}
                </Button>
              )}
              {today.sessions > 0 && (
                <Button size="sm" variant="ghost" icon={NotebookPen} onClick={toNote} loading={writing}>
                  {t("dash.focusToNote")}
                </Button>
              )}
            </div>
          </div>
        );
      }}
    </Loadable>
  );
}

// ------------------------------------------------------------------ Uhr

export function ClockWidget({ widget }: WidgetProps) {
  const c = configOf(widget);
  const seconds = c.seconds === true;
  const now = new Date(useNow(seconds ? 1000 : 15_000));
  return (
    <div className="dw-clock">
      <div className="dw-clock-time num" aria-live="off">
        {fmt(now, { hour: "2-digit", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}) })}
      </div>
      <div className="dw-clock-date">{fmt(now, { weekday: "long", day: "numeric", month: "long" })}</div>
      {c.week !== false && <div className="faint small num">{t("dash.kwYear", { n: isoWeek(now), y: now.getFullYear() })}</div>}
    </div>
  );
}

// ------------------------------------------------------------------ Tagesrückblick

export function ReviewWidget({ widget }: WidgetProps) {
  const { data, error, loading } = useWidgetData<ReviewData>(widget);
  return (
    <Loadable loading={loading} error={error}>
      {() => {
        const r = data!;
        const label = dayLabel(r.date) === t("dash.today") ? t("dash.today") : fmt(new Date(`${r.date}T12:00:00`), { weekday: "long", day: "numeric", month: "long" });
        const share = r.target_minutes > 0 ? r.booked_minutes / r.target_minutes : 0;
        const stats: [string, string][] = [
          [t("dash.rev.pages"), String(r.pages_edited + r.pages_created)],
          [t("dash.rev.tasks"), String(r.tasks_done)],
          [t("dash.rev.meetings"), r.meetings_open ? `${r.meetings} (${t("dash.rev.open", { n: r.meetings_open })})` : String(r.meetings)],
          [t("dash.rev.focus"), hrs(r.focus_minutes)],
        ];
        return (
          <div className="dw-review">
            <div className="dw-review-head">
              <span className="muted">{label}</span>
              <button type="button" className="dw-link" onClick={() => openDayReview(r.date)}>
                {t("dash.open")}
              </button>
            </div>
            {r.empty ? (
              <Empty icon={Sunset}>{t("dash.rev.empty")}</Empty>
            ) : (
              <>
                <div className="dw-review-hours">
                  <span className="num dw-big">{hrs(r.booked_minutes)}</span>
                  {r.target_minutes > 0 && <span className="faint num">/ {hrs(r.target_minutes)}</span>}
                  <span className="grow" />
                  {r.target_minutes > 0 && (r.booked_minutes >= r.target_minutes ? <Badge tone="success">{t("dash.targetMet")}</Badge> : <Badge tone="warning">{t("dash.gapShort", { h: hrs(r.target_minutes - r.booked_minutes) })}</Badge>)}
                </div>
                {r.target_minutes > 0 && (
                  <div className="dw-meter" aria-hidden>
                    <span style={{ width: `${Math.min(1, share) * 100}%` }} />
                  </div>
                )}
                <dl className="dw-stats">
                  {stats.map(([k, v]) => (
                    <div key={k}>
                      <dt className="faint small">{k}</dt>
                      <dd className="num">{v}</dd>
                    </div>
                  ))}
                </dl>
                {r.top_wbs.length > 0 && (
                  <ul className="dw-list dw-review-wbs">
                    {r.top_wbs.map((w) => (
                      <li key={w.label} className="dw-row static">
                        <span className="mono ellipsis grow">{w.label}</span>
                        <span className="num faint">{hrs(w.minutes)}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {r.top_pages.length > 0 && (
                  <ul className="dw-list">
                    {r.top_pages.map((p) => (
                      <li key={p.label}>
                        <button type="button" className="dw-row dw-page" disabled={p.page_id == null} onClick={() => p.page_id != null && s().openPage(p.page_id)}>
                          <PageIcon name={p.icon} size={14} />
                          <span className="grow ellipsis">{p.label}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        );
      }}
    </Loadable>
  );
}

// ------------------------------------------------------------------ Kalender

export function CalendarWidget({ widget }: WidgetProps) {
  const settings = useApp((st) => st.settings?.settings);
  const { data } = useWidgetData<MonthData>(widget);
  const [offset, setOffset] = useState(0);
  const today = new Date();
  const cursor = addMonths(today, offset);
  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  const grid = useMemo(() => monthGrid(year, month, 1), [year, month]);
  // The widget's part covers this month; other months load on their own.
  const [other, setOther] = useState<MonthData | null>(null);
  const range = useMemo(() => [isoDay(grid[0][0]), isoDay(grid[5][6])] as const, [grid]);
  useEffect(() => {
    if (offset === 0) return;
    let alive = true;
    api.dailyOverview(range[0], range[1]).then((d) => alive && setOther(d), () => {});
    return () => {
      alive = false;
    };
  }, [offset, range]);
  const list = offset === 0 ? data : other;
  const days = useMemo(() => new Map((list ?? []).map((d) => [d.date, d])), [list]);
  const todayIso = isoDay(today);
  const target = settings?.daily_target_hours ?? 8;
  const workdays = settings?.workdays ?? [1, 2, 3, 4, 5];
  const trackedSince = [...days.values()].find((d) => d.booked_minutes > 0)?.date;
  const weekdays = useMemo(() => Array.from({ length: 7 }, (_, i) => fmt(addDays(weekStart(today, 1), i), { weekday: "short" }).slice(0, 2)), []);
  return (
    <div className="dw-cal">
      <div className="dw-cal-head">
        <span className="grow">{fmt(new Date(year, month, 1), { month: "long", year: "numeric" })}</span>
        <IconButton icon={ChevronLeft} label={t("dash.prevMonth")} size="sm" onClick={() => setOffset(offset - 1)} />
        <IconButton icon={ChevronRight} label={t("dash.nextMonth")} size="sm" onClick={() => setOffset(offset + 1)} />
      </div>
      <div className="dw-cal-grid" role="grid">
        {weekdays.map((w) => (
          <span key={w} className="dw-cal-wd">
            {w}
          </span>
        ))}
        {grid.flat().map((d) => {
          const iso = isoDay(d);
          const info = days.get(iso);
          const minutes = info?.booked_minutes ?? 0;
          const tone = dayTone(d, minutes, target, workdays, today, trackedSince);
          const cls = ["dw-cal-day", d.getMonth() !== month && "outside", iso === todayIso && "today", info?.has_note && "has-note", tone !== "none" && `tone-${tone}`].filter(Boolean).join(" ");
          return (
            <button key={iso} type="button" className={cls} data-date={iso} title={[iso, info?.has_note ? t("dash.dailyNote") : null, minutes > 0 ? `${hoursLabel(minutes)} h` : null].filter(Boolean).join(" · ")} onClick={(e) => openDailyNote(iso, e.ctrlKey || e.metaKey)}>
              {d.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}
