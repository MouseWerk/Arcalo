// „Morgen-Briefing“: today on one page – the meetings with their preparation, join link and
// note, Jira issues due, overdue or blocked, tasks overdue and due today, the hours the last
// workday still misses, and „Was ist heute wichtig“ written by the assistant (cached per day,
// written again on demand). Sections and their order come from Settings → Briefing; the gear
// changes them here too. Everything is read with one call (`briefing`).

import { useCallback, useEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { AlertTriangle, ClipboardList, Clock, ExternalLink, FileText, Lock, NotebookPen, RefreshCw, Settings2, Sparkles, Sun, Timer, Video, WandSparkles, X, type LucideIcon } from "lucide-react";
import { api } from "../lib/api";
import { useApp } from "../store/app";
import { Badge, Button, EmptyState, IconButton, Progress, Spinner } from "../components/ui";
import { revealText } from "../editor/reveal";
import { dayTitle } from "../lib/activity";
import { fmtDate, isoDay, time } from "../lib/format";
import { openCalendarView, openSettingsSection } from "../lib/calnav";
import { sourceColor } from "../lib/agenda";
import { hiddenCalendars, useHiddenCalendars } from "../lib/calvisibility";
import { openTimesheetDay } from "../lib/reviewnav";
import { requestWeekProposal } from "../lib/weekplan";
import { hm, hours } from "../lib/dayreview";
import { briefingCounts, briefingSettings, missingLabel, shows } from "../lib/briefing";
import { openIssueInBrowser, openIssueNote } from "../lib/jiraActions";
import { useTimeTracking } from "../lib/timetracking";
import { renderMarkdown } from "../lib/markdown";
import { useT, type TKey } from "../lib/i18n";
import type { Briefing, BriefingIssue, BriefingMeeting, BriefingSection, BriefingSectionId, BriefingSummary, BriefingTask } from "../lib/types";
import { SECTION_ICON, SECTION_LABEL, SectionsEditor, unavailableSections } from "./settings/BriefingSection";
import { prepareMeeting } from "../components/MeetingWork";

const s = useApp.getState;

export function BriefingView() {
  const t = useT();
  const pages = useApp((st) => st.pages);
  const entriesVersion = useApp((st) => st.entriesVersion);
  const settings = useApp((st) => st.settings?.settings);
  const cal = settings?.calendar;
  const sectionsKey = JSON.stringify(settings?.briefing?.sections ?? null);
  const jiraKey = settings?.jira?.sites.length ?? 0;
  const timeOn = useTimeTracking();
  const hidden = useHiddenCalendars();
  const [b, setB] = useState<Briefing | null>(null);
  const [failed, setFailed] = useState(false);
  const [tick, setTick] = useState(0);
  const [gear, setGear] = useState(false);
  const [summary, setSummary] = useState<BriefingSummary | null>(null);
  const [writing, setWriting] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const tried = useRef<string | null>(null);
  const seq = useRef(0);
  const today = isoDay(new Date());

  // Saves change tasks and notes: refetch shortly after, and every minute while open.
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
    api
      .briefing([...hidden])
      .then((r) => {
        if (n !== seq.current) return;
        setB(r);
        setFailed(false);
        if (r.summary) setSummary(r.summary);
      })
      .catch((e) => {
        if (n !== seq.current) return;
        setFailed(true);
        s().error(t("brief.loadFailed"), e);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entriesVersion, pages, tick, timeOn, hidden, sectionsKey, jiraKey]);

  const write = useCallback(
    async (refresh: boolean) => {
      setWriting(true);
      setAiError(null);
      try {
        setSummary(await api.briefingSummary(crypto.randomUUID(), [...hiddenCalendars()], refresh));
      } catch (e) {
        setAiError(String(e));
      } finally {
        setWriting(false);
      }
    },
    [],
  );

  // The text of the day: written once when the briefing first opens, then from the cache.
  useEffect(() => {
    if (!b || !shows(b, "ai") || !b.ai_ready || b.summary || summary?.date === b.date || tried.current === b.date) return;
    tried.current = b.date;
    void write(false);
  }, [b, summary, write]);

  const saveSections = async (sections: BriefingSection[]) => {
    const view = s().settings;
    if (!view) return;
    try {
      const saved = await api.saveSettings({ ...view.settings, briefing: { ...briefingSettings(view.settings.briefing), sections } });
      s().set({ settings: saved });
    } catch (e) {
      s().error(t("settings.saveFailed"), e);
    }
  };

  const r = b;
  const sections = briefingSettings(settings?.briefing).sections;
  const render = (id: BriefingSectionId): ReactNode => {
    if (!r) return null;
    switch (id) {
      case "ai":
        return <AiCard key={id} b={r} summary={summary} writing={writing} error={aiError} onWrite={() => void write(true)} />;
      case "meetings":
        return <MeetingsCard key={id} b={r} colorOf={(src) => sourceColor(src, cal)} />;
      case "tasks":
        return <TasksCard key={id} b={r} />;
      case "jira":
        return r.jira ? <JiraCard key={id} b={r} /> : null;
      case "time":
        return r.time ? <TimeCard key={id} b={r} /> : null;
    }
  };

  return (
    <div className="view-scroll">
      <div className="view rv-view bf-view">
        <header className="view-header rv-head">
          <div className="rv-heading">
            <h1>{t("brief.title")}</h1>
            <div className="view-sub rv-date">
              {dayTitle(today)}
              {r && !r.workday && <span className="bf-noworkday"> · {t("brief.noWorkday")}</span>}
            </div>
          </div>
          <div className="view-actions rv-actions">
            <IconButton icon={RefreshCw} label={t("brief.reload")} onClick={() => setTick((n) => n + 1)} />
            <Button icon={Settings2} className={`bf-gear ${gear ? "active" : ""}`} aria-expanded={gear} onClick={() => setGear((v) => !v)}>
              {t("brief.customize")}
            </Button>
          </div>
        </header>

        {gear && (
          <section className="card bf-customize" aria-label={t("brief.customize")}>
            <div className="card-head">
              <h2>{t("brief.sections")}</h2>
              <span className="faint small bf-customize-hint">{t("brief.sectionsDesc")}</span>
              <IconButton icon={X} size="sm" label={t("common.close")} onClick={() => setGear(false)} />
            </div>
            <div className="bf-customize-body">
              <SectionsEditor value={sections} onChange={(v) => void saveSections(v)} unavailable={unavailableSections(settings)} />
            </div>
          </section>
        )}

        {!r ? (
          <div className="center-fill">{failed ? <EmptyState icon={AlertTriangle} title={t("brief.loadFailed")} /> : <Spinner />}</div>
        ) : r.sections.length === 0 ? (
          <EmptyState icon={Sun} title={t("brief.allOff")} action={<Button size="sm" icon={Settings2} onClick={() => setGear(true)}>{t("brief.customize")}</Button>}>
            {t("brief.allOffHint")}
          </EmptyState>
        ) : (
          <>
            <Overview b={r} />
            <div className="rv-grid bf-grid">{r.sections.map(render)}</div>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- parts

function Card({ id, title, count, extra, className = "", children }: { id: BriefingSectionId; title?: string; count?: number; extra?: ReactNode; className?: string; children: ReactNode }) {
  const t = useT();
  const Icon: LucideIcon = SECTION_ICON[id];
  const label = title ?? t(SECTION_LABEL[id]);
  return (
    <section className={`card rv-card bf-card tone-${id} bf-${id} ${className}`} aria-label={label} data-section={id}>
      <div className="card-head">
        <h2>
          <span className="rv-card-icon" aria-hidden>
            <Icon size={14} />
          </span>
          {label}
          {count != null && <span className="rv-count num">{count}</span>}
        </h2>
        {extra}
      </div>
      {children}
    </section>
  );
}

function Overview({ b }: { b: Briefing }) {
  const t = useT();
  const c = briefingCounts(b);
  const items: { id: BriefingSectionId; value: string; label: string }[] = [];
  if (shows(b, "meetings")) items.push({ id: "meetings", value: String(c.upcoming), label: t("brief.ov.meetings", { n: c.meetings }) });
  if (shows(b, "tasks")) items.push({ id: "tasks", value: String(c.tasks), label: c.overdue ? t("brief.ov.overdue", { n: c.overdue }) : t("brief.ov.tasks") });
  if (shows(b, "jira") && b.jira) items.push({ id: "jira", value: String(c.jira), label: b.jira.blocked_total ? t("brief.ov.blocked", { n: b.jira.blocked_total }) : t("brief.ov.jira") });
  if (shows(b, "time") && b.time) items.push({ id: "time", value: hours(c.missing), label: missingLabel(b) });
  if (!items.length) return null;
  return (
    <section className="bf-overview" data-n={items.length} aria-label={t("review.overview")}>
      {items.map((x) => {
        const Icon = SECTION_ICON[x.id];
        return (
          <div key={x.id} className={`rv-stat tone-${x.id}`} data-section={x.id}>
            <span className="rv-stat-label">
              <Icon size={13} aria-hidden /> {t(SECTION_LABEL[x.id])}
            </span>
            <span className="rv-stat-value num">{x.value}</span>
            <span className="rv-stat-sub">{x.label}</span>
          </div>
        );
      })}
    </section>
  );
}

function AiCard({ b, summary, writing, error, onWrite }: { b: Briefing; summary: BriefingSummary | null; writing: boolean; error: string | null; onWrite: () => void }) {
  const t = useT();
  const text = summary && summary.date === b.date ? summary : null;
  const meta = text ? `${text.local ? `${t("brief.local")} · ` : ""}${text.model} · ${time(text.at)}` : writing ? t("brief.writing") : "";
  return (
    <Card
      id="ai"
      className="bf-ai"
      extra={
        <>
          <span className="rv-summary-meta faint small bf-ai-meta">
            {b.private && <Lock size={11} aria-hidden />} {meta}
          </span>
          {b.ai_ready && <IconButton icon={RefreshCw} size="sm" className="bf-ai-refresh" label={t("brief.rewrite")} disabled={writing} onClick={onWrite} />}
        </>
      }
    >
      <div className="rv-summary-body bf-ai-body" aria-live="polite">
        {!b.ai_ready ? (
          <div className="bf-ai-hint">
            <span>{t("brief.noAi")}</span>
            <Button size="sm" icon={Settings2} onClick={() => openSettingsSection("ai")}>
              {t("review.aiSettings")}
            </Button>
          </div>
        ) : writing ? (
          <div className="thinking">
            <span />
            <span />
            <span />
          </div>
        ) : error ? (
          <div className="msg-error">
            <div>{t("brief.aiFailed")}</div>
            <div className="faint small">{error}</div>
          </div>
        ) : text ? (
          <div className="prose prose-chat bf-ai-text" dangerouslySetInnerHTML={{ __html: renderMarkdown(text.text) }} />
        ) : (
          <Button size="sm" icon={Sparkles} onClick={onWrite}>
            {t("brief.write")}
          </Button>
        )}
      </div>
    </Card>
  );
}

const PREP_LABEL: Record<"own" | "series" | "subject", TKey> = { own: "brief.prep.own", series: "brief.prep.series", subject: "brief.prep.subject" };

function MeetingsCard({ b, colorOf }: { b: Briefing; colorOf: (source: string) => string }) {
  const t = useT();
  const [busy, setBusy] = useState<string | null>(null);
  const note = async (m: BriefingMeeting) => {
    if (m.note_page_id != null && s().pages.has(m.note_page_id)) return s().openPage(m.note_page_id, { newTab: true });
    setBusy(m.key);
    try {
      const { page, created } = await api.calendarMeetingNote(m.key);
      await s().refreshTree();
      s().openPage(page.id, { newTab: true });
      if (created) s().toast({ tone: "success", title: t("calv.noteCreated"), detail: page.title });
    } catch (e) {
      s().error(t("calv.noteFailed"), e);
    } finally {
      setBusy(null);
    }
  };
  const openPrep = async (id: number, e: MouseEvent) => {
    if (!s().pages.has(id)) await s().refreshTree();
    s().openPage(id, { newTab: e.ctrlKey || e.metaKey });
  };
  const list = b.meetings;
  return (
    <Card id="meetings" count={list.filter((m) => !m.free).length}>
      <div className="rv-list">
        {!list.length && <div className="rv-empty">{t("brief.noMeetings")}</div>}
        {list.map((m) => {
          const next = m.key === b.next_meeting;
          const running = next && new Date(m.start).getTime() <= Date.now();
          return (
            <div key={m.key} className={`bf-meeting rv-meeting ${m.past ? "past" : ""} ${m.free ? "state-free" : ""} ${next ? "next" : ""}`} style={{ "--ev": colorOf(m.source) } as CSSProperties}>
              <span className="rv-when num">{m.all_day ? t("cal.allDay") : `${time(m.start)}–${time(m.end)}`}</span>
              <span className="rv-main">
                <button type="button" className="bf-link rv-title" onClick={() => openCalendarView({ date: isoDay(new Date(m.start)), key: m.key })}>
                  <span className="ellipsis">{m.title || t("cal.appointment")}</span>
                  {next && <Badge tone="accent">{t(running ? "brief.now" : "brief.next")}</Badge>}
                </button>
                {m.prep ? (
                  <button type="button" className="bf-prep" onClick={(e) => void openPrep(m.prep!.page_id, e)} title={t(PREP_LABEL[m.prep.kind])}>
                    <FileText size={12} aria-hidden />
                    <span className="faint">{t(PREP_LABEL[m.prep.kind])}:</span> <span className="ellipsis">{m.prep.title}</span>
                  </button>
                ) : (
                  !m.free && !m.past && <span className="rv-sub">{t("brief.noPrep")}</span>
                )}
                {m.prep_page != null && (
                  <button type="button" className="bf-prep bf-prep-page" onClick={(e) => void openPrep(m.prep_page!, e)}>
                    <ClipboardList size={12} aria-hidden />
                    <span className="faint">{t("mw.prep.page")}</span>
                  </button>
                )}
              </span>
              <span className="bf-actions">
                {m.link && !m.past && (
                  <Button size="sm" variant={next ? "primary" : "secondary"} icon={Video} className="bf-join" onClick={() => openUrl(m.link!).catch((e) => s().error(t("dash.joinFailed"), e))}>
                    {t("dash.join")}
                  </Button>
                )}
                {!m.free && !m.past && !m.all_day && (
                  <IconButton icon={ClipboardList} size="sm" className="bf-prepare" label={t(m.prep_page != null ? "mw.prep.refresh" : "mw.prep.button")} onClick={() => void prepareMeeting(m.key)} />
                )}
                {!m.free && (
                  <IconButton icon={NotebookPen} size="sm" className="bf-note" label={t(m.note_page_id != null ? "brief.openNote" : "brief.createNote")} disabled={busy === m.key} onClick={() => void note(m)} />
                )}
              </span>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function TaskRow({ task, overdue }: { task: BriefingTask; overdue: boolean }) {
  const t = useT();
  const open = async (newTab: boolean) => {
    if (!s().pages.has(task.page_id)) await s().refreshTree();
    void revealText(task.page_id, task.text, (pid) => s().openPage(pid, { newTab }));
  };
  return (
    <button type="button" className={`rv-row rv-task bf-task ${overdue ? "overdue" : ""}`} onClick={(e) => void open(e.ctrlKey || e.metaKey)}>
      <span className="rv-check" aria-hidden />
      <span className="rv-main">
        <span className="rv-title ellipsis">{task.text}</span>
        <span className="rv-sub ellipsis">{task.page_title}</span>
      </span>
      <span className={`rv-meta num ${overdue ? "bf-overdue" : ""}`}>{overdue && task.due ? fmtDate(task.due) : t("brief.today")}</span>
    </button>
  );
}

function TasksCard({ b }: { b: Briefing }) {
  const t = useT();
  const tk = b.tasks;
  const total = tk.overdue_total + tk.today_total;
  return (
    <Card id="tasks" count={total}>
      <div className="rv-list">
        {total === 0 && <div className="rv-empty">{t("brief.noTasks")}</div>}
        {tk.overdue.length > 0 && (
          <div className="rv-group">
            <div className="rv-group-head">
              <span>{t("brief.overdue")}</span>
              <span className="num">{tk.overdue_total}</span>
            </div>
            {tk.overdue.map((x) => (
              <TaskRow key={`${x.page_id}-${x.ordinal}`} task={x} overdue />
            ))}
          </div>
        )}
        {tk.today.length > 0 && (
          <div className="rv-group">
            <div className="rv-group-head">
              <span>{t("brief.dueToday")}</span>
              <span className="num">{tk.today_total}</span>
            </div>
            {tk.today.map((x) => (
              <TaskRow key={`${x.page_id}-${x.ordinal}`} task={x} overdue={false} />
            ))}
          </div>
        )}
        {total > tk.overdue.length + tk.today.length && (
          <button type="button" className="rv-foot-link" onClick={() => s().openTab({ kind: "tasks" })}>
            {t("brief.allTasks", { n: total })}
          </button>
        )}
      </div>
    </Card>
  );
}

function IssueRow({ i }: { i: BriefingIssue }) {
  const t = useT();
  return (
    <div className="bf-issue">
      <button type="button" className="rv-row" onClick={(e) => void (e.ctrlKey || e.metaKey ? openIssueInBrowser(i.key, i.url) : openIssueNote(i.key))}>
        <span className="rv-ref mono">{i.key}</span>
        <span className="rv-main">
          <span className="rv-title ellipsis">{i.summary}</span>
          <span className="rv-sub ellipsis">
            {i.status}
            {i.due_date ? ` · ${t("brief.due", { date: fmtDate(i.due_date) })}` : ""}
          </span>
        </span>
        {i.blocked ? <Badge tone="danger">{t("brief.blocked")}</Badge> : <span />}
      </button>
      {i.url && <IconButton icon={ExternalLink} size="sm" label={t("brief.inBrowser")} onClick={() => void openIssueInBrowser(i.key, i.url)} />}
    </div>
  );
}

function JiraCard({ b }: { b: Briefing }) {
  const t = useT();
  const j = b.jira!;
  const groups: [TKey, BriefingIssue[], number][] = [
    ["brief.overdue", j.overdue, j.overdue_total],
    ["brief.dueToday", j.due, j.due_total],
    ["brief.blockedGroup", j.blocked, j.blocked_total],
  ];
  const total = j.overdue_total + j.due_total + j.blocked_total;
  return (
    <Card id="jira" count={total}>
      <div className="rv-list">
        {total === 0 && <div className="rv-empty">{t("brief.noIssues")}</div>}
        {groups
          .filter(([, list]) => list.length > 0)
          .map(([label, list, n]) => (
            <div key={label} className="rv-group">
              <div className="rv-group-head">
                <span>{t(label)}</span>
                <span className="num">{n}</span>
              </div>
              {list.map((i) => (
                <IssueRow key={`${i.site}-${i.key}`} i={i} />
              ))}
            </div>
          ))}
        {total > 0 && (
          <button type="button" className="rv-foot-link" onClick={() => s().openTab({ kind: "issues" })}>
            {t("brief.allIssues")}
          </button>
        )}
      </div>
    </Card>
  );
}

const ABSENCE: Record<string, TKey> = { vacation: "brief.abs.vacation", sick: "brief.abs.sick", comp: "brief.abs.comp", other: "brief.abs.other" };

function TimeCard({ b }: { b: Briefing }) {
  const t = useT();
  const tm = b.time!;
  const pct = tm.target_minutes > 0 ? Math.min(100, Math.round((tm.booked_minutes / tm.target_minutes) * 100)) : 100;
  const why = tm.holiday ? t("brief.holiday", { name: tm.holiday }) : tm.absence ? t(ABSENCE[tm.absence] ?? "brief.abs.other") + (tm.half ? ` (${t("brief.half")})` : "") : null;
  return (
    <Card id="time" title={t("brief.lastDay", { day: dayTitle(tm.date) })} extra={<span className="rv-card-extra num">{tm.target_minutes > 0 ? t("review.hoursOf", { h: hours(tm.booked_minutes), target: hours(tm.target_minutes) }) : hours(tm.booked_minutes)}</span>}>
      <div className="bf-time-body">
        <Progress value={pct} tone={tm.missing_minutes === 0 ? "success" : "accent"} />
        <div className={`bf-time-state ${tm.missing_minutes > 0 ? "missing" : "ok"}`}>
          <Clock size={14} aria-hidden />
          <span>{tm.missing_minutes > 0 ? t("brief.missing", { time: hm(tm.missing_minutes) }) : tm.target_minutes > 0 ? t("review.targetReached") : t("brief.noGap")}</span>
          {why && <span className="faint">· {why}</span>}
        </div>
        <div className="bf-time-actions">
          <Button
            size="sm"
            icon={WandSparkles}
            className="bf-week"
            onClick={() => {
              s().openTab({ kind: "timesheet" });
              requestWeekProposal();
            }}
          >
            {t("dash.act.week")}
          </Button>
          <Button size="sm" variant="ghost" icon={Timer} className="bf-sheet" onClick={(e) => openTimesheetDay(tm.date, { newTab: e.ctrlKey || e.metaKey })}>
            {t("brief.timesheet")}
          </Button>
        </div>
      </div>
    </Card>
  );
}
