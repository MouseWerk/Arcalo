// „Tagesrückblick“: one page for the end of the day – time booked per WBS against the target
// with the gaps, meetings with their booking state, pages created and edited, tasks, focus and
// files. Every row leads to its place; „In Tagesnotiz übernehmen“ writes a compact block into
// the daily note, and a local model (never a cloud provider) can write a short summary.

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle, CalendarDays, CalendarRange, Check, CheckSquare, ChevronLeft, ChevronRight, Clock, Copy, FileText, Lock, NotebookPen, Paperclip, RefreshCw, Settings2, Sparkles, Square, Sunset, Target, X,
  type LucideIcon,
} from "lucide-react";
import { api } from "../lib/api";
import { useApp } from "../store/app";
import { Badge, Button, EmptyState, IconButton, Progress, Spinner, type Tone } from "../components/ui";
import { PageIcon } from "../components/icons";
import { pickDate } from "../components/CalendarPopover";
import { flushAllEditors } from "../editor/saves";
import { revealText } from "../editor/reveal";
import { dayTitle } from "../lib/activity";
import { isoDay, time } from "../lib/format";
import { openCalendarView, openSettingsSection } from "../lib/calnav";
import { REVIEW_EVENT, openTimesheetDay, takeReviewDay } from "../lib/reviewnav";
import { MEETING_LABEL, hm, hours, localProviders, openMeetings, progress, reviewMarkdown, shiftDay, upsertReviewBlock } from "../lib/dayreview";
import { renderMarkdown } from "../lib/markdown";
import { useAiTransform } from "../lib/useAiTransform";
import type { DayReview, MeetingState, ReviewMeeting, ReviewPage, ReviewTask } from "../lib/types";

const MEETING_TONE: Record<MeetingState, Tone> = { booked: "success", open: "warning", skipped: "neutral", upcoming: "info", free: "neutral" };

const plural = (n: number, one: string, many: string) => `${n.toLocaleString("de-DE")} ${n === 1 ? one : many}`;

export function DayReviewView() {
  const s = useApp.getState;
  const pages = useApp((st) => st.pages);
  const entriesVersion = useApp((st) => st.entriesVersion);
  const focusId = useApp((st) => `${st.focus?.session.id ?? ""}:${st.focus?.phase ?? ""}`);
  const providers = useApp((st) => st.settings?.settings.providers);
  const [date, setDate] = useState(() => takeReviewDay() ?? isoDay(new Date()));
  const [review, setReview] = useState<DayReview | null>(null);
  const [tick, setTick] = useState(0);
  const [inserting, setInserting] = useState(false);
  const [noLocal, setNoLocal] = useState(false);
  const [copied, setCopied] = useState(false);
  const ai = useAiTransform();
  const root = useRef<HTMLDivElement>(null);
  const seq = useRef(0);
  const today = isoDay(new Date());
  const local = localProviders(providers);

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
    let t: number | undefined;
    const bump = () => {
      window.clearTimeout(t);
      t = window.setTimeout(() => setTick((n) => n + 1), 700);
    };
    window.addEventListener("annalo:page-saved", bump);
    const every = window.setInterval(() => setTick((n) => n + 1), 60_000);
    return () => {
      window.clearTimeout(t);
      window.clearInterval(every);
      window.removeEventListener("annalo:page-saved", bump);
    };
  }, []);

  useEffect(() => {
    const n = ++seq.current;
    api
      .dayReview(date)
      .then((r) => n === seq.current && setReview(r))
      .catch((e) => n === seq.current && s().error("Tagesrückblick nicht geladen", e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, entriesVersion, pages, tick, focusId]);

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
      const t = document.activeElement as HTMLElement | null;
      if (!el || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      if (!el.closest(".pane")?.classList.contains("active")) return;
      const pane = t?.closest(".pane");
      if (pane && !pane.contains(el)) return;
      if (t?.closest("input, textarea, select, [contenteditable='true'], [role='combobox']")) return;
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
        window.dispatchEvent(new CustomEvent("annalo:page-saved", { detail: { id: note.id, content: next, from: "review" } }));
      }
      await s().refreshTree();
      const replaced = doc.content.includes("<!-- rückblick -->");
      s().toast({
        tone: "success",
        title: replaced ? "Rückblick in der Tagesnotiz aktualisiert" : "Rückblick in die Tagesnotiz übernommen",
        detail: summaryText ? "Mit Zusammenfassung" : undefined,
        action: { label: "Öffnen", run: () => s().openPage(note.id) },
      });
    } catch (e) {
      s().error("Nicht in die Tagesnotiz übernommen", e);
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
    s().toast({ tone: "info", title: "Nicht mehr vorhanden", detail: "Die Seite wurde gelöscht oder liegt im Papierkorb." });
    return false;
  };
  const openPage = async (id: number | null, newTab: boolean) => {
    if (await known(id)) s().openPage(id!, { newTab });
  };
  const openTask = async (t: ReviewTask, newTab: boolean) => {
    // Opens the page and flashes the task (the top of the page when its text changed since).
    if (await known(t.page_id)) void revealText(t.page_id!, t.text, (pid) => s().openPage(pid, { newTab }));
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
            <h1>Tagesrückblick</h1>
            <div className="view-sub rv-date">{title}</div>
          </div>
          <div className="view-actions rv-actions">
            <div className="rv-nav" role="group" aria-label="Tag">
              <IconButton icon={ChevronLeft} label="Vorheriger Tag (←)" onClick={() => go(-1)} />
              <Button size="sm" variant="ghost" onClick={toToday} disabled={date === today} title="Heute (T)">
                Heute
              </Button>
              <IconButton icon={ChevronRight} label="Nächster Tag (→)" onClick={() => go(1)} />
              <IconButton icon={CalendarDays} label="Tag wählen" onClick={(e) => pickDate(e.currentTarget, date, setDate)} />
            </div>
            <Button icon={NotebookPen} className="rv-insert" loading={inserting} disabled={!r} onClick={() => void insert()}>
              In Tagesnotiz übernehmen
            </Button>
            <Button
              variant="primary"
              icon={local.length ? Sparkles : Lock}
              className="rv-summarize"
              loading={ai.busy}
              disabled={!r}
              onClick={summarize}
              title={local.length ? "Schreibt eine kurze Zusammenfassung mit dem lokalen Modell" : "Nur mit einem lokalen Modell (z. B. Ollama) möglich"}
            >
              Zusammenfassung schreiben
            </Button>
          </div>
        </header>

        {!r ? (
          <div className="center-fill">
            <Spinner />
          </div>
        ) : (
          <>
            <Stats r={r} />

            {noLocal && (
              <div className="rv-callout" role="status">
                <Lock size={15} aria-hidden />
                <div>
                  <b>Nur mit einem lokalen Modell.</b> Der Rückblick enthält alle Seiten des Tages, auch vertrauliche. Die Zusammenfassung schreibt deshalb nur ein Anbieter, der als lokal markiert ist (z. B. Ollama) – nie ein Cloud-Anbieter.
                </div>
                <div className="rv-callout-actions">
                  <Button size="sm" icon={Settings2} onClick={() => openSettingsSection("ai")}>
                    KI-Einstellungen
                  </Button>
                  <IconButton icon={X} label="Schließen" size="sm" onClick={() => setNoLocal(false)} />
                </div>
              </div>
            )}

            {(ai.busy || ai.text || ai.error) && (
              <section className="card rv-summary" aria-label="Zusammenfassung" aria-live="polite">
                <div className="card-head">
                  <h2>
                    <Sparkles size={14} aria-hidden /> Zusammenfassung
                  </h2>
                  <span className="rv-summary-meta faint small">{ai.meta ? `lokal · ${ai.meta.model}` : ai.busy ? "wird lokal geschrieben…" : ""}</span>
                  <div className="rv-card-actions">
                    {ai.busy ? (
                      <Button size="sm" icon={Square} onClick={() => ai.cancel()}>
                        Stoppen
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
                            {copied ? "Kopiert" : "Kopieren"}
                          </Button>
                        )}
                        <IconButton icon={RefreshCw} label="Neu schreiben" size="sm" onClick={summarize} />
                        <IconButton icon={X} label="Verwerfen" size="sm" onClick={() => ai.reset()} />
                      </>
                    )}
                  </div>
                </div>
                <div className="rv-summary-body">
                  {ai.error ? (
                    <div className="msg-error">
                      <div>Die Zusammenfassung ist fehlgeschlagen.</div>
                      <div className="faint small">{ai.error}</div>
                    </div>
                  ) : !ai.text ? (
                    <div className="thinking">
                      <span />
                      <span />
                      <span />
                    </div>
                  ) : (
                    <div className={`prose prose-chat ${ai.busy ? "streaming" : ""}`} dangerouslySetInnerHTML={{ __html: renderMarkdown(ai.text) }} />
                  )}
                  {summaryText && <div className="faint small rv-summary-hint">„In Tagesnotiz übernehmen“ nimmt die Zusammenfassung mit.</div>}
                </div>
              </section>
            )}

            <div className="rv-grid">
              <TimeCard r={r} onOpen={toSheet} />
              <Section icon={CalendarRange} tone="meetings" title="Termine" count={r.meetings.length} empty="Keine Termine im Kalender." className="rv-meetings">
                {r.meetings.map((m) => (
                  <button key={m.key} type="button" className={`rv-row rv-meeting state-${m.state}`} onClick={() => openMeeting(m)}>
                    <span className="rv-when num">{m.all_day ? "ganztägig" : `${time(m.start)}–${time(m.end)}`}</span>
                    <span className="rv-main">
                      <span className="rv-title ellipsis">{m.title || "Termin"}</span>
                      {m.location && <span className="rv-sub ellipsis">{m.location}</span>}
                    </span>
                    <Badge tone={MEETING_TONE[m.state]}>{MEETING_LABEL[m.state]}</Badge>
                  </button>
                ))}
                {openMeetings(r).length > 0 && (
                  <button type="button" className="rv-foot-link" onClick={() => openCalendarView({ date })}>
                    {plural(openMeetings(r).length, "Termin", "Termine")} noch buchen · im Kalender öffnen
                  </button>
                )}
              </Section>
              <Section icon={FileText} tone="pages" title="Seiten" count={r.pages.length} empty="Keine Seite bearbeitet." className="rv-pages">
                {r.pages.map((p, i) => (
                  <PageRow key={`${p.page_id ?? "x"}-${i}`} p={p} onOpen={(newTab) => void openPage(p.gone ? null : p.page_id, newTab)} />
                ))}
              </Section>
              <TasksCard r={r} onOpen={(t, newTab) => void openTask(t, newTab)} />
              {r.focus.sessions.length > 0 && (
                <Section icon={Target} tone="focus" title="Fokus" count={r.focus.sessions.length} extra={hm(r.focus.minutes)} className="rv-focus">
                  {r.focus.sessions.map((f) => (
                    <button key={f.id} type="button" className="rv-row" onClick={(e) => toSheet(e.ctrlKey || e.metaKey)}>
                      <span className="rv-when num">{time(f.started_at)}</span>
                      <span className="rv-main">
                        <span className="rv-title ellipsis">{f.goal || f.reference || "Fokussitzung"}</span>
                        {f.goal && f.reference && <span className="rv-sub mono ellipsis">{f.reference}</span>}
                      </span>
                      <span className="rv-meta num">
                        {hm(f.worked_minutes)}
                        {f.status === "aborted" ? " · abgebrochen" : f.status === "running" ? " · läuft" : f.entry_id ? " · gebucht" : ""}
                      </span>
                    </button>
                  ))}
                </Section>
              )}
              {r.files.length > 0 && (
                <Section icon={Paperclip} tone="files" title="Dateien" count={r.files.length} className="rv-files">
                  {r.files.map((f) => (
                    <button key={f.name} type="button" className="rv-row" onClick={() => void api.openAttachment(f.name).catch((e) => s().error("Datei nicht geöffnet", e))}>
                      <span className="rv-when num">{time(f.at)}</span>
                      <span className="rv-main">
                        <span className="rv-title ellipsis">{f.name}</span>
                      </span>
                      <span className="rv-meta">{f.kind}</span>
                    </button>
                  ))}
                </Section>
              )}
            </div>

            {isEmpty(r) && (
              <EmptyState icon={Sunset} title={date > today ? "Dieser Tag liegt noch vor dir" : "An diesem Tag wurde nichts aufgezeichnet"}>
                Bearbeitete Seiten, Buchungen, erledigte Aufgaben, Termine und Fokussitzungen erscheinen hier.
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
  const t = r.time;
  const fresh = r.tasks.added.filter((x) => !x.done).length;
  const edited = r.pages.reduce((a, p) => a + p.minutes, 0);
  const open = openMeetings(r).length;
  return (
    <section className="rv-stats" aria-label="Überblick">
      <div className="rv-stat tone-time">
        <span className="rv-stat-label">
          <Clock size={13} aria-hidden /> Gebucht
        </span>
        <span className="rv-stat-value num">
          {hours(t.booked_minutes)}
          {t.target_minutes > 0 && <span className="rv-stat-of"> / {hours(t.target_minutes)}</span>}
        </span>
        <Progress value={progress(r)} tone={t.target_minutes > 0 && t.missing_minutes === 0 ? "success" : "accent"} />
        <span className="rv-stat-sub">
          {t.target_minutes <= 0 ? "kein Arbeitstag" : t.missing_minutes > 0 ? `${hours(t.missing_minutes)} fehlen` : "Soll erreicht"}
          {t.running_minutes > 0 && ` · Timer ${hm(t.running_minutes)}`}
        </span>
      </div>
      <div className="rv-stat tone-meetings">
        <span className="rv-stat-label">
          <CalendarRange size={13} aria-hidden /> Termine
        </span>
        <span className="rv-stat-value num">{r.meetings.length}</span>
        <span className="rv-stat-sub">{open ? `${open} nicht gebucht` : r.meetings.length ? "alles erledigt" : "keine"}</span>
      </div>
      <div className="rv-stat tone-tasks">
        <span className="rv-stat-label">
          <CheckSquare size={13} aria-hidden /> Erledigt
        </span>
        <span className="rv-stat-value num">{r.tasks.done_total}</span>
        <span className="rv-stat-sub">
          {[fresh ? `${fresh} neu` : "", r.tasks.overdue_total ? `${r.tasks.overdue_total} überfällig` : ""].filter(Boolean).join(" · ") || "Aufgaben"}
        </span>
      </div>
      <div className="rv-stat tone-pages">
        <span className="rv-stat-label">
          <FileText size={13} aria-hidden /> Seiten
        </span>
        <span className="rv-stat-value num">{r.pages.length}</span>
        <span className="rv-stat-sub">{edited ? `~${hm(edited)} bearbeitet` : "bearbeitet"}</span>
      </div>
      <div className="rv-stat tone-focus">
        <span className="rv-stat-label">
          <Target size={13} aria-hidden /> Fokus
        </span>
        <span className="rv-stat-value num">{hm(r.focus.minutes)}</span>
        <span className="rv-stat-sub">{plural(r.focus.sessions.length, "Sitzung", "Sitzungen")}</span>
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
  const t = r.time;
  const max = Math.max(1, ...t.items.map((w) => w.minutes));
  return (
    <Section icon={Clock} tone="time" title="Zeit" count={t.items.length} extra={t.target_minutes > 0 ? `${hours(t.booked_minutes)} von ${hours(t.target_minutes)}` : hours(t.booked_minutes)} className="rv-time">
      {t.items.length === 0 ? (
        <div className="rv-empty">{t.running_minutes > 0 ? `Ein Timer läuft seit ${hm(t.running_minutes)}.` : "Nichts gebucht."}</div>
      ) : (
        t.items.map((w) => (
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
            <span className="rv-meta num">{hours(w.minutes)}</span>
          </button>
        ))
      )}
      {t.gaps.length > 0 && (
        <div className="rv-gaps" role="status">
          <AlertTriangle size={13} aria-hidden />
          <span>Ohne Buchung:</span>
          {t.gaps.map((g) => (
            <button key={g.start} type="button" className="gap-chip" onClick={() => onOpen()}>
              {time(g.start)}–{time(g.end)} <span className="faint">({hm(g.minutes)})</span>
            </button>
          ))}
        </div>
      )}
      <button type="button" className="rv-foot-link" onClick={(e) => onOpen(e.ctrlKey || e.metaKey)}>
        {t.missing_minutes > 0 ? `${hours(t.missing_minutes)} fehlen · in der Zeiterfassung buchen` : "In der Zeiterfassung öffnen"}
      </button>
    </Section>
  );
}

function PageRow({ p, onOpen }: { p: ReviewPage; onOpen: (newTab: boolean) => void }) {
  const bits = [p.minutes > 0 ? `~${p.minutes} min` : "", p.word_delta ? `${p.word_delta > 0 ? "+" : "−"}${Math.abs(p.word_delta).toLocaleString("de-DE")} Wörter` : "", p.edits > 0 ? plural(p.edits, "Änderung", "Änderungen") : ""].filter(Boolean);
  return (
    <button type="button" className={`rv-row rv-page ${p.gone ? "gone" : ""}`} onClick={(e) => onOpen(e.ctrlKey || e.metaKey)}>
      <span className="rv-when num">{time(p.last_at)}</span>
      <span className="rv-main">
        <span className="rv-title">
          <PageIcon name={p.icon ?? undefined} size={14} />
          <span className="ellipsis">{p.title}</span>
          {p.created && <Badge tone="accent">neu</Badge>}
          {p.daily && <Badge>Tagesnotiz</Badge>}
        </span>
        <span className="rv-sub">{bits.join(" · ")}</span>
      </span>
    </button>
  );
}

function TasksCard({ r, onOpen }: { r: DayReview; onOpen: (t: ReviewTask, newTab: boolean) => void }) {
  const k = r.tasks;
  const fresh = k.added.filter((x) => !x.done);
  const groups: { id: string; label: string; items: ReviewTask[]; total: number; tone?: Tone }[] = [
    { id: "done", label: "Erledigt", items: k.done, total: k.done_total },
    { id: "added", label: "Neu", items: fresh, total: fresh.length },
    { id: "due", label: "Heute fällig", items: k.due, total: k.due_total, tone: "warning" },
    { id: "overdue", label: "Überfällig", items: k.overdue, total: k.overdue_total, tone: "danger" },
  ];
  const count = k.done_total + fresh.length + k.due_total + k.overdue_total;
  return (
    <Section icon={CheckSquare} tone="tasks" title="Aufgaben" count={count} empty="Keine Aufgaben erledigt oder fällig." className="rv-tasks">
      {groups
        .filter((g) => g.items.length)
        .map((g) => (
          <div key={g.id} className={`rv-group rv-group-${g.id}`}>
            <div className="rv-group-head">
              <span>{g.label}</span>
              <span className="num faint">{g.total}</span>
            </div>
            {g.items.map((t, i) => (
              <button key={`${t.page_id}-${t.text}-${i}`} type="button" className={`rv-row rv-task ${g.id === "done" ? "done" : ""}`} onClick={(e) => onOpen(t, e.ctrlKey || e.metaKey)}>
                <span className="rv-check" aria-hidden>
                  {g.id === "done" ? <Check size={11} strokeWidth={3} /> : null}
                </span>
                <span className="rv-main">
                  <span className="rv-title ellipsis">{t.text}</span>
                  <span className="rv-sub ellipsis">{t.page_title}</span>
                </span>
                {t.due && g.tone && <Badge tone={g.tone}>{g.id === "due" ? "heute" : new Date(`${t.due}T12:00:00`).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" })}</Badge>}
              </button>
            ))}
          </div>
        ))}
    </Section>
  );
}
