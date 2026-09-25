// Kalender: meetings from Outlook and ICS next to the booked time. Day, work week, week, month
// and a list; a meeting opens a side panel to book it (prefilled, WBS remembered per series or
// subject), write its meeting note or mark it „nicht buchen“.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  AlertTriangle, CalendarDays, CalendarRange, CheckCircle2, ChevronLeft, ChevronRight, Clock, Eye, EyeOff, FileText, Layers, ListChecks, Lock, MapPin, NotebookPen, RefreshCw, Repeat, Settings2, Sunset, Timer, User, Users, Video, X,
} from "lucide-react";
import { api, on } from "../lib/api";
import { useApp } from "../store/app";
import { Badge, Button, EmptyState, IconButton, Segmented, Select } from "../components/ui";
import { openDailyNote, pickDate } from "../components/CalendarPopover";
import { dateLocale, fmtDate, fmtMinutes, formatPrefs, isoDay, isoWeek, relative } from "../lib/format";
import {
  bookedEntry, bookingPrefill, durationMinutes, hasSources, isAllDayLike, keyAction, layoutDay, minutesOfDay, monthCells, onDay as coversDay, rangeTitle, sourceColor, sourceName, step, timeRange, viewRange, weekLabel,
  type BookingPrefill, type CalView, type Range,
} from "../lib/agenda";
import { legendSources, setCalendarHidden, useHiddenCalendars, visibleEvents } from "../lib/calvisibility";
import { openSettingsSection, takeCalendarFocus } from "../lib/calnav";
import { useWbs } from "./wbs";
import { EntryDialog } from "./TimesheetView";
import type { CalendarEvent, CalendarSettings, CalendarSourceInfo, CalendarStatus, DayOverview, TimeEntryRow, WbsHint } from "../lib/types";
import { openDayReview } from "../lib/reviewnav";
import { useT, t as tr, type TKey } from "../lib/i18n";

/** Pixels per hour in the time grid. */
const HOUR = 48;
const VIEW_LABELS: Record<CalView, TKey> = { day: "calv.view.day", workweek: "calv.view.workweek", week: "calv.view.week", month: "calv.view.month", agenda: "calv.view.agenda" };
const BUSY_LABELS: Record<CalendarEvent["busy"], TKey> = { free: "calv.busy.free", tentative: "calv.busy.tentative", busy: "calv.busy.busy", oof: "calv.busy.oof", elsewhere: "calv.busy.elsewhere" };

function stored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key) as T | null;
    return v && allowed.includes(v) ? v : fallback;
  } catch {
    return fallback;
  }
}
function store(key: string, v: string) {
  try {
    localStorage.setItem(key, v);
  } catch {
    /* ignore */
  }
}

/** What the view showed last in this session (the view is unmounted when its tab is left). */
const session: { anchor: Date | null; selected: string | null } = { anchor: null, selected: null };

const entryEnd = (x: TimeEntryRow) => new Date(new Date(x.start_time).getTime() + (x.duration_minutes ?? 0) * 60000).toISOString();
const entryRef = (x: TimeEntryRow) => `${x.netzplan_nr}${x.vorgang_nr ? `/${x.vorgang_nr}` : ""}`;

export function CalendarView() {
  const t = useT();
  const settings = useApp((s) => s.settings?.settings);
  const cal = settings?.calendar;
  const version = useApp((s) => s.entriesVersion);
  const [view, setViewState] = useState<CalView>(() => stored("annalo.calendar.view", ["day", "workweek", "week", "month", "agenda"] as const, "workweek"));
  // The day and appointment shown survive switching tabs (this session only).
  const [anchor, setAnchorState] = useState(() => session.anchor ?? new Date());
  const setAnchor = (next: Date | ((d: Date) => Date)) =>
    setAnchorState((d) => {
      const v = typeof next === "function" ? next(d) : next;
      session.anchor = v;
      return v;
    });
  const [showBookings, setShowBookings] = useState(() => stored("annalo.calendar.bookings", ["1", "0"] as const, "1") === "1");
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [entries, setEntries] = useState<TimeEntryRow[]>([]);
  const [overview, setOverview] = useState<Map<string, DayOverview>>(new Map());
  const [status, setStatus] = useState<CalendarStatus | null>(null);
  const [selected, setSelectedState] = useState<string | null>(() => session.selected);
  const setSelected = (k: string | null) => {
    session.selected = k;
    setSelectedState(k);
  };
  const [booking, setBooking] = useState<{ event: CalendarEvent; prefill: BookingPrefill; hint: WbsHint | null } | null>(null);
  const [syncTick, setSyncTick] = useState(0);
  const [now, setNow] = useState(() => new Date());
  const { wbs, las } = useWbs();
  const root = useRef<HTMLDivElement>(null);
  const s = useApp.getState;

  const startsOn = formatPrefs().weekStartsOn;
  const workdays = settings?.workdays ?? [1, 2, 3, 4, 5];
  const range = useMemo(() => viewRange(view, anchor, startsOn, workdays), [view, anchor, startsOn, workdays.join(",")]);
  const rangeKey = `${view}:${isoDay(range.from)}:${isoDay(range.to)}`;

  const setView = (v: CalView) => {
    setViewState(v);
    store("annalo.calendar.view", v);
  };

  // Only the latest request may fill the view (fast paging).
  const seq = useRef(0);
  useEffect(() => {
    const n = ++seq.current;
    const last = new Date(range.to.getTime() - 1);
    Promise.all([
      api.calendarEvents(range.from.toISOString(), range.to.toISOString()),
      // From the day before: an entry that ran past midnight shows on the first day too.
      api.entries(new Date(range.from.getTime() - 86400e3).toISOString(), range.to.toISOString()),
      api.dailyOverview(isoDay(range.from), isoDay(last)).catch(() => [] as DayOverview[]),
    ])
      .then(([ev, en, ov]) => {
        if (n !== seq.current) return;
        setEvents(ev);
        setEntries(en);
        setOverview(new Map(ov.map((d) => [d.date, d])));
      })
      .catch((e) => n === seq.current && s().error(t("calv.loadFailed"), e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeKey, version, syncTick]);

  useEffect(() => {
    const load = () => api.calendarStatus().then(setStatus).catch(() => {});
    load();
    const offs = [
      on("calendar://synced", () => {
        load();
        setSyncTick((x) => x + 1);
      }),
      on("calendar://syncing", load),
      on("settings://changed", load),
    ];
    return () => offs.forEach((u) => u.then((f) => f()));
  }, [cal?.sources.length, cal?.outlook]);

  // The „now“ line moves every minute.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);

  // Opened on a day or appointment (dashboard, timesheet).
  useEffect(() => {
    const apply = () => {
      const f = takeCalendarFocus();
      if (!f) return;
      if (f.date) setAnchor(new Date(`${f.date}T12:00:00`));
      if (f.key) setSelected(f.key);
    };
    apply();
    window.addEventListener("annalo:calendar-focus", apply);
    return () => window.removeEventListener("annalo:calendar-focus", apply);
  }, []);

  // Calendars hidden in the legend (the view only; they keep syncing).
  const hidden = useHiddenCalendars();
  const shown = useMemo(() => visibleEvents(events, hidden), [events, hidden]);
  const booked = useMemo(() => new Map(shown.map((e) => [e.key, bookedEntry(e, entries)])), [shown, entries]);
  const current = shown.find((e) => e.key === selected) ?? null;
  const syncing = status?.sources.some((x) => x.enabled && x.syncing) ?? false;
  const errors = status?.sources.filter((x) => x.enabled && x.status?.error) ?? [];
  const configured = status ? hasSources(cal, status.outlook_available) : true;

  const go = (dir: -1 | 1) => setAnchor((a) => step(view, a, dir));
  const today = () => setAnchor(new Date());
  const openDay = (d: Date) => {
    setAnchor(d);
    setView("day");
  };

  // Keys work while this pane is the active one and nothing else (a field, a dialog, a menu) has them.
  const keyState = useRef({ selected, go, today, setView });
  keyState.current = { selected, go, today, setView };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = root.current;
      const focused = document.activeElement as HTMLElement | null;
      if (!el || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      if (!el.closest(".pane")?.classList.contains("active")) return;
      // Not while another pane (a note) has the focus.
      const pane = focused?.closest(".pane");
      if (pane && !pane.contains(el)) return;
      if (focused?.closest("input, textarea, select, [contenteditable='true'], [role='combobox']")) return;
      if (document.querySelector(".dialog, .menu, .palette, .calendar, .select-pop")) return;
      const k = keyState.current;
      if (e.key === "Escape") {
        if (k.selected) {
          e.preventDefault();
          setSelected(null);
        }
        return;
      }
      const a = keyAction(e.key);
      if (!a) return;
      e.preventDefault();
      if (a.move) k.go(a.move);
      if (a.today) k.today();
      if (a.view) k.setView(a.view);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const sync = async () => {
    try {
      const st = await api.calendarSyncNow();
      setStatus(st);
      setSyncTick((x) => x + 1);
      const failed = st.sources.filter((x) => x.enabled && x.status?.error);
      if (failed.length) s().toast({ tone: "warning", title: t("cal.notAllSynced"), detail: failed.map((f) => `${f.name}: ${f.status?.error}`).join("\n") });
    } catch (e) {
      s().error(t("cal.syncFailed"), e);
    }
  };

  const book = async (e: CalendarEvent) => {
    if (!wbs.some((p) => p.netzplaene.length)) {
      s().toast({ tone: "warning", title: t("time.noNetzplan"), detail: t("time.noNetzplanText"), action: { label: t("ribbon.projects"), run: () => s().openTab({ kind: "projects" }) } });
      return;
    }
    const hint = await api.calendarWbsHint(e.key).catch(() => null);
    setBooking({ event: e, hint, prefill: bookingPrefill(e, hint, settings?.daily_target_hours ?? 8) });
  };

  const note = async (e: CalendarEvent) => {
    try {
      const { page, created } = await api.calendarMeetingNote(e.key);
      await s().refreshTree();
      s().openPage(page.id, { newTab: true });
      if (created) s().toast({ tone: "success", title: t("calv.noteCreated"), detail: page.title });
      setSyncTick((x) => x + 1);
    } catch (err) {
      s().error(t("calv.noteFailed"), err);
    }
  };

  const skip = async (e: CalendarEvent) => {
    try {
      await api.calendarSetSkip(e.key, !e.skip);
      setSyncTick((x) => x + 1);
    } catch (err) {
      s().error(t("common.notSaved"), err);
    }
  };

  const title = rangeTitle(view, range, anchor);
  const pickerDay = isoDay(anchor);

  return (
    <div className={`calv ${current ? "with-detail" : ""}`} ref={root} tabIndex={-1} aria-label={t("nav.calendar")}>
      <header className="calv-head">
        <div className="calv-heading">
          <h1>{title}</h1>
          {view !== "month" && view !== "agenda" && <span className="calv-kw">{weekLabel(range)}</span>}
          {view === "month" && <span className="calv-kw">{t("time.weekNo", { n: `${isoWeek(range.days[0])}–${isoWeek(range.days[range.days.length - 1])}` })}</span>}
        </div>
        <div className="calv-tools">
          <div className="calv-nav" role="group" aria-label={t("feed.range.custom")}>
            <IconButton icon={ChevronLeft} label={t("calv.back")} onClick={() => go(-1)} />
            <Button size="sm" variant="ghost" onClick={today} title={t("calv.todayKey")}>
              {t("feed.range.today")}
            </Button>
            <IconButton icon={ChevronRight} label={t("calv.forward")} onClick={() => go(1)} />
            <IconButton icon={CalendarDays} label={t("calv.pickDate")} onClick={(ev) => pickDate(ev.currentTarget, pickerDay, (iso) => setAnchor(new Date(`${iso}T12:00:00`)))} />
          </div>
          <div className="calv-views">
            <Segmented label={t("calv.view")} value={view} onChange={setView} options={(["day", "workweek", "week", "month", "agenda"] as CalView[]).map((v) => ({ value: v, label: t(VIEW_LABELS[v]) }))} />
          </div>
          <Select className="calv-view-select" aria-label={t("calv.view")} value={view} onChange={(e) => setView(e.target.value as CalView)} options={(["day", "workweek", "week", "month", "agenda"] as CalView[]).map((v) => ({ value: v, label: t(VIEW_LABELS[v]) }))} />
          <div className="calv-actions">
            <IconButton
              icon={Layers}
              label={showBookings ? t("calv.hideBooked") : t("calv.showBooked")}
              active={showBookings}
              aria-pressed={showBookings}
              onClick={() => {
                setShowBookings(!showBookings);
                store("annalo.calendar.bookings", showBookings ? "0" : "1");
              }}
            />
            <IconButton icon={RefreshCw} label={t("calset.syncNow")} className={syncing ? "spinning" : ""} disabled={!configured} onClick={() => void sync()} />
            <IconButton icon={Settings2} label={t("calv.settings")} onClick={() => openSettingsSection("calendar")} />
          </div>
        </div>
      </header>

      {errors.length > 0 && (
        <div className="calv-banner" role="status">
          <AlertTriangle size={14} aria-hidden />
          <span>
            {errors.map((x) => (
              <span key={x.id} className="calv-banner-item">
                <b>{x.name}:</b> {x.status?.error}
              </span>
            ))}
          </span>
          <Button size="sm" variant="ghost" onClick={() => openSettingsSection("calendar")}>
            {t("ribbon.settings")}
          </Button>
        </div>
      )}

      {!configured ? (
        <div className="calv-empty">
          <EmptyState
            icon={CalendarRange}
            title={t("calv.none")}
            action={
              <Button variant="primary" icon={Settings2} onClick={() => openSettingsSection("calendar")}>
                {t("calv.setUp")}
              </Button>
            }
          >
            {status?.outlook_available ? t("calv.noneOutlook") : t("calv.noneIcs")}
          </EmptyState>
        </div>
      ) : (
        <>
        <CalendarLegend sources={legendSources(status)} hidden={hidden} />
        <div className="calv-main">
          <div className="calv-body">
            {view === "month" ? (
              <MonthGrid range={range} anchor={anchor} events={shown} overview={overview} cal={cal} booked={booked} selected={selected} onSelect={setSelected} onDay={openDay} />
            ) : view === "agenda" ? (
              <AgendaList range={range} events={shown} cal={cal} booked={booked} selected={selected} onSelect={setSelected} />
            ) : (
              <TimeGrid
                range={range}
                rangeKey={rangeKey}
                events={shown}
                entries={showBookings ? entries : []}
                overview={overview}
                cal={cal}
                booked={booked}
                now={now}
                selected={selected}
                onSelect={setSelected}
                onDay={openDay}
              />
            )}
          </div>
          {current && (
            <EventDetail
              event={current}
              cal={cal}
              booked={booked.get(current.key) ?? null}
              onClose={() => setSelected(null)}
              onBook={() => void book(current)}
              onNote={() => void note(current)}
              onSkip={() => void skip(current)}
            />
          )}
        </div>
        </>
      )}

      {booking && (
        <EntryDialog
          entry={null}
          wbs={wbs}
          las={las}
          defaultDay={new Date(`${booking.prefill.day}T12:00:00`)}
          prefill={booking.prefill}
          note={
            <div className="calv-book-note">
              <CalendarRange size={14} aria-hidden />
              <span>
                {t("time.fromMeeting", { title: booking.event.title, time: timeRange(booking.event) })}
                {booking.hint ? (
                  <>
                    {" · "}
                    {t("time.wbsLikeLast")} <b>{booking.hint.reference}</b>
                  </>
                ) : null}
              </span>
            </div>
          }
          onClose={() => setBooking(null)}
          onSaved={(id) => {
            const key = booking.event.key;
            void api
              .calendarLinkEntry(key, id)
              .then(() => setSyncTick((x) => x + 1))
              .catch((e) => s().error(t("time.linkFailed"), e));
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- legend

/** The calendars with their colors; a click hides or shows one in the view (sync stays as it is). */
function CalendarLegend({ sources, hidden }: { sources: CalendarSourceInfo[]; hidden: ReadonlySet<string> }) {
  const t = useT();
  if (sources.length < 2) return null;
  const off = sources.filter((x) => hidden.has(x.id)).length;
  return (
    <div className="calv-legend" role="group" aria-label={t("olcal.legend")}>
      {sources.map((src) => {
        const on = !hidden.has(src.id);
        const name = src.name;
        return (
          <button
            type="button"
            key={src.id}
            className={`calv-legend-item ${on ? "" : "off"}`}
            style={{ "--ev": src.color } as CSSProperties}
            aria-pressed={on}
            data-source={src.id}
            data-tooltip={on ? t("olcal.hide", { name }) : t("olcal.show", { name })}
            onClick={() => setCalendarHidden(src.id, on)}
          >
            <span className="calv-legend-dot" aria-hidden />
            <span className="ellipsis">{name}</span>
          </button>
        );
      })}
      {off > 0 && (
        <span className="calv-legend-note faint">
          {t("olcal.hiddenNote", { n: off })}
          <button type="button" className="calv-linkbtn" onClick={() => sources.forEach((x) => setCalendarHidden(x.id, false))}>
            {t("olcal.showAll")}
          </button>
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- time grid

type Booked = Map<string, TimeEntryRow | { id: number } | null>;

function eventStyle(e: CalendarEvent, cal: CalendarSettings | undefined): CSSProperties {
  return { "--ev": sourceColor(e.source, cal) } as CSSProperties;
}

function eventClass(e: CalendarEvent, booked: Booked, selected: string | null) {
  return ["calv-ev", `busy-${e.busy}`, booked.get(e.key) ? "booked" : "", e.skip ? "skipped" : "", e.key === selected ? "selected" : ""].filter(Boolean).join(" ");
}

function EventMarks({ e, booked }: { e: CalendarEvent; booked: Booked }) {
  const t = useT();
  return (
    <>
      {booked.get(e.key) && <CheckCircle2 className="calv-mark booked" size={12} aria-label={t("review.meeting.booked")} />}
      {!booked.get(e.key) && e.skip && <EyeOff className="calv-mark" size={12} aria-label={t("review.meeting.skipped")} />}
      {e.private && <Lock className="calv-mark" size={11} aria-label={t("calv.private")} />}
      {e.recurring && <Repeat className="calv-mark faint-mark" size={11} aria-label={t("calv.series")} />}
    </>
  );
}

function evLabel(e: CalendarEvent, booked: Booked) {
  const parts = [e.title, timeRange(e), e.location, booked.get(e.key) ? tr("review.meeting.booked") : e.skip ? tr("review.meeting.skipped") : ""].filter(Boolean);
  return parts.join(", ");
}

function DayHead({ d, ov, onDay }: { d: Date; ov: DayOverview | undefined; onDay: (d: Date) => void }) {
  const t = useT();
  const iso = isoDay(d);
  const isToday = iso === isoDay(new Date());
  const l = dateLocale();
  return (
    <div className={`calv-dayhead ${isToday ? "today" : ""}`} data-date={iso}>
      <button type="button" className="calv-dayhead-date" onClick={() => onDay(d)} aria-label={t("calv.showDay", { day: d.toLocaleDateString(l, { weekday: "long", day: "numeric", month: "long" }) })}>
        <span className="calv-wd">{d.toLocaleDateString(l, { weekday: "short" }).replace(".", "")}</span>
        <span className="calv-dn">{d.getDate()}</span>
      </button>
      <div className="calv-dayhead-info">
        {ov?.has_note && (
          <button type="button" className="calv-chip-btn" onClick={() => void openDailyNote(iso)} data-tooltip={t("calv.openDaily")} aria-label={t("calv.openDaily")}>
            <FileText size={12} aria-hidden />
          </button>
        )}
        {!!ov?.open_tasks && (
          <button type="button" className="calv-chip-btn" onClick={() => useApp.getState().openTab({ kind: "tasks" })} data-tooltip={t("calv.tasksDue", { n: ov.open_tasks })} aria-label={t("calv.tasksDue", { n: ov.open_tasks })}>
            <ListChecks size={12} aria-hidden />
            {ov.open_tasks}
          </button>
        )}
        {!!ov?.booked_minutes && (
          <span className="calv-booked-sum" data-tooltip={t("calv.booked")} aria-label={t("calv.hoursBooked", { h: fmtMinutes(ov.booked_minutes) })}>
            <Timer size={11} aria-hidden />
            {fmtMinutes(ov.booked_minutes)} h
          </span>
        )}
        {iso <= isoDay(new Date()) && (
          <button type="button" className="calv-chip-btn calv-review-btn" onClick={(e) => openDayReview(iso, { newTab: e.ctrlKey || e.metaKey })} data-tooltip={t("ribbon.review")} aria-label={t("ribbon.review")}>
            <Sunset size={12} aria-hidden />
          </button>
        )}
      </div>
    </div>
  );
}

function TimeGrid(props: {
  range: Range;
  rangeKey: string;
  events: CalendarEvent[];
  entries: TimeEntryRow[];
  overview: Map<string, DayOverview>;
  cal: CalendarSettings | undefined;
  booked: Booked;
  now: Date;
  selected: string | null;
  onSelect: (k: string) => void;
  onDay: (d: Date) => void;
}) {
  const t = useT();
  const { range, events, entries, overview, cal, booked, now, selected, onSelect, onDay } = props;
  const scroll = useRef<HTMLDivElement>(null);
  const scrolledFor = useRef("");
  const allDay = events.filter(isAllDayLike);
  const timed = events.filter((e) => !isAllDayLike(e));
  const withLane = entries.length > 0;

  // Opens on the working hours (or the first meeting, when earlier).
  useLayoutEffect(() => {
    const el = scroll.current;
    if (!el || scrolledFor.current === props.rangeKey) return;
    scrolledFor.current = props.rangeKey;
    const first = timed.filter((e) => range.days.some((d) => coversDay(e, d))).map((e) => minutesOfDay(new Date(e.start)));
    const start = Math.min(7 * 60 + 30, ...first.map((m) => m - 30));
    el.scrollTop = Math.max(0, (start / 60) * HOUR);
  });

  const cols = { "--days": range.days.length } as CSSProperties;
  const todayIso = isoDay(now);
  return (
    <div className={`calv-grid ${withLane ? "with-lane" : ""} days-${range.days.length}`} style={cols}>
      <div className="calv-scroll" ref={scroll}>
        <div className="calv-sticky">
          <div className="calv-row calv-heads">
            <div className="calv-gutter" />
            {range.days.map((d) => (
              <DayHead key={isoDay(d)} d={d} ov={overview.get(isoDay(d))} onDay={onDay} />
            ))}
          </div>
          <div className="calv-row calv-allday">
            <div className="calv-gutter calv-allday-label">{t("cal.allDay")}</div>
            {range.days.map((d) => {
              const list = allDay.filter((e) => coversDay(e, d));
              return (
                <div key={isoDay(d)} className="calv-allday-cell">
                  {list.map((e) => (
                    <button type="button" key={e.key} className={`${eventClass(e, booked, selected)} calv-chip`} style={eventStyle(e, cal)} onClick={() => onSelect(e.key)} aria-label={evLabel(e, booked)}>
                      <span className="calv-ev-title">{e.title}</span>
                      <EventMarks e={e} booked={booked} />
                    </button>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
        <div className="calv-row calv-timeline" style={{ height: 24 * HOUR }}>
          <div className="calv-gutter calv-hours" aria-hidden>
            {Array.from({ length: 24 }, (_, h) => (
              <span key={h} style={{ top: h * HOUR }}>
                {h === 0 ? "" : `${String(h).padStart(2, "0")}:00`}
              </span>
            ))}
          </div>
          {range.days.map((d) => {
            const iso = isoDay(d);
            const placed = layoutDay(timed, d);
            const lane = layoutDay(
              entries.filter((x) => x.status_flag !== "running" && x.duration_minutes).map((x) => ({ start: x.start_time, end: entryEnd(x), x })),
              d,
              10,
            );
            const weekend = [0, 6].includes(d.getDay());
            return (
              <div key={iso} className={`calv-col ${weekend ? "weekend" : ""} ${iso === todayIso ? "today" : ""} ${lane.length ? "has-lane" : ""}`} data-date={iso}>
                <div className="calv-meetings">
                  {placed.map((p) => {
                    const e = p.item;
                    const style = {
                      ...eventStyle(e, cal),
                      top: (p.top / 60) * HOUR,
                      height: Math.max((p.height / 60) * HOUR - 2, 16),
                      left: `calc(${(p.col / p.cols) * 100}% + 1px)`,
                      width: `calc(${100 / p.cols}% - 3px)`,
                    } as CSSProperties;
                    const short = p.height < 40;
                    return (
                      <button type="button" key={e.key} className={`${eventClass(e, booked, selected)} ${short ? "short" : ""}`} style={style} onClick={() => onSelect(e.key)} aria-label={evLabel(e, booked)} data-key={e.key}>
                        <span className="calv-ev-title">{e.title}</span>
                        {!short && <span className="calv-ev-meta">{timeRange(e)}{e.location ? ` · ${e.location}` : ""}</span>}
                        <span className="calv-ev-marks">
                          <EventMarks e={e} booked={booked} />
                        </span>
                      </button>
                    );
                  })}
                </div>
                {lane.length > 0 && (
                  <div className="calv-lane" aria-label={t("calv.bookedTime")}>
                    {lane.map((p) => {
                      const x = p.item.x;
                      const label = `${entryRef(x)} · ${fmtMinutes(x.duration_minutes)} h${x.description ? ` · ${x.description}` : ""}`;
                      return (
                        <button
                          type="button"
                          key={x.id}
                          data-entry={x.id}
                          className={`calv-entry status-${x.status_flag}`}
                          style={{ top: (p.top / 60) * HOUR, height: Math.max((p.height / 60) * HOUR - 1, 6), left: `${(p.col / p.cols) * 100}%`, width: `${100 / p.cols}%` }}
                          data-tooltip={label}
                          aria-label={t("calv.bookedLabel", { label })}
                          onClick={() => useApp.getState().openTab({ kind: "timesheet" })}
                        >
                          <span>{entryRef(x)}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
                {iso === todayIso && <div className="calv-now" style={{ top: (minutesOfDay(now) / 60) * HOUR }} aria-hidden />}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- month

function MonthGrid(props: {
  range: Range;
  anchor: Date;
  events: CalendarEvent[];
  overview: Map<string, DayOverview>;
  cal: CalendarSettings | undefined;
  booked: Booked;
  selected: string | null;
  onSelect: (k: string) => void;
  onDay: (d: Date) => void;
}) {
  const t = useT();
  const { range, anchor, events, overview, cal, booked, selected, onSelect, onDay } = props;
  const cells = useMemo(() => monthCells(events, range.days, 4), [events, range]);
  const weeks = Array.from({ length: range.days.length / 7 }, (_, w) => range.days.slice(w * 7, w * 7 + 7));
  const l = dateLocale();
  const todayIso = isoDay(new Date());
  return (
    <div className="calv-month" role="grid" aria-label={t("calv.view.month")}>
      <div className="calv-month-row calv-month-head" role="row">
        <div className="calv-month-kw">{t("calv.weekShort")}</div>
        {weeks[0].map((d) => (
          <div key={d.getDay()} className="calv-month-wd" role="columnheader">
            {d.toLocaleDateString(l, { weekday: "short" }).replace(".", "")}
          </div>
        ))}
      </div>
      {weeks.map((week) => (
        <div key={isoDay(week[0])} className="calv-month-row" role="row">
          <div className="calv-month-kw">{isoWeek(week[0])}</div>
          {week.map((d) => {
            const iso = isoDay(d);
            const cell = cells.get(iso);
            const ov = overview.get(iso);
            const out = d.getMonth() !== anchor.getMonth();
            return (
              <div key={iso} className={`calv-mcell ${out ? "out" : ""} ${iso === todayIso ? "today" : ""}`} role="gridcell" data-date={iso}>
                <div className="calv-mcell-head">
                  <button type="button" className="calv-mday" onClick={() => onDay(d)} aria-label={t("calv.showDay", { day: fmtDate(d) })}>
                    {d.getDate()}
                  </button>
                  {ov?.has_note && <span className="calv-mnote" data-tooltip={t("capture.daily")} aria-label={t("capture.daily")} />}
                  {!!ov?.booked_minutes && <span className="calv-mhours">{fmtMinutes(ov.booked_minutes)} h</span>}
                </div>
                <div className="calv-mlist">
                  {cell?.shown.map((e) => (
                    <button
                      type="button"
                      key={e.key}
                      className={`${eventClass(e, booked, selected)} calv-mev ${isAllDayLike(e) ? "allday" : ""}`}
                      style={eventStyle(e, cal)}
                      onClick={() => onSelect(e.key)}
                      aria-label={evLabel(e, booked)}
                    >
                      {!isAllDayLike(e) && <span className="calv-mev-time">{timeRange(e).slice(0, 5)}</span>}
                      <span className="calv-ev-title">{e.title}</span>
                      <EventMarks e={e} booked={booked} />
                    </button>
                  ))}
                  {!!cell?.more && (
                    <button type="button" className="calv-more" onClick={() => onDay(d)}>
                      {t("calv.more", { n: cell.more })}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- list

function AgendaList({ range, events, cal, booked, selected, onSelect }: { range: Range; events: CalendarEvent[]; cal: CalendarSettings | undefined; booked: Booked; selected: string | null; onSelect: (k: string) => void }) {
  const t = useT();
  const l = dateLocale();
  const days = range.days.map((d) => ({ d, list: events.filter((e) => coversDay(e, d)) })).filter((x) => x.list.length);
  if (!days.length)
    return (
      <div className="calv-empty">
        <EmptyState icon={CalendarDays} title={t("calv.noEvents")}>
          {t("calv.noEventsText", { n: range.days.length, from: fmtDate(range.days[0]) })}
        </EmptyState>
      </div>
    );
  const todayIso = isoDay(new Date());
  return (
    <div className="calv-agenda">
      {days.map(({ d, list }) => (
        <section key={isoDay(d)} className={`calv-agenda-day ${isoDay(d) === todayIso ? "today" : ""}`}>
          <h2>
            <span>{d.toLocaleDateString(l, { weekday: "long" })}</span>
            <span className="faint">{fmtDate(d)}</span>
          </h2>
          {list.map((e) => (
            <button type="button" key={e.key} className={`calv-agenda-row ${e.key === selected ? "selected" : ""} ${e.skip ? "skipped" : ""}`} style={eventStyle(e, cal)} onClick={() => onSelect(e.key)} aria-label={evLabel(e, booked)}>
              <span className="calv-agenda-time">{timeRange(e)}</span>
              <span className="calv-agenda-bar" aria-hidden />
              <span className="calv-agenda-text">
                <span className="calv-ev-title">{e.title}</span>
                {e.location && <span className="calv-ev-meta">{e.location}</span>}
              </span>
              <span className="calv-agenda-marks">
                {booked.get(e.key) ? <Badge tone="success">{t("review.meeting.booked")}</Badge> : e.skip ? <Badge>{t("review.meeting.skipped")}</Badge> : null}
                {e.link && <Video size={13} className="faint" aria-label={t("calv.online")} />}
              </span>
            </button>
          ))}
        </section>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- detail

function EventDetail({ event: e, cal, booked, onClose, onBook, onNote, onSkip }: { event: CalendarEvent; cal: CalendarSettings | undefined; booked: TimeEntryRow | { id: number } | null; onClose: () => void; onBook: () => void; onNote: () => void; onSkip: () => void }) {
  const t = useT();
  const l = dateLocale();
  const [allPeople, setAllPeople] = useState(false);
  useEffect(() => setAllPeople(false), [e.key]);
  const start = new Date(e.start);
  const end = new Date(e.end);
  const minutes = durationMinutes(e);
  const multiDay = isoDay(start) !== isoDay(new Date(end.getTime() - 1));
  const when = e.all_day
    ? multiDay
      ? `${fmtDate(start)} – ${fmtDate(new Date(end.getTime() - 1))} · ${t("cal.allDay")}`
      : `${start.toLocaleDateString(l, { weekday: "short" })}, ${fmtDate(start)} · ${t("cal.allDay")}`
    : `${start.toLocaleDateString(l, { weekday: "short" })}, ${fmtDate(start)} · ${timeRange(e)} (${fmtMinutes(minutes)} h)`;
  const people = allPeople ? e.attendees : e.attendees.slice(0, 8);
  const entry = booked && "netzplan_nr" in booked ? booked : null;
  const linkKind = e.link?.includes("teams.") ? "Teams" : e.link?.includes("zoom.") ? "Zoom" : e.link?.includes("webex.") ? "Webex" : e.link?.includes("meet.google.") ? "Google Meet" : "Online";
  const calendar = cal?.outlook_calendars?.find((c) => c.id === e.source);
  return (
    <aside className="calv-detail" aria-label={t("cal.appointment")}>
      <div className="calv-detail-head">
        <span className="calv-detail-source" style={eventStyle(e, cal)}>
          <span className="calv-dot" aria-hidden />
          {sourceName(e.source, cal)}
        </span>
        <IconButton icon={X} label={t("calv.closeEsc")} size="sm" onClick={onClose} />
      </div>
      <h2 className="calv-detail-title">{e.title}</h2>
      <div className="calv-detail-rows">
        <div className="calv-detail-row">
          <Clock size={14} aria-hidden />
          <span>{when}</span>
        </div>
        {e.recurring && (
          <div className="calv-detail-row">
            <Repeat size={14} aria-hidden />
            <span>{t("calv.partOfSeries")}</span>
          </div>
        )}
        {e.location && (
          <div className="calv-detail-row">
            <MapPin size={14} aria-hidden />
            <span>{e.location}</span>
          </div>
        )}
        {e.organizer && (
          <div className="calv-detail-row">
            <User size={14} aria-hidden />
            <span>
              {e.organizer} <span className="faint">({t("calv.organizer")})</span>
            </span>
          </div>
        )}
        {e.attendees.length > 0 && (
          <div className="calv-detail-row">
            <Users size={14} aria-hidden />
            <span className="calv-people">
              {people.join(" · ")}
              {e.attendees.length > people.length && (
                <button type="button" className="calv-linkbtn" onClick={() => setAllPeople(true)}>
                  {" "}
                  {t("calv.more", { n: e.attendees.length - people.length })}
                </button>
              )}
            </span>
          </div>
        )}
        <div className="calv-detail-row faint">
          {e.private ? <Lock size={14} aria-hidden /> : <Eye size={14} aria-hidden />}
          <span>
            {t(BUSY_LABELS[e.busy])}
            {e.private ? ` · ${t("calv.private")}` : ""}
          </span>
        </div>
        {calendar?.free_busy && (
          <div className="calv-detail-row faint">
            <EyeOff size={14} aria-hidden />
            <span>{t("olcal.freeBusyEvent")}</span>
          </div>
        )}
        {!!e.also_in?.length && (
          <div className="calv-detail-row calv-also-in">
            <Layers size={14} aria-hidden />
            <span>
              {t("olcal.alsoIn")}
              {e.also_in.map((x) => (
                <span key={x} className="calv-also-cal" style={{ "--ev": sourceColor(x, cal) } as CSSProperties}>
                  <span className="calv-dot" aria-hidden />
                  {sourceName(x, cal)}
                </span>
              ))}
            </span>
          </div>
        )}
        {calendar && !calendar.booking && (
          <div className="calv-detail-row faint">
            <Timer size={14} aria-hidden />
            <span>{t("olcal.notForBooking")}</span>
          </div>
        )}
      </div>
      {e.link && (
        <Button icon={Video} className="calv-join" onClick={() => void openUrl(e.link!).catch((err) => useApp.getState().error(t("links.openFailed"), err))}>
          {t("calv.join", { kind: linkKind })}
        </Button>
      )}
      {e.categories.length > 0 && (
        <div className="calv-cats">
          {e.categories.map((c) => (
            <Badge key={c}>{c}</Badge>
          ))}
        </div>
      )}

      <div className={`calv-book-state ${booked ? "booked" : e.skip ? "skipped" : ""}`} role="status">
        {booked ? (
          <>
            <CheckCircle2 size={15} aria-hidden />
            <span>
              {entry ? t("calv.bookedAs", { ref: entryRef(entry), h: fmtMinutes(entry.duration_minutes) }) : t("calv.booked")}
              {entry?.status_flag === "exported" ? ` · ${t("calv.exported")}` : ""}
            </span>
          </>
        ) : e.skip ? (
          <>
            <EyeOff size={15} aria-hidden />
            <span>{t("calv.markedSkip")}</span>
          </>
        ) : (
          <>
            <Timer size={15} aria-hidden />
            <span>{t("calv.notBooked")}</span>
          </>
        )}
      </div>

      <div className="calv-detail-actions">
        <Button variant={booked || e.skip ? "secondary" : "primary"} icon={Timer} onClick={onBook}>
          {booked ? t("calv.bookAgain") : t("calv.bookTime")}
        </Button>
        <Button icon={NotebookPen} onClick={onNote}>
          {e.note_page_id != null ? t("calv.openNote") : t("calv.note")}
        </Button>
        {!booked && (
          <Button variant="ghost" icon={e.skip ? Eye : EyeOff} onClick={onSkip}>
            {e.skip ? t("calv.unskip") : t("calv.skip")}
          </Button>
        )}
        {entry && (
          <Button variant="ghost" onClick={() => useApp.getState().openTab({ kind: "timesheet" })}>
            {t("calv.showInTimesheet")}
          </Button>
        )}
      </div>

      {e.body && (
        <details className="calv-body-text">
          <summary>{t("time.description")}</summary>
          <pre>{e.body}</pre>
        </details>
      )}
      <SyncedHint source={e.source} />
    </aside>
  );
}

/** When the appointment's calendar was last read. */
function SyncedHint({ source }: { source: string }) {
  const t = useT();
  const [at, setAt] = useState<string | null>(null);
  useEffect(() => {
    api
      .calendarStatus()
      .then((st) => setAt(st.sources.find((x) => x.id === source)?.status?.synced_at ?? null))
      .catch(() => {});
  }, [source]);
  return at ? <div className="calv-synced faint">{t("calv.asOf", { when: relative(at) })}</div> : null;
}
