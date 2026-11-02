// Event handlers that wait (for a tree refresh, say) before they act: a later event must not act
// before an earlier one, or the earlier one undoes it (two pages opened from the quick search one
// after the other: the first, answered late, would replace the second in its tab).

/** Wraps `handle` so that each call starts once the previous one has finished (also when it failed). */
export function inOrder<T>(handle: (arg: T) => Promise<unknown> | unknown): (arg: T) => Promise<void> {
  let last: Promise<unknown> = Promise.resolve();
  return (arg) => {
    const run = last.then(() => handle(arg));
    last = run.catch(() => {});
    return run.then(() => {});
  };
}
