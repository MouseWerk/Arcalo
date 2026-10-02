// Undo and redo for a canvas: whole-document snapshots (the serialized JSON). A gesture (a drag,
// a resize, a text edit) records the state before it once; repeated records of the same state
// are dropped, so a click without a change leaves nothing to undo.

export class CanvasHistory {
  private past: string[] = [];
  private future: string[] = [];

  constructor(private readonly limit = 100) {}

  /** Records `before` (the state a change starts from); clears the redo list. */
  record(before: string) {
    if (this.past[this.past.length - 1] === before) return;
    this.past.push(before);
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
  }

  /** Drops the last record when the change it announced did not happen (`current` equals it). */
  settle(current: string) {
    if (this.past[this.past.length - 1] === current) this.past.pop();
  }

  /** The state to go back to from `current`, or null. */
  undo(current: string): string | null {
    let prev = this.past.pop();
    while (prev === current) prev = this.past.pop();
    if (prev == null) return null;
    this.future.push(current);
    return prev;
  }

  redo(current: string): string | null {
    const next = this.future.pop();
    if (next == null) return null;
    this.past.push(current);
    return next;
  }

  get canUndo() {
    return this.past.length > 0;
  }
  get canRedo() {
    return this.future.length > 0;
  }

  clear() {
    this.past = [];
    this.future = [];
  }
}
