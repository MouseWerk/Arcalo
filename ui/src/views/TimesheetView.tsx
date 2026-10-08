// Weekly timesheet with timer, week grid, entry list, editing and export.

import { useEffect, useMemo, useRef, useState } from "react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  AlertTriangle, CalendarDays, Check, CloudUpload, Printer, ChevronLeft, ChevronRight, Clipboard, Download, MoreHorizontal, Pause, Pencil, Play, Plus, RotateCcw, Send, Square, Target, Timer, Trash2, WandSparkles, X,
} from "lucide-react";
import { api, on } from "../lib/api";
import { bookingPrefill, durationMinutes, sourceColor, nonBookingSources, timeRange, unbooked } from "../lib/agenda";
import { useApp } from "../store/app";
import { Badge, Button, Dialog, EmptyState, Field, IconButton, Input, Segmented, Switch, useMenu, type Tone } from "../components/ui";
import { DateInput, TimeInput } from "../components/DateInput";
import { addDays, clock, dateLocale, dayMonthName, dayOfMonth, decimalSep, fmtMinutes, isoDay, isoWeek, isoWeekday, parseDurationInput, time, weekStart, weekdayShort } from "../lib/format";
import { exportFileName } from "../lib/prefs";
import { useTimerSeconds, stopTimer, toggleTimerPause } from "../components/Sidebar";
import { LeistungsartSelect, NetzplanSelect, VorgangSelect, useWbs } from "./wbs";
import { catsDecimalSep, catsGrid, dayTargets, undeletableReason, weekGaps } from "../lib/cats";
import { workApi, type Absence, type Holiday } from "../lib/workwidgets";
import type { CalendarEvent, ExportFormat, ExportResult, ProjectTree, StatusFlag, TimeEntryRow, WbsHint } from "../lib/types";
import { modLabel } from "../lib/shortcut";
import { withHint } from "../lib/keymap";
import { openFocusDialog } from "../components/Focus";
import { WeekProposalButton, WeekProposalDialog } from "./WeekProposal";
import { OPEN_EVENT, takeWeekProposalRequest } from "../lib/weekplan";
import { TIMESHEET_DAY_EVENT, takeTimesheetDay } from "../lib/reviewnav";
import { currentLang, useT, type TKey } from "../lib/i18n";
import { jiraApi, worklogDeleteKeys, worklogShown, type EntryIssue } from "../lib/jira";
import { defaultLeistungsart } from "../lib/timetracking";
import { startedOn } from "../onboarding/firststeps";

const STATUS: Record<StatusFlag, { label: TKey; tone: Tone }> = {
  running: { label: "time.status.running", tone: "info" },
  draft: { label: "time.status.draft", tone: "neutral" },
  released: { label: "time.status.released", tone: "accent" },
  exported: { label: "time.status.exported", tone: "success" },
};

export function TimesheetView() {
  const t = useT();
  const version = useApp((s) => s.entriesVersion);
  const [week, setWeek] = useState(() => weekStart(new Date()));
  const [rows, setRows] = useState<TimeEntryRow[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [editing, setEditing] = useState<TimeEntryRow | "new" | null>(null);
  const [exporting, setExporting] = useState(false);
  const [proposing, setProposing] = useState(false);
  const { wbs, las } = useWbs();
  const s = useApp.getState;
  // „Woche vorschlagen“ from the palette, the reminder or elsewhere: opened here.
  useEffect(() => {
    const take = () => {
      if (takeWeekProposalRequest()) {
        setWeek(weekStart(new Date()));
        setProposing(true);
      }
    };
    take();
    window.addEventListener(OPEN_EVENT, take);
    return () => window.removeEventListener(OPEN_EVENT, take);
  }, []);
  // A day from the Tagesrückblick: its week.
  useEffect(() => {
    const take = () => {
      const d = takeTimesheetDay();
      if (d) setWeek(weekStart(new Date(`${d}T12:00:00`)));
    };
    take();
    window.addEventListener(TIMESHEET_DAY_EVENT, take);
    return () => window.removeEventListener(TIMESHEET_DAY_EVENT, take);
  }, []);

  // Only the latest request may update the list (fast week switching).
  const seq = useRef(0);
  const load = () => {
    const n = ++seq.current;
    api
      .entries(week.toISOString(), addDays(week, 7).toISOString())
      .then((r) => n === seq.current && setRows(r))
      .catch((e) => s().error(t("time.loadFailed"), e));
  };
  useEffect(() => {
    load();
    setSelected(new Set());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [week, version]);
  const issues = useEntryIssues(rows);

  const done = rows.filter((r) => r.status_flag !== "running");
  const total = done.reduce((a, r) => a + (r.duration_minutes ?? 0), 0);
  const byStatus = (st: StatusFlag) => done.filter((r) => r.status_flag === st).reduce((a, r) => a + (r.duration_minutes ?? 0), 0);
  const todayKey = isoDay(new Date());
  const settings = useApp((st) => st.settings?.settings);
  const workdays = settings?.workdays ?? [1, 2, 3, 4, 5];
  const { targets, off } = useWeekTargets(week);
  const end = addDays(week, 6);
  const range = `${dayMonthName(week)} – ${dayMonthName(end, true)}`;

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      s().toast({ tone: "success", title: ok });
      setSelected(new Set());
      s().bumpEntries();
    } catch (e) {
      s().error(t("common.actionFailed"), e);
    }
  };

  return (
    <div className="view-scroll">
      <div className="view">
        <header className="view-header">
          <div>
            <h1>{t("ribbon.timesheet")}</h1>
            <div className="view-sub">
              {t("time.weekNo", { n: isoWeek(week) })} · {range}
            </div>
          </div>
          <div className="view-actions ts-actions">
            <div className="week-nav">
              <IconButton icon={ChevronLeft} label={t("time.prevWeek")} onClick={() => setWeek(addDays(week, -7))} />
              <Button size="sm" variant="ghost" onClick={() => setWeek(weekStart(new Date()))}>
                {t("time.thisWeek")}
              </Button>
              <IconButton icon={ChevronRight} label={t("time.nextWeek")} onClick={() => setWeek(addDays(week, 7))} />
            </div>
            <IconButton icon={Printer} label={t("time.print")} onClick={() => window.print()} />
            <Button icon={Download} onClick={() => setExporting(true)}>
              {t("time.export")}
            </Button>
            <WeekProposalButton onClick={() => setProposing(true)} />
            <Button icon={Plus} variant="primary" onClick={() => setEditing("new")}>
              {t("time.entry")}
            </Button>
          </div>
        </header>

        <TimerCard wbs={wbs} las={las} />

        <div className="stat-row">
          <Stat label={t("time.weekTotal")} value={`${fmtMinutes(total)} h`} sub={t("time.targetHours", { h: fmtMinutes(targets.reduce((a, b) => a + b, 0)) })} />
          <Stat label={t("time.status.draft")} value={`${fmtMinutes(byStatus("draft"))} h`} />
          {/* Colored only when there is something: a green „0,00 h“ reads like a result. */}
          <Stat label={t("time.status.released")} value={`${fmtMinutes(byStatus("released"))} h`} tone={byStatus("released") ? "accent" : undefined} />
          <Stat label={t("time.status.exported")} value={`${fmtMinutes(byStatus("exported"))} h`} tone={byStatus("exported") ? "success" : undefined} />
        </div>

        <WeekGrid rows={done} week={week} todayKey={todayKey} targets={targets} off={off} workdays={workdays} onPropose={() => setProposing(true)} />

        <MeetingSuggestions week={week} rows={rows} wbs={wbs} las={las} onPropose={() => setProposing(true)} />

        <section className="card">
          <div className="card-head">
            <h2>{t("time.entries")}</h2>
            {selected.size > 0 ? (
              <div className="bulk">
                <span className="faint">{t("common.selected", { n: selected.size })}</span>
                <Button size="sm" icon={Send} onClick={() => act(() => api.setStatus([...selected], "released"), t("time.released"))}>
                  {t("time.release")}
                </Button>
                <Button size="sm" icon={RotateCcw} variant="ghost" onClick={() => act(() => api.setStatus([...selected], "draft"), t("time.backToDraft"))}>
                  {t("time.status.draft")}
                </Button>
                <Button
                  size="sm"
                  icon={Trash2}
                  variant="danger"
                  onClick={async () => {
                    // Exported and running entries stay (the core refuses to delete them).
                    const kept = rows.filter((r) => selected.has(r.id) && undeletableReason(r.status_flag));
                    const ids = [...selected].filter((id) => !kept.some((r) => r.id === id));
                    if (!ids.length) {
                      s().toast({ tone: "warning", title: t("time.notDeletable"), detail: t("time.notDeletableText") });
                      return;
                    }
                    const note = kept.length ? ` ${t("time.keptOnDelete", { n: kept.length })}` : "";
                    const keys = worklogDeleteKeys(ids.map((id) => issues.get(id)).filter((e): e is EntryIssue => !!e));
                    const jira = keys.length ? ` ${t("time.deleteJira", { keys: keys.join(", ") })}` : "";
                    if (!(await s().confirm({ title: t("time.deleteEntriesAsk"), message: t("time.deleteEntriesText", { n: ids.length }) + jira + note, confirmLabel: t("common.delete"), danger: true }))) return;
                    act(() => Promise.all(ids.map((id) => api.deleteEntry(id))), t("time.entriesDeleted"));
                  }}
                >
                  {t("common.delete")}
                </Button>
                <IconButton icon={X} label={t("common.clearSelection")} onClick={() => setSelected(new Set())} />
              </div>
            ) : (
              <span className="faint small">{t("time.releasedExport")}</span>
            )}
          </div>
          {rows.length === 0 ? (
            <EmptyState icon={Timer} title={t("time.emptyWeek")} action={<Button icon={Plus} onClick={() => setEditing("new")}>{t("time.addEntry")}</Button>}>
              {t("time.emptyHint")} <span className="mono">{t("time.emptyExample")}</span> {t("time.emptyHintEnd")}
            </EmptyState>
          ) : (
            <EntryList rows={rows} issues={issues} selected={selected} setSelected={setSelected} onEdit={setEditing} week={week} />
          )}
        </section>
      </div>
      {editing && <EntryDialog entry={editing === "new" ? null : editing} wbs={wbs} las={las} onClose={() => setEditing(null)} defaultDay={week} note={editing !== "new" && <WorklogEditNote issue={issues.get(editing.id)} />} />}
      {exporting && <ExportDialog week={week} onClose={() => setExporting(false)} />}
      {proposing && <WeekProposalDialog week={week} entries={rows} wbs={wbs} onClose={() => setProposing(false)} />}
    </div>
  );
}

function Stat({ label, value, tone, sub }: { label: string; value: string; tone?: Tone; sub?: string }) {
  return (
    <div className={`stat ${tone ? `stat-${tone}` : ""}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value num">{value}</div>
      {sub && <div className="stat-note">{sub}</div>}
    </div>
  );
}

// ------------------------------------------------------------------ timer

function TimerCard({ wbs, las }: { wbs: ProjectTree[]; las: [string, string][] }) {
  const t = useT();
  const timer = useApp((s) => s.timer);
  const seconds = useTimerSeconds();
  const [np, setNp] = useState<number | null>(() => {
    const v = localStorage.getItem("annalo.timer.np");
    return v ? +v : null;
  });
  const [vorgang, setVorgang] = useState(() => localStorage.getItem("annalo.timer.vorgang") ?? "");
  const [la, setLa] = useState(() => localStorage.getItem("annalo.timer.la") ?? "DEV");
  const [desc, setDesc] = useState("");
  const [quick, setQuick] = useState("");
  const booking = useRef(false);
  const s = useApp.getState;
  const all = wbs.flatMap((p) => p.netzplaene);
  const defaults = useApp((st) => st.settings?.settings.time?.default_leistungsart);
  // Another Netzplan: its default Leistungsart, when one is set (Settings → Zeiterfassung).
  const chooseNp = (v: number) => {
    setNp(v);
    setVorgang("");
    const nr = all.find((x) => x.id === v)?.netzplan_nr;
    if (nr && Object.keys(defaults ?? {}).some((k) => k.toLowerCase() === nr.toLowerCase())) setLa(defaultLeistungsart(defaults, nr, las));
  };
  useEffect(() => {
    // None yet, or the remembered one was deleted: the first Netzplan.
    if (all.length && (np == null || !all.some((x) => x.id === np))) setNp(all[0].id);
  }, [all, np]);

  const start = async () => {
    if (np == null) return;
    try {
      localStorage.setItem("annalo.timer.np", String(np));
      localStorage.setItem("annalo.timer.vorgang", vorgang);
      localStorage.setItem("annalo.timer.la", la);
      await api.timerStart(np, vorgang || null, la || null, desc);
      setDesc("");
      s().bumpEntries();
    } catch (e) {
      s().error(t("time.timerStartFailed"), e);
    }
  };
  const book = async () => {
    // Enter twice while the booking is on its way books once.
    if (booking.current) return;
    booking.current = true;
    const line = /^\/(zeit|time)\b/i.test(quick.trim()) ? quick.trim() : `/zeit ${quick.trim()}`;
    try {
      const out = await api.logTime(line);
      s().toast({ tone: "success", title: t("time.booked", { h: fmtMinutes(out.entry.duration_minutes) }), detail: out.entry.description || undefined });
      s().alerts(out.alerts);
      setQuick("");
      s().bumpEntries();
    } catch (e) {
      s().error(t("time.bookFailed"), e);
    } finally {
      booking.current = false;
    }
  };

  if (timer) {
    const e = timer.entry;
    const n = all.find((x) => x.id === e.netzplan_id);
    const paused = !!timer.paused_since;
    return (
      <section className={`card timer-card running${paused ? " paused" : ""}`}>
        <div className="timer-live">
          <span className={paused ? "pause-dot big" : "rec-dot big"} aria-hidden />
          <div>
            <div className="timer-clock num">{clock(seconds)}</div>
            <div className="timer-what">
              <span className="mono">
                {n?.netzplan_nr}
                {e.vorgang_nr ? `/${e.vorgang_nr}` : ""}
              </span>
              {e.leistungsart && <Badge>{e.leistungsart}</Badge>}
              <span>{e.description || <span className="faint">{t("time.noDescription")}</span>}</span>
              {paused && <Badge>{t("timer.paused")}</Badge>}
              {timer.idle_minutes > 0 && <Badge tone="warning">{t("time.idleMinutes", { n: timer.idle_minutes })}</Badge>}
            </div>
          </div>
        </div>
        <div className="timer-actions">
          <Button
            variant="ghost"
            onClick={async () => {
              if (!(await s().confirm({ title: t("time.discardTimerAsk"), message: t("time.discardTimerText"), confirmLabel: t("common.discard"), danger: true }))) return;
              try {
                await api.timerDiscard();
                s().bumpEntries();
              } catch (e) {
                s().error(t("time.discardTimerFailed"), e);
              }
            }}
          >
            {t("common.discard")}
          </Button>
          <Button icon={paused ? Play : Pause} onClick={() => void toggleTimerPause()} title={withHint(paused ? t("timer.resume") : t("timer.pause"), "timer_pause")}>
            {paused ? t("timer.resume") : t("timer.pause")}
          </Button>
          <Button variant="primary" icon={Square} onClick={() => stopTimer()}>
            {t("time.stop")}
          </Button>
        </div>
      </section>
    );
  }

  return (
    <section className="card timer-card">
      <div className="timer-form">
        <NetzplanSelect wbs={wbs} value={np} onChange={chooseNp} />
        <VorgangSelect wbs={wbs} netzplanId={np} value={vorgang} onChange={setVorgang} />
        <LeistungsartSelect las={las} value={la} onChange={setLa} />
        <Input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder={t("time.workingOn")} onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && start()} aria-label={t("time.description")} />
        <span className="timer-start">
          <Button variant="primary" icon={Play} onClick={start} disabled={np == null}>
            {t("time.start")}
          </Button>
          <IconButton
            icon={Target}
            label={t("time.focusOnActivity")}
            onClick={() => {
              const n = all.find((x) => x.id === np);
              openFocusDialog({ reference: n ? `${n.netzplan_nr}${vorgang ? `/${vorgang}` : ""}` : "", goal: desc });
            }}
          />
        </span>
      </div>
      <div className="quick-book">
        <span className="faint small">{t("time.quickBook")}</span>
        <Input
          className="mono"
          value={quick}
          onChange={(e) => setQuick(e.target.value)}
          placeholder={t("time.quickBookPlaceholder")}
          onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && quick.trim() && book()}
          aria-label={t("time.quickBook")}
        />
      </div>
    </section>
  );
}

// -------------------------------------------------------------- week grid

/**
 * Target minutes per day of the week (own weekday targets, holidays of the state, absences, as
 * the week proposal counts them) and the days off with their reason (holiday name, absence).
 */
function useWeekTargets(week: Date): { targets: number[]; off: Map<string, string> } {
  const t = useT();
  const settings = useApp((st) => st.settings?.settings);
  const [data, setData] = useState<{ absences: Absence[]; holidays: Holiday[] } | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const un = on("data://absences", () => setVersion((v) => v + 1));
    return () => void un.then((f) => f());
  }, []);
  const state = settings?.time?.balance?.state ?? "";
  useEffect(() => {
    let live = true;
    workApi
      .absences(isoDay(week), isoDay(addDays(week, 6)))
      .then((d) => live && setData(d))
      .catch(() => live && setData(null));
    return () => {
      live = false;
    };
  }, [week, version, state]);
  return useMemo(() => {
    const holidays = new Set(data?.holidays.map((h) => h.date));
    const targets = dayTargets(week, {
      daily: settings?.daily_target_hours ?? 8,
      workdays: settings?.workdays ?? [1, 2, 3, 4, 5],
      weekdayHours: settings?.time?.balance?.weekday_hours,
      holidays,
      absences: data?.absences,
    });
    const off = new Map<string, string>();
    for (const h of data?.holidays ?? []) off.set(h.date, currentLang() === "en" ? h.name_en : h.name);
    for (const a of data?.absences ?? []) {
      const kind = t(`work.abs.${a.kind}` as TKey);
      off.set(a.date, a.half ? `${kind} (${t("work.abs.half")})` : kind);
    }
    return { targets, off };
  }, [data, week, settings, t]);
}

function WeekGrid({ rows, week, todayKey, targets, off, workdays, onPropose }: { rows: TimeEntryRow[]; week: Date; todayKey: string; targets: number[]; off: Map<string, string>; workdays: number[]; onPropose: () => void }) {
  const t = useT();
  const weekend = (i: number) => !workdays.includes(isoWeekday(addDays(week, i)));
  const days = Array.from({ length: 7 }, (_, i) => addDays(week, i));
  const keys = days.map(isoDay);
  const lines = useMemo(() => {
    const map = new Map<string, { label: string; la: string | null; perDay: number[] }>();
    for (const r of rows) {
      const k = `${r.netzplan_nr}/${r.vorgang_nr ?? ""}/${r.leistungsart ?? ""}`;
      const line = map.get(k) ?? { label: `${r.netzplan_nr}${r.vorgang_nr ? "/" + r.vorgang_nr : ""}`, la: r.leistungsart, perDay: Array(7).fill(0) };
      const d = keys.indexOf(isoDay(new Date(r.start_time)));
      if (d >= 0) line.perDay[d] += r.duration_minutes ?? 0;
      map.set(k, line);
    }
    return [...map.values()].sort((a, b) => a.label.localeCompare(b.label));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, week]);
  // A new workspace: the days before its first start were not missed.
  const gaps = weekGaps(rows, week, new Date(), targets, startedOn());
  const gapKeys = new Set(gaps.map((g) => isoDay(g.day)));
  const s = useApp.getState;
  const copyCats = async () => {
    const { text, ids } = catsGrid(rows, week, catsDecimalSep(s().settings?.settings.time?.cats_decimal));
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      return s().error(t("devlog.copyFailed"), e);
    }
    const open = rows.filter((r) => ids.includes(r.id) && r.status_flag !== "exported").map((r) => r.id);
    s().toast({
      tone: "success",
      title: t("time.catsCopied"),
      detail: t("time.catsCopiedText", { mod: modLabel() }),
      action: open.length
        ? {
            label: t("time.markExported"),
            run: async () => {
              try {
                await api.setStatus(open, "exported");
                s().bumpEntries();
              } catch (e) {
                s().error(t("time.statusFailed"), e);
              }
            },
          }
        : undefined,
    });
  };
  if (!lines.length && !gaps.length) return null;
  const dayTotals = keys.map((_, i) => lines.reduce((a, l) => a + l.perDay[i], 0));
  const cell = (m: number) => (m ? fmtMinutes(m) : "");
  return (
    <section className="card">
      <div className="card-head">
        <h2>{t("time.weekOverview")}</h2>
        {lines.length > 0 && (
          <Button size="sm" variant="ghost" icon={Clipboard} onClick={copyCats}>
            {t("time.copyCats")}
          </Button>
        )}
      </div>
      {gaps.length > 0 && (
        <div className="week-gaps" role="status">
          <AlertTriangle size={14} />
          <span>{t("time.belowTarget")}</span>
          {gaps.map((g) => (
            <span key={isoDay(g.day)} className="gap-chip" title={t("time.bookedOf", { booked: fmtMinutes(g.bookedMinutes), target: fmtMinutes(g.bookedMinutes + g.missingMinutes) })}>
              {weekdayShort(g.day)} {dayOfMonth(g.day)} −{fmtMinutes(g.missingMinutes)} h
            </span>
          ))}
          <span className="grow" />
          <Button size="sm" variant="ghost" icon={WandSparkles} onClick={onPropose}>
            {t("time.fillGaps")}
          </Button>
        </div>
      )}
      <div className="table-wrap">
        <table className="table week-grid">
          <thead>
            <tr>
              <th>{t("time.col.wbs")}</th>
              <th>{t("time.col.la")}</th>
              {days.map((d, i) => (
                <th key={i} className={`num ${keys[i] === todayKey ? "today" : ""} ${weekend(i) || off.has(keys[i]) ? "weekend" : ""}`} data-tooltip={off.get(keys[i])}>
                  {weekdayShort(d)} <span className="faint">{dayOfMonth(d)}</span>
                  {off.has(keys[i]) && <span className="sr-only">, {off.get(keys[i])}</span>}
                </th>
              ))}
              <th className="num">{t("time.col.total")}</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.label + l.la}>
                <td className="mono">{l.label}</td>
                <td>{l.la && <Badge>{l.la}</Badge>}</td>
                {l.perDay.map((m, i) => (
                  <td key={i} className={`num ${keys[i] === todayKey ? "today" : ""} ${weekend(i) ? "weekend" : ""}`}>
                    {cell(m)}
                  </td>
                ))}
                <td className="num strong">{fmtMinutes(l.perDay.reduce((a, b) => a + b, 0))}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={2}>{t("time.col.total")}</td>
              {dayTotals.map((m, i) => (
                <td key={i} className={`num ${keys[i] === todayKey ? "today" : ""} ${weekend(i) ? "weekend" : ""} ${gapKeys.has(keys[i]) ? "gap" : ""}`}>
                  {cell(m)}
                </td>
              ))}
              <td className="num strong">{fmtMinutes(dayTotals.reduce((a, b) => a + b, 0))}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}

// ------------------------------------------------------------- Jira worklogs

/** The issue keys and Jira worklog states of the entries, kept current while worklogs go out. */
function useEntryIssues(rows: TimeEntryRow[]): Map<number, EntryIssue> {
  const [map, setMap] = useState<Map<number, EntryIssue>>(new Map());
  useEffect(() => {
    const ids = rows.map((r) => r.id);
    let alive = true;
    const load = () => {
      if (!ids.length) return setMap(new Map());
      jiraApi.entryIssues(ids).then((list) => alive && setMap(new Map(list.map((e) => [e.entry_id, e]))), () => {});
    };
    load();
    const off = on("jira://worklog", load);
    return () => {
      alive = false;
      void off.then((f) => f());
    };
  }, [rows]);
  return map;
}

const WORKLOG_LABEL: Record<"posted" | "pending" | "failed" | "none", TKey> = {
  posted: "time.wl.posted",
  pending: "time.wl.pending",
  failed: "time.wl.failed",
  none: "time.wl.none",
};

/** The issue key of an entry with the state of its Jira worklog; a failed one can be sent again. */
function WorklogChip({ issue }: { issue: EntryIssue }) {
  const t = useT();
  const shown = worklogShown(issue);
  const [busy, setBusy] = useState(false);
  const retry = async () => {
    setBusy(true);
    try {
      await jiraApi.retryWorklog(issue.entry_id);
    } catch (e) {
      useApp.getState().error(t("time.wl.failed"), e);
    } finally {
      setBusy(false);
    }
  };
  const title = t(WORKLOG_LABEL[shown]) + (shown === "failed" && issue.error ? `: ${issue.error}` : "");
  return (
    <span className={`entry-jira wl-${shown}`} data-key={issue.issue_key} data-state={shown} title={title}>
      <span className="entry-jira-dot" aria-hidden />
      <span className="mono">{issue.issue_key}</span>
      {shown !== "none" && <span className="entry-jira-state">{t(`time.wl.short.${shown}` as TKey)}</span>}
      {shown === "failed" && (
        <button type="button" className="entry-jira-retry" onClick={retry} disabled={busy} aria-label={t("time.wl.retry")} title={t("time.wl.retry")}>
          <RotateCcw size={11} aria-hidden />
        </button>
      )}
    </span>
  );
}

/** In the edit dialog: changes of duration, start or comment go to the posted worklog. */
function WorklogEditNote({ issue }: { issue: EntryIssue | undefined }) {
  const t = useT();
  if (!issue?.worklog_id || !issue.syncs) return null;
  return (
    <p className="entry-jira-note small faint">
      <CloudUpload size={13} aria-hidden /> {t("time.wl.editNote", { key: issue.issue_key })}
    </p>
  );
}

// ------------------------------------------------------------- entry list

function EntryList({ rows, issues, selected, setSelected, onEdit, week }: { rows: TimeEntryRow[]; issues: Map<number, EntryIssue>; selected: Set<number>; setSelected: (s: Set<number>) => void; onEdit: (r: TimeEntryRow) => void; week: Date }) {
  const t = useT();
  const [menu, , openMenuAt] = useMenu();
  const s = useApp.getState;
  // Entries booked by focus sessions carry a mark.
  const [focusIds, setFocusIds] = useState<Set<number>>(new Set());
  useEffect(() => {
    api.focusEntryIds().then((ids) => setFocusIds(new Set(ids)), () => {});
  }, [rows]);
  const groups = useMemo(() => {
    const g = new Map<string, TimeEntryRow[]>();
    for (const r of [...rows].sort((a, b) => b.start_time.localeCompare(a.start_time))) {
      const k = isoDay(new Date(r.start_time));
      g.set(k, [...(g.get(k) ?? []), r]);
    }
    return [...g.entries()];
  }, [rows]);
  void week;
  const setStatus = async (id: number, status: StatusFlag) => {
    try {
      await api.setStatus([id], status);
      s().bumpEntries();
    } catch (e) {
      s().error(t("time.statusFailed"), e);
    }
  };
  const toggle = (id: number) => {
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelected(next);
  };
  return (
    <div className="entry-list">
      {groups.map(([day, list]) => {
        const sum = list.reduce((a, r) => a + (r.duration_minutes ?? 0), 0);
        const selectable = list.filter((r) => r.status_flag !== "running" && r.status_flag !== "exported");
        const allSel = selectable.length > 0 && selectable.every((r) => selected.has(r.id));
        return (
          <div key={day} className="entry-day">
            <div className="entry-day-head">
              <input
                type="checkbox"
                className="check"
                checked={allSel}
                aria-label={t("time.selectDay")}
                onChange={() => {
                  const next = new Set(selected);
                  selectable.forEach((r) => (allSel ? next.delete(r.id) : next.add(r.id)));
                  setSelected(next);
                }}
              />
              <span className="entry-day-title">{new Date(day + "T12:00:00").toLocaleDateString(dateLocale(), { weekday: "long", day: "numeric", month: "long" })}</span>
              <span className="grow" />
              <span className="num strong">{fmtMinutes(sum)} h</span>
            </div>
            {list.map((r) => (
              <div key={r.id} className={`entry ${selected.has(r.id) ? "sel" : ""}`} onDoubleClick={() => r.status_flag !== "running" && r.status_flag !== "exported" && onEdit(r)}>
                <input type="checkbox" className="check" checked={selected.has(r.id)} disabled={r.status_flag === "running" || r.status_flag === "exported"} onChange={() => toggle(r.id)} aria-label={t("common.select")} title={r.status_flag === "exported" ? t("time.alreadyExported") : undefined} />
                <span className="entry-time num faint">
                  {time(r.start_time)}–{r.end_time ? time(r.end_time) : "…"}
                </span>
                <span className="entry-wbs mono">
                  {r.netzplan_nr}
                  {r.vorgang_nr ? `/${r.vorgang_nr}` : ""}
                </span>
                <span className="entry-la">{r.leistungsart && <Badge>{r.leistungsart}</Badge>}</span>
                <span className="entry-desc">
                  {r.description || <span className="faint">{t("time.noDescription")}</span>}
                  {focusIds.has(r.id) && (
                    <span className="entry-focus" title={t("time.fromFocus")}>
                      <Target size={11} aria-hidden /> {t("time.focus")}
                    </span>
                  )}
                  {issues.has(r.id) && <WorklogChip issue={issues.get(r.id)!} />}
                </span>
                <Badge tone={STATUS[r.status_flag].tone}>{t(STATUS[r.status_flag].label)}</Badge>
                <span className="entry-dur num">{r.duration_minutes != null ? `${fmtMinutes(r.duration_minutes)} h` : t("time.runningLower")}</span>
                <IconButton
                  icon={MoreHorizontal}
                  label={t("ribbon.actions")}
                  size="md"
                  disabled={r.status_flag === "running"}
                  onClick={(e) =>
                    openMenuAt(e, [
                      { label: t("links.editShort"), icon: Pencil, disabled: r.status_flag === "exported", onSelect: () => onEdit(r) },
                      r.status_flag === "released"
                        ? { label: t("time.backToDraft"), icon: RotateCcw, onSelect: () => setStatus(r.id, "draft") }
                        : { label: t("time.release"), icon: Check, disabled: r.status_flag === "exported", onSelect: () => setStatus(r.id, "released") },
                      {
                        label: t("time.startFocus"),
                        icon: Target,
                        onSelect: () => openFocusDialog({ reference: `${r.netzplan_nr}${r.vorgang_nr ? `/${r.vorgang_nr}` : ""}`, goal: r.description }),
                      },
                      ...(issues.get(r.id) && worklogShown(issues.get(r.id)!) === "failed"
                        ? [{ label: t("time.wl.retry"), icon: CloudUpload, onSelect: () => void jiraApi.retryWorklog(r.id).catch((e) => s().error(t("time.wl.failed"), e)) }]
                        : []),
                      "separator",
                      {
                        label: undeletableReason(r.status_flag) ? t("time.cannotDelete", { reason: undeletableReason(r.status_flag)! }) : t("common.delete"),
                        icon: Trash2,
                        danger: true,
                        disabled: undeletableReason(r.status_flag) != null,
                        onSelect: async () => {
                          const keys = worklogDeleteKeys(issues.has(r.id) ? [issues.get(r.id)!] : []);
                          const jira = keys.length ? ` ${t("time.deleteJira", { keys: keys.join(", ") })}` : "";
                          if (!(await s().confirm({ title: t("time.deleteEntryAsk"), message: t("time.deleteEntryText", { what: r.description || r.netzplan_nr, h: fmtMinutes(r.duration_minutes) }) + jira, confirmLabel: t("common.delete"), danger: true }))) return;
                          try {
                            await api.deleteEntry(r.id);
                            s().bumpEntries();
                          } catch (e) {
                            s().error(t("common.deleteFailed"), e);
                          }
                        },
                      },
                    ])
                  }
                />
              </div>
            ))}
          </div>
        );
      })}
      {menu}
    </div>
  );
}

// ----------------------------------------------------------- entry dialog

/** Values for a new entry (e.g. booked from a calendar appointment). */
export interface EntryPrefill {
  /** YYYY-MM-DD, HH:MM. */
  day: string;
  from: string;
  minutes: number;
  description: string;
  netzplanId?: number | null;
  vorgangNr?: string | null;
  leistungsart?: string | null;
}

export function EntryDialog({ entry, wbs, las, onClose, defaultDay, prefill, onSaved, note }: { entry: TimeEntryRow | null; wbs: ProjectTree[]; las: [string, string][]; onClose: () => void; defaultDay: Date; prefill?: EntryPrefill; onSaved?: (entryId: number) => void; note?: React.ReactNode }) {
  const t = useT();
  const start = entry ? new Date(entry.start_time) : prefill ? new Date(`${prefill.day}T${prefill.from}:00`) : (() => {
    const d = isoDay(new Date()) >= isoDay(defaultDay) && isoDay(new Date()) <= isoDay(addDays(defaultDay, 6)) ? new Date() : new Date(defaultDay);
    d.setHours(9, 0, 0, 0);
    return d;
  })();
  const knownNp = (id: number | null | undefined) => (id != null && wbs.some((p) => p.netzplaene.some((n) => n.id === id)) ? id : null);
  const [np, setNp] = useState<number | null>(entry?.netzplan_id ?? knownNp(prefill?.netzplanId) ?? wbs[0]?.netzplaene[0]?.id ?? null);
  const [vorgang, setVorgang] = useState(entry?.vorgang_nr ?? (knownNp(prefill?.netzplanId) != null ? (prefill?.vorgangNr ?? "") : ""));
  const defaults = useApp((st) => st.settings?.settings.time?.default_leistungsart);
  const npNr = (id: number | null) => wbs.flatMap((p) => p.netzplaene).find((n) => n.id === id)?.netzplan_nr;
  // A new entry starts with the Netzplan's default Leistungsart (Settings → Zeiterfassung) and
  // follows it when the Netzplan changes, until a Leistungsart is chosen.
  const laChosen = useRef(!!(entry || prefill?.leistungsart));
  const [la, setLaState] = useState(entry?.leistungsart ?? prefill?.leistungsart ?? defaultLeistungsart(defaults, npNr(np), las));
  const setLa = (v: string) => {
    laChosen.current = true;
    setLaState(v);
  };
  const [day, setDay] = useState(isoDay(start));
  const [from, setFrom] = useState(`${String(start.getHours()).padStart(2, "0")}:${String(start.getMinutes()).padStart(2, "0")}`);
  const [dur, setDur] = useState(entry?.duration_minutes != null ? fmtMinutes(entry.duration_minutes) : prefill ? fmtMinutes(prefill.minutes) : fmtMinutes(60));
  const [desc, setDesc] = useState(entry?.description ?? prefill?.description ?? "");
  const [busy, setBusy] = useState(false);
  // Enter and a click right after each other must not book twice.
  const submitting = useRef(false);
  const s = useApp.getState;
  const minutes = parseDurationInput(dur);

  const submit = async () => {
    if (np == null || minutes == null || minutes <= 0 || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    try {
      const startTime = new Date(`${day}T${from}:00`).toISOString();
      if (entry) {
        await api.updateEntry({ id: entry.id, vorgangNr: vorgang || null, leistungsart: la || null, startTime, durationMinutes: minutes, description: desc });
      } else {
        const out = await api.createEntry({ netzplanId: np, vorgangNr: vorgang || null, leistungsart: la || null, startTime, durationMinutes: minutes, description: desc });
        s().alerts(out.alerts);
        onSaved?.(out.entry.id);
      }
      s().bumpEntries();
      s().toast({ tone: "success", title: entry ? t("time.entrySaved") : t("time.booked", { h: fmtMinutes(minutes) }) });
      onClose();
    } catch (e) {
      s().error(t("common.saveFailed"), e);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };
  // Enter submits, except while an input method composes a word.
  const onEnter = (e: { key: string; nativeEvent: { isComposing: boolean } }) => {
    if (e.key === "Enter" && !e.nativeEvent.isComposing) submit();
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={entry ? t("time.editEntry") : t("time.logTime")}
      width={520}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" onClick={submit} loading={busy} disabled={np == null || minutes == null || minutes <= 0}>
            {entry ? t("common.save") : t("time.book")}
          </Button>
        </>
      }
    >
      {note}
      <div className="form-grid">
        <Field label={t("wbs.netzplan")}>
          <NetzplanSelect
            wbs={wbs}
            value={np}
            onChange={(v) => {
              setNp(v);
              setVorgang("");
              if (!laChosen.current) setLaState(defaultLeistungsart(defaults, npNr(v), las));
            }}
            disabled={!!entry}
          />
        </Field>
        <Field label={t("wbs.vorgang")}>
          <VorgangSelect wbs={wbs} netzplanId={np} value={vorgang} onChange={setVorgang} />
        </Field>
        <Field label={t("time.date")}>
          <DateInput value={day} onChange={setDay} aria-label={t("time.date")} />
        </Field>
        <Field label={t("time.startTime")}>
          <TimeInput value={from} onChange={setFrom} aria-label={t("time.startTime")} />
        </Field>
        <Field label={t("time.duration")} hint={minutes == null ? t("time.durationHint", { a: `1${decimalSep()}5` }) : `${fmtMinutes(minutes)} h`}>
          <Input value={dur} onChange={(e) => setDur(e.target.value)} onKeyDown={onEnter} />
        </Field>
        <Field label={t("wbs.leistungsart")}>
          <LeistungsartSelect las={las} value={la} onChange={setLa} />
        </Field>
      </div>
      <Field label={t("time.description")}>
        <Input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder={t("time.whatDone")} onKeyDown={onEnter} />
      </Field>
    </Dialog>
  );
}

// ----------------------------------------------------------------- meetings

/**
 * „Termine übernehmen“: meetings of the week from the calendar sync that are over and not booked
 * yet; each can be booked (prefilled like in the Kalender) or marked „nicht buchen“.
 */
function MeetingSuggestions({ week, rows, wbs, las, onPropose }: { week: Date; rows: TimeEntryRow[]; wbs: ProjectTree[]; las: [string, string][]; onPropose: () => void }) {
  const t = useT();
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [booking, setBooking] = useState<{ event: CalendarEvent; prefill: EntryPrefill; hint: WbsHint | null } | null>(null);
  const [tick, setTick] = useState(0);
  const [open, setOpen] = useState(false);
  const target = useApp((st) => st.settings?.settings.daily_target_hours ?? 8);
  const s = useApp.getState;
  useEffect(() => {
    let alive = true;
    api
      .calendarEvents(week.toISOString(), addDays(week, 7).toISOString())
      .then((e) => alive && setEvents(e))
      .catch(() => alive && setEvents([]));
    const off = on("calendar://synced", () => setTick((x) => x + 1));
    return () => {
      alive = false;
      off.then((f) => f());
    };
  }, [week, tick]);
  const cal = useApp((st) => st.settings?.settings.calendar);
  const list = useMemo(() => unbooked(events, rows, new Date(), nonBookingSources(cal)), [events, rows, cal]);
  if (!list.length) return null;
  const shown = open ? list : list.slice(0, 4);
  const book = async (e: CalendarEvent) => {
    if (!wbs.some((p) => p.netzplaene.length)) return s().toast({ tone: "warning", title: t("time.noNetzplan"), detail: t("time.noNetzplanText") });
    const hint = await api.calendarWbsHint(e.key).catch(() => null);
    setBooking({ event: e, hint, prefill: bookingPrefill(e, hint, target) });
  };
  const skip = async (e: CalendarEvent) => {
    try {
      await api.calendarSetSkip(e.key, true);
      setTick((x) => x + 1);
    } catch (err) {
      s().error(t("common.notSaved"), err);
    }
  };
  return (
    <section className="card ts-meetings" aria-label={t("time.meetings")}>
      <div className="card-head">
        <h2>{t("time.meetings")}</h2>
        <span className="faint grow">{t("time.meetingsOpen", { n: list.length })}</span>
        <Button size="sm" icon={WandSparkles} onClick={onPropose} title={t("time.meetingsAllTitle")}>
          {t("time.meetingsAll")}
        </Button>
      </div>
      <ul className="ts-meeting-list">
        {shown.map((e) => (
          <li key={e.key} className="ts-meeting" style={{ "--ev": sourceColor(e.source, useApp.getState().settings?.settings.calendar) } as React.CSSProperties}>
            <span className="ts-meeting-bar" aria-hidden />
            <span className="ts-meeting-when num">
              {weekdayShort(new Date(e.start))} {timeRange(e)}
            </span>
            <span className="ts-meeting-title ellipsis" title={e.title}>
              {e.title}
            </span>
            <span className="faint num">{fmtMinutes(durationMinutes(e))} h</span>
            <Button size="sm" icon={Timer} onClick={() => void book(e)}>
              {t("time.book")}
            </Button>
            <IconButton icon={X} size="sm" label={t("time.dontBook", { title: e.title })} onClick={() => void skip(e)} />
          </li>
        ))}
      </ul>
      {list.length > 4 && (
        <Button size="sm" variant="ghost" onClick={() => setOpen(!open)}>
          {open ? t("common.showLess") : t("common.showAll", { n: list.length })}
        </Button>
      )}
      {booking && (
        <EntryDialog
          entry={null}
          wbs={wbs}
          las={las}
          defaultDay={week}
          prefill={booking.prefill}
          note={
            <div className="calv-book-note">
              <CalendarDays size={14} aria-hidden />
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
          onSaved={(id) => void api.calendarLinkEntry(booking.event.key, id).catch((err) => s().error(t("time.linkFailed"), err))}
        />
      )}
    </section>
  );
}

// ----------------------------------------------------------------- export

const FORMATS: { value: ExportFormat; label: string; ext: string }[] = [
  { value: "sap_cats", label: "SAP CATS", ext: "csv" },
  { value: "jira_worklog", label: "Jira", ext: "json" },
  { value: "csv", label: "CSV", ext: "csv" },
  { value: "json", label: "JSON", ext: "json" },
];

function ExportDialog({ week, onClose }: { week: Date; onClose: () => void }) {
  const t = useT();
  const [format, setFormat] = useState<ExportFormat>("sap_cats");
  const [from, setFrom] = useState(isoDay(week));
  const [to, setTo] = useState(isoDay(addDays(week, 6)));
  const [onlyReleased, setOnlyReleased] = useState(true);
  const [mark, setMark] = useState(true);
  const [preview, setPreview] = useState<ExportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const s = useApp.getState;
  const range = () => ({ from: new Date(`${from}T00:00:00`).toISOString(), to: addDays(new Date(`${to}T00:00:00`), 1).toISOString() });

  useEffect(() => {
    api
      .exportEntries({ format, ...range(), onlyReleased, markExported: false, path: null })
      .then(setPreview)
      .catch(() => setPreview(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [format, from, to, onlyReleased]);

  const doExport = async (target: "file" | "clipboard") => {
    setBusy(true);
    try {
      let path: string | null = null;
      if (target === "file") {
        const f = FORMATS.find((x) => x.value === format)!;
        const st = useApp.getState().settings?.settings;
        const name = exportFileName(st?.time?.export_file_pattern ?? "", { from, to, format, week: isoWeek(new Date(`${from}T00:00:00`)), pernr: st?.pernr });
        path = await saveDialog({ defaultPath: `${name}.${f.ext}`, filters: [{ name: f.label, extensions: [f.ext] }] });
        if (!path) return;
      }
      // Clipboard: copy first, mark only once the copy succeeded.
      const res = await api.exportEntries({ format, ...range(), onlyReleased, markExported: mark && target === "file", path });
      if (target === "clipboard") {
        await navigator.clipboard.writeText(res.content);
        if (mark && res.exported_ids.length) await api.setStatus(res.exported_ids, "exported");
      }
      s().toast({
        tone: "success",
        title: target === "file" ? t("time.exportSaved") : t("time.exportCopied"),
        detail: mark ? t("time.exportedMarked", { n: res.exported_ids.length }) : t("time.entriesCount", { n: res.exported_ids.length }),
      });
      if (mark) s().bumpEntries();
      onClose();
    } catch (e) {
      s().error(t("time.exportFailed"), e);
    } finally {
      setBusy(false);
    }
  };

  const count = preview?.exported_ids.length ?? 0;
  return (
    <Dialog
      open
      onClose={onClose}
      title={t("time.exportTitle")}
      description={t("time.exportDesc")}
      width={680}
      footer={
        <>
          <span className="faint small grow">
            {t("time.entriesCount", { n: count })}
            {preview?.skipped.length ? `, ${t("time.skipped", { n: preview.skipped.length })}` : ""}
          </span>
          <Button icon={Clipboard} onClick={() => doExport("clipboard")} disabled={!count} loading={busy}>
            {t("common.copy")}
          </Button>
          <Button variant="primary" icon={Download} onClick={() => doExport("file")} disabled={!count} loading={busy}>
            {t("common.saveAs")}
          </Button>
        </>
      }
    >
      <div className="export-opts">
        <Segmented value={format} options={FORMATS} onChange={setFormat} />
        <div className="row-gap">
          <CalendarDays size={14} className="faint" />
          <DateInput value={from} onChange={setFrom} aria-label={t("common.from")} className="w-date" />
          <span className="faint">{t("common.to")}</span>
          <DateInput value={to} onChange={setTo} aria-label={t("common.until")} className="w-date" />
        </div>
        <label className="row-gap small">
          <Switch checked={onlyReleased} onChange={setOnlyReleased} label={t("time.onlyReleasedShort")} /> {t("time.onlyReleased")}
        </label>
        <label className="row-gap small">
          <Switch checked={mark} onChange={setMark} label={t("time.markExported")} /> {t("time.markAfter")}
        </label>
      </div>
      {format === "jira_worklog" && preview && preview.skipped.length > 0 && (
        <p className="warn-note small">{t("time.jiraMissing")}</p>
      )}
      <pre className="export-preview">{preview ? preview.content || t("time.noEntriesRange") : "…"}</pre>
    </Dialog>
  );
}
