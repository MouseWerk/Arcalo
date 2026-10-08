// „Wochenrückblick“: one week (Monday to Sunday) on one page – booked time per day against the
// target with holidays, absences and the gaps, the top Netzpläne/Vorgänge, meetings by day,
// tasks done and still open, pages worked on and focus. Every row leads to its place; a day
// opens its Tagesrückblick. „Zusammenfassen“ asks the AI through the router (private content
// stays local); „Als Wochenbericht speichern“ writes the week as a page and updates it later.

import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  AlertTriangle, CalendarDays, CalendarRange, Check, CheckSquare, ChevronLeft, ChevronRight, ClipboardList, Clock, Copy, ExternalLink, FileText, LayoutTemplate, RefreshCw, Sparkles, Square, Target, X,
  type LucideIcon,
} from "lucide-react";
import { useApp } from "../store/app";
import { Badge, Button, EmptyState, IconButton, Progress, Skeleton, type Tone } from "../components/ui";
import { PageIcon } from "../components/icons";
import { pickDate } from "../components/CalendarPopover";
import { AiErrorNote, AiSetupNote, useAiConfigured } from "../components/AiNotes";
import { flushAllEditors } from "../editor/saves";
import { reloadEditors } from "../editor/NoteEditor";
import { revealText } from "../editor/reveal";
import { fmtDayMonth, int, isoDay, time } from "../lib/format";
import { openCalendarView } from "../lib/calnav";
import { sourceColor } from "../lib/agenda";
import { openDayReview, openTimesheetDay } from "../lib/reviewnav";
import { useTimeTracking } from "../lib/timetracking";
import { MEETING_LABEL, hm, hours } from "../lib/dayreview";
import { renderMarkdown } from "../lib/markdown";
import { useAiTransform } from "../lib/useAiTransform";
import {
  WEEK_REVIEW_EVENT, dayOff, dayProgress, dayShort, isEmptyWeek, meetingsByDay, mondayOf, openWeekMeetings, shiftWeek, takeWeekReviewDay, weekApi, weekProgress, weekSubtitle,
  type WeekPage, type WeekReview, type WeekTask,
} from "../lib/weekreview";
import { useT } from "../lib/i18n";

const s = useApp.getState;

export function WeekReviewView() {
  const t = useT();
  const pages = useApp((st) => st.pages);
  const entriesVersion = useApp((st) => st.entriesVersion);
  const cal = useApp((st) => st.settings?.settings.calendar);
  const [monday, setMonday] = useState(() => takeWeekReviewDay() ?? mondayOf(isoDay(new Date())));
  const [review, setReview] = useState<WeekReview | null>(null);
  const [tick, setTick] = useState(0);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [askSetup, setAskSetup] = useState(false);
  const ai = useAiTransform();
  const configured = useAiConfigured();
  const root = useRef<HTMLDivElement>(null);
  const seq = useRef(0);
  const thisMonday = mondayOf(isoDay(new Date()));
  // Time tracking switched: the review comes back with (or without) its time part.
  const timeOn = useTimeTracking();

  // Opened on a week from elsewhere (Kalender, Tagesrückblick, start page).
  useEffect(() => {
    const take = () => {
      const d = takeWeekReviewDay();
      if (d) setMonday(d);
    };
    window.addEventListener(WEEK_REVIEW_EVENT, take);
    return () => window.removeEventListener(WEEK_REVIEW_EVENT, take);
  }, []);

  // Saves change the week: refetch shortly after, and every minute while open.
  useEffect(() => {
    let timer: number | undefined;
    const bump = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setTick((n) => n + 1), 700);
    };
    window.addEventListener("annalo:page-saved", bump);
    const every = window.setInterval(() => setTick((n) => n + 1), 60_000);
    return () => {
      window.clearTimeout(timer);
      window.clearInterval(every);
      window.removeEventListener("annalo:page-saved", bump);
    };
  }, []);

  useEffect(() => {
    const n = ++seq.current;
    weekApi
      .review(monday)
      .then((r) => n === seq.current && setReview(r))
      .catch((e) => n === seq.current && s().error(t("week.loadFailed"), e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monday, entriesVersion, pages, tick, timeOn]);

  // Another week: the summary belongs to the old one.
  const { reset } = ai;
  useEffect(() => {
    reset();
    setAskSetup(false);
  }, [monday, reset]);

  const go = useCallback((delta: number) => setMonday((d) => shiftWeek(d, delta)), []);
  const toThisWeek = useCallback(() => setMonday(mondayOf(isoDay(new Date()))), []);

  // ← / → / T while this pane is the active one and no field, dialog or menu has the keys.
  const keys = useRef({ go, toThisWeek });
  keys.current = { go, toThisWeek };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = root.current;
      const focused = document.activeElement as HTMLElement | null;
      if (!el || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      if (!el.closest(".pane")?.classList.contains("active")) return;
      const pane = focused?.closest(".pane");
      if (pane && !pane.contains(el)) return;
      if (focused?.closest("input, textarea, select, [contenteditable='true'], [role='combobox']")) return;
      if (document.querySelector(".dialog, .menu, .palette, .calendar, .select-pop")) return;
      if (e.key === "ArrowLeft") keys.current.go(-1);
      else if (e.key === "ArrowRight") keys.current.go(1);
      else if (e.key === "t" || e.key === "T") keys.current.toThisWeek();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const summaryText = !ai.busy && !ai.error && ai.text.trim() ? ai.text.trim() : null;

  const summarize = () => {
    if (!configured) {
      setAskSetup(true);
      return;
    }
    setAskSetup(false);
    void ai.runWith((requestId, overrideLimit) => weekApi.summary(requestId, monday, overrideLimit));
  };

  const save = async () => {
    if (!review) return;
    if (review.report_page_id != null) {
      const choice = await s().choose({ title: t("week.saveAgainTitle"), message: t("week.saveAgainText"), confirmLabel: t("week.update"), altLabel: t("week.openReport") });
      if (choice === "alt") return void openPage(review.report_page_id, false);
      if (choice !== "confirm") return;
    }
    setSaving(true);
    try {
      // Pending edits first: the report page may be open with the user's notes.
      await flushAllEditors().catch(() => {});
      const out = await weekApi.save(monday, summaryText);
      if (!out.created) reloadEditors([out.page.id]);
      await s().refreshTree();
      setTick((n) => n + 1);
      s().toast({
        tone: "success",
        title: out.created ? t("week.saved") : t("week.updated"),
        detail: summaryText ? `${out.page.title} · ${t("review.withSummary")}` : out.page.title,
        action: { label: t("links.open"), run: () => s().openPage(out.page.id) },
      });
    } catch (e) {
      s().error(t("week.saveFailed"), e);
    } finally {
      setSaving(false);
    }
  };

  const editTemplate = async () => {
    try {
      const page = await weekApi.template();
      await s().refreshTree();
      s().openPage(page.id);
    } catch (e) {
      s().error(t("week.templateFailed"), e);
    }
  };

  /** Whether page `id` is (still) there; a page created elsewhere since the tree was loaded is found too. */
  const known = async (id: number | null) => {
    if (id == null) return false;
    if (!s().pages.has(id)) await s().refreshTree();
    if (s().pages.has(id)) return true;
    s().toast({ tone: "info", title: t("feed.gone"), detail: t("feed.goneText") });
    return false;
  };
  const openPage = async (id: number | null, newTab: boolean) => {
    if (await known(id)) s().openPage(id!, { newTab });
  };
  const openTask = async (task: WeekTask, newTab: boolean) => {
    if (await known(task.page_id)) void revealText(task.page_id!, task.text, (pid) => s().openPage(pid, { newTab }));
  };

  const r = review && review.monday === monday ? review : null;

  return (
    <div className="view-scroll" ref={root}>
      <div className="view rv-view wr-view">
        <header className="view-header rv-head">
          <div className="rv-heading">
            <h1>{t("week.title")}</h1>
            <div className="view-sub rv-date wr-date">{weekSubtitle({ monday, week: r?.week ?? isoWeekOf(monday) })}</div>
          </div>
          <div className="view-actions rv-actions">
            <div className="rv-nav" role="group" aria-label={t("calv.view.week")}>
              <IconButton icon={ChevronLeft} label={t("week.prev")} onClick={() => go(-1)} />
              <Button size="sm" variant="ghost" className="wr-this-week" onClick={toThisWeek} disabled={monday === thisMonday} title={t("week.thisWeekKey")}>
                {t("week.thisWeek")}
              </Button>
              <IconButton icon={ChevronRight} label={t("week.next")} onClick={() => go(1)} />
              <IconButton icon={CalendarDays} label={t("week.pick")} onClick={(e) => pickDate(e.currentTarget, monday, (iso) => setMonday(mondayOf(iso)))} />
            </div>
            {r?.report_page_id != null && (
              <IconButton icon={ExternalLink} className="wr-open-report" label={t("week.openReport")} onClick={(e) => void openPage(r.report_page_id, e.ctrlKey || e.metaKey)} />
            )}
            <IconButton icon={LayoutTemplate} className="wr-template" label={t("week.template")} onClick={() => void editTemplate()} />
            <Button icon={ClipboardList} className="wr-save" loading={saving} disabled={!r} onClick={() => void save()}>
              {t("week.save")}
            </Button>
            <Button variant="primary" icon={Sparkles} className="wr-summarize" loading={ai.busy} disabled={!r} onClick={summarize} title={configured ? t("week.summarizeTitle") : t("ai.setup.action")}>
              {t("week.summarize")}
            </Button>
          </div>
        </header>

        {!r ? (
          <Skeleton rows={4} variant="cards" />
        ) : (
          <>
            <Stats r={r} />

            {askSetup && !configured && (
              <div className="wr-setup">
                <AiSetupNote text={t("ai.setup.week")} />
                <IconButton icon={X} label={t("common.close")} size="sm" onClick={() => setAskSetup(false)} />
              </div>
            )}

            {(ai.busy || ai.text || ai.error) && (
              <section className="card rv-summary" aria-label={t("review.md.summary")} aria-live="polite">
                <div className="card-head">
                  <h2>
                    <Sparkles size={14} aria-hidden /> {t("review.md.summary")}
                  </h2>
                  <span className="rv-summary-meta faint small">{ai.meta ? (ai.meta.tier === "local" ? t("review.localModel", { model: ai.meta.model }) : ai.meta.model) : ai.busy ? t("week.writing") : ""}</span>
                  <div className="rv-card-actions">
                    {ai.busy ? (
                      <Button size="sm" icon={Square} onClick={() => ai.cancel()}>
                        {t("time.stop")}
                      </Button>
                    ) : (
                      <>
                        {summaryText && (
                          <Button
                            size="sm"
                            icon={copied ? Check : Copy}
                            className="rv-copy"
                            onClick={() => {
                              void navigator.clipboard.writeText(summaryText);
                              setCopied(true);
                              window.setTimeout(() => setCopied(false), 1200);
                            }}
                          >
                            {copied ? t("common.copied") : t("common.copy")}
                          </Button>
                        )}
                        <IconButton icon={RefreshCw} label={t("review.rewrite")} size="sm" onClick={summarize} />
                        <IconButton icon={X} label={t("common.discard")} size="sm" onClick={() => ai.reset()} />
                      </>
                    )}
                  </div>
                </div>
                <div className="rv-summary-body">
                  {ai.error ? (
                    <AiErrorNote message={ai.error} onRetry={summarize} />
                  ) : !ai.text ? (
                    <div className="thinking">
                      <span />
                      <span />
                      <span />
                    </div>
                  ) : (
                    <div className={`prose prose-chat ${ai.busy ? "streaming" : ""}`} dangerouslySetInnerHTML={{ __html: renderMarkdown(ai.text) }} />
                  )}
                  {summaryText && <div className="faint small rv-summary-hint">{t("week.summaryHint")}</div>}
                </div>
              </section>
            )}

            {!r.without_time && <Days r={r} />}

            <div className="rv-grid">
              {!r.without_time && <TimeCard r={r} />}
              <MeetingsCard r={r} cal={cal} />
              <TasksCard r={r} onOpen={(task, newTab) => void openTask(task, newTab)} />
              <Section icon={FileText} tone="pages" title={t("review.md.pages")} count={r.pages_total} empty={t("week.noPages")} className="rv-pages">
                {r.pages.map((p, i) => (
                  <PageRow key={`${p.page_id ?? "x"}-${i}`} p={p} onOpen={(newTab) => void openPage(p.gone ? null : p.page_id, newTab)} />
                ))}
              </Section>
              {(r.focus.sessions > 0 || r.focus.blocks.length > 0) && <FocusCard r={r} />}
            </div>

            {isEmptyWeek(r) && (
              <EmptyState icon={CalendarRange} title={monday > thisMonday ? t("week.future") : t("week.nothing")}>
                {t("week.emptyHint")}
              </EmptyState>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** The ISO week of `monday` before the review has loaded (the header shows it at once). */
function isoWeekOf(monday: string): number {
  const d = new Date(`${monday}T12:00:00`);
  const x = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate() + 3));
  const y = new Date(Date.UTC(x.getUTCFullYear(), 0, 1));
  return Math.ceil(((x.getTime() - y.getTime()) / 86400000 + 1) / 7);
}

function Stats({ r }: { r: WeekReview }) {
  const t = useT();
  const tm = r.time;
  const open = openWeekMeetings(r).length;
  const edits = r.pages.reduce((a, p) => a + p.edits, 0);
  const booked = r.meetings.filter((m) => m.state === "booked").length;
  return (
    <section className={`rv-stats ${r.without_time ? "no-time" : ""}`} aria-label={t("review.overview")}>
      {!r.without_time && (
        <div className="rv-stat tone-time">
          <span className="rv-stat-label">
            <Clock size={13} aria-hidden /> {t("calv.booked")}
          </span>
          <span className="rv-stat-value num">
            {hours(tm.booked_minutes)}
            {tm.target_minutes > 0 && <span className="rv-stat-of"> / {hours(tm.target_minutes)}</span>}
          </span>
          <Progress value={weekProgress(r)} tone={tm.target_minutes > 0 && tm.booked_minutes >= tm.target_minutes ? "success" : "accent"} />
          <span className="rv-stat-sub">
            {tm.target_minutes <= 0 ? t("week.noTarget") : tm.missing_minutes > 0 ? t("week.missing", { h: hours(tm.missing_minutes) }) : t("review.targetReached")}
            {tm.running_minutes > 0 && ` · ${t("review.timer", { time: hm(tm.running_minutes) })}`}
          </span>
        </div>
      )}
      <div className="rv-stat tone-meetings">
        <span className="rv-stat-label">
          <CalendarRange size={13} aria-hidden /> {t("review.md.meetings")}
        </span>
        <span className="rv-stat-value num">{r.meetings.length}</span>
        <span className="rv-stat-sub">
          {r.without_time ? (r.meetings.length ? t("week.days", { n: new Set(r.meetings.map((m) => m.day)).size }) : t("review.none")) : [booked ? t("week.booked", { n: booked }) : "", open ? t("review.notBooked", { n: open }) : ""].filter(Boolean).join(" · ") || t("review.none")}
        </span>
      </div>
      <div className="rv-stat tone-tasks">
        <span className="rv-stat-label">
          <CheckSquare size={13} aria-hidden /> {t("review.done")}
        </span>
        <span className="rv-stat-value num">{r.tasks.done_total}</span>
        <span className="rv-stat-sub">
          {[r.tasks.open_total ? t("week.open", { n: r.tasks.open_total }) : "", r.tasks.overdue_total ? t("review.md.overdue", { n: r.tasks.overdue_total }) : ""].filter(Boolean).join(" · ") || t("review.md.tasks")}
        </span>
      </div>
      <div className="rv-stat tone-pages">
        <span className="rv-stat-label">
          <FileText size={13} aria-hidden /> {t("review.md.pages")}
        </span>
        <span className="rv-stat-value num">{r.pages_total}</span>
        <span className="rv-stat-sub">{edits ? t("feed.changes", { n: edits }) : t("review.edited")}</span>
      </div>
      <div className="rv-stat tone-focus">
        <span className="rv-stat-label">
          <Target size={13} aria-hidden /> {t("review.md.focus")}
        </span>
        {/* No session yet: the time planned in focus blocks. */}
        <span className="rv-stat-value num">{hm(r.focus.sessions || !r.focus.blocks.length ? r.focus.minutes : r.focus.planned_minutes)}</span>
        <span className="rv-stat-sub">
          {r.focus.sessions || !r.focus.blocks.length
            ? [t("review.md.sessions", { n: r.focus.sessions }), r.focus.blocks.length ? t("week.blocks", { n: r.focus.blocks.length }) : ""].filter(Boolean).join(" · ")
            : t("week.blocksPlanned", { n: r.focus.blocks.length })}
        </span>
      </div>
    </section>
  );
}

/** Monday to Sunday: booked against the target, days off named; a day opens its Tagesrückblick. */
function Days({ r }: { r: WeekReview }) {
  const t = useT();
  const today = isoDay(new Date());
  return (
    <section className="wr-days" aria-label={t("week.daysLabel")}>
      {r.days.map((d) => {
        const off = dayOff(d);
        const over = d.booked_minutes > d.target_minutes && d.target_minutes > 0;
        return (
          <button
            key={d.date}
            type="button"
            className={`wr-day ${d.future ? "future" : ""} ${d.date === today ? "today" : ""} ${off ? "off" : ""}`}
            onClick={(e) => openDayReview(d.date, { newTab: e.ctrlKey || e.metaKey })}
            title={t("week.openDay")}
            aria-current={d.date === today ? "date" : undefined}
          >
            <span className="wr-day-head">
              <span className="wr-day-name">{dayShort(d.date)}</span>
              {d.missing_minutes > 0 && <AlertTriangle size={12} className="wr-day-warn" aria-label={t("review.md.missing", { h: hours(d.missing_minutes) })} />}
            </span>
            <span className="wr-day-value num">
              {hours(d.booked_minutes)}
              {d.target_minutes > 0 && <span className="wr-day-of"> / {hours(d.target_minutes)}</span>}
            </span>
            <span className="wr-day-bar" aria-hidden>
              <span className={over ? "over" : ""} style={{ width: `${dayProgress(d) * 100}%` }} />
            </span>
            <span className="wr-day-sub ellipsis">
              {off ?? (d.missing_minutes > 0 ? t("review.md.missing", { h: hours(d.missing_minutes) }) : d.gaps.length ? t("week.gaps", { n: d.gaps.length }) : d.target_minutes <= 0 && !d.booked_minutes ? t("review.noWorkday") : " ")}
            </span>
          </button>
        );
      })}
    </section>
  );
}

function Section({
  icon: Icon,
  tone,
  title,
  count,
  extra,
  empty,
  className = "",
  children,
}: {
  icon: LucideIcon;
  tone: string;
  title: string;
  count: number;
  extra?: string;
  empty?: string;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <section className={`card rv-card tone-${tone} ${className}`} aria-label={title}>
      <div className="card-head">
        <h2>
          <span className="rv-card-icon" aria-hidden>
            <Icon size={14} />
          </span>
          {title}
          <span className="rv-count num">{count}</span>
        </h2>
        {extra && <span className="rv-card-extra num">{extra}</span>}
      </div>
      <div className="rv-list">{count === 0 && empty ? <div className="rv-empty">{empty}</div> : children}</div>
    </section>
  );
}

function TimeCard({ r }: { r: WeekReview }) {
  const t = useT();
  const tm = r.time;
  const max = Math.max(1, ...tm.items.map((w) => w.minutes));
  const toSheet = (newTab = false) => openTimesheetDay(r.monday, { newTab });
  const gapDays = r.days.filter((d) => d.gaps.length || d.missing_minutes > 0);
  return (
    <Section icon={Clock} tone="time" title={t("week.topWbs")} count={tm.items.length} extra={tm.target_minutes > 0 ? t("review.hoursOf", { h: hours(tm.booked_minutes), target: hours(tm.target_minutes) }) : hours(tm.booked_minutes)} className="rv-time">
      {tm.items.length === 0 ? (
        <div className="rv-empty">{tm.running_minutes > 0 ? t("review.timerRunning", { time: hm(tm.running_minutes) }) : t("review.nothingBooked")}</div>
      ) : (
        tm.items.slice(0, 8).map((w) => (
          <button key={`${w.netzplan_id}-${w.label}`} type="button" className="rv-row rv-wbs" onClick={(e) => toSheet(e.ctrlKey || e.metaKey)} title={w.descriptions.join("\n")}>
            <span className="rv-main">
              <span className="rv-title">
                <span className="mono rv-ref">{w.label}</span>
                <span className="ellipsis">{w.title}</span>
              </span>
              <span className="rv-bar" aria-hidden>
                <span style={{ width: `${(w.minutes / max) * 100}%` }} />
              </span>
              {w.descriptions.length > 0 && <span className="rv-sub ellipsis">{w.descriptions.join(" · ")}</span>}
            </span>
            <span className="rv-meta num">{hours(w.minutes)}</span>
          </button>
        ))
      )}
      {gapDays.length > 0 && (
        <div className="rv-gaps" role="status">
          <AlertTriangle size={13} aria-hidden />
          <span>{t("review.gaps")}</span>
          {gapDays.map((d) => (
            <button key={d.date} type="button" className="gap-chip" onClick={(e) => openDayReview(d.date, { newTab: e.ctrlKey || e.metaKey })}>
              {dayShort(d.date)} <span className="faint">({d.missing_minutes > 0 ? t("review.md.missing", { h: hours(d.missing_minutes) }) : t("week.gaps", { n: d.gaps.length })})</span>
            </button>
          ))}
        </div>
      )}
      <button type="button" className="rv-foot-link" onClick={(e) => toSheet(e.ctrlKey || e.metaKey)}>
        {tm.missing_minutes > 0 ? t("review.missingBook", { h: hours(tm.missing_minutes) }) : t("review.openTimesheet")}
      </button>
    </Section>
  );
}

function MeetingsCard({ r, cal }: { r: WeekReview; cal: Parameters<typeof sourceColor>[1] }) {
  const t = useT();
  const open = openWeekMeetings(r).length;
  return (
    <Section icon={CalendarRange} tone="meetings" title={t("review.md.meetings")} count={r.meetings.length} empty={t("week.noMeetings")} className="rv-meetings">
      {meetingsByDay(r.meetings).map((g) => (
        <div key={g.day} className="rv-group wr-meeting-day">
          <div className="rv-group-head">
            <span>{dayShort(g.day)}</span>
            <span className="num faint">{g.meetings.length}</span>
          </div>
          {g.meetings.map((m) => (
            <button key={m.key} type="button" className={`rv-row rv-meeting state-${m.state}`} style={{ "--ev": sourceColor(m.source, cal) } as CSSProperties} onClick={() => openCalendarView({ date: g.day, key: m.key })}>
              <span className="rv-when num">{m.all_day ? t("cal.allDay") : `${time(m.start)}–${time(m.end)}`}</span>
              <span className="rv-main">
                <span className="rv-title ellipsis">{m.title || t("cal.appointment")}</span>
                {m.location && <span className="rv-sub ellipsis">{m.location}</span>}
              </span>
              {m.state !== "done" && (
                <span className={`calv-state state-${m.state} ${m.state === "booked" ? "booked" : ""}`}>
                  {m.state === "booked" && <Check size={12} strokeWidth={2.5} aria-hidden />}
                  {t(MEETING_LABEL[m.state])}
                </span>
              )}
            </button>
          ))}
        </div>
      ))}
      {open > 0 && (
        <button type="button" className="rv-foot-link" onClick={() => openCalendarView({ date: openWeekMeetings(r)[0].day })}>
          {t("review.meetingsToBook", { n: open })}
        </button>
      )}
    </Section>
  );
}

function TasksCard({ r, onOpen }: { r: WeekReview; onOpen: (task: WeekTask, newTab: boolean) => void }) {
  const t = useT();
  const k = r.tasks;
  const today = isoDay(new Date());
  const groups: { id: string; label: string; items: WeekTask[]; total: number; tone?: Tone }[] = [
    { id: "done", label: t("review.done"), items: k.done, total: k.done_total },
    { id: "open", label: t("week.openGroup"), items: k.open, total: k.open_total, tone: "warning" },
    { id: "overdue", label: t("tasks.overdue"), items: k.overdue, total: k.overdue_total, tone: "danger" },
  ];
  const count = k.done_total + k.open_total + k.overdue_total;
  return (
    <Section icon={CheckSquare} tone="tasks" title={t("review.md.tasks")} count={count} empty={t("week.noTasks")} className="rv-tasks">
      {groups
        .filter((g) => g.items.length)
        .map((g) => (
          <div key={g.id} className={`rv-group rv-group-${g.id}`}>
            <div className="rv-group-head">
              <span>{g.label}</span>
              <span className="num faint">{g.total}</span>
            </div>
            {g.items.map((task, i) => (
              <button key={`${task.page_id}-${task.text}-${i}`} type="button" className={`rv-row rv-task ${g.id === "done" ? "done" : ""}`} onClick={(e) => onOpen(task, e.ctrlKey || e.metaKey)}>
                <span className="rv-check" aria-hidden>
                  {g.id === "done" ? <Check size={11} strokeWidth={3} /> : null}
                </span>
                <span className="rv-main">
                  <span className="rv-title ellipsis">{task.text}</span>
                  <span className="rv-sub ellipsis">
                    {[task.page_title, task.repeating ? t("week.repeating") : ""].filter(Boolean).join(" · ")}
                  </span>
                </span>
                {g.id === "done" && task.day ? (
                  <span className="rv-meta">{dayShort(task.day)}</span>
                ) : (
                  task.due && <Badge tone={task.due < today ? "danger" : (g.tone ?? "neutral")}>{task.due === today ? t("review.today") : fmtDayMonth(new Date(`${task.due}T12:00:00`))}</Badge>
                )}
              </button>
            ))}
          </div>
        ))}
    </Section>
  );
}

function PageRow({ p, onOpen }: { p: WeekPage; onOpen: (newTab: boolean) => void }) {
  const t = useT();
  const words = (n: number) => t("review.words", { n: Math.abs(n), count: `${n > 0 ? "+" : "−"}${int(Math.abs(n))}` });
  const bits = [p.days > 1 ? t("week.days", { n: p.days }) : "", p.edits > 0 ? t("feed.changes", { n: p.edits }) : "", p.word_delta ? words(p.word_delta) : "", p.minutes > 0 ? `~${hm(p.minutes)}` : ""].filter(Boolean);
  return (
    <button type="button" className={`rv-row rv-page wr-page ${p.gone ? "gone" : ""}`} onClick={(e) => onOpen(e.ctrlKey || e.metaKey)}>
      <span className="rv-main">
        <span className="rv-title">
          <PageIcon name={p.icon ?? undefined} size={14} />
          <span className="ellipsis">{p.title}</span>
          {p.created && <Badge tone="accent">{t("review.md.new")}</Badge>}
          {p.daily && <Badge>{t("capture.daily")}</Badge>}
        </span>
        <span className="rv-sub">{bits.join(" · ")}</span>
      </span>
      <span className="rv-meta">{dayShort(isoDay(new Date(p.last_at)))}</span>
    </button>
  );
}

function FocusCard({ r }: { r: WeekReview }) {
  const t = useT();
  const f = r.focus;
  return (
    <Section icon={Target} tone="focus" title={t("week.focus")} count={f.blocks.length} extra={f.sessions ? `${t("review.md.sessions", { n: f.sessions })} · ${hm(f.minutes)}` : undefined} empty={t("week.noBlocks")} className="rv-focus">
      {f.blocks.map((b) => (
        <button key={b.id} type="button" className="rv-row" onClick={() => openCalendarView({ date: isoDay(new Date(b.start)) })}>
          <span className="rv-when num">
            {dayShort(isoDay(new Date(b.start)))} {time(b.start)}
          </span>
          <span className="rv-main">
            <span className="rv-title ellipsis">{b.title}</span>
          </span>
          <span className="rv-meta num">
            {hm(b.minutes)}
            {b.task_done ? ` · ${t("week.blockDone")}` : b.booked ? ` · ${t("review.meeting.booked")}` : b.focus_minutes ? ` · ${t("week.focused", { time: hm(b.focus_minutes) })}` : ""}
          </span>
        </button>
      ))}
    </Section>
  );
}
