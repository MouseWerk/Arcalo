import { afterEach, describe, expect, it, vi } from "vitest";
import { LONG_TEXT, PAUSE_MS, pacer } from "./pace";

afterEach(() => vi.useRealTimers());

// Whole-text work (word count, chip scan) once cost every key press in long notes (686 ms per key at 1 MB).
describe("pacer", () => {
  it("runs at once for short texts", () => {
    const p = pacer();
    const fn = vi.fn();
    for (let i = 0; i < 5; i++) p.run(100, fn);
    expect(fn).toHaveBeenCalledTimes(5);
  });

  it("waits for a pause in typing in long texts", () => {
    vi.useFakeTimers();
    const p = pacer();
    const fn = vi.fn();
    for (let i = 0; i < 20; i++) {
      p.run(LONG_TEXT, fn);
      vi.advanceTimersByTime(PAUSE_MS / 3);
    }
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(PAUSE_MS);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("drops a waiting run on cancel", () => {
    vi.useFakeTimers();
    const p = pacer();
    const fn = vi.fn();
    p.run(LONG_TEXT * 10, fn);
    p.cancel();
    vi.advanceTimersByTime(PAUSE_MS * 2);
    expect(fn).not.toHaveBeenCalled();
  });
});

// The source view used to count words and scan for chips synchronously on every change.
describe("source view", () => {
  it("does its whole-text work through the pacer", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(resolve(__dirname, "../editor/SourceEditor.tsx"), "utf8");
    const calls = [...src.matchAll(/markdownStats\(|\.shown\(/g)].map((m) => m.index!);
    expect(calls.length).toBeGreaterThan(1);
    for (const at of calls) expect(src.slice(Math.max(0, at - 400), at)).toMatch(/pace\.run\(/);
  });
});
