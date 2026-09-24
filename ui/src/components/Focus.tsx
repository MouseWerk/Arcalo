// Focus sessions (Pomodoro): the start dialog, the countdown engine, the status bar ring and
// the start-page widget. The session itself lives in the core (it survives restarts); the UI
// counts down, completes it on time and shows what was booked and held back.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Coffee, NotebookPen, Play, Square, Target, X } from "lucide-react";
import { api, on } from "../lib/api";
import { useApp } from "../store/app";
import { Button, Dialog, Field, Input, Segmented, Switch, useMenu } from "./ui";
import { zeitRefItems } from "../editor/zeit-source";
import type { ZeitSuggestItem } from "../editor/extensions";
import { BREAKS, LENGTHS, countdown, hm, lastChoice, parseMinutes, phaseProgress, remainingMs, saveChoice, sessionSummary, type FocusChoice } from "../lib/focus";
import { addDays, isoDay, weekStart } from "../lib/format";
import { reloadEditors } from "../editor/NoteEditor";
import type { FocusDone, FocusReport } from "../lib/types";

const s = useApp.getState;

/** Opens the start dialog, optionally with a Vorgang and goal. */
export function openFocusDialog(preset: { reference?: string; goal?: string } = {}) {
  s().set({ focusDialog: preset });
}

/** The focus mode was switched on by the session (and is switched off with it). */
let focusModeBySession = false;

async function reload() {
  try {
    const st = await api.focusState();
    s().set({ focus: st && !(st.phase === "break" && remainingMs(st, Date.now()) <= 0) ? st : null });
    if (st?.completed) showDone({ ...st.completed, held: st.held ?? [] });
  } catch (e) {
    s().error("Fokussitzung nicht geladen", e);
  }
}

/** The message after a session: booked minutes, break and the held-back notifications. */
function showDone(done: FocusDone) {
  const held = s().heldToasts;
  s().set({ heldToasts: [] });
  if (focusModeBySession) {
    focusModeBySession = false;
    s().set({ focusMode: false });
  }
  const { title, detail } = sessionSummary(done, held);
  s().toast({
    tone: done.session.status === "done" ? "success" : "info",
    title,
    detail: detail || undefined,
    urgent: true,
    persistent: held.length > 0 || done.held.length > 0,
    action: { label: "Nächste Sitzung", run: () => void nextSession() },
  });
  s().bumpEntries();
}

export async function startFocus(c: FocusChoice) {
  try {
    saveChoice(c);
    const st = await api.focusStart({ reference: c.reference.trim(), minutes: c.minutes, break_minutes: c.breakMinutes, goal: c.goal.trim() });
    s().set({ focus: st, heldToasts: [], focusDialog: null });
    if (c.focusMode && !s().focusMode) {
      focusModeBySession = true;
      s().set({ focusMode: true });
    }
  } catch (e) {
    s().error("Fokussitzung nicht gestartet", e);
  }
}

/** The next session with the last choices. */
export async function nextSession() {
  await startFocus(lastChoice());
}

/** Ends the running session early; asks whether to book the minutes so far. */
export async function abortFocus() {
  const f = s().focus;
  if (!f || f.phase !== "work") return;
  const minutes = Math.round((Date.now() - new Date(f.session.started_at).getTime()) / 60_000);
  let book = false;
  if (f.session.reference && minutes >= 1) {
    const choice = await s().choose({
      title: "Fokussitzung abbrechen?",
      message: `Bisher ${minutes} Min. auf ${f.session.reference}. Soll diese Zeit gebucht werden?`,
      confirmLabel: `${minutes} Min. buchen`,
      altLabel: "Nicht buchen",
      cancelLabel: "Weiterarbeiten",
    });
    if (choice === "cancel") return;
    book = choice === "confirm";
  } else if (!(await s().confirm({ title: "Fokussitzung abbrechen?", message: "Die Sitzung wird beendet.", confirmLabel: "Abbrechen", cancelLabel: "Weiterarbeiten" }))) return;
  try {
    const done = await api.focusAbort(book);
    s().set({ focus: null });
    showDone(done);
  } catch (e) {
    s().error("Fokussitzung nicht beendet", e);
    void reload();
  }
}

export async function endBreak() {
  try {
    await api.focusEndBreak();
    s().set({ focus: null });
  } catch (e) {
    s().error("Pause nicht beendet", e);
  }
}

/** Loads the session at start, follows changes from elsewhere and completes it on time. */
export function useFocusEngine() {
  useEffect(() => {
    void reload();
    const un = [
      on("focus://changed", () => void reload()),
      // Completed by the shell (the window slept): same message as here.
      on<FocusDone>("focus://completed", (done) => {
        showDone(done);
        void reload();
      }),
    ];
    let finishing = false;
    const tick = window.setInterval(() => {
      const f = s().focus;
      if (!f || finishing || remainingMs(f, Date.now()) > 0) return;
      if (f.phase === "work") {
        finishing = true;
        api
          .focusFinish()
          .then((done) => {
            showDone(done);
            return reload();
          })
          .catch(() => reload())
          .finally(() => (finishing = false));
      } else {
        s().set({ focus: null });
        s().toast({ tone: "info", title: "Pause vorbei", urgent: true, action: { label: "Nächste Sitzung", run: () => void nextSession() } });
      }
    }, 500);
    return () => {
      window.clearInterval(tick);
      un.forEach((u) => u.then((f) => f()));
    };
  }, []);
}

/** Re-renders every `ms` while `on`. */
function useNow(on: boolean, ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [on, ms]);
  return now;
}

export function FocusRing({ progress, size = 14, stroke = 2, tone = "accent" }: { progress: number; size?: number; stroke?: number; tone?: "accent" | "break" }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <svg className={`focus-ring focus-ring-${tone}`} width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
      <circle className="focus-ring-track" cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} fill="none" />
      <circle
        className="focus-ring-fill"
        cx={size / 2}
        cy={size / 2}
        r={r}
        strokeWidth={stroke}
        fill="none"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - progress)}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}

/** Status bar: ring, remaining time and Vorgang; a click opens the session menu. */
export function FocusStatus() {
  const focus = useApp((st) => st.focus);
  const focusMode = useApp((st) => st.focusMode);
  const held = useApp((st) => st.heldToasts.length);
  const now = useNow(!!focus);
  const [menu, , openMenuAt] = useMenu();
  if (!focus) return null;
  const work = focus.phase === "work";
  const left = countdown(remainingMs(focus, now));
  const label = work ? `Fokus: noch ${left}${focus.session.reference ? ` auf ${focus.session.reference}` : ""}` : `Pause: noch ${left}`;
  return (
    <>
      <button
        type="button"
        className={`sb-item sb-focus ${work ? "work" : "break"}`}
        aria-label={label}
        title={focus.session.goal ? `${label} – ${focus.session.goal}` : label}
        onClick={(e) =>
          openMenuAt(
            e,
            work
              ? [
                  { label: "Sitzung abbrechen…", icon: Square, onSelect: () => void abortFocus() },
                  { label: focusMode ? "Fokusmodus beenden" : "Fokusmodus einschalten", icon: Target, onSelect: () => s().set({ focusMode: !focusMode }) },
                ]
              : [
                  { label: "Nächste Sitzung starten", icon: Play, onSelect: () => void nextSession() },
                  { label: "Andere Sitzung…", icon: Target, onSelect: () => openFocusDialog() },
                  { label: "Pause beenden", icon: X, onSelect: () => void endBreak() },
                ],
          )
        }
      >
        {work ? <FocusRing progress={phaseProgress(focus, now)} /> : <Coffee size={12} />}
        <span className="num sb-focus-time">{left}</span>
        {work && focus.session.reference && <span className="faint">{focus.session.reference}</span>}
        {work && held > 0 && <span className="sb-focus-held" title={`${held} Hinweise zurückgehalten`}>{held}</span>}
      </button>
      {menu}
    </>
  );
}

// ------------------------------------------------------------------ dialog

/** Vorgang input with the `/zeit` suggestions (recently booked first). */
function RefCombo({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [items, setItems] = useState<ZeitSuggestItem[]>([]);
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    zeitRefItems(value.trim())
      .then((r) => alive && (setItems(r.slice(0, 8)), setSel(0)))
      .catch(() => alive && setItems([]));
    return () => {
      alive = false;
    };
  }, [value, open]);
  const pick = (it: ZeitSuggestItem) => {
    onChange(it.insert);
    setOpen(false);
  };
  return (
    <div className="combo">
      <Input
        className="mono"
        value={value}
        placeholder="NP-8801/1020"
        aria-label="Vorgang"
        role="combobox"
        aria-expanded={open && items.length > 0}
        aria-autocomplete="list"
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 120)}
        onChange={(e) => (onChange(e.target.value), setOpen(true))}
        onKeyDown={(e) => {
          if (!open || !items.length) return;
          if (e.key === "ArrowDown") (e.preventDefault(), setSel((v) => (v + 1) % items.length));
          else if (e.key === "ArrowUp") (e.preventDefault(), setSel((v) => (v - 1 + items.length) % items.length));
          else if (e.key === "Enter" && items[sel] && items[sel].insert !== value) (e.preventDefault(), pick(items[sel]));
          else if (e.key === "Escape") (e.stopPropagation(), e.preventDefault(), setOpen(false));
        }}
      />
      {open && items.length > 0 && (
        <div className="combo-list" role="listbox" ref={list}>
          {items.map((it, i) => (
            <div
              key={it.id}
              role="option"
              aria-selected={i === sel}
              className={`combo-item ${i === sel ? "sel" : ""}`}
              onMouseDown={(e) => (e.preventDefault(), pick(it))}
              onMouseMove={() => sel !== i && setSel(i)}
            >
              <span className="combo-icon">{it.icon}</span>
              <span className="grow ellipsis">{it.title}</span>
              {it.hint && <span className="faint small num">{it.hint}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function FocusDialogHost() {
  const preset = useApp((st) => st.focusDialog);
  if (!preset) return null;
  return <FocusDialog preset={preset} />;
}

function FocusDialog({ preset }: { preset: { reference?: string; goal?: string } }) {
  const last = useMemo(lastChoice, []);
  const timer = useApp((st) => st.timer);
  const [reference, setReference] = useState(preset.reference ?? last.reference);
  const [goal, setGoal] = useState(preset.goal ?? (preset.reference ? "" : last.goal));
  const preset0 = LENGTHS.includes(last.minutes as (typeof LENGTHS)[number]) ? String(last.minutes) : "custom";
  const [length, setLength] = useState<string>(preset0);
  const [custom, setCustom] = useState(preset0 === "custom" ? String(last.minutes).replace(".", ",") : "35");
  const [pause, setPause] = useState<string>(BREAKS.includes(last.breakMinutes as (typeof BREAKS)[number]) ? String(last.breakMinutes) : "5");
  const [focusMode, setFocusMode] = useState(last.focusMode);
  const [busy, setBusy] = useState(false);
  const minutes = length === "custom" ? parseMinutes(custom) : Number(length);
  // Stable, so the dialog does not re-run its focus handling on every keystroke.
  const close = useCallback(() => s().set({ focusDialog: null }), []);
  const start = async () => {
    if (minutes == null || busy) return;
    setBusy(true);
    await startFocus({ reference, minutes, breakMinutes: Number(pause), goal, focusMode });
    setBusy(false);
  };
  return (
    <Dialog
      open
      onClose={close}
      title="Fokussitzung"
      description="Konzentriert arbeiten, dann Pause. Die Zeit wird als Entwurf auf den Vorgang gebucht; Hinweise warten bis zum Ende."
      width={500}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Abbrechen
          </Button>
          <Button variant="primary" icon={Play} onClick={start} disabled={minutes == null} loading={busy}>
            Starten
          </Button>
        </>
      }
    >
      <div className="focus-form" onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT" && !e.defaultPrevented && (e.preventDefault(), start())}>
        <Field label="Vorgang" hint={reference.trim() ? undefined : "Ohne Vorgang wird nichts gebucht."}>
          <RefCombo value={reference} onChange={setReference} />
        </Field>
        <Field label="Ziel">
          <Input value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="Woran arbeitest du?" aria-label="Ziel" data-autofocus={preset.reference ? true : undefined} />
        </Field>
        <div className="focus-row">
          <Field label="Länge">
            <span className="focus-length">
              <Segmented
                label="Länge"
                value={length}
                onChange={setLength}
                options={[...LENGTHS.map((m) => ({ value: String(m), label: `${m} Min.` })), { value: "custom", label: "Eigene" }]}
              />
              {length === "custom" && (
                <Input className="num focus-custom" value={custom} onChange={(e) => setCustom(e.target.value)} aria-label="Eigene Länge in Minuten" aria-invalid={minutes == null} />
              )}
            </span>
          </Field>
          <Field label="Pause">
            <Segmented label="Pause" value={pause} onChange={setPause} options={BREAKS.map((m) => ({ value: String(m), label: `${m} Min.` }))} />
          </Field>
        </div>
        <div className="focus-switch">
          <Switch checked={focusMode} onChange={setFocusMode} label="Fokusmodus während der Sitzung" />
          <span>Fokusmodus während der Sitzung</span>
          <span className="faint small">Seitenleiste, Panel und Leiste ausblenden</span>
        </div>
        {timer && <p className="faint small focus-note">Ein Timer läuft – die Fokuszeit wird zusätzlich gebucht.</p>}
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------------ widget

/** Start page „Fokus“: sessions and minutes today and this week, per Vorgang. */
export function FocusWidget() {
  const entriesVersion = useApp((st) => st.entriesVersion);
  const focus = useApp((st) => st.focus);
  const [today, setToday] = useState<FocusReport | null>(null);
  const [week, setWeek] = useState<FocusReport | null>(null);
  const [writing, setWriting] = useState(false);
  const now = useNow(!!focus, 1000);
  useEffect(() => {
    let alive = true;
    const d = new Date();
    const monday = weekStart(d);
    Promise.all([api.focusReport(isoDay(d), isoDay(d)), api.focusReport(isoDay(monday), isoDay(addDays(monday, 6)))])
      .then(([a, b]) => alive && (setToday(a), setWeek(b)))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [entriesVersion, focus?.session.id, focus?.phase]);
  const toNote = async () => {
    setWriting(true);
    try {
      const id = await api.focusDailyLine();
      await s().refreshTree();
      reloadEditors([id]);
      s().toast({ tone: "success", title: "In die Tagesnotiz eingetragen", action: { label: "Öffnen", run: () => s().openPage(id) } });
    } catch (e) {
      s().error("Nicht eingetragen", e);
    } finally {
      setWriting(false);
    }
  };
  if (!today || !week) return null;
  const max = Math.max(1, ...today.by_reference.map((r) => r.minutes));
  return (
    <div className="dw-focus">
      <div className="dw-focus-sum">
        <div>
          <span className="num dw-big">{today.sessions}</span>
          <span className="faint">{today.sessions === 1 ? "Sitzung" : "Sitzungen"} heute · {hm(today.minutes)}</span>
        </div>
        <span className="faint small num">Woche: {week.sessions} · {hm(week.minutes)}</span>
      </div>
      {focus ? (
        <div className={`dw-focus-live ${focus.phase}`}>
          <FocusRing progress={phaseProgress(focus, now)} size={22} stroke={2.5} tone={focus.phase === "work" ? "accent" : "break"} />
          <span className="num">{countdown(remainingMs(focus, now))}</span>
          <span className="faint ellipsis grow">{focus.phase === "work" ? focus.session.goal || focus.session.reference || "Fokus" : "Pause"}</span>
        </div>
      ) : today.by_reference.length === 0 ? (
        <div className="dw-empty">Heute noch keine Fokussitzung.</div>
      ) : null}
      {today.by_reference.length > 0 && (
        <ul className="dw-list dw-focus-list" aria-label="Fokus je Vorgang heute">
          {today.by_reference.slice(0, 4).map((r) => (
            <li key={r.reference || "-"}>
              <span className="mono ellipsis">{r.reference || "ohne Vorgang"}</span>
              <span className="dw-focus-bar" aria-hidden>
                <span style={{ width: `${(r.minutes / max) * 100}%` }} />
              </span>
              <span className="num faint">{hm(r.minutes)}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="dw-focus-actions">
        {!focus && (
          <Button size="sm" icon={Target} onClick={() => openFocusDialog()}>
            Fokus starten
          </Button>
        )}
        {today.sessions > 0 && (
          <Button size="sm" variant="ghost" icon={NotebookPen} onClick={toNote} loading={writing}>
            In Tagesnotiz
          </Button>
        )}
      </div>
    </div>
  );
}


