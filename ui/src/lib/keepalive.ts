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
}

/** A tab's current place („home“ for a pane without tabs). */
export const slotKey = (tab: Tab | null) => (tab ? `${tab.id}:${tab.kind}:${tab.pageId ?? tab.tag ?? ""}` : "home");

/**
 * The places of a pane that stay mounted: the shown one first (so it comes first in the
 * document), then the most recently left ones of tabs still open, at most `max`.
 */
export function keepAlive(prev: Kept[], tab: Tab | null, tabIds: string[], max = KEEP_ALIVE): Kept[] {
  const key = slotKey(tab);
  const rest = prev.filter((k) => k.key !== key && (k.tab ? tabIds.includes(k.tab.id) : !tab));
  return [{ key, tab }, ...rest].slice(0, max);
}
