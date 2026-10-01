// Focus sessions (Pomodoro): the start dialog, the countdown engine and the status bar ring
// (the start-page widget is in components/dashboard). The session itself lives in the core (it
// survives restarts); the UI counts down, completes it on time and shows what was booked and held back.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Coffee, Play, Square, Target, X } from "lucide-react";
import { api, on } from "../lib/api";
import { useApp } from "../store/app";
import { timeTrackingEnabled, useTimeTracking } from "../lib/timetracking";
import { Button, Dialog, Field, Input, Segmented, Switch, useMenu } from "./ui";
import { zeitRefItems } from "../editor/zeit-source";
import type { ZeitSuggestItem } from "../editor/extensions";
import { BREAKS, LENGTHS, countdown, lastChoice, parseMinutes, phaseProgress, remainingMs, saveChoice, sessionSummary, type FocusChoice } from "../lib/focus";
import type { FocusDone } from "../lib/types";
import { t as tr, useT } from "../lib/i18n";

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
    s().error(tr("focus.notLoaded"), e);
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
  const { title, detail } = sessionSummary(done, held, done.held, timeTrackingEnabled());
  s().toast({
    tone: done.session.status === "done" ? "success" : "info",
    title,
    detail: detail || undefined,
    urgent: true,
    persistent: held.length > 0 || done.held.length > 0,
    action: { label: tr("focus.next"), run: () => void nextSession() },
  });
  s().bumpEntries();
}

export async function startFocus(c: FocusChoice) {
  try {
    saveChoice(c);
    // Time tracking off: focus sessions without a Vorgang (nothing is booked).
    const reference = timeTrackingEnabled() ? c.reference.trim() : "";
    const st = await api.focusStart({ reference, minutes: c.minutes, break_minutes: c.breakMinutes, goal: c.goal.trim() });
    s().set({ focus: st, heldToasts: [], focusDialog: null });
    if (c.focusMode && !s().focusMode) {
      focusModeBySession = true;
      s().set({ focusMode: true });
    }
  } catch (e) {
    s().error(tr("focus.notStarted"), e);
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
  if (f.session.reference && minutes >= 1 && timeTrackingEnabled()) {
    const choice = await s().choose({
      title: tr("focus.abortTitle"),
      message: tr("focus.abortMessage", { n: minutes, ref: f.session.reference }),
      confirmLabel: tr("focus.bookMinutes", { n: minutes }),
      altLabel: tr("focus.dontBook"),
      cancelLabel: tr("focus.keepWorking"),
    });
    if (choice === "cancel") return;
    book = choice === "confirm";
  } else if (!(await s().confirm({ title: tr("focus.abortTitle"), message: tr("focus.abortEnds"), confirmLabel: tr("focus.abort"), cancelLabel: tr("focus.keepWorking") }))) return;
  try {
    const done = await api.focusAbort(book);
    s().set({ focus: null });
    showDone(done);
  } catch (e) {
    s().error(tr("focus.notEnded"), e);
    void reload();
  }
}

export async function endBreak() {
  try {
    await api.focusEndBreak();
    s().set({ focus: null });
  } catch (e) {
    s().error(tr("focus.breakNotEnded"), e);
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
        s().toast({ tone: "info", title: tr("focus.breakOver"), urgent: true, action: { label: tr("focus.next"), run: () => void nextSession() } });
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
  useT();
  const focus = useApp((st) => st.focus);
  const focusMode = useApp((st) => st.focusMode);
  const held = useApp((st) => st.heldToasts.length);
  const now = useNow(!!focus);
  const [menu, , openMenuAt] = useMenu();
  if (!focus) return null;
  const work = focus.phase === "work";
  const left = countdown(remainingMs(focus, now));
  const label = work
    ? focus.session.reference
      ? tr("focus.statusOn", { left, ref: focus.session.reference })
      : tr("focus.status", { left })
    : tr("focus.breakStatus", { left });
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
                  { label: tr("focus.menuAbort"), icon: Square, onSelect: () => void abortFocus() },
                  { label: focusMode ? tr("focus.modeOff") : tr("focus.modeOn"), icon: Target, onSelect: () => s().set({ focusMode: !focusMode }) },
                ]
              : [
                  { label: tr("focus.startNext"), icon: Play, onSelect: () => void nextSession() },
                  { label: tr("focus.other"), icon: Target, onSelect: () => openFocusDialog() },
                  { label: tr("focus.endBreak"), icon: X, onSelect: () => void endBreak() },
                ],
          )
        }
      >
        {work ? <FocusRing progress={phaseProgress(focus, now)} /> : <Coffee size={12} />}
        <span className="num sb-focus-time">{left}</span>
        {work && focus.session.reference && <span className="faint">{focus.session.reference}</span>}
        {work && held > 0 && <span className="sb-focus-held" title={tr("focus.heldCount", { n: held })}>{held}</span>}
      </button>
      {menu}
    </>
  );
}

// ------------------------------------------------------------------ dialog

/** Vorgang input with the `/zeit` suggestions (recently booked first). */
function RefCombo({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  useT();
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
        aria-label={tr("focus.ref")}
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
  useT();
  const last = useMemo(lastChoice, []);
  const timer = useApp((st) => st.timer);
  const timeOn = useTimeTracking();
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
      title={tr("focus.dialogTitle")}
      description={tr(timeOn ? "focus.dialogDesc" : "tt.focusDesc")}
      width={500}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            {tr("common.cancel")}
          </Button>
          <Button variant="primary" icon={Play} onClick={start} disabled={minutes == null} loading={busy}>
            {tr("focus.start")}
          </Button>
        </>
      }
    >
      <div className="focus-form" onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT" && !e.defaultPrevented && (e.preventDefault(), start())}>
        {timeOn && (
          <Field label={tr("focus.ref")} hint={reference.trim() ? undefined : tr("focus.noRefHint")}>
            <RefCombo value={reference} onChange={setReference} />
          </Field>
        )}
        <Field label={tr("focus.goal")}>
          <Input value={goal} onChange={(e) => setGoal(e.target.value)} placeholder={tr("focus.goalPh")} aria-label={tr("focus.goal")} data-autofocus={preset.reference || !timeOn ? true : undefined} />
        </Field>
        <div className="focus-row">
          <Field label={tr("focus.length")}>
            <span className="focus-length">
              <Segmented
                label={tr("focus.length")}
                value={length}
                onChange={setLength}
                options={[...LENGTHS.map((m) => ({ value: String(m), label: tr("focus.minutes", { n: m }) })), { value: "custom", label: tr("focus.custom") }]}
              />
              {length === "custom" && (
                <Input className="num focus-custom" value={custom} onChange={(e) => setCustom(e.target.value)} aria-label={tr("focus.customAria")} aria-invalid={minutes == null} />
              )}
            </span>
          </Field>
          <Field label={tr("focus.break")}>
            <Segmented label={tr("focus.break")} value={pause} onChange={setPause} options={BREAKS.map((m) => ({ value: String(m), label: tr("focus.minutes", { n: m }) }))} />
          </Field>
        </div>
        <div className="focus-switch">
          <Switch checked={focusMode} onChange={setFocusMode} label={tr("focus.modeDuring")} />
          <span>{tr("focus.modeDuring")}</span>
          <span className="faint small">{tr("focus.modeDuringSub")}</span>
        </div>
        {timer && timeOn && <p className="faint small focus-note">{tr("focus.timerNote")}</p>}
      </div>
    </Dialog>
  );
}


