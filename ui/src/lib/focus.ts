// Focus sessions (Pomodoro): countdown, ring, the last choices and the summary after a session.

import type { FocusDone, FocusState, HeldNotification } from "./types";
import { parseGermanNumber } from "./format";

export const LENGTHS = [25, 50] as const;
export const BREAKS = [5, 10] as const;
/** Longest session in minutes (as in the core). */
export const MAX_MINUTES = 240;

/** Milliseconds left in the current phase. */
export function remainingMs(state: Pick<FocusState, "ends_at">, now: number): number {
  return Math.max(0, new Date(state.ends_at).getTime() - now);
}

/** Share of the current phase that is over, 0..1 (the ring). */
export function phaseProgress(state: FocusState, now: number): number {
  const end = new Date(state.ends_at).getTime();
  const start =
    state.phase === "work" ? new Date(state.session.started_at).getTime() : end - state.session.break_minutes * 60_000;
  const total = end - start;
  if (total <= 0) return 1;
  return Math.min(1, Math.max(0, (now - start) / total));
}

/** `24:59` (rounded up, so it never shows 00:00 while time is left); `1:05:00` above an hour. */
export function countdown(ms: number): string {
  const s = Math.ceil(Math.max(0, ms) / 1000);
  const h = Math.floor(s / 3600);
  const two = (x: number) => String(x).padStart(2, "0");
  return h ? `${h}:${two(Math.floor((s % 3600) / 60))}:${two(s % 60)}` : `${two(Math.floor(s / 60))}:${two(s % 60)}`;
}

/** A custom length in minutes („35“, „12,5“); null when it is not 1–240. */
export function parseMinutes(text: string): number | null {
  const n = parseGermanNumber(text.trim());
  return n != null && n >= 1 && n <= MAX_MINUTES ? n : null;
}

/** `100` → `1:40 h` (like the daily note line). */
export const hm = (minutes: number) => `${Math.floor(Math.max(0, minutes) / 60)}:${String(Math.max(0, Math.round(minutes)) % 60).padStart(2, "0")} h`;

export interface FocusChoice {
  reference: string;
  minutes: number;
  breakMinutes: number;
  goal: string;
  /** Switch on the focus mode (no sidebar, panel, ribbon) during the session. */
  focusMode: boolean;
}

const KEY = "annalo.focus.last";
export const DEFAULT_CHOICE: FocusChoice = { reference: "", minutes: 25, breakMinutes: 5, goal: "", focusMode: false };

/** The choices of the last session (the dialog starts with them). */
export function lastChoice(): FocusChoice {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (raw && typeof raw === "object") return { ...DEFAULT_CHOICE, ...raw };
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_CHOICE };
}
export function saveChoice(c: FocusChoice) {
  try {
    localStorage.setItem(KEY, JSON.stringify(c));
  } catch {
    /* ignore */
  }
}

/** Title and text of the message after a session: what was booked and what was held back. */
export function sessionSummary(done: FocusDone, heldToasts: { title: string }[], held: HeldNotification[] = done.held): { title: string; detail: string } {
  const s = done.session;
  const title = s.status === "done" ? (s.break_minutes > 0 ? `Pause – ${s.break_minutes} Min.` : "Fokussitzung geschafft") : "Fokussitzung beendet";
  const parts: string[] = [];
  const minutes = done.entry ? s.worked_minutes : 0;
  if (done.entry) parts.push(`${hm(minutes)} ${done.extended ? "zur Buchung addiert" : "gebucht"}${s.reference ? ` auf ${s.reference}` : ""} (Entwurf)`);
  else if (s.status === "done" && !s.reference) parts.push(`${hm(s.worked_minutes)} Fokus, ohne Vorgang nicht gebucht`);
  else if (s.status === "aborted") parts.push("Nicht gebucht");
  const titles = [...heldToasts.map((t) => t.title), ...held.map((h) => h.title)];
  if (titles.length) {
    const shown = titles.slice(0, 3).join(" · ");
    parts.push(`${titles.length} ${titles.length === 1 ? "Hinweis" : "Hinweise"} zurückgehalten: ${shown}${titles.length > 3 ? " …" : ""}`);
  }
  return { title, detail: parts.join(". ") };
}
