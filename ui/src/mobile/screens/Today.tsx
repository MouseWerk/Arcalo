// „Heute“: the date, booked time against the day's target, the running timer, today's
// meetings (from the desktop's calendars), tasks due and the way to the daily note.

import { useEffect, useState } from "react";
import { CalendarDays, ChevronRight, MapPin, NotebookPen, Pause, Play, RefreshCw, Settings as SettingsIcon, Square, TriangleAlert } from "lucide-react";
import { api } from "../../lib/api";
import { dateLong, relative, time } from "../../lib/format";
import { t } from "../../lib/i18n";
import type { CalendarEvent, GitSyncStatus } from "../../lib/types";
import { mobileApi, type Today } from "../api";
import { errorText, useMobile } from "../context";
import { hours, progress } from "../model";
import { Header, Notice, Section, Spinner } from "../ui";
import { TaskRow } from "./Tasks";

const MAX_TASKS = 5;

export function TodayScreen() {
  const m = useMobile();
  const [today, setToday] = useState<Today | null>(null);
  const [status, setStatus] = useState<GitSyncStatus | null>(null);
  const [conflicts, setConflicts] = useState(0);
  const [, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    mobileApi
      .today()
      .then((d) => live && setToday(d))
      .catch((e) => m.toast("error", errorText(e)));
    if (m.settings.git_sync.remote_url.trim()) {
      api.gitSyncStatus().then((s) => live && setStatus(s)).catch(() => {});
      api.gitConflicts().then((c) => live && setConflicts(c.length)).catch(() => {});
    }
    return () => {
      live = false;
    };
  }, [m.version]); // eslint-disable-line react-hooks/exhaustive-deps

  // The running timer counts up.
  useEffect(() => {
    if (!today?.timer || today.timer.paused_since) return;
    const id = window.setInterval(() => setTick((n) => n + 1), 30_000);
    return () => window.clearInterval(id);
  }, [today?.timer]);

  const now = new Date();
  const eyebrow = today ? dateLong(`${today.date}T12:00:00`) : "";
  const actions = (
    <>
      {m.settings.git_sync.remote_url.trim() && (
        <button type="button" className={m.syncing ? "m-icon-btn m-spin" : "m-icon-btn"} onClick={() => void m.sync()} aria-label={t("set.git.syncNow")} disabled={m.syncing}>
          <RefreshCw size={20} />
        </button>
      )}
      <button type="button" className="m-icon-btn" onClick={() => m.open({ kind: "settings" })} aria-label={t("mob.today.settings")}>
        <SettingsIcon size={20} />
      </button>
    </>
  );

  return (
    <div className="m-screen">
      <Header title={t("mob.tab.today")} eyebrow={eyebrow} actions={actions} />
      <div className="m-scroll">
        {!today ? (
          <div className="m-loading">
            <Spinner />
          </div>
        ) : (
          <>
            {status?.last_error && (
              <Notice tone="error" icon={<TriangleAlert size={18} />}>
                <strong>{t("mob.today.syncFailed")}</strong>
                <span>{status.last_error}</span>
              </Notice>
            )}
            {conflicts > 0 && (
              <button type="button" className="m-notice m-notice-warning m-notice-btn" onClick={() => m.open({ kind: "settings" })}>
                <span className="m-notice-icon">
                  <TriangleAlert size={18} />
                </span>
                <span className="m-notice-body">{t("mob.today.conflicts", { n: conflicts })}</span>
                <ChevronRight size={18} className="m-chevron" />
              </button>
            )}
            {today.time_tracking && <TimeCard today={today} now={now} />}
            <Section title={t("mob.today.meetings")} aside={today.events_from ? <span className="m-section-aside">{t("mob.today.meetingsFrom", { when: relative(today.events_from) })}</span> : undefined} flush>
              {today.events.length ? (
                <ul className="m-list">
                  {today.events.map((e) => (
                    <EventRow key={e.key} e={e} />
                  ))}
                </ul>
              ) : (
                <div className="m-card-empty">
                  <p>{t("mob.today.noMeetings")}</p>
                  {!today.events_from && <p className="m-faint">{t("mob.today.meetingsHint")}</p>}
                </div>
              )}
            </Section>
            <Section title={t("mob.today.due")} flush>
              {today.tasks.length ? (
                <ul className="m-list">
                  {today.tasks.slice(0, MAX_TASKS).map((task) => (
                    <TaskRow key={`${task.page_id}:${task.ordinal}`} task={task} />
                  ))}
                  {today.tasks.length > MAX_TASKS && (
                    <li>
                      <button type="button" className="m-row m-row-more" onClick={() => m.tab("tasks")}>
                        <span className="m-row-main">{t("mob.today.moreTasks", { n: today.tasks.length - MAX_TASKS })}</span>
                        <ChevronRight size={18} className="m-chevron" />
                      </button>
                    </li>
                  )}
                </ul>
              ) : (
                <div className="m-card-empty">
                  <p>{t("mob.today.noDue")}</p>
                </div>
              )}
            </Section>
            <Section flush>
              <button type="button" className="m-row" onClick={() => m.open({ kind: "daily", date: today.date })}>
                <span className="m-row-icon">
                  <NotebookPen size={20} />
                </span>
                <span className="m-row-main">
                  <span className="m-row-title">{t("mob.today.daily")}</span>
                  <span className="m-row-sub">{t("mob.today.dailyOpen")}</span>
                </span>
                <ChevronRight size={18} className="m-chevron" />
              </button>
            </Section>
          </>
        )}
      </div>
    </div>
  );
}

function TimeCard({ today, now }: { today: Today; now: Date }) {
  const m = useMobile();
  const timer = today.timer;
  // The timer's minutes since the start screen was loaded count too.
  const extra = timer && !timer.paused_since ? Math.max(0, Math.floor((now.getTime() - loadedAt(today)) / 60_000)) : 0;
  const booked = today.booked_minutes + extra;
  const share = progress(booked, today.target_minutes);
  const act = (f: () => Promise<unknown>) => () =>
    void f()
      .then(() => m.refresh())
      .catch((e) => m.toast("error", errorText(e)));
  return (
    <section className="m-section">
      <div className="m-card m-time-card">
        <div className="m-stat-row">
          <div>
            <div className="m-eyebrow">{t("mob.today.booked")}</div>
            <div className="m-stat">
              <span className="num">{hours(booked)}</span>
              <span className="m-stat-of">{today.target_minutes > 0 ? t("mob.today.ofTarget", { target: hours(today.target_minutes) }) : t("mob.today.noTarget")}</span>
            </div>
          </div>
          <div className="m-week">{t("mob.today.week", { time: hours(today.week_minutes + extra) })}</div>
        </div>
        <div className="m-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share * 100)} aria-label={t("mob.today.booked")}>
          <div className="m-progress-fill" style={{ width: `${share * 100}%` }} />
        </div>
        {timer && (
          <div className="m-timer-row">
            <span className={timer.paused_since ? "m-timer-dot paused" : "m-timer-dot"} aria-hidden="true" />
            <span className="m-row-main">
              <span className="m-row-title">{timer.paused_since ? t("mob.today.timerPaused") : t("mob.today.timerRunning")}</span>
              <span className="m-row-sub">
                {timer.reference}
                {timer.entry.description ? ` · ${timer.entry.description}` : ""} · <span className="num">{hours(timer.worked_minutes + extra)}</span>
              </span>
            </span>
            <button type="button" className="m-icon-btn m-icon-btn-soft" aria-label={timer.paused_since ? t("mob.time.resume") : t("mob.time.pause")} onClick={act(() => api.timerPause(!timer.paused_since))}>
              {timer.paused_since ? <Play size={20} /> : <Pause size={20} />}
            </button>
            <button
              type="button"
              className="m-icon-btn m-icon-btn-soft"
              aria-label={t("mob.time.stop")}
              onClick={act(async () => {
                const done = await mobileApi.timerStop();
                const minutes = done.reduce((n, e) => n + (e.duration_minutes ?? 0), 0);
                m.toast(done.length ? "success" : "info", done.length ? t("mob.time.stopped", { time: hours(minutes), ref: timer.reference }) : t("mob.time.tooShort"));
              })}
            >
              <Square size={18} />
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

const loaded = new WeakMap<Today, number>();
function loadedAt(today: Today) {
  let at = loaded.get(today);
  if (at === undefined) {
    at = Date.now();
    loaded.set(today, at);
  }
  return at;
}

function EventRow({ e }: { e: CalendarEvent }) {
  return (
    <li className="m-event">
      <span className="m-event-time num">{e.all_day ? t("mob.today.allDay") : `${time(e.start)}–${time(e.end)}`}</span>
      <span className="m-row-main">
        <span className="m-row-title">{e.title}</span>
        {e.location && (
          <span className="m-row-sub m-event-place">
            <MapPin size={13} />
            {e.location}
          </span>
        )}
      </span>
      <CalendarDays size={16} className="m-faint-icon" />
    </li>
  );
}
