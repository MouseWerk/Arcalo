// Building blocks the start page's widgets share: empty states, page and task rows, the timer
// block, a progress ring, hours and dates in the chosen format.

import { useEffect, useState, type ReactNode } from "react";
import { CalendarPlus, Pause, Play, Square, type LucideIcon } from "lucide-react";
import { api } from "../../lib/api";
import { useApp } from "../../store/app";
import { clock, fmtMinutes, formatPrefs, isoDay, relative } from "../../lib/format";
import { t } from "../../lib/i18n";
import type { Page, Task, TimeEntryRow } from "../../lib/types";
import { Badge, Button, IconButton, Spinner } from "../ui";
import { openPlanPicker, setPlanData, type PlanItem } from "../../lib/blocks";
import { PageIcon } from "../icons";
import { stopTimer, toggleTimerPause, useTimerSeconds } from "../Sidebar";

export const s = useApp.getState;

/** Hours in the style of the settings: „5,50 h“ or „5:30 h“. */
export const hrs = (minutes: number) => `${fmtMinutes(minutes)} h`;

export const locale = () => (formatPrefs().lang === "en" ? "en-GB" : "de-DE");

// Intl formatters are expensive to create (a start page formats hundreds of dates): one each.
const formatters = new Map<string, Intl.DateTimeFormat>();
/** `d` formatted with `opts` in the language of the settings. */
export function fmt(d: Date | string, opts: Intl.DateTimeFormatOptions): string {
  const key = `${locale()}|${JSON.stringify(opts)}`;
  let f = formatters.get(key);
  if (!f) formatters.set(key, (f = new Intl.DateTimeFormat(locale(), opts)));
  return f.format(typeof d === "string" ? new Date(d) : d);
}
export const hhmm = (d: Date | string) => fmt(d, { hour: "2-digit", minute: "2-digit" });

/** „Heute“, „Morgen“ or „Fr., 25.09.“. */
export function dayLabel(iso: string, today = new Date()): string {
  const t0 = isoDay(today);
  const tomorrow = isoDay(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1));
  if (iso === t0) return t("dash.today");
  if (iso === tomorrow) return t("dash.tomorrow");
  return fmt(new Date(`${iso}T12:00:00`), { weekday: "short", day: "2-digit", month: "2-digit" });
}

/** The time until `ms` from now: „in 25 Min.“, „in 1:10 h“. */
export function until(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60000));
  if (min < 1) return t("dash.now");
  if (min < 60) return t("dash.inMin", { n: min });
  return t("dash.inHours", { h: `${Math.floor(min / 60)}:${String(min % 60).padStart(2, "0")}` });
}

/** Re-renders every `ms` (clocks, countdowns, the now marker). */
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [ms]);
  return now;
}

export function Empty({ icon: Icon, children, action }: { icon?: LucideIcon; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="dw-empty">
      {Icon && <Icon size={18} strokeWidth={1.5} className="dw-empty-icon" aria-hidden />}
      <div>{children}</div>
      {action && <div className="dw-empty-action">{action}</div>}
    </div>
  );
}

/** Loading (a quiet spinner after a moment), an error, or the content. */
export function Loadable({ loading, error, children }: { loading: boolean; error?: string; children: () => ReactNode }) {
  if (error) return <div className="dw-error">{t("dash.loadFailed")}: {error}</div>;
  if (loading) return <Skeleton />;
  return <>{children()}</>;
}

export function Skeleton() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const id = window.setTimeout(() => setShow(true), 250);
    return () => window.clearTimeout(id);
  }, []);
  return show ? (
    <div className="dw-skel" aria-busy="true" aria-label={t("dash.loading")}>
      <span />
      <span />
      <span />
    </div>
  ) : null;
}

export function PageRows({ pages, when }: { pages: Page[]; when?: boolean }) {
  return (
    <ul className="dw-list">
      {pages.map((p) => (
        <li key={p.id}>
          <button type="button" className="dw-row dw-page" onClick={(e) => s().openPage(p.id, { newTab: e.ctrlKey || e.metaKey })}>
            <PageIcon name={p.icon} size={15} />
            <span className="grow ellipsis">{p.title}</span>
            {when && <span className="faint dw-when">{relative(p.updated_at)}</span>}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** A task with its checkbox; `onDone` after it was ticked off. */
export function TaskRow({ task, today, page = true, onDone }: { task: Pick<Task, "page_id" | "page_title" | "ordinal" | "text" | "due" | "priority">; today: string; page?: boolean; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [gone, setGone] = useState(false);
  const done = async () => {
    setBusy(true);
    try {
      await api.setTaskDone(task.page_id, task.ordinal, true, task.text);
      setGone(true);
      onDone();
    } catch (e) {
      s().error(t("dash.taskFailed"), e);
    } finally {
      setBusy(false);
    }
  };
  const overdue = !!task.due && task.due < today;
  const plan: PlanItem = { kind: "task", page_id: task.page_id, ordinal: task.ordinal, text: task.text, page_title: task.page_title };
  const text = task.text.replace(/\s#[\p{L}\p{N}_/-]+/gu, "").trim() || task.text;
  return (
    <li className={`dw-task ${gone ? "done" : ""}`} draggable={!gone} onDragStart={(e) => setPlanData(e.dataTransfer, plan)}>
      <button type="button" role="checkbox" aria-checked={gone} aria-label={t("dash.taskDone", { text: task.text })} className="dw-check" disabled={busy || gone} onClick={done} />
      <button type="button" className="dw-task-text" onClick={(e) => s().openPage(task.page_id, { newTab: e.ctrlKey || e.metaKey })} title={task.page_title}>
        <span className="grow ellipsis">{text}</span>
        {page && <span className="faint dw-task-page ellipsis">{task.page_title}</span>}
        {task.priority >= 2 && <Badge tone="warning">{t("dash.prioHigh")}</Badge>}
        {overdue ? <Badge tone="danger">{t("dash.overdue")}</Badge> : task.due && task.due !== today ? <span className="faint num dw-when">{dayLabel(task.due)}</span> : null}
      </button>
      {!gone && <IconButton icon={CalendarPlus} size="sm" className="dw-plan" label={t("blocks.plan")} onClick={() => openPlanPicker(plan)} />}
    </li>
  );
}

/** Progress ring (0..1, beyond 1 full); the label sits in its middle. */
export function Ring({ value, size = 64, stroke = 6, tone = "accent", children, label }: { value: number; size?: number; stroke?: number; tone?: "accent" | "success" | "warning"; children?: ReactNode; label: string }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(1, value));
  return (
    <div className={`dw-ring tone-${tone}`} style={{ width: size, height: size }} role="img" aria-label={label}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} className="dw-ring-track" strokeWidth={stroke} fill="none" />
        <circle cx={size / 2} cy={size / 2} r={r} className="dw-ring-fill" opacity={v > 0 ? 1 : 0} strokeWidth={stroke} fill="none" strokeDasharray={`${c * v} ${c}`} strokeLinecap="round" transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      </svg>
      <div className="dw-ring-label">{children}</div>
    </div>
  );
}

/** The running timer with „Stoppen“, or a quick start on the last references. */
export function TimerBlock({ refs, compact }: { refs: TimeEntryRow[] | undefined; compact?: boolean }) {
  const timer = useApp((st) => st.timer);
  const seconds = useTimerSeconds();
  const start = async (r: TimeEntryRow) => {
    try {
      await api.timerStart(r.netzplan_id, r.vorgang_nr, r.leistungsart, r.description);
      s().set({ timer: await api.timerStatus() });
      s().bumpEntries();
    } catch (e) {
      s().error(t("dash.timerFailed"), e);
    }
  };
  if (timer) {
    const e = timer.entry;
    const paused = !!timer.paused_since;
    return (
      <div className={`dw-timer running${paused ? " paused" : ""}`}>
        <span className={paused ? "pause-dot" : "rec-dot"} aria-hidden />
        <div className="grow dw-timer-main">
          <span className="num dw-big">{clock(seconds)}</span>
          <span className="faint ellipsis">{paused ? t("timer.paused") : e.description || e.vorgang_nr || t("dash.w.timer")}</span>
        </div>
        <IconButton icon={paused ? Play : Pause} label={paused ? t("timer.resume") : t("timer.pause")} onClick={() => void toggleTimerPause()} />
        <Button size="sm" icon={Square} onClick={() => stopTimer()}>
          {t("dash.stop")}
        </Button>
      </div>
    );
  }
  if (!refs) return <Spinner />;
  if (!refs.length) return <Empty>{t("dash.timerEmpty")}</Empty>;
  return (
    <ul className={`dw-list ${compact ? "dw-timer-refs compact" : "dw-timer-refs"}`} aria-label={t("dash.lastBooked")}>
      {refs.slice(0, compact ? 2 : 3).map((r) => {
        const ref = `${r.netzplan_nr}${r.vorgang_nr ? "/" + r.vorgang_nr : ""}`;
        return (
          <li key={`${r.netzplan_id}/${r.vorgang_nr}`}>
            <button type="button" className="dw-row dw-start" onClick={() => start(r)} aria-label={t("dash.timerStartOn", { ref })}>
              <Play size={13} aria-hidden />
              <span className="mono">{ref}</span>
              <span className="faint ellipsis grow">{r.description}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** „Mehr …“ at the end of a list. */
export function More({ n, onClick }: { n: number; onClick: () => void }) {
  if (n <= 0) return null;
  return (
    <li>
      <button type="button" className="dw-row dw-more" onClick={onClick}>
        {t("dash.more", { n })}
      </button>
    </li>
  );
}
