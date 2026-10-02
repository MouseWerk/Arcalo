// Work widgets of the start page (1.7): „Gleitzeitsaldo“, „Urlaub“, „Fristen“, „Markierte
// E-Mails“, „Nächster Termin“ and „Team“, the absence dialog (also in the Kalender's day
// header) and what the registry needs of them. The chart widgets live in charts.tsx.

import { useEffect, useState, type CSSProperties } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { BarChart3, CalendarClock, CalendarOff, Clock3, Flag, Grid3x3, Hourglass, KanbanSquare, Mail as MailIcon, NotebookPen, Palmtree, Plus, Users, Video, type LucideIcon } from "lucide-react";
import type { ComponentType } from "react";
import { api, on } from "../../lib/api";
import { useApp } from "../../store/app";
import { fmtDate, fmtHours, decimal, isoDay } from "../../lib/format";
import { currentLang, t } from "../../lib/i18n";
import { isAllDayLike, sourceColor, sourceName, timeRange } from "../../lib/agenda";
import { openCalendarView, openSettingsSection } from "../../lib/calnav";
import { useHiddenCalendars, visibleEvents } from "../../lib/calvisibility";
import { configOf } from "../../lib/dashboard";
import { sparkline } from "../../lib/charts";
import { useTimeTracking } from "../../lib/timetracking";
import {
  ABSENCE_KINDS,
  countdown,
  dayWithCountdown,
  deadlineSources,
  mergeDeadlines,
  nextChange,
  onDeadlineSources,
  PRESENCE_LABEL,
  sortTeam,
  workApi,
  type Absence,
  type AbsenceKind,
  type BalanceData,
  type Deadline,
  type DeadlinesData,
  type FlaggedMail,
  type Holiday,
  type TeamData,
  type VacationData,
  type WorkKind,
} from "../../lib/workwidgets";
import type { CalendarEvent, GridWidget } from "../../lib/types";
import type { AgendaData } from "../../lib/dashtypes";
import { Badge, Button, Dialog, IconButton, Input, Switch } from "../ui";
import { DateInput } from "../DateInput";
import { openMailDialog } from "../MailImport";
import { useDash, useWidgetData } from "./data";
import { dayLabel, Empty, fmt, hhmm, Loadable, Ring, s, until, useNow } from "./common";
import { nextMeeting } from "./day";
import { ChartWidget, HeatmapWidget, KanbanWidget } from "./charts";
import type { WidgetProps } from "./registry";

/** Signed hours: „+12,50 h“, „−3,25 h“. */
export const signedHours = (minutes: number) => `${minutes > 0 ? "+" : minutes < 0 ? "−" : "±"}${fmtHours(Math.abs(minutes) / 60)} h`;
/** Days with up to one decimal: „12“, „2,5“. */
const days = (n: number) => decimal(n, 1);
const holidayName = (h: Holiday) => (currentLang() === "en" ? h.name_en : h.name);

// ------------------------------------------------------------------ absences

const KIND_LABEL: Record<AbsenceKind, Parameters<typeof t>[0]> = {
  vacation: "work.abs.vacation",
  sick: "work.abs.sick",
  comp: "work.abs.comp",
  other: "work.abs.other",
};

/** Absences and holidays of a year, loaded once and renewed when absences change. */
const yearCache = new Map<number, Promise<{ absences: Absence[]; holidays: Holiday[] }>>();
const yearListeners = new Set<() => void>();
let subscribed = false;
function yearData(year: number) {
  if (!subscribed) {
    subscribed = true;
    void on("data://absences", () => {
      yearCache.clear();
      yearListeners.forEach((f) => f());
    });
    void on("settings://changed", () => {
      yearCache.clear();
      yearListeners.forEach((f) => f());
    });
  }
  let p = yearCache.get(year);
  if (!p) {
    p = workApi.absences(`${year}-01-01`, `${year}-12-31`).catch(() => ({ absences: [], holidays: [], state: "" }));
    yearCache.set(year, p);
  }
  return p;
}

/** The absence and the holiday of `date` (YYYY-MM-DD). */
export function useDayOff(date: string): { absence: Absence | null; holiday: Holiday | null } {
  const [v, setV] = useState<{ absence: Absence | null; holiday: Holiday | null }>({ absence: null, holiday: null });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const f = () => setTick((x) => x + 1);
    yearListeners.add(f);
    return () => void yearListeners.delete(f);
  }, []);
  useEffect(() => {
    let alive = true;
    yearData(Number(date.slice(0, 4))).then((d) => {
      if (alive) setV({ absence: d.absences.find((a) => a.date === date) ?? null, holiday: d.holidays.find((h) => h.date === date) ?? null });
    });
    return () => {
      alive = false;
    };
  }, [date, tick]);
  return v;
}

/** „Abwesenheit eintragen“: a day or a range, kind, half day, note; removing an entered day. */
export function AbsenceDialog({ date, existing, onClose }: { date: string; existing?: Absence | null; onClose: () => void }) {
  const [from, setFrom] = useState(date);
  const [to, setTo] = useState(date);
  const [kind, setKind] = useState<AbsenceKind>(existing?.kind ?? "vacation");
  const [half, setHalf] = useState(existing?.half ?? false);
  const [note, setNote] = useState(existing?.note ?? "");
  const [busy, setBusy] = useState(false);
  const range = to > from;
  const save = async () => {
    setBusy(true);
    try {
      const saved = await workApi.saveAbsence(from, to < from ? from : to, kind, half && !range, note);
      s().toast({ tone: "success", title: t("work.abs.saved", { n: saved.length }) });
      onClose();
    } catch (e) {
      s().error(t("work.abs.saveFailed"), e);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    try {
      await workApi.removeAbsence(date, date);
      onClose();
    } catch (e) {
      s().error(t("work.abs.saveFailed"), e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      width={500}
      title={existing ? t("work.abs.editTitle") : t("work.abs.title")}
      description={t("work.abs.desc")}
      footer={
        <>
          {existing && (
            <Button variant="ghost" onClick={remove} disabled={busy} className="wa-remove">
              {t("work.abs.remove")}
            </Button>
          )}
          <span className="grow" />
          <Button variant="ghost" onClick={onClose}>
            {t("dash.cancel")}
          </Button>
          <Button variant="primary" onClick={save} disabled={busy} className="wa-save">
            {t("common.save")}
          </Button>
        </>
      }
    >
      <div className="wa">
        <div className="wa-kinds" role="radiogroup" aria-label={t("work.abs.kind")}>
          {ABSENCE_KINDS.map((k) => (
            <button key={k} type="button" role="radio" aria-checked={kind === k} className={`wa-kind k-${k} ${kind === k ? "on" : ""}`} data-kind={k} onClick={() => setKind(k)}>
              <span className="wa-dot" aria-hidden />
              {t(KIND_LABEL[k])}
            </button>
          ))}
        </div>
        <p className="faint small wa-kind-hint">{t(`work.abs.${kind}Hint` as Parameters<typeof t>[0])}</p>
        <div className="wa-dates">
          <label className="field">
            <span className="field-label">{t("work.abs.from")}</span>
            <DateInput value={from} onChange={(v) => (setFrom(v), v > to && setTo(v))} aria-label={t("work.abs.from")} className="wa-from" />
          </label>
          <label className="field">
            <span className="field-label">{t("work.abs.to")}</span>
            <DateInput value={to} onChange={setTo} aria-label={t("work.abs.to")} className="wa-to" />
          </label>
        </div>
        {range ? (
          <p className="faint small">{t("work.abs.rangeHint")}</p>
        ) : (
          <div className="wa-half">
            <Switch checked={half} onChange={setHalf} label={t("work.abs.half")} />
            <span>{t("work.abs.half")}</span>
          </div>
        )}
        <label className="field">
          <span className="field-label">{t("work.abs.note")}</span>
          <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder={t("work.abs.notePh")} aria-label={t("work.abs.note")} />
        </label>
      </div>
    </Dialog>
  );
}

/** The Kalender's day header: the holiday's name, the absence, or (on hover) „Abwesenheit eintragen“. */
export function DayOffChip({ date }: { date: string }) {
  const timeOn = useTimeTracking();
  const { absence, holiday } = useDayOff(date);
  const [open, setOpen] = useState(false);
  if (!timeOn) return null;
  const label = absence ? `${t(KIND_LABEL[absence.kind])}${absence.half ? ` (${t("work.abs.halfShort")})` : ""}` : null;
  return (
    <>
      {holiday && (
        <span className="wa-holiday" data-tooltip={holidayName(holiday)} aria-label={holidayName(holiday)}>
          {holidayName(holiday)}
        </span>
      )}
      <button
        type="button"
        className={`calv-chip-btn wa-chip ${absence ? `set k-${absence.kind}` : ""}`}
        onClick={() => setOpen(true)}
        data-tooltip={label ?? t("work.abs.title")}
        aria-label={label ? t("work.abs.editLabel", { kind: label }) : t("work.abs.title")}
      >
        {absence ? <span className="wa-chip-text">{label}</span> : <CalendarOff size={12} aria-hidden />}
      </button>
      {open && <AbsenceDialog date={date} existing={absence} onClose={() => setOpen(false)} />}
    </>
  );
}

// ------------------------------------------------------------------ Gleitzeitsaldo

export function BalanceWidget({ widget }: WidgetProps) {
  const { data, error, loading } = useWidgetData<BalanceData>(widget);
  const [dialog, setDialog] = useState(false);
  const { today } = useDash();
  return (
    <Loadable loading={loading} error={error}>
      {() => {
        const d = data!;
        const values = d.weeks.map((w) => w.minutes);
        const spark = sparkline(values, 200, 44);
        const tone = d.minutes > 0 ? "pos" : d.minutes < 0 ? "neg" : "";
        return (
          <div className="wb">
            <div className="wb-main">
              <span className={`num wb-value ${tone}`} aria-label={t("work.bal.label", { h: signedHours(d.minutes) })}>
                {signedHours(d.minutes)}
              </span>
              <span className={`wb-delta num ${d.week_delta > 0 ? "pos" : d.week_delta < 0 ? "neg" : ""}`}>{t("work.bal.week", { h: signedHours(d.week_delta) })}</span>
            </div>
            {values.length > 1 && (
              <svg className="wb-spark" viewBox="0 0 200 44" preserveAspectRatio="none" role="img" aria-label={t("work.bal.spark", { n: values.length })}>
                {spark.zero != null && <line x1="0" x2="200" y1={spark.zero} y2={spark.zero} className="wb-zero" />}
                <path d={spark.path} className="wb-line" vectorEffect="non-scaling-stroke" />
                {d.weeks.map((w, i) => (
                  <title key={w.week_start}>{i === d.weeks.length - 1 ? `${fmtDate(`${w.week_start}T12:00:00`)}: ${signedHours(w.minutes)}` : ""}</title>
                ))}
              </svg>
            )}
            <div className="wb-today small">
              {d.running && <span className="rec-dot" aria-hidden />}
              <span className="faint">{t("work.bal.today")}</span>
              <span className="num">{t("work.bal.todayOf", { booked: fmtHours(d.today_booked / 60), target: fmtHours(d.today_target / 60) })}</span>
              <span className="grow" />
              <Button size="sm" variant="ghost" icon={CalendarOff} onClick={() => setDialog(true)} className="wb-absence">
                {t("work.abs.short")}
              </Button>
            </div>
            <div className="wb-foot faint small">
              {d.configured ? (
                t("work.bal.since", { date: fmtDate(`${d.start}T12:00:00`) })
              ) : (
                <button type="button" className="dw-link" onClick={() => openSettingsSection("time")}>
                  {t("work.bal.setStart")}
                </button>
              )}
            </div>
            {dialog && <AbsenceDialog date={isoDay(today)} onClose={() => setDialog(false)} />}
          </div>
        );
      }}
    </Loadable>
  );
}

// ------------------------------------------------------------------ Urlaub

export function VacationWidget({ widget }: WidgetProps) {
  const { data, error, loading } = useWidgetData<VacationData>(widget);
  const [dialog, setDialog] = useState(false);
  const { today } = useDash();
  return (
    <Loadable loading={loading} error={error}>
      {() => {
        const d = data!;
        const used = d.entitlement > 0 ? (d.taken + d.planned) / d.entitlement : 0;
        const todayIso = isoDay(today);
        return (
          <div className="wv">
            <div className="wv-top">
              <Ring value={used} size={68} stroke={7} tone={d.left < 0 ? "warning" : "accent"} label={t("work.vac.ring", { left: days(d.left), all: days(d.entitlement) })}>
                <span className="num wv-left">{days(d.left)}</span>
              </Ring>
              <div className="wv-facts">
                <div className="wv-title">{t("work.vac.left", { n: d.left })}</div>
                <dl className="wv-dl small">
                  <dt className="faint">{t("work.vac.taken")}</dt>
                  <dd className="num">{days(d.taken)}</dd>
                  <dt className="faint">{t("work.vac.planned")}</dt>
                  <dd className="num">{days(d.planned)}</dd>
                  <dt className="faint">{t("work.vac.entitlement", { year: d.year })}</dt>
                  <dd className="num">{days(d.entitlement)}</dd>
                </dl>
              </div>
            </div>
            <ul className="dw-list wv-list">
              {d.upcoming.map((b) => (
                <li key={b.from} className={`wv-row k-${b.kind}`}>
                  <span className="wa-dot" aria-hidden />
                  <span className="ellipsis grow">
                    {t(KIND_LABEL[b.kind])} <span className="faint">{b.from === b.to ? dayLabel(b.from, today) : `${fmtDate(`${b.from}T12:00:00`).slice(0, 6)} – ${fmtDate(`${b.to}T12:00:00`)}`}</span>
                  </span>
                  <span className="num faint">{t("work.vac.days", { n: b.days, d: days(b.days) })}</span>
                </li>
              ))}
              <li className="wv-row wv-holiday">
                <Palmtree size={13} aria-hidden className="faint" />
                {d.next_holiday ? (
                  <span className="wv-hol grow">
                    <span className="ellipsis">{holidayName(d.next_holiday)}</span>
                    <span className="num faint small">{d.next_holiday.date === todayIso ? t("dash.today") : dayWithCountdown(d.next_holiday.date, todayIso, dayLabel(d.next_holiday.date, today))}</span>
                  </span>
                ) : (
                  <button type="button" className="dw-link grow" onClick={() => openSettingsSection("time")}>
                    {t("work.vac.pickState")}
                  </button>
                )}
              </li>
            </ul>
            <Button size="sm" variant="ghost" icon={Plus} onClick={() => setDialog(true)} className="wv-add">
              {t("work.abs.title")}
            </Button>
            {dialog && <AbsenceDialog date={todayIso} onClose={() => setDialog(false)} />}
          </div>
        );
      }}
    </Loadable>
  );
}

// ------------------------------------------------------------------ Fristen

/** Items of the due-date sources registered in the UI (see `registerDeadlineSource`). */
function useUiDeadlines(today: string, until: string | undefined): Deadline[] {
  const [items, setItems] = useState<Deadline[]>([]);
  const [tick, setTick] = useState(0);
  useEffect(() => onDeadlineSources(() => setTick((x) => x + 1)), []);
  useEffect(() => {
    const list = deadlineSources();
    if (!until || !list.length) return setItems([]);
    let alive = true;
    Promise.all(list.map(([, f]) => f({ today, until }).catch(() => [] as Deadline[]))).then((r) => alive && setItems(r.flat()));
    return () => {
      alive = false;
    };
  }, [today, until, tick]);
  return items;
}

export function DeadlinesWidget({ widget }: WidgetProps) {
  const { data, error, loading } = useWidgetData<DeadlinesData>(widget);
  const { today } = useDash();
  const todayIso = isoDay(today);
  const extra = useUiDeadlines(todayIso, data?.until);
  return (
    <Loadable loading={loading} error={error}>
      {() => {
        const items = mergeDeadlines(data!.items, extra);
        if (!items.length) return <Empty icon={Hourglass}>{t("work.dl.none", { n: Number(configOf(widget).days ?? 14) })}</Empty>;
        const overdue = items.filter((d) => d.date < todayIso).length;
        return (
          <div className="wd">
            {overdue > 0 && <Badge tone="danger">{t("work.dl.overdueCount", { n: overdue })}</Badge>}
            <ul className="dw-list wd-list">
              {items.map((d) => {
                const c = countdown(d.date, todayIso);
                const open = () => (d.url ? void openUrl(d.url) : d.page_id != null ? s().openPage(d.page_id) : undefined);
                return (
                  <li key={`${d.source}|${d.key}`}>
                    <button type="button" className={`dw-row wd-row tone-${c.tone}`} onClick={open} title={`${fmtDate(`${d.date}T12:00:00`)} · ${d.detail}`}>
                      <span className="wd-date num">
                        <span className="wd-day">{fmt(new Date(`${d.date}T12:00:00`), { day: "2-digit" })}</span>
                        <span className="wd-mon">{fmt(new Date(`${d.date}T12:00:00`), { month: "short" }).replace(/\.$/, "")}</span>
                      </span>
                      <span className="wd-main">
                        <span className="ellipsis wd-title">{d.title}</span>
                        <span className="ellipsis faint small">{d.detail}</span>
                      </span>
                      {d.priority >= 2 && <Badge tone="warning">{t("dash.prioHigh")}</Badge>}
                      <span className={`wd-count num tone-${c.tone}`}>{c.text}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      }}
    </Loadable>
  );
}

// ------------------------------------------------------------------ Markierte E-Mails

let flaggedCache: { at: number; value: { available: boolean; mails: FlaggedMail[] } } | null = null;

export function MailFlagsWidget() {
  const [state, setState] = useState<{ available: boolean; mails: FlaggedMail[] } | null>(flaggedCache?.value ?? null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { today } = useDash();
  const load = async (force = false) => {
    if (!force && flaggedCache && Date.now() - flaggedCache.at < 60_000) return setState(flaggedCache.value);
    setBusy(true);
    try {
      const v = await workApi.flagged();
      flaggedCache = { at: Date.now(), value: v };
      setState(v);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void load();
    // Outlook is asked again every five minutes while the start page is open.
    const id = window.setInterval(() => void load(true), 5 * 60_000);
    return () => window.clearInterval(id);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (error)
    return (
      <Empty icon={MailIcon} action={<Button size="sm" onClick={() => void load(true)} disabled={busy}>{t("work.mail.retry")}</Button>}>
        <span className="wm-error">{error}</span>
      </Empty>
    );
  if (!state) return <Loadable loading error={undefined}>{() => null}</Loadable>;
  if (!state.available) return <Empty icon={MailIcon}>{t("work.mail.unavailable")}</Empty>;
  if (!state.mails.length) return <Empty icon={Flag}>{t("work.mail.none")}</Empty>;
  const todayIso = isoDay(today);
  return (
    <ul className="dw-list wm-list">
      {state.mails.map((m) => {
        const c = m.flag_due ? countdown(m.flag_due, todayIso) : null;
        return (
          <li key={m.entry_id} className="wm-row">
            <Flag size={13} aria-hidden className={`wm-flag ${c ? `tone-${c.tone}` : ""}`} />
            <div className="wm-main">
              <span className="ellipsis wm-subject" title={m.subject}>{m.subject}</span>
              <span className="wm-meta small">
                <span className="ellipsis faint">
                  {m.from_name || m.from_email}
                  {m.flag_request ? ` · ${m.flag_request}` : ""}
                </span>
                {c && <span className={`wd-count num tone-${c.tone}`}>{c.text}</span>}
              </span>
            </div>
            <span className="wm-actions">
              <IconButton icon={MailIcon} size="sm" label={t("work.mail.open", { subject: m.subject })} onClick={() => workApi.flaggedOpen(m.entry_id, m.store_id).catch((e) => s().error(t("work.mail.openFailed"), e))} />
              <IconButton icon={Plus} size="sm" label={t("work.mail.task", { subject: m.subject })} onClick={() => openMailDialog([m])} />
            </span>
          </li>
        );
      })}
    </ul>
  );
}

// ------------------------------------------------------------------ Nächster Termin

/** Outlook calendars of someone else. */
const SHARED_KINDS = new Set(["mailbox", "shared", "room", "group"]);

/** The meeting running now or next, and the one after it. */
export function upcomingTwo(events: CalendarEvent[], now: number): { first: { event: CalendarEvent; running: boolean } | null; second: CalendarEvent | null } {
  const first = nextMeeting(events, now);
  if (!first) return { first: null, second: null };
  const after = new Date(first.event.start).getTime();
  const second = events
    .filter((e) => !isAllDayLike(e) && e.busy !== "free" && e.key !== first.event.key && new Date(e.start).getTime() >= after && new Date(e.start).getTime() > now)
    .sort((a, b) => a.start.localeCompare(b.start))[0];
  return { first, second: second ?? null };
}

export function NextMeetingWidget({ widget }: WidgetProps) {
  const { data, error, loading } = useWidgetData<AgendaData>(widget);
  const cal = useApp((st) => st.settings?.settings.calendar);
  const hidden = useHiddenCalendars();
  const now = useNow(1000);
  const c = configOf(widget);
  const only = Array.isArray(c.sources) ? (c.sources as string[]) : [];
  const openNote = async (e: CalendarEvent) => {
    try {
      const r = await api.calendarMeetingNote(e.key);
      if (r.created) await s().refreshTree();
      s().openPage(r.page.id);
    } catch (err) {
      s().error(t("work.meet.noteFailed"), err);
    }
  };
  return (
    <Loadable loading={loading} error={error}>
      {() => {
        const d = data!;
        if (!d.configured)
          return (
            <Empty icon={CalendarClock} action={<Button size="sm" onClick={() => openSettingsSection("calendar")}>{t("dash.setup")}</Button>}>
              {t("dash.noCalendar")}
            </Empty>
          );
        // Without a choice: your own calendars (a colleague's meetings are not yours).
        const shared = new Set((cal?.outlook_calendars ?? []).filter((x) => SHARED_KINDS.has(x.kind)).map((x) => x.id));
        const events = visibleEvents(d.events, hidden).filter((e) => (only.length ? only.includes(e.source) : !shared.has(e.source)));
        const { first, second } = upcomingTwo(events, now);
        if (!first) return <Empty icon={CalendarClock}>{t("work.meet.none")}</Empty>;
        const e = first.event;
        const ms = first.running ? new Date(e.end).getTime() - now : new Date(e.start).getTime() - now;
        const soon = first.running || ms < 15 * 60_000;
        const secs = Math.max(0, Math.floor(ms / 1000));
        const clock = secs < 3600 ? `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}` : null;
        return (
          <div className={`wn ${first.running ? "live" : ""}`} style={{ "--ev": sourceColor(e.source, cal) } as CSSProperties}>
            <div className="wn-when small">
              <span className="dw-next-dot" aria-hidden />
              <span>{first.running ? t("work.meet.running") : dayLabel(isoDay(new Date(e.start)))}</span>
              <span className="faint num">{timeRange(e)}</span>
            </div>
            <button type="button" className="wn-title" onClick={() => openCalendarView({ date: isoDay(new Date(e.start)), key: e.key })}>
              {e.title}
            </button>
            {e.location && <div className="faint small ellipsis wn-loc">{e.location}</div>}
            <div className="wn-count" aria-live="off">
              <span className="num wn-clock">{clock ?? until(ms).replace(/^in /, "")}</span>
              <span className="faint small">{first.running ? t("work.meet.left") : t("work.meet.until")}</span>
            </div>
            <div className="wn-actions">
              {e.link && (
                <Button size="sm" variant={soon ? "primary" : "secondary"} icon={Video} onClick={() => openUrl(e.link!).catch((err) => s().error(t("dash.joinFailed"), err))}>
                  {t("dash.join")}
                </Button>
              )}
              <Button size="sm" variant="ghost" icon={NotebookPen} onClick={() => void openNote(e)}>
                {e.note_page_id ? t("work.meet.openNote") : t("work.meet.newNote")}
              </Button>
            </div>
            {second && (
              <button type="button" className="wn-then dw-row" onClick={() => openCalendarView({ date: isoDay(new Date(second.start)), key: second.key })} title={sourceName(second.source, cal)}>
                <span className="faint small">{t("work.meet.then")}</span>
                <span className="num small">{isoDay(new Date(second.start)) === isoDay(new Date(now)) ? hhmm(second.start) : `${dayLabel(isoDay(new Date(second.start)))} ${hhmm(second.start)}`}</span>
                <span className="ellipsis grow">{second.title}</span>
              </button>
            )}
          </div>
        );
      }}
    </Loadable>
  );
}

// ------------------------------------------------------------------ Team

export function TeamWidget({ widget }: WidgetProps) {
  const { data, error, loading } = useWidgetData<TeamData>(widget);
  const { refresh } = useDash();
  const now = useNow(30_000);
  const change = data ? nextChange(data.members) : null;
  // Someone's state changed meanwhile: ask again.
  useEffect(() => {
    if (change != null && now >= change) refresh(["calendar"]);
  }, [change, now, refresh]);
  return (
    <Loadable loading={loading} error={error}>
      {() => {
        const d = data!;
        if (!d.available.length) return <Empty icon={Users} action={<Button size="sm" onClick={() => openSettingsSection("calendar")}>{t("dash.setup")}</Button>}>{t("work.team.noCalendars")}</Empty>;
        if (!d.members.length) return <Empty icon={Users}>{t("work.team.pick")}</Empty>;
        return (
          <ul className="dw-list wt-list">
            {sortTeam(d.members).map((m) => (
              <li key={m.source} className={`wt-row st-${m.state}`}>
                <span className="wt-avatar" style={{ "--ev": m.color } as CSSProperties} aria-hidden>
                  {initials(m.name)}
                  <span className="wt-dot" />
                </span>
                <span className="wt-main">
                  <span className="ellipsis wt-name">{m.name}</span>
                  <span className="ellipsis faint small">
                    <span className={`wt-state st-${m.state}`}>{t(PRESENCE_LABEL[m.state])}</span>
                    {m.title ? ` · ${m.title}` : ""}
                  </span>
                </span>
                <span className="faint small num wt-until">{m.until ? untilText(m.until, m.next, now) : m.state === "free" ? t("work.team.freeAll") : ""}</span>
              </li>
            ))}
          </ul>
        );
      }}
    </Loadable>
  );
}

const initials = (name: string) =>
  name
    .replace(/,.*$/, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("") || "?";

/** „bis 11:30“, „ab 14:00 beschäftigt“, „bis Fr. 09:00“. */
function untilText(at: string, next: TeamData["members"][number]["next"], now: number): string {
  const d = new Date(at);
  const sameDay = isoDay(d) === isoDay(new Date(now));
  const time = sameDay ? hhmm(d) : `${fmt(d, { weekday: "short" })} ${hhmm(d)}`;
  return next && next !== "free" ? t("work.team.from", { time, state: t(PRESENCE_LABEL[next]) }) : t("work.team.until", { time });
}

// ------------------------------------------------------------------ registry

export const WORK_BODIES: Record<WorkKind, ComponentType<WidgetProps>> = {
  balance: BalanceWidget,
  vacation: VacationWidget,
  deadlines: DeadlinesWidget,
  mail_flags: MailFlagsWidget,
  next_meeting: NextMeetingWidget,
  team: TeamWidget,
  chart: ChartWidget,
  heatmap: HeatmapWidget,
  kanban: KanbanWidget,
};

export const WORK_ICONS: Record<WorkKind, LucideIcon> = {
  balance: Clock3,
  vacation: Palmtree,
  deadlines: Hourglass,
  mail_flags: Flag,
  next_meeting: CalendarClock,
  team: Users,
  chart: BarChart3,
  heatmap: Grid3x3,
  kanban: KanbanSquare,
};

/** Where a work widget's title leads. */
export function workOpener(w: GridWidget): (() => void) | null {
  const c = w.config ?? {};
  switch (w.kind) {
    case "balance":
      return () => s().openTab({ kind: "timesheet" });
    case "vacation":
    case "next_meeting":
    case "team":
      return () => openCalendarView();
    case "deadlines":
      return () => s().openTab({ kind: "tasks" });
    case "kanban":
      return typeof c.page === "number" ? () => s().openPage(c.page as number) : null;
    case "chart": {
      const chart = c.chart as { source?: string; page?: unknown } | undefined;
      return chart?.source === "pages" && typeof chart.page === "number" ? () => s().openPage(chart.page as number) : null;
    }
    default:
      return null;
  }
}

