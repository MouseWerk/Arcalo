// Pending saves of all editors (rename, mode switch, window close wait for them).

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
}

/** Adds a save handle to `flushAllEditors`; returns the removal. */
export function registerFlusher(f: () => Promise<void>) {
  flushers.add(f);
  return () => void flushers.delete(f);
}
