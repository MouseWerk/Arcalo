// Weekly timesheet with timer, week grid, entry list, editing and export.

import { useEffect, useMemo, useRef, useState } from "react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  AlertTriangle, CalendarDays, Check, Printer, ChevronLeft, ChevronRight, Clipboard, Download, MoreHorizontal, Pencil, Play, Plus, RotateCcw, Send, Square, Timer, Trash2, X,
} from "lucide-react";
import { api } from "../lib/api";
import { useApp } from "../store/app";
import { Badge, Button, Dialog, EmptyState, Field, IconButton, Input, Segmented, Switch, useMenu, type Tone } from "../components/ui";
import { addDays, clock, fmtHours, fmtMinutes, isoDay, isoWeek, isoWeekday, parseDurationInput, time, weekStart, weekdayShort } from "../lib/format";
import { exportFileName } from "../lib/prefs";
import { useTimerSeconds, stopTimer } from "../components/Sidebar";
import { LeistungsartSelect, NetzplanSelect, VorgangSelect, useWbs } from "./wbs";
import { catsGrid, weekGaps } from "../lib/cats";
import type { ExportFormat, ExportResult, ProjectTree, StatusFlag, TimeEntryRow } from "../lib/types";
import { modLabel } from "../lib/shortcut";

const STATUS: Record<StatusFlag, { label: string; tone: Tone }> = {
  running: { label: "Läuft", tone: "info" },
  draft: { label: "Entwurf", tone: "neutral" },
  released: { label: "Freigegeben", tone: "accent" },
  exported: { label: "Exportiert", tone: "success" },
};

export function TimesheetView() {
  const version = useApp((s) => s.entriesVersion);
  const [week, setWeek] = useState(() => weekStart(new Date()));
  const [rows, setRows] = useState<TimeEntryRow[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [editing, setEditing] = useState<TimeEntryRow | "new" | null>(null);
  const [exporting, setExporting] = useState(false);
  const { wbs, las } = useWbs();
  const s = useApp.getState;

  // Only the latest request may update the list (fast week switching).
  const seq = useRef(0);
  const load = () => {
    const n = ++seq.current;
    api
      .entries(week.toISOString(), addDays(week, 7).toISOString())
      .then((r) => n === seq.current && setRows(r))
      .catch((e) => s().error("Einträge nicht geladen", e));
  };
  useEffect(() => {
    load();
    setSelected(new Set());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [week, version]);

  const done = rows.filter((r) => r.status_flag !== "running");
  const total = done.reduce((a, r) => a + (r.duration_minutes ?? 0), 0);
  const byStatus = (st: StatusFlag) => done.filter((r) => r.status_flag === st).reduce((a, r) => a + (r.duration_minutes ?? 0), 0);
  const todayKey = isoDay(new Date());
  const settings = useApp((st) => st.settings?.settings);
  const target = settings?.daily_target_hours ?? 8;
  const workdays = settings?.workdays ?? [1, 2, 3, 4, 5];
  const end = addDays(week, 6);
  const range = `${week.toLocaleDateString("de-DE", { day: "numeric", month: "short" })} – ${end.toLocaleDateString("de-DE", { day: "numeric", month: "short", year: "numeric" })}`;

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      s().toast({ tone: "success", title: ok });
      setSelected(new Set());
      s().bumpEntries();
    } catch (e) {
      s().error("Aktion fehlgeschlagen", e);
    }
  };

  return (
    <div className="view-scroll">
      <div className="view">
        <header className="view-header">
          <div>
            <h1>Zeiterfassung</h1>
            <div className="view-sub">
              KW {isoWeek(week)} · {range}
            </div>
          </div>
          <div className="view-actions">
            <div className="week-nav">
              <IconButton icon={ChevronLeft} label="Vorherige Woche" onClick={() => setWeek(addDays(week, -7))} />
              <Button size="sm" variant="ghost" onClick={() => setWeek(weekStart(new Date()))}>
                Diese Woche
              </Button>
              <IconButton icon={ChevronRight} label="Nächste Woche" onClick={() => setWeek(addDays(week, 7))} />
            </div>
            <IconButton icon={Printer} label="Woche drucken / als PDF" onClick={() => window.print()} />
            <Button icon={Download} onClick={() => setExporting(true)}>
              Export
            </Button>
            <Button icon={Plus} variant="primary" onClick={() => setEditing("new")}>
              Eintrag
            </Button>
          </div>
        </header>

        <TimerCard wbs={wbs} las={las} />

        <div className="stat-row">
          <Stat label="Woche gesamt" value={`${fmtMinutes(total)} h`} sub={`Soll ${fmtHours(target * workdays.length)} h`} />
          <Stat label="Entwurf" value={`${fmtMinutes(byStatus("draft"))} h`} />
          <Stat label="Freigegeben" value={`${fmtMinutes(byStatus("released"))} h`} tone="accent" />
          <Stat label="Exportiert" value={`${fmtMinutes(byStatus("exported"))} h`} tone="success" />
        </div>

        <WeekGrid rows={done} week={week} todayKey={todayKey} target={target} workdays={workdays} />

        <section className="card">
          <div className="card-head">
            <h2>Einträge</h2>
            {selected.size > 0 ? (
              <div className="bulk">
                <span className="faint">{selected.size} ausgewählt</span>
                <Button size="sm" icon={Send} onClick={() => act(() => api.setStatus([...selected], "released"), "Einträge freigegeben")}>
                  Freigeben
                </Button>
                <Button size="sm" icon={RotateCcw} variant="ghost" onClick={() => act(() => api.setStatus([...selected], "draft"), "Zurück auf Entwurf")}>
                  Entwurf
                </Button>
                <Button
                  size="sm"
                  icon={Trash2}
                  variant="danger"
                  onClick={async () => {
                    if (!(await s().confirm({ title: "Einträge löschen?", message: `${selected.size} Einträge werden endgültig gelöscht.`, confirmLabel: "Löschen", danger: true }))) return;
                    act(() => Promise.all([...selected].map((id) => api.deleteEntry(id))), "Einträge gelöscht");
                  }}
                >
                  Löschen
                </Button>
                <IconButton icon={X} label="Auswahl aufheben" onClick={() => setSelected(new Set())} />
              </div>
            ) : (
              <span className="faint small">Freigegebene Einträge gehen in den Export</span>
            )}
          </div>
          {rows.length === 0 ? (
            <EmptyState icon={Timer} title="Keine Einträge in dieser Woche" action={<Button icon={Plus} onClick={() => setEditing("new")}>Eintrag hinzufügen</Button>}>
              Starte einen Timer oder tippe <span className="mono">/zeit NP-8801/1020 1.5h</span> in einer Notiz.
            </EmptyState>
          ) : (
            <EntryList rows={rows} selected={selected} setSelected={setSelected} onEdit={setEditing} week={week} />
          )}
        </section>
      </div>
      {editing && <EntryDialog entry={editing === "new" ? null : editing} wbs={wbs} las={las} onClose={() => setEditing(null)} defaultDay={week} />}
      {exporting && <ExportDialog week={week} onClose={() => setExporting(false)} />}
    </div>
  );
}

function Stat({ label, value, tone, sub }: { label: string; value: string; tone?: Tone; sub?: string }) {
  return (
    <div className={`stat ${tone ? `stat-${tone}` : ""}`}>
      <div className="stat-label">
        {label}
        {sub && <span className="stat-sub"> · {sub}</span>}
      </div>
      <div className="stat-value num">{value}</div>
    </div>
  );
}

// ------------------------------------------------------------------ timer

function TimerCard({ wbs, las }: { wbs: ProjectTree[]; las: [string, string][] }) {
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
  const s = useApp.getState;
  const all = wbs.flatMap((p) => p.netzplaene);
  useEffect(() => {
    if (np == null && all.length) setNp(all[0].id);
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
      s().error("Timer nicht gestartet", e);
    }
  };
  const book = async () => {
    const line = /^\/(zeit|time)\b/i.test(quick.trim()) ? quick.trim() : `/zeit ${quick.trim()}`;
    try {
      const out = await api.logTime(line);
      s().toast({ tone: "success", title: `${fmtMinutes(out.entry.duration_minutes)} h gebucht`, detail: out.entry.description || undefined });
      s().alerts(out.alerts);
      setQuick("");
      s().bumpEntries();
    } catch (e) {
      s().error("Buchung fehlgeschlagen", e);
    }
  };

  if (timer) {
    const e = timer.entry;
    const n = all.find((x) => x.id === e.netzplan_id);
    return (
      <section className="card timer-card running">
        <div className="timer-live">
          <span className="rec-dot big" aria-hidden />
          <div>
            <div className="timer-clock num">{clock(seconds)}</div>
            <div className="timer-what">
              <span className="mono">
                {n?.netzplan_nr}
                {e.vorgang_nr ? `/${e.vorgang_nr}` : ""}
              </span>
              {e.leistungsart && <Badge>{e.leistungsart}</Badge>}
              <span>{e.description || <span className="faint">Ohne Beschreibung</span>}</span>
              {timer.idle_minutes > 0 && <Badge tone="warning">{timer.idle_minutes} Min. inaktiv</Badge>}
            </div>
          </div>
        </div>
        <div className="timer-actions">
          <Button
            variant="ghost"
            onClick={async () => {
              if (!(await s().confirm({ title: "Timer verwerfen?", message: "Die laufende Zeit wird nicht gebucht.", confirmLabel: "Verwerfen", danger: true }))) return;
              try {
                await api.timerDiscard();
                s().bumpEntries();
              } catch (e) {
                s().error("Timer konnte nicht verworfen werden", e);
              }
            }}
          >
            Verwerfen
          </Button>
          <Button variant="primary" icon={Square} onClick={() => stopTimer()}>
            Stoppen
          </Button>
        </div>
      </section>
    );
  }

  return (
    <section className="card timer-card">
      <div className="timer-form">
        <NetzplanSelect wbs={wbs} value={np} onChange={(v) => (setNp(v), setVorgang(""))} />
        <VorgangSelect wbs={wbs} netzplanId={np} value={vorgang} onChange={setVorgang} />
        <LeistungsartSelect las={las} value={la} onChange={setLa} />
        <Input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Woran arbeitest du?" onKeyDown={(e) => e.key === "Enter" && start()} aria-label="Beschreibung" />
        <Button variant="primary" icon={Play} onClick={start} disabled={np == null}>
          Starten
        </Button>
      </div>
      <div className="quick-book">
        <span className="faint small">Schnell buchen</span>
        <Input
          className="mono"
          value={quick}
          onChange={(e) => setQuick(e.target.value)}
          placeholder="NP-8801/1020 1.5h #DEV Review @gestern"
          onKeyDown={(e) => e.key === "Enter" && quick.trim() && book()}
          aria-label="Schnell buchen"
        />
      </div>
    </section>
  );
}

// -------------------------------------------------------------- week grid

function WeekGrid({ rows, week, todayKey, target, workdays }: { rows: TimeEntryRow[]; week: Date; todayKey: string; target: number; workdays: number[] }) {
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
  const gaps = weekGaps(rows, week, new Date(), target, workdays);
  const gapKeys = new Set(gaps.map((g) => isoDay(g.day)));
  const s = useApp.getState;
  const copyCats = async () => {
    const { text, ids } = catsGrid(rows, week);
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      return s().error("Kopieren fehlgeschlagen", e);
    }
    const open = rows.filter((r) => ids.includes(r.id) && r.status_flag !== "exported").map((r) => r.id);
    s().toast({
      tone: "success",
      title: "Für CATS kopiert",
      detail: `Netzplan, Vorgang, Leistungsart und Stunden je Tag – in CATS mit ${modLabel()} V einfügen.`,
      action: open.length
        ? {
            label: "Als exportiert markieren",
            run: async () => {
              try {
                await api.setStatus(open, "exported");
                s().bumpEntries();
              } catch (e) {
                s().error("Status nicht geändert", e);
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
        <h2>Wochenübersicht</h2>
        {lines.length > 0 && (
          <Button size="sm" variant="ghost" icon={Clipboard} onClick={copyCats}>
            In CATS kopieren
          </Button>
        )}
      </div>
      {gaps.length > 0 && (
        <div className="week-gaps" role="status">
          <AlertTriangle size={14} />
          <span>Unter Soll:</span>
          {gaps.map((g) => (
            <span key={isoDay(g.day)} className="gap-chip" title={`${fmtMinutes(g.bookedMinutes)} von ${fmtHours(target)} h gebucht`}>
              {weekdayShort(g.day)} {g.day.getDate()}. −{fmtMinutes(g.missingMinutes)} h
            </span>
          ))}
        </div>
      )}
      <div className="table-wrap">
        <table className="table week-grid">
          <thead>
            <tr>
              <th>Netzplan / Vorgang</th>
              <th>LA</th>
              {days.map((d, i) => (
                <th key={i} className={`num ${keys[i] === todayKey ? "today" : ""} ${weekend(i) ? "weekend" : ""}`}>
                  {weekdayShort(d)} <span className="faint">{d.getDate()}.</span>
                </th>
              ))}
              <th className="num">Summe</th>
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
              <td colSpan={2}>Summe</td>
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

// ------------------------------------------------------------- entry list

function EntryList({ rows, selected, setSelected, onEdit, week }: { rows: TimeEntryRow[]; selected: Set<number>; setSelected: (s: Set<number>) => void; onEdit: (r: TimeEntryRow) => void; week: Date }) {
  const [menu, openMenu] = useMenu();
  const s = useApp.getState;
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
      s().error("Status konnte nicht geändert werden", e);
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
                aria-label="Tag auswählen"
                onChange={() => {
                  const next = new Set(selected);
                  selectable.forEach((r) => (allSel ? next.delete(r.id) : next.add(r.id)));
                  setSelected(next);
                }}
              />
              <span className="entry-day-title">{new Date(day + "T12:00:00").toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long" })}</span>
              <span className="grow" />
              <span className="num strong">{fmtMinutes(sum)} h</span>
            </div>
            {list.map((r) => (
              <div key={r.id} className={`entry ${selected.has(r.id) ? "sel" : ""}`} onDoubleClick={() => r.status_flag !== "running" && r.status_flag !== "exported" && onEdit(r)}>
                <input type="checkbox" className="check" checked={selected.has(r.id)} disabled={r.status_flag === "running" || r.status_flag === "exported"} onChange={() => toggle(r.id)} aria-label="Auswählen" title={r.status_flag === "exported" ? "Bereits exportiert" : undefined} />
                <span className="entry-time num faint">
                  {time(r.start_time)}–{r.end_time ? time(r.end_time) : "…"}
                </span>
                <span className="entry-wbs mono">
                  {r.netzplan_nr}
                  {r.vorgang_nr ? `/${r.vorgang_nr}` : ""}
                </span>
                <span className="entry-la">{r.leistungsart && <Badge>{r.leistungsart}</Badge>}</span>
                <span className="entry-desc">{r.description || <span className="faint">Ohne Beschreibung</span>}</span>
                <Badge tone={STATUS[r.status_flag].tone}>{STATUS[r.status_flag].label}</Badge>
                <span className="entry-dur num">{r.duration_minutes != null ? `${fmtMinutes(r.duration_minutes)} h` : "läuft"}</span>
                <IconButton
                  icon={MoreHorizontal}
                  label="Aktionen"
                  size={26}
                  disabled={r.status_flag === "running"}
                  onClick={(e) =>
                    openMenu(e, [
                      { label: "Bearbeiten", icon: Pencil, disabled: r.status_flag === "exported", onSelect: () => onEdit(r) },
                      r.status_flag === "released"
                        ? { label: "Zurück auf Entwurf", icon: RotateCcw, onSelect: () => setStatus(r.id, "draft") }
                        : { label: "Freigeben", icon: Check, disabled: r.status_flag === "exported", onSelect: () => setStatus(r.id, "released") },
                      "separator",
                      {
                        label: "Löschen",
                        icon: Trash2,
                        danger: true,
                        onSelect: async () => {
                          if (!(await s().confirm({ title: "Eintrag löschen?", message: `${r.description || r.netzplan_nr} (${fmtMinutes(r.duration_minutes)} h) wird gelöscht.`, confirmLabel: "Löschen", danger: true }))) return;
                          try {
                            await api.deleteEntry(r.id);
                            s().bumpEntries();
                          } catch (e) {
                            s().error("Löschen fehlgeschlagen", e);
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

function EntryDialog({ entry, wbs, las, onClose, defaultDay }: { entry: TimeEntryRow | null; wbs: ProjectTree[]; las: [string, string][]; onClose: () => void; defaultDay: Date }) {
  const start = entry ? new Date(entry.start_time) : (() => {
    const d = isoDay(new Date()) >= isoDay(defaultDay) && isoDay(new Date()) <= isoDay(addDays(defaultDay, 6)) ? new Date() : new Date(defaultDay);
    d.setHours(9, 0, 0, 0);
    return d;
  })();
  const [np, setNp] = useState<number | null>(entry?.netzplan_id ?? wbs[0]?.netzplaene[0]?.id ?? null);
  const [vorgang, setVorgang] = useState(entry?.vorgang_nr ?? "");
  const [la, setLa] = useState(entry?.leistungsart ?? "DEV");
  const [day, setDay] = useState(isoDay(start));
  const [from, setFrom] = useState(`${String(start.getHours()).padStart(2, "0")}:${String(start.getMinutes()).padStart(2, "0")}`);
  const [dur, setDur] = useState(entry?.duration_minutes != null ? fmtMinutes(entry.duration_minutes) : "1,00");
  const [desc, setDesc] = useState(entry?.description ?? "");
  const [busy, setBusy] = useState(false);
  const s = useApp.getState;
  const minutes = parseDurationInput(dur);

  const submit = async () => {
    if (np == null || minutes == null) return;
    setBusy(true);
    try {
      const startTime = new Date(`${day}T${from}:00`).toISOString();
      if (entry) {
        await api.updateEntry({ id: entry.id, vorgangNr: vorgang || null, leistungsart: la || null, startTime, durationMinutes: minutes, description: desc });
      } else {
        const out = await api.createEntry({ netzplanId: np, vorgangNr: vorgang || null, leistungsart: la || null, startTime, durationMinutes: minutes, description: desc });
        s().alerts(out.alerts);
      }
      s().bumpEntries();
      s().toast({ tone: "success", title: entry ? "Eintrag gespeichert" : `${fmtMinutes(minutes)} h gebucht` });
      onClose();
    } catch (e) {
      s().error("Speichern fehlgeschlagen", e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={entry ? "Eintrag bearbeiten" : "Zeit erfassen"}
      width={520}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Abbrechen
          </Button>
          <Button variant="primary" onClick={submit} loading={busy} disabled={np == null || minutes == null || minutes <= 0}>
            {entry ? "Speichern" : "Buchen"}
          </Button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="Netzplan">
          <NetzplanSelect wbs={wbs} value={np} onChange={(v) => (setNp(v), setVorgang(""))} disabled={!!entry} />
        </Field>
        <Field label="Vorgang">
          <VorgangSelect wbs={wbs} netzplanId={np} value={vorgang} onChange={setVorgang} />
        </Field>
        <Field label="Datum">
          <Input type="date" value={day} onChange={(e) => setDay(e.target.value)} />
        </Field>
        <Field label="Beginn">
          <Input type="time" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="Dauer" hint={minutes == null ? "z. B. 1,5 oder 1:30 oder 90m" : `${fmtMinutes(minutes)} h`}>
          <Input value={dur} onChange={(e) => setDur(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} />
        </Field>
        <Field label="Leistungsart">
          <LeistungsartSelect las={las} value={la} onChange={setLa} />
        </Field>
      </div>
      <Field label="Beschreibung">
        <Input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Was wurde gemacht?" onKeyDown={(e) => e.key === "Enter" && submit()} />
      </Field>
    </Dialog>
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
      s().toast({ tone: "success", title: target === "file" ? "Export gespeichert" : "In Zwischenablage kopiert", detail: `${res.exported_ids.length} Einträge${mark ? ", als exportiert markiert" : ""}` });
      if (mark) s().bumpEntries();
      onClose();
    } catch (e) {
      s().error("Export fehlgeschlagen", e);
    } finally {
      setBusy(false);
    }
  };

  const count = preview?.exported_ids.length ?? 0;
  return (
    <Dialog
      open
      onClose={onClose}
      title="Zeiten exportieren"
      description="Für den Upload in SAP CATS, Jira oder andere Systeme."
      width={680}
      footer={
        <>
          <span className="faint small grow">{count} Einträge{preview?.skipped.length ? `, ${preview.skipped.length} übersprungen` : ""}</span>
          <Button icon={Clipboard} onClick={() => doExport("clipboard")} disabled={!count} loading={busy}>
            Kopieren
          </Button>
          <Button variant="primary" icon={Download} onClick={() => doExport("file")} disabled={!count} loading={busy}>
            Speichern unter…
          </Button>
        </>
      }
    >
      <div className="export-opts">
        <Segmented value={format} options={FORMATS} onChange={setFormat} />
        <div className="row-gap">
          <CalendarDays size={14} className="faint" />
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="Von" />
          <span className="faint">bis</span>
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="Bis" />
        </div>
        <label className="row-gap small">
          <Switch checked={onlyReleased} onChange={setOnlyReleased} label="Nur freigegebene" /> Nur freigegebene Einträge
        </label>
        <label className="row-gap small">
          <Switch checked={mark} onChange={setMark} label="Als exportiert markieren" /> Danach als exportiert markieren
        </label>
      </div>
      {format === "jira_worklog" && preview && preview.skipped.length > 0 && (
        <p className="warn-note small">Für einige Einträge fehlt die Jira-Zuordnung. Lege sie unter Einstellungen › Zeiterfassung fest.</p>
      )}
      <pre className="export-preview">{preview ? preview.content || "Keine Einträge im Zeitraum" : "…"}</pre>
    </Dialog>
  );
}
