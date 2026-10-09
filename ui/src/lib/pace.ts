// Work on a whole text after each change (word count, chip scan, outline) is cheap for short texts and costs a
// noticeable part of every key press in long ones: there it waits for a pause in typing.

/** Text length (characters) above which whole-text work waits for a pause in typing. */
export const LONG_TEXT = 20_000;
/** The pause in typing that whole-text work of long texts waits for. */
export const PAUSE_MS = 300;

export interface Pacer {
  /** Runs `fn` now when `size` is below {@link LONG_TEXT}, else once no other run came for {@link PAUSE_MS}. */
  run(size: number, fn: () => void): void;
  /** Drops a waiting run (unmount). */
  cancel(): void;
}

export function pacer(): Pacer {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  return {
    run(size, fn) {
      cancel();
      if (size < LONG_TEXT) return fn();
      timer = setTimeout(() => {
        timer = undefined;
        fn();
      }, PAUSE_MS);
    },
    cancel,
  };
}
