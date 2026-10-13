// Pending text that must be stored before the page goes away (the Android app's switch between
// the phone app and the full app, lib/uiswitch.ts). Editors register how to store theirs; the
// desktop's editors also have `flushAllEditors` (editor/NoteEditor.tsx), which the full app adds.

type Flusher = () => Promise<unknown> | unknown;

const flushers = new Set<Flusher>();

/** Registers a way to store pending text; returns the removal. */
export function onFlush(f: Flusher): () => void {
  flushers.add(f);
  return () => {
    flushers.delete(f);
  };
}

/** Stores every pending text; false when one failed or took longer than `timeoutMs`. */
export async function flushAll(timeoutMs = 5000): Promise<boolean> {
  const all = Promise.all([...flushers].map((f) => Promise.resolve().then(f)));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, fail) => {
    timer = setTimeout(() => fail(new Error("timeout")), timeoutMs);
  });
  try {
    await Promise.race([all, late]);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
