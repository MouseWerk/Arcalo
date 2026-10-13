// The Android app's switch between the phone app (`mobile.html`) and the full app (`index.html`),
// 1.20. At the start each page asks once which interface fits (`bootInterface`) and goes over to
// the other page before it shows anything; while it runs it follows the window (`followInterface`):
// resized, moved to another display, a mouse or keyboard plugged in (ShellPlugin.kt announces
// those as the event `arcalo-display`), or the setting changed. Before it goes over, the unsaved
// text is stored (`flush`); a switch waits while a field outside the editors is being typed in or a
// dialog is open, and stops for the session after too many switches (`switchAllowed`).
//
// Both interfaces use the same workspace in the same process: switching loads the other page,
// nothing is copied.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { chooseInterface, factsFromViewport, pageOf, switchAllowed, type DisplayFacts, type Interface, type InterfaceChoice } from "./uimode";

interface AndroidDisplay {
  facts: DisplayFacts | null;
  choice: InterfaceChoice;
}

const TIMES_KEY = "arcalo.uiswitch.times";
/** The event a page sends itself when the setting changed (and ShellPlugin.kt on a window change). */
export const DISPLAY_EVENT = "arcalo-display";

function readTimes(): number[] {
  try {
    const v = JSON.parse(sessionStorage.getItem(TIMES_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "number") : [];
  } catch {
    return [];
  }
}

function noteSwitch(now: number): void {
  try {
    sessionStorage.setItem(TIMES_KEY, JSON.stringify([...readTimes(), now].slice(-6)));
  } catch {
    // No session storage: no limit either (the decision itself does not flap, uimode.ts).
  }
}

/** The interface for the window and the device now. */
export async function decide(current: Interface): Promise<Interface> {
  let display: AndroidDisplay | null = null;
  try {
    display = await invoke<AndroidDisplay>("android_display");
  } catch {
    display = null;
  }
  const facts = display?.facts ?? factsFromViewport(window);
  return chooseInterface(display?.choice ?? "auto", facts, current);
}

/** Leaves for the other page (replacing this one, so Android's back button never returns to it). */
function go(target: Interface): void {
  noteSwitch(Date.now());
  location.replace(pageOf(target));
}

/**
 * At the start: the interface this page should show. When it is the other one, the page goes over
 * and this resolves to `null` (the caller renders nothing).
 */
export async function bootInterface(current: Interface): Promise<Interface | null> {
  const want = await decide(current);
  if (want === current || !switchAllowed(readTimes(), Date.now())) return current;
  go(want);
  return null;
}

/** Typing in a field whose text no flush stores (a dialog's field, a search box): wait for it. */
function typingElsewhere(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el || el.closest("[data-flush], .ProseMirror, .cm-editor")) return false;
  const field = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value.trim() !== "" : el.isContentEditable;
  return field || !!document.querySelector("[role='dialog'][aria-modal='true'], dialog[open]");
}

/**
 * Follows the window while the page runs; `flush` stores the unsaved text and resolves to false
 * when it could not (the page then stays). Returns the clean-up.
 */
export function followInterface(current: Interface, flush: () => Promise<boolean>): () => void {
  let timer = 0;
  let busy = false;
  const check = async () => {
    if (busy || document.visibilityState === "hidden") return;
    busy = true;
    try {
      const want = await decide(current);
      if (want === current || !switchAllowed(readTimes(), Date.now())) return;
      if (typingElsewhere()) {
        schedule(2000);
        return;
      }
      if (!(await flush())) {
        schedule(5000);
        return;
      }
      go(want);
    } finally {
      busy = false;
    }
  };
  // A window being dragged to a new size reports many sizes: decided once it rests.
  const schedule = (ms = 600) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void check(), ms);
  };
  const now = () => schedule(0);
  const onVisible = () => document.visibilityState === "visible" && schedule(300);
  const pointer = window.matchMedia?.("(any-pointer: fine)");
  const onResize = () => schedule();
  window.addEventListener("resize", onResize);
  window.addEventListener(DISPLAY_EVENT, now);
  document.addEventListener("visibilitychange", onVisible);
  pointer?.addEventListener?.("change", now);
  // The setting „Oberfläche auf Android“ saved (here, in the other interface's settings, or by a sync).
  const settings = listen("settings://changed", now).catch(() => null);
  return () => {
    void settings.then((off) => off?.());
    window.clearTimeout(timer);
    window.removeEventListener("resize", onResize);
    window.removeEventListener(DISPLAY_EVENT, now);
    document.removeEventListener("visibilitychange", onVisible);
    pointer?.removeEventListener?.("change", now);
  };
}

/** Asks the page to check again at once (the setting „Oberfläche“ changed). */
export function interfaceSettingChanged(): void {
  window.dispatchEvent(new Event(DISPLAY_EVENT));
}
