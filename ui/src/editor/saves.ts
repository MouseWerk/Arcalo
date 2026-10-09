// Pending saves of all editors (rename, mode switch, window close wait for them).

import { t } from "../lib/i18n";
import { useApp } from "../store/app";

/** Autosave delay after the last change (Settings → Editor, 250–3000 ms), for both editors. */
export const saveDelay = () => Math.min(3000, Math.max(250, useApp.getState().settings?.settings.editor?.autosave_ms ?? 450));

// Flush handles of all mounted editors.
const flushers = new Set<() => Promise<void>>();

// Saves still on their way, also of editors that were closed meanwhile: whoever reads the
// page next (a mode switch, a reload) waits for them.
const pendingSaves = new Set<Promise<unknown>>();

/** Registers a running save with `flushAllEditors`. */
export function trackSave<T>(p: Promise<T>): Promise<T> {
  pendingSaves.add(p);
  p.then(
    () => pendingSaves.delete(p),
    () => pendingSaves.delete(p),
  );
  return p;
}

/** Saves pending edits of every open editor; rejects if one of them could not be saved. */
export async function flushAllEditors() {
  await Promise.all([...flushers].map((f) => f()));
  await Promise.allSettled([...pendingSaves]);
  if (unsaved.size > 0) {
    await retryUnsaved();
    if (unsaved.size > 0) throw new Error(t("ne.changesNotSaved"));
  }
}

/** Adds a save handle to `flushAllEditors`; returns the removal. */
export function registerFlusher(f: () => Promise<void>) {
  flushers.add(f);
  return () => void flushers.delete(f);
}

// ---- edits of closed editors whose save failed (full disk, read-only folder)

type SaveFn = (pageId: number, content: string) => Promise<unknown>;

/** The newest text of each page whose editor was closed while its save failed. */
const unsaved = new Map<number, string>();
/** Saves a kept text (set by the first editor that keeps one; tests pass their own). */
let saver: SaveFn | null = null;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
/** How long to wait before the next attempt. */
export const UNSAVED_RETRY_MS = 5000;
function schedule() {
  if (retryTimer !== undefined || unsaved.size === 0) return;
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    void retryUnsaved();
  }, UNSAVED_RETRY_MS);
}

/**
 * Keeps the edits of a closed editor whose save failed: they are saved again every few seconds
 * until it works, `flushAllEditors` (quit, lock) reports them, and an editor that opens the
 * page again starts from them (`takeUnsaved`). Without this they were gone with the editor.
 */
export function keepUnsaved(pageId: number, content: string, save: SaveFn) {
  saver = save;
  unsaved.set(pageId, content);
  schedule();
}

/** The kept text of `pageId`, handed over to an editor that opens the page (it saves it). */
export function takeUnsaved(pageId: number): string | undefined {
  const content = unsaved.get(pageId);
  if (content === undefined) return undefined;
  unsaved.delete(pageId);
  return content;
}

/** Pages with kept, not yet saved edits. */
export function unsavedPages(): number[] {
  return [...unsaved.keys()];
}

let retrying: Promise<void> | null = null;

/** Tries to save every kept text once; the ones that fail wait for the next round. */
export function retryUnsaved(): Promise<void> {
  if (retrying) return retrying;
  retrying = (async () => {
    for (const [pageId, content] of [...unsaved]) {
      if (!saver) break;
      try {
        await trackSave(saver(pageId, content));
      } catch {
        continue;
      }
      // An editor may have taken it over (or a newer text was kept) meanwhile.
      if (unsaved.get(pageId) !== content) continue;
      unsaved.delete(pageId);
          // Editors showing the page take the saved text over.
      window.dispatchEvent(new CustomEvent("arcalo:page-saved", { detail: { id: pageId, content, from: "unsaved" } }));
    }
  })().finally(() => {
    retrying = null;
    schedule();
  });
  return retrying;
}
