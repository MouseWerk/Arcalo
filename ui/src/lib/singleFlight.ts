// A write that must not run twice at once: a second Enter, Ctrl+Enter or click while the first one
// is still on its way (to Jira, say) is dropped. A `busy` state alone does not do it: the key handler
// that runs again still holds the state of the render before.

import { useCallback, useRef } from "react";

/** Runs `run` unless the run before is still going; the dropped call resolves to undefined. */
export function singleFlight() {
  let running = false;
  return async <T>(run: () => Promise<T>): Promise<T | undefined> => {
    if (running) return undefined;
    running = true;
    try {
      return await run();
    } finally {
      running = false;
    }
  };
}

/** `singleFlight` for a component: one gate per mounted component. */
export function useSingleFlight() {
  const gate = useRef<ReturnType<typeof singleFlight> | null>(null);
  gate.current ??= singleFlight();
  return useCallback(<T>(run: () => Promise<T>) => gate.current!(run), []);
}
