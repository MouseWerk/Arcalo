// Pending saves of all editors (rename, mode switch, window close wait for them).

import { t } from "../lib/i18n";
import { merge3 } from "../lib/merge3";
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

// Whether an editor holds edits that are not saved yet (checked right before the page goes away).
const dirtyChecks = new Set<() => boolean>();

/** Adds a save handle to `flushAllEditors` (and how to tell its edits are unsaved); returns the
 *  removal. */
export function registerFlusher(f: () => Promise<void>, dirty?: () => boolean) {
  flushers.add(f);
  if (dirty) dirtyChecks.add(dirty);
  return () => {
    flushers.delete(f);
    if (dirty) dirtyChecks.delete(dirty);
  };
}

/** Edits not saved yet: of an open editor (typed after the last flush) or kept from a closed one. */
export function editorsDirty(): boolean {
  return unsaved.size > 0 || [...dirtyChecks].some((d) => d());
}

// ---- edits of closed editors whose save failed (full disk, read-only folder)

type SaveFn = (pageId: number, content: string, base?: string) => Promise<unknown>;

/** The newest text of each page whose editor was closed while its save failed, and the page as
 *  that editor knew it (its saves merge with changes made elsewhere since, as the editor's would). */
const unsaved = new Map<number, { content: string; base?: string }>();
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
 * Only the editor's last save may keep its text: an older one that fails while a newer one is
 * queued would later be written over the newer text.
 */
export function keepUnsaved(pageId: number, content: string, save: SaveFn, base?: string) {
  saver = save;
  unsaved.set(pageId, { content, base });
  schedule();
}

/** The kept text of `pageId`, handed over to an editor that opens the page (it saves it): merged
 *  with `current`, what the page holds now, so changes saved meanwhile stay. */
export function takeUnsaved(pageId: number, current?: string): string | undefined {
  const kept = unsaved.get(pageId);
  if (kept === undefined) return undefined;
  unsaved.delete(pageId);
  return current !== undefined && kept.base !== undefined ? merge3(kept.base, kept.content, current) : kept.content;
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
    for (const [pageId, kept] of [...unsaved]) {
      if (!saver) break;
      let saved: unknown;
      try {
        saved = await trackSave(saver(pageId, kept.content, kept.base));
      } catch {
        continue;
      }
      // An editor may have taken it over (or a newer text was kept) meanwhile.
      if (unsaved.get(pageId) !== kept) continue;
      unsaved.delete(pageId);
      // Editors showing the page take the saved text over (merged with changes made elsewhere).
      const merged = (saved as { merged?: string } | null | undefined)?.merged;
      window.dispatchEvent(new CustomEvent("arcalo:page-saved", { detail: { id: pageId, content: merged ?? kept.content, from: "unsaved" } }));
    }
  })().finally(() => {
    retrying = null;
    schedule();
  });
  return retrying;
}
