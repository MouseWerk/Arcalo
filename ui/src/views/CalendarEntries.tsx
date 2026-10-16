// Appointments created and changed in the Kalender and written to Outlook (1.21): saving with the
// confirmation for organized meetings and the offer to switch writing on, an appointment in the
// time grid that is moved and resized with the mouse or the keyboard, the panel of a new
// appointment, and the part of an appointment's panel that changes it or says why it cannot.

import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { AlertTriangle, CalendarClock, ExternalLink, Lock, Plus, RefreshCw, Trash2, Undo2, X } from "lucide-react";
import { api } from "../lib/api";
import { useApp } from "../store/app";
import { Button, IconButton, Input, Select } from "../components/ui";
import { t as tr, useT, type TKey } from "../lib/i18n";
import { isoDay, time } from "../lib/format";
import { attendeeName, sourceName } from "../lib/agenda";
import { editedTimes, moved, resized, SNAP } from "../lib/blocks";
import { isComposing } from "../lib/ime";
import { DateInput, TimeInput } from "../components/DateInput";
import type { CalendarEvent, CalendarSettings, Editability, EntryFields } from "../lib/types";

/** Whether the appointment can be changed here (organized meetings after a confirmation). */
export const canEdit = (e: Pick<CalendarEvent, "editable">) => e.editable === "yes" || e.editable === "confirm";

/** Why an appointment cannot be changed here. */
const READ_ONLY: Partial<Record<Editability, TKey>> = {
  received: "entries.ro.received",
  series: "entries.ro.series",
  shared: "entries.ro.shared",
  free_busy: "entries.ro.freeBusy",
  ics: "entries.ro.ics",
  unavailable: "entries.ro.unavailable",
  unknown: "entries.ro.unknown",
};

/** Whether new appointments can be made here: Outlook Classic is there and its calendar is read. */
export const canCreate = (cal: CalendarSettings | undefined, available: boolean | undefined) => !!available && !!cal?.outlook;

/** People invited besides the organizer (0 when their names are not known). */
export function invited(e: CalendarEvent): number {
  const organizer = attendeeName(e.organizer).toLowerCase();
  return e.attendees.filter((a) => a.trim() && attendeeName(a).toLowerCase() !== organizer).length;
}

/** `09:00–10:30` of local times. */
const span = (start: string, end: string) => `${time(start)}–${time(end)}`;

/**
 * Writing is on, or the user switches it on now (the offer on first use). Settings → Kalender has
 * the same switch.
 */
export async function writesOn(): Promise<boolean> {
  const s = useApp.getState;
  if (s().settings?.settings.calendar.entries_outlook) return true;
  const ok = await s().confirm({ title: tr("entries.offerTitle"), message: tr("entries.offerText"), confirmLabel: tr("entries.offerOn") });
  if (!ok) return false;
  try {
    await api.calendarEntriesEnable(true);
    await s().refreshSettings();
    return true;
  } catch (e) {
    s().error(tr("entries.enableFailed"), e);
    return false;
  }
}

/** Asks before Outlook sends the change of an organized meeting to its attendees; `null`: cancelled. */
async function confirmSend(e: CalendarEvent): Promise<boolean | null> {
  if (e.editable !== "confirm") return false;
  const n = invited(e);
  const ok = await useApp.getState().confirm({
    title: n > 0 ? tr("entries.sendTitle", { n }) : tr("entries.sendTitleAll"),
    message: tr("entries.sendText"),
    confirmLabel: tr("entries.send"),
  });
  return ok ? true : null;
}

type Local = (key: string, e: CalendarEvent | null) => void;

/** Saves a change (shown at once, back when it fails or the update is not confirmed). */
export async function saveEntry(e: CalendarEvent, patch: EntryFields, local: Local): Promise<CalendarEvent | null> {
  const s = useApp.getState;
  const send = await confirmSend(e);
  if (send === null) {
    local(e.key, e);
    return null;
  }
  local(e.key, { ...e, ...patch, write: e.write ?? { op: "update", state: "pending", error: null, outlook: null, mine: null, send } });
  try {
    const saved = await api.calendarEntryUpdate(e.key, patch, send);
    local(e.key, saved);
    return saved;
  } catch (err) {
    local(e.key, e);
    s().error(tr("entries.saveFailed"), err);
    return null;
  }
}

/** Deletes an appointment (to Outlook's Deleted Items); the message brings it back. */
export async function deleteEntry(e: CalendarEvent, local: Local) {
  const s = useApp.getState;
  local(e.key, null);
  try {
    await api.calendarEntryDelete(e.key);
    s().toast({
      tone: "info",
      title: tr("entries.deleted"),
      detail: tr("entries.deletedText", { title: e.title }),
      action: {
        label: tr("common.undo"),
        run: () =>
          void api
            .calendarEntryUndo(e.key)
            .then((back) => local(back.key, back))
            .catch((err) => s().error(tr("entries.undoFailed"), err)),
      },
    });
  } catch (err) {
    local(e.key, e);
    s().error(tr("entries.deleteFailed"), err);
  }
}

interface Drag {
  mode: "move" | "resize";
  x: number;
  y: number;
  colWidth: number;
  minutes: number;
  days: number;
  active: boolean;
}

/**
 * An appointment that can be changed, in the time grid: a click opens it, dragging moves it (also
 * to another day), the handle at its foot changes its length; the keyboard does the same.
 */
export function EntryItem(props: {
  event: CalendarEvent;
  className: string;
  style: CSSProperties;
  hourPx: number;
  dayIndex: number;
  dayCount: number;
  label: string;
  tooltip: string;
  selected: boolean;
  onSelect: (key: string) => void;
  onChange: (e: CalendarEvent, p: { start: string; end: string }) => void;
  onDelete: (e: CalendarEvent) => void;
  children: (shown: { start: string; end: string }) => ReactNode;
}) {
  const t = useT();
  const { event: e, hourPx } = props;
  const [drag, setDrag] = useState<Drag | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  // A drag ends with a click on the same element: that click must not open the appointment.
  const dragged = useRef(false);

  const down = (ev: ReactPointerEvent<HTMLDivElement>) => {
    if (ev.button !== 0) return;
    const resize = (ev.target as HTMLElement).closest(".calv-entry-handle") != null;
    const col = ref.current?.closest(".calv-col");
    ev.stopPropagation();
    dragged.current = false;
    ref.current?.setPointerCapture?.(ev.pointerId);
    setDrag({ mode: resize ? "resize" : "move", x: ev.clientX, y: ev.clientY, colWidth: col?.getBoundingClientRect().width ?? 1, minutes: 0, days: 0, active: false });
  };
  const move = (ev: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    const dy = ev.clientY - drag.y;
    const dx = ev.clientX - drag.x;
    const active = drag.active || Math.abs(dy) > 3 || Math.abs(dx) > 3;
    const minutes = Math.round(((dy / hourPx) * 60) / SNAP) * SNAP;
    const days = drag.mode === "move" ? Math.max(-props.dayIndex, Math.min(props.dayCount - 1 - props.dayIndex, Math.round(dx / drag.colWidth))) : 0;
    if (active !== drag.active || minutes !== drag.minutes || days !== drag.days) setDrag({ ...drag, active, minutes, days });
  };
  const up = (ev: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    ref.current?.releasePointerCapture?.(ev.pointerId);
    setDrag(null);
    if (!drag.active) return;
    dragged.current = true;
    if (!drag.minutes && !drag.days) return;
    props.onChange(e, drag.mode === "move" ? moved(e, drag.minutes, drag.days) : resized(e, drag.minutes));
  };
  const click = () => {
    if (dragged.current) {
      dragged.current = false;
      return;
    }
    props.onSelect(e.key);
  };
  const key = (ev: ReactKeyboardEvent<HTMLDivElement>) => {
    if (isComposing(ev) || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    let p: { start: string; end: string } | null = null;
    if (ev.key === "ArrowUp" || ev.key === "ArrowDown") {
      const d = ev.key === "ArrowUp" ? -SNAP : SNAP;
      p = ev.shiftKey ? resized(e, d) : moved(e, d);
    } else if (ev.key === "ArrowLeft" || ev.key === "ArrowRight") {
      const d = ev.key === "ArrowLeft" ? -1 : 1;
      if (props.dayIndex + d < 0 || props.dayIndex + d >= props.dayCount) return;
      p = moved(e, 0, d);
    } else if (ev.key === "Enter" || ev.key === " " || ev.key === "F2") {
      ev.preventDefault();
      props.onSelect(e.key);
      return;
    } else if ((ev.key === "Delete" || ev.key === "Backspace") && e.editable === "yes") {
      ev.preventDefault();
      props.onDelete(e);
      return;
    }
    if (!p) return;
    ev.preventDefault();
    props.onChange(e, p);
  };

  const shift = drag?.active ? drag : null;
  const top = Number(props.style.top ?? 0) + (shift?.mode === "move" ? (shift.minutes / 60) * hourPx : 0);
  const height = Math.max(hourPx / 4 - 2, Number(props.style.height ?? 0) + (shift?.mode === "resize" ? (shift.minutes / 60) * hourPx : 0));
  const shown = shift ? (shift.mode === "move" ? moved(e, shift.minutes, shift.days) : resized(e, shift.minutes)) : { start: e.start, end: e.end };
  return (
    <div
      ref={ref}
      role="button"
      tabIndex={0}
      data-key={e.key}
      className={`${props.className} calv-appt ${drag?.active ? "dragging" : ""}`}
      style={{ ...props.style, top, height, transform: shift?.days ? `translateX(${shift.days * shift.colWidth}px)` : undefined }}
      aria-label={props.label}
      aria-description={t("blocks.keys")}
      aria-expanded={props.selected}
      aria-controls={props.selected ? "calv-detail" : undefined}
      data-tooltip-full={drag ? undefined : props.tooltip}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={() => setDrag(null)}
      onClick={click}
      onKeyDown={key}
    >
      {props.children(shown)}
      <span className="calv-entry-handle" aria-hidden title={t("blocks.resize")} />
    </div>
  );
}

/** The stretch of a new appointment in the grid (while dragging, and while its panel is open). */
export function EntryGhost({ start, end, hourPx }: { start: Date; end: Date; hourPx: number }) {
  const t = useT();
  const day = new Date(start.getFullYear(), start.getMonth(), start.getDate()).getTime();
  const top = ((start.getTime() - day) / 3_600_000) * hourPx;
  const height = Math.max(12, ((end.getTime() - start.getTime()) / 3_600_000) * hourPx - 2);
  return (
    <div className="calv-entry-ghost" style={{ top, height }} aria-hidden>
      <span className="ellipsis">{t("entries.new")}</span>
      <span className="num">{span(start.toISOString(), end.toISOString())}</span>
    </div>
  );
}

/** `HH:MM` of a local time. */
const hm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

/**
 * Date, start and end of an appointment in the app's formats; `onCommit` gets the new times when
 * the focus leaves them (a new start keeps the length, a day picked in the calendar applies at once).
 */
function WhenInputs({ start, end, onCommit }: { start: Date; end: Date; onCommit: (s: Date, e: Date) => void }) {
  const t = useT();
  const [date, setDate] = useState(isoDay(start));
  const [from, setFrom] = useState(hm(start));
  const [to, setTo] = useState(hm(end));
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setDate(isoDay(start));
    setFrom(hm(start));
    setTo(hm(end));
  }, [start.getTime(), end.getTime()]);
  const commit = (next: { date?: string } = {}) => {
    const r = editedTimes(start, end, { date: next.date ?? date, from, to });
    if (r) onCommit(r.start, r.end);
  };
  return (
    <div
      ref={box}
      className="calv-entry-when"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) commit();
      }}
    >
      <DateInput
        aria-label={t("entries.date")}
        value={date}
        onChange={(iso) => {
          setDate(iso);
          if (!box.current?.contains(document.activeElement)) commit({ date: iso });
        }}
      />
      <TimeInput aria-label={t("entries.start")} value={from} onChange={setFrom} />
      <span className="faint" aria-hidden>
        –
      </span>
      <TimeInput aria-label={t("entries.end")} value={to} onChange={setTo} />
    </div>
  );
}

/** The own Outlook calendars new appointments can go to. */
export function targetCalendars(cal: CalendarSettings | undefined) {
  return (cal?.outlook_calendars ?? []).filter((c) => c.enabled && !c.free_busy && (c.kind === "own" || c.kind === "file") && (c.default || c.entry_id));
}

/** The panel of a new appointment: title, date and times, place, calendar. */
export function EntryEditor({ draft, cal, onChange, onClose, onCreated }: { draft: { start: Date; end: Date }; cal: CalendarSettings | undefined; onChange: (d: { start: Date; end: Date }) => void; onClose: () => void; onCreated: (e: CalendarEvent) => void }) {
  const t = useT();
  const [title, setTitle] = useState("");
  const [location, setLocation] = useState("");
  const targets = targetCalendars(cal);
  const [source, setSource] = useState(() => (targets.some((c) => c.id === cal?.entry_target) ? cal!.entry_target! : "outlook"));
  const [busy, setBusy] = useState(false);
  const create = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const e = await api.calendarEntryCreate({ source, title: title.trim() || tr("entries.new"), start: draft.start.toISOString(), end: draft.end.toISOString(), location: location.trim() });
      onCreated(e);
    } catch (err) {
      useApp.getState().error(t("entries.createFailed"), err);
    } finally {
      setBusy(false);
    }
  };
  const keys = (e: ReactKeyboardEvent) => {
    if (isComposing(e)) return;
    if (e.key === "Enter") (e.preventDefault(), void create());
    if (e.key === "Escape") (e.preventDefault(), e.stopPropagation(), onClose());
  };
  return (
    <aside className="calv-detail calv-entry-editor" id="calv-detail" aria-label={t("entries.editor")} onKeyDown={keys}>
      <div className="calv-detail-head">
        <span className="calv-detail-source">
          <Plus size={13} aria-hidden />
          <span className="ellipsis">{t("entries.editor")}</span>
        </span>
        <IconButton icon={X} label={t("calv.closeEsc")} size="sm" onClick={onClose} />
      </div>
      <div className="calv-detail-top">
        <Input autoFocus className="calv-entry-name" value={title} placeholder={t("entries.titlePlaceholder")} aria-label={t("entries.title")} onChange={(e) => setTitle(e.target.value)} />
        <WhenInputs start={draft.start} end={draft.end} onCommit={(start, end) => onChange({ start, end })} />
      </div>
      <section className="calv-detail-sec calv-entry-fields">
        <Input value={location} placeholder={t("entries.locationPlaceholder")} aria-label={t("entries.location")} onChange={(e) => setLocation(e.target.value)} />
        {targets.length > 1 && (
          <Select aria-label={t("entries.calendar")} value={source} onChange={(e) => setSource(e.target.value)} options={targets.map((c) => ({ value: c.id, label: sourceName(c.id, cal) }))} />
        )}
      </section>
      <div className="calv-detail-actions calv-entry-actions">
        <Button variant="primary" icon={Plus} loading={busy} onClick={() => void create()}>
          {t("entries.create")}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          {t("common.cancel")}
        </Button>
      </div>
    </aside>
  );
}

/** The title of an appointment that can be changed, in its panel. */
export function EntryTitle({ e, onSave }: { e: CalendarEvent; onSave: (p: EntryFields) => void }) {
  const t = useT();
  const [title, setTitle] = useState(e.title);
  useEffect(() => setTitle(e.title), [e.key, e.title]);
  const save = () => {
    const v = title.trim();
    if (v && v !== e.title) onSave({ title: v });
    else setTitle(e.title);
  };
  return (
    <Input
      className="calv-entry-name"
      value={title}
      aria-label={t("entries.title")}
      onChange={(ev) => setTitle(ev.target.value)}
      onBlur={save}
      onKeyDown={(ev) => {
        if (isComposing(ev)) return;
        if (ev.key === "Enter") (ev.preventDefault(), (ev.target as HTMLInputElement).blur());
        if (ev.key === "Escape") (ev.stopPropagation(), setTitle(e.title));
      }}
    />
  );
}

/** Date and times of an appointment that can be changed, and its place. */
export function EntryFieldsEdit({ e, onSave }: { e: CalendarEvent; onSave: (p: EntryFields) => void }) {
  const t = useT();
  const [location, setLocation] = useState(e.location);
  useEffect(() => setLocation(e.location), [e.key, e.location]);
  return (
    <>
      {!e.all_day && <WhenInputs start={new Date(e.start)} end={new Date(e.end)} onCommit={(s, en) => onSave({ start: s.toISOString(), end: en.toISOString() })} />}
      <Input
        className="calv-entry-place"
        value={location}
        placeholder={t("entries.locationPlaceholder")}
        aria-label={t("entries.location")}
        onChange={(ev) => setLocation(ev.target.value)}
        onBlur={() => location.trim() !== e.location && onSave({ location: location.trim() })}
        onKeyDown={(ev) => {
          if (isComposing(ev)) return;
          if (ev.key === "Enter") (ev.preventDefault(), (ev.target as HTMLInputElement).blur());
          if (ev.key === "Escape") (ev.stopPropagation(), setLocation(e.location));
        }}
      />
    </>
  );
}

const FIELD_LABELS: Record<keyof EntryFields, TKey> = { title: "entries.title", start: "entries.start", end: "entries.end", location: "entries.location" };

/** A field's value as shown in the conflict. */
function fieldText(k: keyof EntryFields, v: string | undefined) {
  if (v == null) return "";
  return k === "start" || k === "end" ? `${new Date(v).toLocaleDateString(undefined, { day: "numeric", month: "numeric" })} ${time(v)}` : v || "–";
}

/** What waits for Outlook, a conflict to settle, why the appointment cannot be changed, and its actions. */
export function EntryState({ e, onLocal }: { e: CalendarEvent; onLocal: Local }) {
  const t = useT();
  const s = useApp.getState;
  const [busy, setBusy] = useState<"" | "retry" | "outlook" | "mine" | "show" | "discard">("");
  const run = async (what: typeof busy, fn: () => Promise<unknown>, failed: TKey) => {
    setBusy(what);
    try {
      await fn();
    } catch (err) {
      s().error(t(failed), err);
    } finally {
      setBusy("");
    }
  };
  const w = e.write;
  const ro = e.editable ? READ_ONLY[e.editable] : undefined;
  const outlook = e.source === "outlook" || e.source.startsWith("outlook:");
  const conflictFields = w?.state === "conflict" ? (Object.keys(FIELD_LABELS) as (keyof EntryFields)[]).filter((k) => w.outlook?.[k] != null) : [];
  // A change that failed or that Outlook refused can be dropped: the appointment shows as Outlook has it.
  const discard = (
    <Button size="sm" variant="ghost" icon={Undo2} loading={busy === "discard"} onClick={() => void run("discard", () => api.calendarEntryDiscard(e.key), "entries.discardFailed")}>
      {t("entries.discard")}
    </Button>
  );
  return (
    <section className="calv-detail-sec calv-entry-state">
      {w?.state === "pending" && (
        <div className="calv-entry-note pending" role="status" data-write="pending">
          <CalendarClock size={14} aria-hidden />
          <span>
            {t("entries.pending")}
            {w.error && <span className="faint small calv-block-error">{w.error}</span>}
          </span>
          <Button size="sm" variant="ghost" icon={RefreshCw} loading={busy === "retry"} onClick={() => void run("retry", () => api.calendarEntriesRetry(), "entries.saveFailed")}>
            {t("blocks.retry")}
          </Button>
          {w.error && discard}
        </div>
      )}
      {w?.state === "refused" && (
        <div className="calv-entry-note conflict" role="status" data-write="refused">
          <AlertTriangle size={14} aria-hidden />
          <span>
            <b>{t("entries.refused")}</b>
            {w.error && <span className="faint small calv-block-error">{w.error}</span>}
          </span>
          {discard}
        </div>
      )}
      {w?.state === "conflict" && (
        <div className="calv-entry-conflict" role="status" data-write="conflict">
          <div className="calv-entry-note conflict">
            <AlertTriangle size={14} aria-hidden />
            <span>
              <b>{t("entries.conflict")}</b>
              <span className="faint small calv-block-error">{t("entries.conflictText")}</span>
            </span>
          </div>
          <dl className="calv-entry-diff">
            {conflictFields.map((k) => (
              <div key={k}>
                <dt>{t(FIELD_LABELS[k])}</dt>
                <dd>
                  <span className="faint">{t("entries.inOutlook")}</span> {fieldText(k, w.outlook?.[k])}
                </dd>
                <dd>
                  <span className="faint">{t("entries.mine")}</span> {fieldText(k, w.mine?.[k])}
                </dd>
              </div>
            ))}
          </dl>
          <div className="calv-entry-choice">
            <Button size="sm" loading={busy === "outlook"} onClick={() => void run("outlook", () => api.calendarEntryResolve(e.key, false), "entries.resolveFailed")}>
              {t("entries.takeOutlook")}
            </Button>
            <Button size="sm" loading={busy === "mine"} onClick={() => void run("mine", () => api.calendarEntryResolve(e.key, true), "entries.resolveFailed")}>
              {t("entries.keepMine")}
            </Button>
          </div>
        </div>
      )}
      {e.editable === "confirm" && (
        <div className="calv-entry-note">
          <Lock size={14} aria-hidden />
          <span>{t("entries.confirmNote")}</span>
        </div>
      )}
      {ro && (
        <div className="calv-entry-note" data-readonly={e.editable}>
          <Lock size={14} aria-hidden />
          <span>{t(ro)}</span>
        </div>
      )}
      {e.editable === "off" && (
        <div className="calv-entry-note">
          <Lock size={14} aria-hidden />
          <span>{t("entries.offText")}</span>
          <Button size="sm" variant="ghost" onClick={() => void writesOn()}>
            {t("entries.offerOn")}
          </Button>
        </div>
      )}
      <div className="calv-entry-buttons">
        {outlook && e.outlook_id && (
          <Button size="sm" variant="ghost" icon={ExternalLink} loading={busy === "show"} onClick={() => void run("show", () => api.calendarEntryShow(e.key), "entries.showFailed")}>
            {e.editable === "confirm" ? t("entries.cancelInOutlook") : t("entries.openInOutlook")}
          </Button>
        )}
        {e.editable === "yes" && (
          <Button size="sm" variant="ghost" icon={Trash2} className="calv-entry-delete" onClick={() => void deleteEntry(e, onLocal)}>
            {t("common.delete")}
          </Button>
        )}
      </div>
    </section>
  );
}

/** `Termin Titel, 09:00–10:00` for the grid's appointment. */
export const entryLabel = (e: CalendarEvent) => tr("entries.label", { title: e.title, time: span(e.start, e.end) });
