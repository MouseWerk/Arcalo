// „Aktivität“: a timeline of what happened – pages created and edited, tasks, bookings, files,
// focus sessions, backups and syncs – with a day summary, filters and a virtualized list.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity as ActivityIcon, CalendarSearch, CheckSquare, Clock, Database, FilePlus2, FileText, Paperclip, RefreshCw, Search, Target, Upload,
} from "lucide-react";
import { api } from "../lib/api";
import { useApp } from "../store/app";
import { EmptyState, IconButton, Select, Spinner } from "../components/ui";
import { DateInput, dayLabel } from "../components/DateInput";
import { pickDate } from "../components/CalendarPopover";
import { PageIcon } from "../components/icons";
import { useWbs } from "./wbs";
import { hm } from "../lib/focus";
import { isoDay, time } from "../lib/format";
import {
  KIND_GROUPS, RANGE_LABELS, dayBounds, dayTitle, describe, feedRows, groupOf, presetDays, rowOffsets, visibleRange, type FeedRow, type KindGroup, type RangePreset,
} from "../lib/activity";
import type { Activity, FeedSummary } from "../lib/types";

import { ACTIVITY_PREF as PREF } from "./activityDay";
export { openActivityDay } from "./activityDay";
interface Prefs {
  preset: RangePreset;
  from: string;
  to: string;
}
function loadPrefs(): Prefs {
  const today = isoDay(new Date());
  try {
    const raw = JSON.parse(localStorage.getItem(PREF) ?? "null");
    if (raw?.preset) return { preset: raw.preset, from: raw.from ?? today, to: raw.to ?? today };
  } catch {
    /* ignore */
  }
  return { preset: "week", from: today, to: today };
}

const GROUP_ICON: Record<KindGroup, typeof FileText> = {
  pages: FileText,
  tasks: CheckSquare,
  time: Clock,
  files: Paperclip,
  focus: Target,
  system: Database,
};

export function ActivityView() {
  const s = useApp.getState;
  const pages = useApp((st) => st.pages);
  const entriesVersion = useApp((st) => st.entriesVersion);
  const focusId = useApp((st) => `${st.focus?.session.id ?? ""}:${st.focus?.phase ?? ""}`);
  const { wbs } = useWbs();
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [wbsFilter, setWbsFilter] = useState("");
  const [person, setPerson] = useState("");
  const [people, setPeople] = useState<string[]>([]);
  const [groups, setGroups] = useState<Set<KindGroup>>(new Set());
  const [items, setItems] = useState<Activity[] | null>(null);
  const [summary, setSummary] = useState<FeedSummary | null>(null);
  const [tick, setTick] = useState(0);
  const seq = useRef(0);

  useEffect(() => {
    try {
      localStorage.setItem(PREF, JSON.stringify(prefs));
    } catch {
      /* ignore */
    }
  }, [prefs]);
  useEffect(() => {
    const onDay = (e: Event) => {
      const iso = (e as CustomEvent<string>).detail;
      setPrefs({ preset: "day", from: iso, to: iso });
    };
    window.addEventListener("annalo:activity-day", onDay);
    return () => window.removeEventListener("annalo:activity-day", onDay);
  }, []);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(query.trim()), 200);
    return () => window.clearTimeout(t);
  }, [query]);
  // Saves change the feed: refetch shortly after, and every minute while open.
  useEffect(() => {
    let t: number | undefined;
    const bump = () => {
      window.clearTimeout(t);
      t = window.setTimeout(() => setTick((n) => n + 1), 600);
    };
    window.addEventListener("annalo:page-saved", bump);
    const every = window.setInterval(() => setTick((n) => n + 1), 60_000);
    return () => {
      window.clearTimeout(t);
      window.clearInterval(every);
      window.removeEventListener("annalo:page-saved", bump);
    };
  }, []);

  const days = prefs.preset === "day" || prefs.preset === "custom" ? { from: prefs.from, to: prefs.to < prefs.from ? prefs.from : prefs.to } : presetDays(prefs.preset);
  const bounds = dayBounds(days.from, days.to);
  const kinds = useMemo(() => KIND_GROUPS.filter((g) => groups.has(g.id)).flatMap((g) => g.kinds), [groups]);

  const load = useCallback(() => {
    const n = ++seq.current;
    const [kind, a, b] = wbsFilter.split(":");
    Promise.all([
      api.activity({
        from: bounds.from,
        to: bounds.to,
        kinds,
        project_id: kind === "p" ? Number(a) : null,
        netzplan_id: kind === "n" || kind === "v" ? Number(a) : null,
        vorgang_nr: kind === "v" ? b : null,
        person: person || null,
        query: debounced || null,
      }),
      api.activitySummary(bounds.from, bounds.to),
      api.activityPeople().catch(() => []),
    ])
      .then(([list, sum, ppl]) => {
        if (n !== seq.current) return;
        setItems(list);
        setSummary(sum);
        setPeople(ppl);
      })
      .catch((e) => n === seq.current && (setItems([]), s().error("Aktivität nicht geladen", e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bounds.from, bounds.to, kinds, wbsFilter, person, debounced]);
  useEffect(load, [load, entriesVersion, pages, tick, focusId]);

  const single = days.from === days.to;
  const heading = single ? dayTitle(days.from) : `${dayLabel(days.from)} – ${dayLabel(days.to)}`;
  const setPreset = (p: RangePreset) => {
    if (p === "custom") setPrefs({ preset: "custom", from: days.from, to: days.to });
    else setPrefs((cur) => ({ ...cur, preset: p }));
  };
  const toggleGroup = (g: KindGroup) =>
    setGroups((cur) => {
      const next = new Set(cur);
      if (next.has(g)) next.delete(g);
      else next.add(g);
      return next;
    });

  // ---- virtualized list: rows positioned absolutely inside a box of the full height.
  const rows = useMemo(() => feedRows(items ?? []), [items]);
  const { offsets, total } = useMemo(() => rowOffsets(rows), [rows]);
  const scroller = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 800 });
  useEffect(() => {
    const sc = scroller.current;
    if (!sc) return;
    const update = () => {
      const list = listRef.current;
      const offset = list ? list.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop : 0;
      setView({ top: Math.max(0, sc.scrollTop - offset), height: sc.clientHeight });
    };
    update();
    sc.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(sc);
    return () => {
      sc.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, [items]);
  const [start, end] = visibleRange(offsets, total, view.top, view.height);

  const open = (a: Activity, newTab: boolean) => {
    if (a.page_id != null && pages.has(a.page_id)) return s().openPage(a.page_id, { newTab });
    if (a.kind.startsWith("entry_") || a.kind === "focus_session") return s().openTab({ kind: "timesheet" }, { newTab });
    if (a.kind === "file_added") return void api.openAttachment(a.title).catch((e) => s().error("Datei nicht geöffnet", e));
    if (a.kind === "backup" || a.kind === "sync") return s().openTab({ kind: "settings" }, { newTab });
    s().toast({ tone: "info", title: "Nicht mehr vorhanden", detail: "Die Seite wurde gelöscht oder liegt im Papierkorb." });
  };

  return (
    <div className="view-scroll" ref={scroller}>
      <div className="view activity-view">
        <header className="view-header">
          <div>
            <h1>Aktivität</h1>
            <div className="view-sub">Was wann passiert ist: Seiten, Aufgaben, Buchungen, Dateien und Fokus</div>
          </div>
          <div className="view-actions">
            <button
              type="button"
              className="btn btn-secondary btn-md activity-jump"
              onClick={(e) => pickDate(e.currentTarget, days.from, (iso) => setPrefs({ preset: "day", from: iso, to: iso }))}
            >
              <CalendarSearch size={14} aria-hidden />
              <span>Was habe ich am … gemacht?</span>
            </button>
            <IconButton icon={RefreshCw} label="Aktualisieren" onClick={() => setTick((n) => n + 1)} />
          </div>
        </header>

        <div className="activity-filters">
          <div className="activity-range" role="radiogroup" aria-label="Zeitraum">
            {(Object.keys(RANGE_LABELS) as Exclude<RangePreset, "day">[]).map((p) => (
              <button key={p} type="button" role="radio" aria-checked={prefs.preset === p} className={`chip ${prefs.preset === p ? "on" : ""}`} onClick={() => setPreset(p)}>
                {RANGE_LABELS[p]}
              </button>
            ))}
            {prefs.preset === "day" && (
              <span className="chip on" role="radio" aria-checked>
                {dayLabel(days.from)}
              </span>
            )}
          </div>
          {prefs.preset === "custom" && (
            <div className="activity-dates">
              <DateInput value={prefs.from} onChange={(iso) => setPrefs((c) => ({ ...c, from: iso }))} aria-label="Von" />
              <span className="faint">bis</span>
              <DateInput value={prefs.to} onChange={(iso) => setPrefs((c) => ({ ...c, to: iso }))} aria-label="Bis" />
            </div>
          )}
          <div className="activity-row-filters">
            <span className="input affix-input activity-search">
              <Search size={14} className="faint" aria-hidden />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Suchen…" aria-label="Aktivität durchsuchen" spellCheck={false} />
            </span>
            <Select value={wbsFilter} onChange={(e) => setWbsFilter(e.target.value)} aria-label="Projekt, Netzplan oder Vorgang">
              <option value="">Alle Projekte</option>
              {wbs.map((p) => (
                <optgroup key={p.id} label={`${p.project_code} · ${p.name}`}>
                  <option value={`p:${p.id}`}>{p.project_code} (ganzes Projekt)</option>
                  {p.netzplaene.flatMap((n) => [
                    <option key={`n${n.id}`} value={`n:${n.id}`}>
                      {n.netzplan_nr} · {n.description || n.wbs_element}
                    </option>,
                    ...n.vorgaenge.map((v) => (
                      <option key={`v${v.id}`} value={`v:${n.id}:${v.vorgang_nr}`}>
                        {"  "}
                        {n.netzplan_nr}/{v.vorgang_nr} · {v.description}
                      </option>
                    )),
                  ])}
                </optgroup>
              ))}
            </Select>
            <Select value={person} onChange={(e) => setPerson(e.target.value)} aria-label="Person" disabled={!people.length && !person}>
              <option value="">Alle Personen</option>
              {people.map((p) => (
                <option key={p} value={p}>
                  @{p}
                </option>
              ))}
            </Select>
          </div>
          <div className="activity-kinds" role="group" aria-label="Art">
            {KIND_GROUPS.map((g) => {
              const Icon = GROUP_ICON[g.id];
              return (
                <button key={g.id} type="button" aria-pressed={groups.has(g.id)} className={`chip chip-kind kind-${g.id} ${groups.has(g.id) ? "on" : ""}`} onClick={() => toggleGroup(g.id)}>
                  <Icon size={13} aria-hidden /> {g.label}
                </button>
              );
            })}
          </div>
        </div>

        <section className="activity-summary card" aria-label="Zusammenfassung">
          <div className="activity-summary-head">
            <h2>{heading}</h2>
            {single && <span className="faint small">{days.from === isoDay(new Date()) ? "bisher" : ""}</span>}
          </div>
          <div className="activity-stats">
            <Stat value={summary?.pages_edited ?? 0} label={summary?.pages_edited === 1 ? "Seite bearbeitet" : "Seiten bearbeitet"} icon={FileText} tone="pages" />
            <Stat value={summary?.tasks_done ?? 0} label={summary?.tasks_done === 1 ? "Aufgabe erledigt" : "Aufgaben erledigt"} icon={CheckSquare} tone="tasks" />
            <Stat value={`${((summary?.booked_minutes ?? 0) / 60).toLocaleString("de-DE", { maximumFractionDigits: 2 })} h`} label="gebucht" icon={Clock} tone="time" />
            <Stat value={summary?.focus_sessions ?? 0} label={summary?.focus_minutes ? `Fokus · ${hm(summary.focus_minutes)}` : "Fokussitzungen"} icon={Target} tone="focus" />
          </div>
        </section>

        {items == null ? (
          <div className="center-fill">
            <Spinner />
          </div>
        ) : items.length === 0 ? (
          <EmptyState icon={ActivityIcon} title="Keine Aktivität in diesem Zeitraum">
            {query || kinds.length || wbsFilter || person ? "Mit diesen Filtern gibt es nichts. Filter lockern oder einen anderen Zeitraum wählen." : "Bearbeitete Seiten, erledigte Aufgaben und Buchungen erscheinen hier."}
          </EmptyState>
        ) : (
          <div className="activity-list" ref={listRef} style={{ height: total }} role="list" aria-label="Aktivitäten">
            {rows.slice(start, end).map((r, k) => (
              <Row key={r.key} row={r} top={offsets[start + k]} onOpen={open} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ value, label, icon: Icon, tone }: { value: number | string; label: string; icon: typeof FileText; tone: KindGroup }) {
  return (
    <div className={`activity-stat kind-${tone}`}>
      <span className="activity-stat-icon" aria-hidden>
        <Icon size={15} />
      </span>
      <span className="activity-stat-value num">{value}</span>
      <span className="activity-stat-label">{label}</span>
    </div>
  );
}

const KIND_ICON: Partial<Record<Activity["kind"], typeof FileText>> = {
  page_created: FilePlus2,
  entry_exported: Upload,
  sync: RefreshCw,
};

function Row({ row, top, onOpen }: { row: FeedRow; top: number; onOpen: (a: Activity, newTab: boolean) => void }) {
  if (row.type === "day")
    return (
      <div className="activity-day" style={{ top }} role="presentation">
        <span>{dayTitle(row.day)}</span>
        <span className="faint small num">{row.count}</span>
      </div>
    );
  const a = row.item;
  const g = groupOf(a.kind);
  const Icon = KIND_ICON[a.kind] ?? GROUP_ICON[g];
  const d = describe(a);
  return (
    <button type="button" role="listitem" className={`activity-item kind-${g}`} data-kind={a.kind} style={{ top }} onClick={(e) => onOpen(a, e.ctrlKey || e.metaKey)}>
      <span className="activity-time num">{time(a.at)}</span>
      <span className="activity-icon" aria-hidden>
        {a.page_icon && g === "pages" ? <PageIcon name={a.page_icon} size={15} /> : <Icon size={15} />}
      </span>
      <span className="activity-text">
        <span className="activity-line">
          <span className="activity-verb">{d.verb}</span>
          <span className="activity-title ellipsis">{d.title}</span>
        </span>
        {(d.detail || a.people.length > 0) && (
          <span className="activity-detail ellipsis">
            {d.detail}
            {a.people.length > 0 && <span className="activity-people">{a.people.map((p) => `@${p}`).join(" ")}</span>}
          </span>
        )}
      </span>
      {a.reference && g !== "time" && g !== "focus" && <span className="activity-ref mono">{a.reference}</span>}
    </button>
  );
}


