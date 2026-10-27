// Pending text that must be stored before the page goes away (the Android app's switch between
// the phone app and the full app, lib/uiswitch.ts). Editors register how to store theirs and how
// to tell that something is still unsaved; the desktop's editors also have `flushAllEditors`
// (editor/saves.ts), which the full app adds.

/** Stores the pending text; rejects (or resolves to `false`) when it could not. */
type Flusher = () => Promise<unknown> | unknown;

const flushers = new Set<Flusher>();
const pendings = new Set<() => boolean>();

/** Registers a way to store pending text and, optionally, to tell that text is still unsaved
 *  (checked right before the page goes away); returns the removal. */
export function onFlush(f: Flusher, pending?: () => boolean): () => void {
  flushers.add(f);
  if (pending) pendings.add(pending);
  return () => {
    flushers.delete(f);
    if (pending) pendings.delete(pending);
  };
}

/** Text that no flush stored yet (typed while the flush ran). */
export function unsavedLeft(): boolean {
  return [...pendings].some((p) => {
    try {
      return p();
    } catch {
      return true;
    }
  });
}

/** Stores every pending text; false when one failed, took longer than `timeoutMs`, or text is
 *  still unsaved after it. */
export async function flushAll(timeoutMs = 5000): Promise<boolean> {
  const all = Promise.all([...flushers].map((f) => Promise.resolve().then(f)));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, fail) => {
    timer = setTimeout(() => fail(new Error("timeout")), timeoutMs);
  });
  try {
    const results = await Promise.race([all, late]);
    return !results.some((r) => r === false) && !unsavedLeft();
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
