// Daily-note calendar: a month grid with a dot for every daily note and the booked
// hours per day (tinted against the daily target). Clicking a day opens its note.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { api } from "../lib/api";
import { useApp } from "../store/app";
import { addDays, dateLong, isoDay, weekdayLabels } from "../lib/format";
import { addMonths, dayTone, hoursLabel, monthGrid, weekNumber } from "../lib/calendar";
import type { DayOverview } from "../lib/types";
import { Button, IconButton, MENU_GAP } from "./ui";


/** Opens the calendar next to `el` (or centered without an element), showing `date` (default today). */
export function openCalendar(el?: Element | null, date?: string, side: "below" | "right" = "below") {
  const r = el?.getBoundingClientRect();
  const at = !r ? {} : side === "right" ? { x: r.right + 8, y: r.top } : { x: r.left, y: r.bottom + MENU_GAP };
  useApp.getState().set({ calendar: { ...at, date } });
}

/** The calendar as a date picker below `el`: `onPick` gets the chosen day (YYYY-MM-DD). */
export function pickDate(el: Element, date: string | undefined, onPick: (iso: string) => void) {
  const r = el.getBoundingClientRect();
  useApp.getState().set({ calendar: { x: r.left, y: r.bottom + MENU_GAP, date: date || undefined, onPick } });
}

/** Opens (or creates) the daily note of `iso` (YYYY-MM-DD). */
export async function openDailyNote(iso: string, newTab = false) {
  const s = useApp.getState();
  try {
    const p = await api.dailyNote(iso);
    await s.refreshTree();
    s.openPage(p.id, { newTab });
  } catch (e) {
    s.error("Tagesnotiz konnte nicht geöffnet werden", e);
  }
}

const parseDay = (iso?: string) => {
  const m = iso?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date();
};

export function CalendarPopover() {
  const anchor = useApp((s) => s.calendar);
  if (!anchor) return null;
  return <Calendar key={`${anchor.x}-${anchor.y}-${anchor.date}`} x={anchor.x} y={anchor.y} date={anchor.date} onPick={anchor.onPick} />;
}

function Calendar({ x, y, date, onPick }: { x?: number; y?: number; date?: string; onPick?: (iso: string) => void }) {
  const settings = useApp((s) => s.settings?.settings);
  const entriesVersion = useApp((s) => s.entriesVersion);
  const [cursor, setCursor] = useState(() => parseDay(date));
  const [days, setDays] = useState<Map<string, DayOverview>>(new Map());
  const [pos, setPos] = useState<{ left: number; top: number } | null>(x != null && y != null ? { left: x, top: y } : null);
  const ref = useRef<HTMLDivElement>(null);
  const close = () => useApp.getState().set({ calendar: null });

  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  const grid = useMemo(() => monthGrid(year, month), [year, month]);
  const from = isoDay(grid[0][0]);
  const to = isoDay(grid[5][6]);
  const today = new Date();
  const todayIso = isoDay(today);
  const target = settings?.daily_target_hours ?? 8;
  const workdays = settings?.workdays ?? [1, 2, 3, 4, 5];

  useEffect(() => {
    let alive = true;
    api
      .dailyOverview(from, to)
      .then((list) => alive && setDays(new Map(list.map((d) => [d.date, d]))))
      .catch(() => alive && setDays(new Map()));
    return () => {
      alive = false;
    };
  }, [from, to, entriesVersion]);

  // Keep the popover inside the window.
  useLayoutEffect(() => {
    if (x == null || y == null) return;
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    setPos({ left: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)), top: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) });
  }, [x, y]);

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    window.addEventListener("mousedown", onDown, true);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      if (document.activeElement === document.body || ref.current?.contains(document.activeElement)) prev?.focus?.();
    };
  }, []);

  const open = (d: Date, newTab = false) => {
    close();
    if (onPick) onPick(isoDay(d));
    else openDailyNote(isoDay(d), newTab);
  };
  const picked = onPick && date ? date : null;

  const onKey = (e: React.KeyboardEvent) => {
    const move = (d: Date) => {
      e.preventDefault();
      e.stopPropagation();
      setCursor(d);
    };
    if (e.key === "ArrowLeft") move(addDays(cursor, -1));
    else if (e.key === "ArrowRight") move(addDays(cursor, 1));
    else if (e.key === "ArrowUp") move(addDays(cursor, -7));
    else if (e.key === "ArrowDown") move(addDays(cursor, 7));
    else if (e.key === "PageUp") move(addMonths(cursor, e.shiftKey ? -12 : -1));
    else if (e.key === "PageDown") move(addMonths(cursor, e.shiftKey ? 12 : 1));
    else if (e.key === "Home") move(new Date());
    else if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      open(cursor, e.ctrlKey || e.metaKey);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };

  const trackedSince = useMemo(() => [...days.values()].find((d) => d.booked_minutes > 0)?.date, [days]);
  const monthLabel = new Date(year, month, 1).toLocaleDateString("de-DE", { month: "long", year: "numeric" });
  const cursorIso = isoDay(cursor);

  const body = (
    <div
      ref={ref}
      className={`calendar ${pos ? "calendar-anchored" : ""}`}
      style={pos ? { left: pos.left, top: pos.top } : undefined}
      role="dialog"
      aria-label={onPick ? "Datum wählen" : "Kalender"}
      tabIndex={-1}
      onKeyDown={onKey}
    >
      <div className="cal-head">
        <div className="cal-month" aria-live="polite">
          {monthLabel}
        </div>
        <IconButton icon={ChevronLeft} label="Vorheriger Monat (Bild ↑)" size="md" onClick={() => setCursor(addMonths(cursor, -1))} />
        <Button size="sm" variant="ghost" onClick={() => setCursor(new Date())}>
          Heute
        </Button>
        <IconButton icon={ChevronRight} label="Nächster Monat (Bild ↓)" size="md" onClick={() => setCursor(addMonths(cursor, 1))} />
      </div>
      <div className="cal-grid" role="grid" aria-label={monthLabel}>
        <div className="cal-row cal-weekdays" role="row">
          <span className="cal-kw" role="columnheader">
            KW
          </span>
          {weekdayLabels().map((w) => (
            <span key={w} className="cal-wd" role="columnheader">
              {w}
            </span>
          ))}
        </div>
        {grid.map((week) => (
          <div key={isoDay(week[0])} className="cal-row" role="row">
            <span className="cal-kw" role="rowheader">
              {weekNumber(week.find((d) => d.getDay() === 1) ?? week[0])}
            </span>
            {week.map((d) => {
              const iso = isoDay(d);
              const info = days.get(iso);
              const minutes = info?.booked_minutes ?? 0;
              const weekday = ((d.getDay() + 6) % 7) + 1;
              const tone = dayTone(d, minutes, target, workdays, today, trackedSince);
              const label = [
                dateLong(iso + "T12:00:00"),
                info?.has_note ? "Tagesnotiz" : null,
                minutes > 0 ? `${hoursLabel(minutes)} h gebucht` : null,
                info?.open_tasks ? `${info.open_tasks} offene ${info.open_tasks === 1 ? "Aufgabe" : "Aufgaben"} fällig` : null,
              ]
                .filter(Boolean)
                .join(" · ");
              const cls = [
                "cal-day",
                d.getMonth() !== month && "outside",
                !workdays.includes(weekday) && "weekend",
                iso === todayIso && "today",
                iso === picked && "picked",
                iso === cursorIso && "focus",
                info?.has_note && "has-note",
                tone !== "none" && `tone-${tone}`,
              ]
                .filter(Boolean)
                .join(" ");
              return (
                <button
                  key={iso}
                  type="button"
                  role="gridcell"
                  tabIndex={-1}
                  className={cls}
                  data-date={iso}
                  aria-label={label}
                  aria-selected={iso === cursorIso}
                  aria-current={iso === todayIso ? "date" : undefined}
                  title={label}
                  onClick={(e) => open(d, e.ctrlKey || e.metaKey)}
                  onMouseDown={(e) => e.preventDefault()}
                >
                  <span className="cal-num">{d.getDate()}</span>
                  <span className="cal-hours">{hoursLabel(minutes)}</span>
                  <span className="cal-bar" aria-hidden>
                    {minutes > 0 && <span style={{ width: `${Math.min(1, minutes / Math.max(1, target * 60)) * 100}%` }} />}
                  </span>
                  <span className="cal-marks" aria-hidden>
                    {info?.has_note && <span className="cal-dot" />}
                    {!!info?.open_tasks && <span className="cal-task" />}
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
      <div className="cal-foot">
        <span>
          <span className="cal-dot" /> Tagesnotiz
        </span>
        <span>
          <span className="cal-task" /> Aufgabe fällig
        </span>
        <span className="grow" />
        <span className="faint" title={`Pfeiltasten: Tag · Bild ↑/↓: Monat · Pos1: heute · Enter: ${onPick ? "übernehmen" : "öffnen"} · Esc: schließen`}>
          <kbd>Enter</kbd> {onPick ? "übernehmen" : "öffnen"}
        </span>
      </div>
    </div>
  );

  return createPortal(
    pos ? (
      body
    ) : (
      <div className="overlay overlay-top" onMouseDown={(e) => e.target === e.currentTarget && close()}>
        {body}
      </div>
    ),
    document.body,
  );
}
