// Per-page view choices kept on this device: full width, and the Markdown source mode.

import { useSyncExternalStore } from "react";
import { flushAllEditors } from "../editor/saves";

type Mode = "full" | "source";
const KEY: Record<Mode, string> = { full: "annalo.page-full", source: "annalo.page-source" };
const listeners = new Set<() => void>();

function read(mode: Mode): number[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY[mode]) ?? "[]");
    return Array.isArray(v) ? v.filter((n) => typeof n === "number") : [];
  } catch {
    return [];
  }
}

export function pageMode(mode: Mode, id: number): boolean {
  return read(mode).includes(id);
}

export function setPageMode(mode: Mode, id: number, on: boolean) {
  const ids = read(mode).filter((n) => n !== id);
  if (on) ids.push(id);
  try {
    // The most recent few hundred are enough.
    localStorage.setItem(KEY[mode], JSON.stringify(ids.slice(-500)));
  } catch {
    // Storage full or blocked: the choice lasts until the page is closed.
  }
  listeners.forEach((l) => l());
}

/** The choice for page `id`, updated when it changes (also from another pane). */
export function usePageMode(mode: Mode, id: number): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => pageMode(mode, id),
  );
}

/** Shortcut and palette commands for the focused pane's page. */
export type PageCommand = "source" | "full";
export const PAGE_COMMAND_EVENT = "annalo:page-command";
export const requestPageCommand = (cmd: PageCommand) => window.dispatchEvent(new CustomEvent(PAGE_COMMAND_EVENT, { detail: cmd }));

/** Visual editor or Markdown source: every editor saves first, so neither shows an old state. */
export async function togglePageSource(id: number) {
  await flushAllEditors().catch(() => {});
  setPageMode("source", id, !pageMode("source", id));
}
