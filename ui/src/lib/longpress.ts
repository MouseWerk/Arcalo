// A long press opens the context menu on a touch screen (1.20, the full app on Android): the
// app's menus listen to `contextmenu`, which a mouse sends with its right button. Android's
// WebView sends one after a long press on most elements, but not everywhere and not on every
// version; this sends it when the WebView did not, and drops the WebView's own when it comes
// after ours (one menu per press). Text fields and the editor keep Android's long press: it
// selects a word and shows the system's text tools.

/** How long a finger rests before the menu opens (Android's long-press time is about 500 ms). */
export const LONG_PRESS_MS = 520;
/** How far a finger may move before the press counts as scrolling. */
export const MOVE_TOLERANCE = 10;

interface Timers {
  set: (f: () => void, ms: number) => number;
  clear: (id: number) => void;
  now: () => number;
}

const realTimers: Timers = {
  set: (f, ms) => window.setTimeout(f, ms),
  clear: (id) => window.clearTimeout(id),
  now: () => Date.now(),
};

/** Where a long press keeps Android's own meaning (text selection). */
export function keepsNativePress(target: EventTarget | null): boolean {
  const el = target as Element | null;
  if (!el || typeof el.closest !== "function") return true;
  return !!el.closest("input, textarea, select, [contenteditable=''], [contenteditable='true'], .ProseMirror, .cm-editor, [data-native-press]");
}

/** Listens on `root`; returns the clean-up. */
export function installLongPress(root: Document | HTMLElement = document, timers: Timers = realTimers): () => void {
  let timer = 0;
  let start: { x: number; y: number; target: EventTarget | null } | null = null;
  /** When our menu went out: a native one shortly after is the same press. */
  let sentAt = -Infinity;
  /** The release of the finger that opened the menu has not clicked yet (a new press clears it). */
  let swallowClick = false;
  const cancel = () => {
    if (timer) timers.clear(timer);
    timer = 0;
    start = null;
  };
  const onDown = (e: Event) => {
    const p = e as PointerEvent;
    swallowClick = false;
    if ((p.pointerType !== "touch" && p.pointerType !== "pen") || p.isPrimary === false || keepsNativePress(p.target)) return cancel();
    cancel();
    start = { x: p.clientX, y: p.clientY, target: p.target };
    timer = timers.set(() => {
      const at = start;
      cancel();
      if (!at?.target) return;
      sentAt = timers.now();
      swallowClick = true;
      at.target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: at.x, clientY: at.y, button: 2, buttons: 0 }));
    }, LONG_PRESS_MS);
  };
  const onMove = (e: Event) => {
    const p = e as PointerEvent;
    if (start && Math.hypot(p.clientX - start.x, p.clientY - start.y) > MOVE_TOLERANCE) cancel();
  };
  const onMenu = (e: Event) => {
    if (!e.isTrusted) return;
    // The WebView's own: ours went out already (drop it), or it came first (ours is not needed).
    if (timers.now() - sentAt < 800) {
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    cancel();
  };
  // After a long press the finger's release must not also click what it rests on (only that
  // release: the next press, a tap on the menu, clicks as usual).
  const onClick = (e: Event) => {
    if (swallowClick && timers.now() - sentAt < 1500) {
      swallowClick = false;
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  };
  const opts = { capture: true, passive: true } as const;
  root.addEventListener("pointerdown", onDown, opts);
  root.addEventListener("pointermove", onMove, opts);
  root.addEventListener("pointerup", cancel, opts);
  root.addEventListener("pointercancel", cancel, opts);
  root.addEventListener("contextmenu", onMenu, true);
  root.addEventListener("click", onClick, true);
  return () => {
    cancel();
    root.removeEventListener("pointerdown", onDown, opts);
    root.removeEventListener("pointermove", onMove, opts);
    root.removeEventListener("pointerup", cancel, opts);
    root.removeEventListener("pointercancel", cancel, opts);
    root.removeEventListener("contextmenu", onMenu, true);
    root.removeEventListener("click", onClick, true);
  };
}
