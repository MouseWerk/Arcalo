// Which places of a pane stay mounted while another tab is shown: switching tabs, or going back
// and forth in one, keeps a note's undo history, caret and scroll and a view's filters.

import type { Tab } from "../store/app";

/**
 * The shown place of the active pane. Kept places are in the pane too (hidden), so queries for
 * the editor, title or scroll box of what the user sees go through this, never just `.pane.active`.
 */
export const SHOWN_PLACE = ".pane.active > .pane-content:not([hidden])";

/** How many places a pane keeps alive (the shown one and the most recently left ones). */
export const KEEP_ALIVE = 5;

export interface Kept {
  key: string;
  tab: Tab | null;
  /** When the place was last shown (a counter): the least recent one goes first when too many are kept. */
  shown: number;
}

/** A tab's current place („home“ for a pane without tabs). */
export const slotKey = (tab: Tab | null) => (tab ? `${tab.id}:${tab.kind}:${tab.pageId ?? tab.tag ?? ""}` : "home");

/**
 * The places of a pane that stay mounted, in the order they are in the document: the shown one
 * and the most recently left ones of tabs still open, at most `max`. The order is stable: a
 * place shown again stays where it is, so switching tabs never moves a kept view in the document
 * (a moved node loses its scroll offsets and selection, reloads its frames and fires its
 * observers). A new place goes first, so what was just opened is first in the document. Hidden
 * places are out of the accessibility tree and the Tab order; the shown one is the only panel
 * after the tab strip a screen reader sees.
 */
export function keepAlive(prev: Kept[], tab: Tab | null, tabIds: string[], max = KEEP_ALIVE): Kept[] {
  const key = slotKey(tab);
  const shown = Math.max(0, ...prev.map((k) => k.shown)) + 1;
  const open = prev.filter((k) => k.key === key || (k.tab ? tabIds.includes(k.tab.id) : !tab));
  const kept = open.some((k) => k.key === key)
    ? open.map((k) => (k.key === key ? { key, tab, shown } : k))
    : [{ key, tab, shown }, ...open];
  while (kept.length > max) {
    const oldest = kept.reduce((a, b) => (b.shown < a.shown ? b : a));
    kept.splice(kept.indexOf(oldest), 1);
  }
  return kept;
}

/**
 * Calls `onHide` when `el` stops being laid out: its kept place was hidden (another tab is
 * shown in the pane). What an editor puts over the page on `document.body` (a hint, a popup)
 * goes with it, so it never floats over the tab shown instead. Returns the disconnect function.
 */
export function onHidden(el: Element, onHide: () => void): () => void {
  if (typeof ResizeObserver === "undefined") return () => {};
  // Acted on in the next frame: removing an overlay inside the observer's callback changes layout
  // during its delivery ("ResizeObserver loop completed with undelivered notifications").
  let frame = 0;
  const watch = new ResizeObserver(() => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      if (el.isConnected && el.getClientRects().length === 0) onHide();
    });
  });
  watch.observe(el);
  return () => {
    cancelAnimationFrame(frame);
    watch.disconnect();
  };
}
