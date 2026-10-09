// „Tagesrückblick“: one page for the end of the day – time booked per WBS against the target
// with the gaps, meetings with their booking state, pages created and edited, tasks, focus and
// files. Every row leads to its place; „In Tagesnotiz übernehmen“ writes a compact block into
// the daily note, and a local model (never a cloud provider) can write a short summary.

import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  AlertTriangle, CalendarCheck, CalendarDays, CalendarRange, Check, CheckSquare, ChevronLeft, ChevronRight, Clock, Copy, FileText, Lock, NotebookPen, Paperclip, RefreshCw, Settings2, Sparkles, Square, Sunset, Target, X,
  type LucideIcon,
} from "lucide-react";
import { api } from "../lib/api";
import { useApp } from "../store/app";
import { Badge, Button, EmptyState, IconButton, Progress, type Tone, Skeleton } from "../components/ui";
import { PageIcon } from "../components/icons";
import { pickDate } from "../components/CalendarPopover";
import { flushAllEditors } from "../editor/saves";
import { revealText } from "../editor/reveal";
import { dayTitle, fileKind } from "../lib/activity";
import { fmtDayMonth, fmtDuration, int, isoDay, time } from "../lib/format";
import { openCalendarView, openSettingsSection } from "../lib/calnav";
import { sourceColor } from "../lib/agenda";
import { REVIEW_EVENT, openTimesheetDay, takeReviewDay } from "../lib/reviewnav";
import { openWeekReview } from "../lib/weekreview";
import { useTimeTracking } from "../lib/timetracking";
import { MEETING_LABEL, findReviewBlock, localProviders, meetingsSub, openMeetings, progress, reviewMarkdown, shiftDay, upsertReviewBlock } from "../lib/dayreview";
import { renderMarkdown } from "../lib/markdown";
import { useAiTransform } from "../lib/useAiTransform";
import { useAi } from "../lib/aiswitch";
import { AiErrorNote } from "../components/AiNotes";
import type { DayReview, ReviewMeeting, ReviewPage, ReviewTask } from "../lib/types";
import { useT } from "../lib/i18n";

export function DayReviewView() {
  const t = useT();
  const s = useApp.getState;
  const pages = useApp((st) => st.pages);
  const entriesVersion = useApp((st) => st.entriesVersion);
  const focusId = useApp((st) => `${st.focus?.session.id ?? ""}:${st.focus?.phase ?? ""}`);
  const providers = useApp((st) => st.settings?.settings.providers);
  const cal = useApp((st) => st.settings?.settings.calendar);
  const [date, setDate] = useState(() => takeReviewDay() ?? isoDay(new Date()));
  const [review, setReview] = useState<DayReview | null>(null);
  const [tick, setTick] = useState(0);
  const [inserting, setInserting] = useState(false);
  const [noLocal, setNoLocal] = useState(false);
  const [copied, setCopied] = useState(false);
  const ai = useAiTransform();
  // „KI verwenden“ off: the review without „Zusammenfassen“; inserting it is the main action.
  const aiOn = useAi();
  const root = useRef<HTMLDivElement>(null);
  const seq = useRef(0);
  const today = isoDay(new Date());
  const local = localProviders(providers);
  // Time tracking switched: the review comes back with (or without) its time parts.
  const timeOn = useTimeTracking();

  // Opened on a day from elsewhere (daily note, Kalender, reminder).
  useEffect(() => {
    const take = () => {
      const d = takeReviewDay();
      if (d) setDate(d);
    };
    window.addEventListener(REVIEW_EVENT, take);
    return () => window.removeEventListener(REVIEW_EVENT, take);
  }, []);

  // Saves change the day: refetch shortly after, and every minute while open (today).
  useEffect(() => {
    let timer: number | undefined;
    const bump = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setTick((n) => n + 1), 700);
    };
    window.addEventListener("arcalo:page-saved", bump);
    const every = window.setInterval(() => setTick((n) => n + 1), 60_000);
    return () => {
      window.clearTimeout(timer);
      window.clearInterval(every);
      window.removeEventListener("arcalo:page-saved", bump);
    };
  }, []);

  useEffect(() => {
    const n = ++seq.current;
    api
      .dayReview(date)
      .then((r) => n === seq.current && setReview(r))
      .catch((e) => n === seq.current && s().error(t("review.loadFailed"), e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, entriesVersion, pages, tick, focusId, timeOn]);

  // Another day: the summary belongs to the old one.
  const { reset } = ai;
  useEffect(() => {
    reset();
    setNoLocal(false);
  }, [date, reset]);

  const go = useCallback((delta: number) => setDate((d) => shiftDay(d, delta)), []);
  const toToday = useCallback(() => setDate(isoDay(new Date())), []);

  // ← / → / T while this pane is the active one and no field, dialog or menu has the keys.
  const keys = useRef({ go, toToday });
  keys.current = { go, toToday };
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
      else if (e.key === "t" || e.key === "T") keys.current.toToday();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const summaryText = !ai.busy && !ai.error && ai.text.trim() ? ai.text.trim() : null;

  const insert = async () => {
    if (!review) return;
    setInserting(true);
    try {
      // Pending edits first, so the note is read as the user last saw it.
      await flushAllEditors();
      const note = await api.dailyNote(date);
      const doc = await api.page(note.id);
      const next = upsertReviewBlock(doc.content, reviewMarkdown(review, summaryText));
      if (next !== doc.content) {
        await api.savePage(note.id, next);
        window.dispatchEvent(new CustomEvent("arcalo:page-saved", { detail: { id: note.id, content: next, from: "review" } }));
      }
      await s().refreshTree();
      const replaced = !!findReviewBlock(doc.content);
      s().toast({
        tone: "success",
        title: replaced ? t("review.updated") : t("review.inserted"),
        detail: summaryText ? t("review.withSummary") : undefined,
        action: { label: t("links.open"), run: () => s().openPage(note.id) },
      });
    } catch (e) {
      s().error(t("review.insertFailed"), e);
    } finally {
      setInserting(false);
    }
  };

  const summarize = () => {
    if (!local.length) {
      setNoLocal(true);
      return;
    }
    setNoLocal(false);
    void ai.runWith((requestId) => api.dayReviewSummary(requestId, date));
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
  const openTask = async (task: ReviewTask, newTab: boolean) => {
    // Opens the page and flashes the task (the top of the page when its text changed since).
    if (await known(task.page_id)) void revealText(task.page_id!, task.text, (pid) => s().openPage(pid, { newTab }));
  };
  const openMeeting = (m: ReviewMeeting) => openCalendarView({ date, key: m.key });
  const toSheet = (newTab = false) => openTimesheetDay(date, { newTab });

  const r = review && review.date === date ? review : null;
  const title = dayTitle(date);

  return (
    <div className="view-scroll" ref={root}>
      <div className="view rv-view">
        <header className="view-header rv-head">
          <div className="rv-heading">
            <h1>{t("ribbon.review")}</h1>
            <div className="view-sub rv-date">{title}</div>
          </div>
          <div className="view-actions rv-actions">
            <div className="rv-nav" role="group" aria-label={t("calv.view.day")}>
              <IconButton icon={ChevronLeft} label={t("review.prevDay")} onClick={() => go(-1)} />
              <Button size="sm" variant="ghost" onClick={toToday} disabled={date === today} title={t("calv.todayKey")}>
                {t("feed.range.today")}
              </Button>
              <IconButton icon={ChevronRight} label={t("review.nextDay")} onClick={() => go(1)} />
              <IconButton icon={CalendarDays} label={t("review.pickDay")} onClick={(e) => pickDate(e.currentTarget, date, setDate)} />
            </div>
            <Button variant="ghost" icon={CalendarCheck} className="rv-week" onClick={(e) => openWeekReview(date, { newTab: e.ctrlKey || e.metaKey })} aria-label={t("week.view")} data-tooltip-full={t("week.view")}>
              {t("week.view")}
            </Button>
            <Button variant={aiOn ? "secondary" : "primary"} icon={NotebookPen} className="rv-insert" loading={inserting} disabled={!r} onClick={() => void insert()}>
              {t("review.insert")}
            </Button>
            {aiOn && (
              <Button
                variant="primary"
                icon={local.length ? Sparkles : Lock}
                className="rv-summarize"
                loading={ai.busy}
                disabled={!r}
                onClick={summarize}
                title={local.length ? t("review.summarizeTitle") : t("review.summarizeNoLocal")}
              >
                {t("review.summarize")}
              </Button>
            )}
          </div>
        </header>

        {!r ? (
          <Skeleton rows={4} variant="cards" />
        ) : (
          <>
            <Stats r={r} />

            {noLocal && aiOn && (
              <div className="rv-callout" role="status">
                <Lock size={15} aria-hidden />
                <div>
                  <b>{t("review.localOnly")}</b> {t("review.localOnlyText")}
                </div>
                <div className="rv-callout-actions">
                  <Button size="sm" icon={Settings2} onClick={() => openSettingsSection("ai")}>
                    {t("review.aiSettings")}
                  </Button>
                  <IconButton icon={X} label={t("common.close")} size="sm" onClick={() => setNoLocal(false)} />
                </div>
              </div>
            )}

            {aiOn && (ai.busy || ai.text || ai.error) && (
              <section className="card rv-summary" aria-label={t("review.md.summary")} aria-live="polite">
                <div className="card-head">
                  <h2>
                    <Sparkles size={14} aria-hidden /> {t("review.md.summary")}
                  </h2>
                  <span className="rv-summary-meta faint small">{ai.meta ? t("review.localModel", { model: ai.meta.model }) : ai.busy ? t("review.writing") : ""}</span>
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
                  {summaryText && <div className="faint small rv-summary-hint">{t("review.summaryHint")}</div>}
                </div>
              </section>
            )}

            <div className="rv-grid">
              {!r.without_time && <TimeCard r={r} onOpen={toSheet} />}
              <Section icon={CalendarRange} tone="meetings" title={t("review.md.meetings")} count={r.meetings.length} empty={t("review.noMeetings")} className="rv-meetings">
                {r.meetings.map((m) => (
                  <button key={m.key} type="button" className={`rv-row rv-meeting state-${m.state}`} style={{ "--ev": sourceColor(m.source, cal) } as CSSProperties} onClick={() => openMeeting(m)}>
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
                {openMeetings(r).length > 0 && (
                  <button type="button" className="rv-foot-link" onClick={() => openCalendarView({ date })}>
                    {t("review.meetingsToBook", { n: openMeetings(r).length })}
                  </button>
                )}
              </Section>
              <Section icon={FileText} tone="pages" title={t("review.md.pages")} count={r.pages.length} empty={t("review.noPages")} className="rv-pages">
                {r.pages.map((p, i) => (
                  <PageRow key={`${p.page_id ?? "x"}-${i}`} p={p} onOpen={(newTab) => void openPage(p.gone ? null : p.page_id, newTab)} />
                ))}
              </Section>
              <TasksCard r={r} onOpen={(task, newTab) => void openTask(task, newTab)} />
              {r.focus.sessions.length > 0 && (
                <Section icon={Target} tone="focus" title={t("review.md.focus")} count={r.focus.sessions.length} extra={fmtDuration(r.focus.minutes)} className="rv-focus">
                  {r.focus.sessions.map((f) => (
                    <button key={f.id} type="button" className="rv-row" onClick={(e) => !r.without_time && toSheet(e.ctrlKey || e.metaKey)}>
                      <span className="rv-when num">{time(f.started_at)}</span>
                      <span className="rv-main">
                        <span className="rv-title ellipsis">{f.goal || f.reference || t("feed.focus")}</span>
                        {f.goal && f.reference && <span className="rv-sub mono ellipsis">{f.reference}</span>}
                      </span>
                      <span className="rv-meta num">
                        {fmtDuration(f.worked_minutes)}
                        {f.status === "aborted" ? ` · ${t("review.aborted")}` : f.status === "running" ? ` · ${t("time.runningLower")}` : f.entry_id ? ` · ${t("review.meeting.booked")}` : ""}
                      </span>
                    </button>
                  ))}
                </Section>
              )}
              {r.files.length > 0 && (
                <Section icon={Paperclip} tone="files" title={t("review.md.files")} count={r.files.length} className="rv-files">
                  {r.files.map((f) => (
                    <button key={f.name} type="button" className="rv-row" onClick={() => void api.openAttachment(f.name).catch((e) => s().error(t("feed.fileOpenFailed"), e))}>
                      <span className="rv-when num">{time(f.at)}</span>
                      <span className="rv-main">
                        <span className="rv-title ellipsis">{f.name}</span>
                      </span>
                      <span className="rv-meta">{fileKind(f.kind)}</span>
                    </button>
                  ))}
                </Section>
              )}
            </div>

            {isEmpty(r) && (
              <EmptyState icon={Sunset} title={date > today ? t("review.future") : t("review.nothing")}>
                {t("review.emptyHint")}
              </EmptyState>
            )}
          </>
        )}
      </div>
    </div>
  );
}

const isEmpty = (r: DayReview) =>
  !r.pages.length && !r.time.entries.length && !r.time.running_minutes && !r.tasks.done.length && !r.tasks.added.length && !r.meetings.length && !r.focus.sessions.length && !r.files.length;

function Stats({ r }: { r: DayReview }) {
  const t = useT();
  const tm = r.time;
  const fresh = r.tasks.added.filter((x) => !x.done).length;
  const edited = r.pages.reduce((a, p) => a + p.minutes, 0);
  return (
    <section className={`rv-stats ${r.without_time ? "no-time" : ""}`} aria-label={t("review.overview")}>
      {!r.without_time && <div className="rv-stat tone-time">
        <span className="rv-stat-label">
          <Clock size={13} aria-hidden /> {t("calv.booked")}
        </span>
        <span className="rv-stat-value num">
          {fmtDuration(tm.booked_minutes)}
          {tm.target_minutes > 0 && <span className="rv-stat-of"> / {fmtDuration(tm.target_minutes)}</span>}
        </span>
        <Progress value={progress(r)} tone={tm.target_minutes > 0 && tm.missing_minutes === 0 ? "success" : "accent"} />
        <span className="rv-stat-sub">
          {tm.target_minutes <= 0 ? t("review.noWorkday") : tm.missing_minutes > 0 ? t("review.md.missing", { h: fmtDuration(tm.missing_minutes) }) : t("review.targetReached")}
          {tm.running_minutes > 0 && ` · ${t("review.timer", { time: fmtDuration(tm.running_minutes) })}`}
        </span>
      </div>}
      <div className="rv-stat tone-meetings">
        <span className="rv-stat-label">
          <CalendarRange size={13} aria-hidden /> {t("review.md.meetings")}
        </span>
        <span className="rv-stat-value num">{r.meetings.length}</span>
        <span className="rv-stat-sub">{meetingsSub(r)}</span>
      </div>
      <div className="rv-stat tone-tasks">
        <span className="rv-stat-label">
          <CheckSquare size={13} aria-hidden /> {t("review.done")}
        </span>
        <span className="rv-stat-value num">{r.tasks.done_total}</span>
        <span className="rv-stat-sub">
          {[fresh ? t("review.md.added", { n: fresh }) : "", r.tasks.overdue_total ? t("review.md.overdue", { n: r.tasks.overdue_total }) : ""].filter(Boolean).join(" · ") || t("review.md.tasks")}
        </span>
      </div>
      <div className="rv-stat tone-pages">
        <span className="rv-stat-label">
          <FileText size={13} aria-hidden /> {t("review.md.pages")}
        </span>
        <span className="rv-stat-value num">{r.pages.length}</span>
        <span className="rv-stat-sub">{edited ? t("review.editedFor", { time: fmtDuration(edited) }) : t("review.edited")}</span>
      </div>
      <div className="rv-stat tone-focus">
        <span className="rv-stat-label">
          <Target size={13} aria-hidden /> {t("review.md.focus")}
        </span>
        <span className="rv-stat-value num">{fmtDuration(r.focus.minutes)}</span>
        <span className="rv-stat-sub">{t("review.md.sessions", { n: r.focus.sessions.length })}</span>
      </div>
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

function TimeCard({ r, onOpen }: { r: DayReview; onOpen: (newTab?: boolean) => void }) {
  const t = useT();
  const tm = r.time;
  const max = Math.max(1, ...tm.items.map((w) => w.minutes));
  return (
    <Section icon={Clock} tone="time" title={t("review.md.time")} count={tm.items.length} extra={tm.target_minutes > 0 ? t("review.hoursOf", { h: fmtDuration(tm.booked_minutes), target: fmtDuration(tm.target_minutes) }) : fmtDuration(tm.booked_minutes)} className="rv-time">
      {tm.items.length === 0 ? (
        <div className="rv-empty">{tm.running_minutes > 0 ? t("review.timerRunning", { time: fmtDuration(tm.running_minutes) }) : t("review.nothingBooked")}</div>
      ) : (
        tm.items.map((w) => (
          <button key={w.label} type="button" className="rv-row rv-wbs" onClick={(e) => onOpen(e.ctrlKey || e.metaKey)} title={w.descriptions.join("\n")}>
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
            <span className="rv-meta num">{fmtDuration(w.minutes)}</span>
          </button>
        ))
      )}
      {tm.gaps.length > 0 && (
        <div className="rv-gaps" role="status">
          <AlertTriangle size={13} aria-hidden />
          <span>{t("review.gaps")}</span>
          {tm.gaps.map((g) => (
            <button key={g.start} type="button" className="gap-chip" onClick={() => onOpen()}>
              {time(g.start)}–{time(g.end)} <span className="faint">({fmtDuration(g.minutes)})</span>
            </button>
          ))}
        </div>
      )}
      <button type="button" className="rv-foot-link" onClick={(e) => onOpen(e.ctrlKey || e.metaKey)}>
        {tm.missing_minutes > 0 ? t("review.missingBook", { h: fmtDuration(tm.missing_minutes) }) : t("review.openTimesheet")}
      </button>
    </Section>
  );
}

function PageRow({ p, onOpen }: { p: ReviewPage; onOpen: (newTab: boolean) => void }) {
  const t = useT();
  const words = (n: number) => t("review.words", { n: Math.abs(n), count: `${n > 0 ? "+" : "−"}${int(Math.abs(n))}` });
  const bits = [p.minutes > 0 ? `~${p.minutes} min` : "", p.word_delta ? words(p.word_delta) : "", p.edits > 0 ? t("feed.changes", { n: p.edits }) : ""].filter(Boolean);
  return (
    <button type="button" className={`rv-row rv-page ${p.gone ? "gone" : ""}`} onClick={(e) => onOpen(e.ctrlKey || e.metaKey)}>
      <span className="rv-when num">{time(p.last_at)}</span>
      <span className="rv-main">
        <span className="rv-title">
          <PageIcon name={p.icon ?? undefined} size={14} />
          <span className="ellipsis">{p.title}</span>
          {p.created && <Badge tone="accent">{t("review.md.new")}</Badge>}
          {p.daily && <Badge>{t("capture.daily")}</Badge>}
        </span>
        <span className="rv-sub">{bits.join(" · ")}</span>
      </span>
    </button>
  );
}

function TasksCard({ r, onOpen }: { r: DayReview; onOpen: (task: ReviewTask, newTab: boolean) => void }) {
  const t = useT();
  const k = r.tasks;
  const fresh = k.added.filter((x) => !x.done);
  const groups: { id: string; label: string; items: ReviewTask[]; total: number; tone?: Tone }[] = [
    { id: "done", label: t("review.done"), items: k.done, total: k.done_total },
    { id: "added", label: t("qs.new"), items: fresh, total: fresh.length },
    { id: "due", label: t("review.dueToday"), items: k.due, total: k.due_total, tone: "warning" },
    { id: "overdue", label: t("tasks.overdue"), items: k.overdue, total: k.overdue_total, tone: "danger" },
  ];
  const count = k.done_total + fresh.length + k.due_total + k.overdue_total;
  return (
    <Section icon={CheckSquare} tone="tasks" title={t("review.md.tasks")} count={count} empty={t("review.noTasks")} className="rv-tasks">
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
                  <span className="rv-sub ellipsis">{task.page_title}</span>
                </span>
                {task.due && g.tone && <Badge tone={g.tone}>{g.id === "due" ? t("review.today") : fmtDayMonth(new Date(`${task.due}T12:00:00`))}</Badge>}
              </button>
            ))}
          </div>
        ))}
    </Section>
  );
}
