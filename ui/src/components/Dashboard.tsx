// The start page's widget grid (also shown in new tabs). „Anpassen“ switches to edit mode:
// add, remove, reorder (drag & drop or the arrow buttons) and resize; „Fertig“ saves.

import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, GripVertical, Play, Plus, SlidersHorizontal, Square, Star, X } from "lucide-react";
import { api, on } from "../lib/api";
import { useApp } from "../store/app";
import { addDays, clock, h1, isoDay, relative, weekStart } from "../lib/format";
import { hoursLabel, monthGrid, dayTone, addMonths } from "../lib/calendar";
import { layoutReducer, SIZE_LABELS, weekBars, WIDGET_KINDS, WIDGETS, type LayoutAction } from "../lib/dashboard";
import type { AlertLevel, BudgetStatus, DayOverview, Page, Task, TimeEntryRow, Widget, WidgetSize } from "../lib/types";
import { Badge, Button, IconButton, Progress, useMenu, type Tone } from "./ui";
import { PageIcon } from "./icons";
import { stopTimer, useTimerSeconds } from "./Sidebar";
import { openDailyNote } from "./CalendarPopover";

const WIDGET_MIME = "application/x-annalo-widget";

export function Dashboard() {
  const view = useApp((s) => s.settings);
  const saved = view?.settings.dashboard.widgets;
  const [draft, setDraft] = useState<Widget[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropBefore, setDropBefore] = useState<string | null | undefined>(undefined);
  const [menu, openMenu] = useMenu();
  const s = useApp.getState;
  if (!saved) return null;
  const editing = draft != null;
  const widgets = draft ?? saved;
  const dispatch = (a: LayoutAction) => setDraft((d) => layoutReducer(d ?? saved, a));

  const finish = async () => {
    if (!draft || !view) return;
    setSaving(true);
    try {
      s().set({ settings: await api.saveDashboard({ ...view.settings.dashboard, widgets: draft }) });
      setDraft(null);
    } catch (e) {
      s().error("Startseite nicht gespeichert", e);
    } finally {
      setSaving(false);
    }
  };
  const addMenu = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    openMenu(
      { clientX: r.left, clientY: r.bottom + 4 },
      WIDGET_KINDS.map((k) => ({ label: WIDGETS[k].label, onSelect: () => dispatch({ type: "add", kind: k }) })),
    );
  };

  const drag = (w: Widget) =>
    editing
      ? {
          draggable: true,
          onDragStart: (e: DragEvent) => {
            e.dataTransfer.setData(WIDGET_MIME, w.id);
            e.dataTransfer.effectAllowed = "move";
            setDragId(w.id);
          },
          onDragEnd: () => {
            setDragId(null);
            setDropBefore(undefined);
          },
          onDragOver: (e: DragEvent) => {
            if (!dragId) return;
            e.preventDefault();
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            const after = e.clientX > r.left + r.width / 2;
            const i = widgets.findIndex((x) => x.id === w.id);
            setDropBefore(after ? (widgets[i + 1]?.id ?? null) : w.id);
          },
          onDrop: (e: DragEvent) => {
            e.preventDefault();
            const id = e.dataTransfer.getData(WIDGET_MIME) || dragId;
            if (id && dropBefore !== undefined) dispatch({ type: "drop", id, before: dropBefore });
            setDragId(null);
            setDropBefore(undefined);
          },
        }
      : {};

  return (
    <section className={`dash ${editing ? "editing" : ""}`} aria-label="Übersicht">
      <div className="dash-bar">
        {editing ? (
          <>
            <span className="faint dash-hint">Ziehen oder mit den Pfeilen verschieben</span>
            <Button size="sm" icon={Plus} onClick={addMenu}>
              Widget hinzufügen
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
              Abbrechen
            </Button>
            <Button size="sm" variant="primary" onClick={finish} loading={saving}>
              Fertig
            </Button>
          </>
        ) : (
          <Button size="sm" variant="ghost" icon={SlidersHorizontal} onClick={() => setDraft(saved.map((w) => ({ ...w })))}>
            Anpassen
          </Button>
        )}
      </div>
      <div className="dash-grid">
        {widgets.map((w, i) => (
          <article
            key={w.id}
            className={`card dw dw-${w.size} ${dragId === w.id ? "dragging" : ""} ${dragId && dropBefore === w.id ? "drop-before" : ""} ${dragId && dropBefore === null && i === widgets.length - 1 ? "drop-after" : ""}`}
            data-widget={w.id}
            data-kind={w.kind}
            aria-label={WIDGETS[w.kind].label}
            {...drag(w)}
          >
            <header className="dw-head">
              {editing && <GripVertical size={14} className="faint dw-grip" aria-hidden />}
              <h2>{WIDGETS[w.kind].label}</h2>
              {editing && (
                <div className="dw-tools">
                  <div className="dw-sizes" role="group" aria-label="Größe">
                    {(["s", "m", "l"] as WidgetSize[]).map((sz) => (
                      <button key={sz} type="button" aria-pressed={w.size === sz} title={SIZE_LABELS[sz]} aria-label={`Größe ${SIZE_LABELS[sz]}`} onClick={() => dispatch({ type: "resize", id: w.id, size: sz })}>
                        {sz.toUpperCase()}
                      </button>
                    ))}
                  </div>
                  <IconButton icon={ArrowUp} label="Nach vorn" size={24} iconSize={13} disabled={i === 0} onClick={() => dispatch({ type: "move", id: w.id, delta: -1 })} />
                  <IconButton icon={ArrowDown} label="Nach hinten" size={24} iconSize={13} disabled={i === widgets.length - 1} onClick={() => dispatch({ type: "move", id: w.id, delta: 1 })} />
                  <IconButton icon={X} label="Entfernen" size={24} iconSize={13} onClick={() => dispatch({ type: "remove", id: w.id })} />
                </div>
              )}
            </header>
            <div className="dw-body" inert={editing}>
              <WidgetBody widget={w} />
            </div>
          </article>
        ))}
        {widgets.length === 0 && (
          <div className="dash-empty faint">
            {editing ? "Keine Widgets. „Widget hinzufügen“ fügt welche hinzu." : "Die Startseite ist leer. „Anpassen“ fügt Widgets hinzu."}
          </div>
        )}
      </div>
      {menu}
    </section>
  );
}

function WidgetBody({ widget }: { widget: Widget }) {
  switch (widget.kind) {
    case "today":
      return <TodayWidget />;
    case "week":
      return <WeekWidget />;
    case "budgets":
      return <BudgetsWidget size={widget.size} />;
    case "recent":
      return <RecentWidget size={widget.size} />;
    case "favorites":
      return <FavoritesWidget />;
    case "timer":
      return <TimerWidget />;
    case "note":
      return <NoteWidget />;
    case "calendar":
      return <CalendarWidget />;
  }
}

/** Reloads with `load` on mount, when `deps` change and on the given backend events. */
function useLoad<T>(load: () => Promise<T>, deps: unknown[], events: string[] = []): [T | null, () => void] {
  const [data, setData] = useState<T | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    load().then(
      (d) => alive && setData(d),
      () => alive && setData(null),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  useEffect(() => {
    const un = events.map((ev) => on(ev, () => setTick((t) => t + 1)));
    return () => un.forEach((u) => u.then((f) => f()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return [data, () => setTick((t) => t + 1)];
}

const Empty = ({ children }: { children: ReactNode }) => <div className="dw-empty">{children}</div>;

// ------------------------------------------------------------------ Heute

function TodayWidget() {
  const entriesVersion = useApp((s) => s.entriesVersion);
  const pages = useApp((s) => s.pages);
  const today = isoDay(new Date());
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const s = useApp.getState;
  const [tasks, reload] = useLoad(
    async () => {
      const [due, [day]] = await Promise.all([api.tasks({ status: "open", due_before: today }), api.dailyOverview(today, today)]);
      const onNote = day?.note_id != null ? await api.tasks({ status: "open", page_id: day.note_id }) : [];
      const key = (t: Task) => `${t.page_id}:${t.ordinal}`;
      const seen = new Set(due.map(key));
      return [...due, ...onNote.filter((t) => !seen.has(key(t)))];
    },
    [today, entriesVersion, pages],
    ["data://tasks"],
  );
  const add = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    try {
      await api.captureSubmit(`- [ ] ${t}`);
      setText("");
      await s().refreshTree();
      reload();
    } catch (e) {
      s().error("Aufgabe nicht angelegt", e);
    } finally {
      setBusy(false);
    }
  };
  const done = async (t: Task) => {
    try {
      await api.setTaskDone(t.page_id, t.ordinal, true, t.text);
      reload();
    } catch (e) {
      s().error("Aufgabe nicht abgehakt", e);
    }
  };
  return (
    <div className="dw-today">
      {tasks && tasks.length === 0 && <Empty>Nichts fällig. Schönen Tag!</Empty>}
      {tasks && tasks.length > 0 && (
        <ul className="dw-list" aria-label="Fällige Aufgaben">
          {tasks.slice(0, 8).map((t) => (
            <li key={`${t.page_id}:${t.ordinal}`} className="dw-task">
              <button type="button" role="checkbox" aria-checked={false} aria-label={`Erledigt: ${t.text}`} className="dw-check" onClick={() => done(t)} />
              <button type="button" className="dw-task-text" onClick={() => s().openPage(t.page_id)} title={t.page_title}>
                <span className="grow ellipsis">{t.text}</span>
                {t.due && t.due < today && <Badge tone="danger">überfällig</Badge>}
                {t.priority >= 2 && <Badge tone="warning">hoch</Badge>}
              </button>
            </li>
          ))}
          {tasks.length > 8 && (
            <li>
              <button type="button" className="dw-more" onClick={() => s().openTab({ kind: "tasks" })}>
                {tasks.length - 8} weitere …
              </button>
            </li>
          )}
        </ul>
      )}
      <input
        className="input dw-add"
        value={text}
        placeholder="Aufgabe für heute…"
        aria-label="Aufgabe zur Tagesnotiz hinzufügen"
        disabled={busy}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            add();
          }
        }}
      />
    </div>
  );
}

// ------------------------------------------------------------------ Woche

function WeekWidget() {
  const entriesVersion = useApp((s) => s.entriesVersion);
  const settings = useApp((s) => s.settings?.settings);
  const monday = useMemo(() => weekStart(new Date()), []);
  const [days] = useLoad(() => api.dailyOverview(isoDay(monday), isoDay(addDays(monday, 6))), [monday, entriesVersion]);
  const target = settings?.daily_target_hours ?? 8;
  const week = weekBars(days ?? [], monday, target, settings?.workdays ?? [1, 2, 3, 4, 5], new Date());
  const gaps = week.bars.filter((b) => b.gap > 0);
  return (
    <button type="button" className="dw-week" onClick={() => useApp.getState().openTab({ kind: "timesheet" })} aria-label="Woche in der Zeiterfassung öffnen">
      <div className="dw-week-sum">
        <span className="num dw-big">{h1(week.bookedMinutes / 60)}</span>
        <span className="faint num">von {h1(week.targetMinutes / 60)} h</span>
        <span className="grow" />
        {gaps.length > 0 ? <Badge tone="warning">{h1(week.gapMinutes / 60)} h Lücke</Badge> : <Badge tone="success">Keine Lücken</Badge>}
      </div>
      <div className="dw-bars" style={{ "--target": week.targetLine } as React.CSSProperties}>
        {week.bars.map((b) => (
          <div
            key={b.date}
            className={`dw-bar-col ${b.workday ? "" : "weekend"} ${b.today ? "today" : ""} ${b.gap > 0 ? "gap" : ""}`}
            title={`${b.label}: ${hoursLabel(b.minutes) || "0"} h${b.gap > 0 ? ` · ${h1(b.gap / 60)} h fehlen` : ""}`}
          >
            <div className="dw-bar-track">
              {b.workday && target > 0 && <span className="dw-bar-target" aria-hidden />}
              <span className="dw-bar-fill" style={{ height: `${b.fill * 100}%` }} />
            </div>
            <span className="dw-bar-h num">{hoursLabel(b.minutes)}</span>
            <span className="dw-bar-day">{b.label}</span>
          </div>
        ))}
      </div>
    </button>
  );
}

// ---------------------------------------------------------------- Budgets

const LEVEL: Record<AlertLevel, { tone: Tone; label: string; rank: number }> = {
  ok: { tone: "success", label: "OK", rank: 0 },
  warning: { tone: "warning", label: "Warnung", rank: 1 },
  critical: { tone: "danger", label: "Kritisch", rank: 2 },
  exceeded: { tone: "danger", label: "Überschritten", rank: 3 },
};

function BudgetsWidget({ size }: { size: WidgetSize }) {
  const entriesVersion = useApp((s) => s.entriesVersion);
  const thresholds = useApp((s) => s.settings?.settings.thresholds);
  const [alerts] = useLoad(
    async () => {
      const tree = await api.wbs();
      const ids = tree.flatMap((p) => p.netzplaene.map((n) => n.id));
      const all = (await Promise.all(ids.map((id) => api.budget(id)))).flat();
      return all.filter((b) => b.level !== "ok").sort((a, b) => LEVEL[b.level].rank - LEVEL[a.level].rank || b.consumed - a.consumed);
    },
    [entriesVersion, thresholds?.warning, thresholds?.critical],
  );
  const open = () => useApp.getState().openTab({ kind: "projects" });
  if (!alerts) return null;
  if (alerts.length === 0) return <Empty>Alle Budgets im Rahmen.</Empty>;
  const max = size === "s" ? 4 : 8;
  return (
    <ul className="dw-list">
      {alerts.slice(0, max).map((b: BudgetStatus) => (
        <li key={b.label}>
          <button type="button" className="dw-budget" onClick={open} title={`${h1(b.booked_hours)} von ${h1(b.planned_hours)} h gebucht, Prognose ${h1(b.eac_hours)} h`}>
            <span className="dw-budget-head">
              <span className="mono ellipsis grow">{b.label}</span>
              <Badge tone={LEVEL[b.level].tone}>{LEVEL[b.level].label}</Badge>
            </span>
            <span className="dw-budget-bar">
              <Progress value={b.consumed} tone={LEVEL[b.level].tone} marker={b.planned_hours > 0 ? b.eac_hours / b.planned_hours : undefined} />
              <span className="num faint">{Math.round(b.consumed * 100)} %</span>
            </span>
          </button>
        </li>
      ))}
      {alerts.length > max && (
        <li>
          <button type="button" className="dw-more" onClick={open}>
            {alerts.length - max} weitere …
          </button>
        </li>
      )}
    </ul>
  );
}

// ------------------------------------------------------- pages (recent, favorites)

function PageRows({ pages, when }: { pages: Page[]; when?: boolean }) {
  const s = useApp.getState;
  return (
    <ul className="dw-list">
      {pages.map((p) => (
        <li key={p.id}>
          <button type="button" className="dw-page" onClick={(e) => s().openPage(p.id, { newTab: e.ctrlKey || e.metaKey })}>
            <PageIcon name={p.icon} size={15} />
            <span className="grow ellipsis">{p.title}</span>
            {when && <span className="faint dw-when">{relative(p.updated_at)}</span>}
          </button>
        </li>
      ))}
    </ul>
  );
}

function RecentWidget({ size }: { size: WidgetSize }) {
  const pages = useApp((s) => s.pages);
  const [recent] = useLoad(() => api.recentPages(size === "s" ? 5 : 8), [pages, size]);
  if (!recent) return null;
  return recent.length ? <PageRows pages={recent} when={size !== "s"} /> : <Empty>Noch keine Seiten.</Empty>;
}

function FavoritesWidget() {
  const pages = useApp((s) => s.pages);
  const favs = useMemo(() => [...pages.values()].filter((p) => p.favorite).sort((a, b) => a.title.localeCompare(b.title, "de")), [pages]);
  if (!favs.length)
    return (
      <Empty>
        Keine Lesezeichen. <Star size={12} className="inline-icon" /> im Seitenmenü setzt eins.
      </Empty>
    );
  return <PageRows pages={favs.slice(0, 10)} />;
}

// ------------------------------------------------------------------ Timer

function TimerWidget() {
  const timer = useApp((s) => s.timer);
  const entriesVersion = useApp((s) => s.entriesVersion);
  const seconds = useTimerSeconds();
  const s = useApp.getState;
  const [refs] = useLoad(
    async () => {
      const rows = await api.entries(new Date(Date.now() - 60 * 86400_000).toISOString());
      const seen = new Set<string>();
      const out: TimeEntryRow[] = [];
      for (const r of [...rows].sort((a, b) => b.start_time.localeCompare(a.start_time))) {
        const key = `${r.netzplan_id}/${r.vorgang_nr ?? ""}`;
        if (r.status_flag === "running" || seen.has(key)) continue;
        seen.add(key);
        out.push(r);
        if (out.length === 3) break;
      }
      return out;
    },
    [entriesVersion],
  );
  const start = async (r: TimeEntryRow) => {
    try {
      await api.timerStart(r.netzplan_id, r.vorgang_nr, r.leistungsart, r.description);
      s().bumpEntries();
    } catch (e) {
      s().error("Timer nicht gestartet", e);
    }
  };
  if (timer) {
    const e = timer.entry;
    return (
      <div className="dw-timer running">
        <span className="rec-dot" aria-hidden />
        <div className="grow dw-timer-main">
          <span className="num dw-big">{clock(seconds)}</span>
          <span className="faint ellipsis">{e.description || e.vorgang_nr || "Timer"}</span>
        </div>
        <Button size="sm" icon={Square} onClick={() => stopTimer()}>
          Stoppen
        </Button>
      </div>
    );
  }
  if (!refs) return null;
  if (!refs.length) return <Empty>Noch keine Buchungen. Starte einen Timer in der Zeiterfassung.</Empty>;
  return (
    <ul className="dw-list" aria-label="Zuletzt gebucht">
      {refs.map((r) => (
        <li key={`${r.netzplan_id}/${r.vorgang_nr}`}>
          <button type="button" className="dw-page dw-start" onClick={() => start(r)} aria-label={`Timer starten: ${r.netzplan_nr}${r.vorgang_nr ? "/" + r.vorgang_nr : ""}`}>
            <Play size={13} />
            <span className="mono">{r.netzplan_nr}{r.vorgang_nr ? `/${r.vorgang_nr}` : ""}</span>
            <span className="faint ellipsis grow">{r.description}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

// ------------------------------------------------------------------ Notiz

function NoteWidget() {
  const stored = useApp((s) => s.settings?.settings.dashboard.note ?? "");
  const [text, setText] = useState(stored);
  const pending = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const note = pending.current;
    pending.current = null;
    if (note == null) return;
    const st = useApp.getState();
    const dash = st.settings?.settings.dashboard;
    if (!dash || dash.note === note) return;
    api.saveDashboard({ ...dash, note }).then(
      (v) => useApp.getState().set({ settings: v }),
      (e) => useApp.getState().error("Notiz nicht gespeichert", e),
    );
  };
  // Another tab changed it: take it over unless something is being typed here.
  useEffect(() => {
    if (pending.current == null) setText(stored);
  }, [stored]);
  useEffect(() => flush, []);

  return (
    <textarea
      className="input dw-note"
      value={text}
      placeholder="Gedanken, Telefonnummern, Zwischenstände…"
      aria-label="Notiz"
      spellCheck
      onChange={(e) => {
        setText(e.target.value);
        pending.current = e.target.value;
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(flush, 600);
      }}
      onBlur={flush}
    />
  );
}

// --------------------------------------------------------------- Kalender

const WEEKDAYS = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];

function CalendarWidget() {
  const settings = useApp((s) => s.settings?.settings);
  const entriesVersion = useApp((s) => s.entriesVersion);
  const [cursor, setCursor] = useState(() => new Date());
  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  const grid = useMemo(() => monthGrid(year, month), [year, month]);
  const [list] = useLoad(() => api.dailyOverview(isoDay(grid[0][0]), isoDay(grid[5][6])), [grid, entriesVersion]);
  const days = useMemo(() => new Map((list ?? []).map((d: DayOverview) => [d.date, d])), [list]);
  const today = new Date();
  const todayIso = isoDay(today);
  const target = settings?.daily_target_hours ?? 8;
  const workdays = settings?.workdays ?? [1, 2, 3, 4, 5];
  const trackedSince = [...days.values()].find((d) => d.booked_minutes > 0)?.date;
  return (
    <div className="dw-cal">
      <div className="dw-cal-head">
        <span className="grow">{new Date(year, month, 1).toLocaleDateString("de-DE", { month: "long", year: "numeric" })}</span>
        <IconButton icon={ChevronLeft} label="Vorheriger Monat" size={22} iconSize={13} onClick={() => setCursor(addMonths(cursor, -1))} />
        <IconButton icon={ChevronRight} label="Nächster Monat" size={22} iconSize={13} onClick={() => setCursor(addMonths(cursor, 1))} />
      </div>
      <div className="dw-cal-grid" role="grid">
        {WEEKDAYS.map((w) => (
          <span key={w} className="dw-cal-wd">
            {w}
          </span>
        ))}
        {grid.flat().map((d) => {
          const iso = isoDay(d);
          const info = days.get(iso);
          const minutes = info?.booked_minutes ?? 0;
          const tone = dayTone(d, minutes, target, workdays, today, trackedSince);
          const cls = ["dw-cal-day", d.getMonth() !== month && "outside", iso === todayIso && "today", info?.has_note && "has-note", tone !== "none" && `tone-${tone}`].filter(Boolean).join(" ");
          return (
            <button
              key={iso}
              type="button"
              className={cls}
              data-date={iso}
              title={[iso, info?.has_note ? "Tagesnotiz" : null, minutes > 0 ? `${hoursLabel(minutes)} h` : null].filter(Boolean).join(" · ")}
              onClick={(e) => openDailyNote(iso, e.ctrlKey || e.metaKey)}
            >
              {d.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}
