import { describe, expect, it, vi } from "vitest";

const shell = vi.hoisted(() => ({ listens: [] as string[], fire: new Map<string, (e: { payload: unknown }) => void>() }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, cb: (e: { payload: unknown }) => void) => {
    shell.listens.push(event);
    shell.fire.set(event, cb);
    return Promise.resolve(() => {});
  },
}));

import { on } from "./api";

describe("event subscriptions", () => {
  it("share one shell listener per event and call handlers in order until dropped", async () => {
    const seen: string[] = [];
    const a = await on<number>("perf://a", (n) => seen.push(`a${n}`));
    const b = await on<number>("perf://a", (n) => seen.push(`b${n}`));
    await on<number>("perf://other", () => seen.push("other"));
    expect(shell.listens.filter((e) => e === "perf://a")).toHaveLength(1);
    shell.fire.get("perf://a")!({ payload: 1 });
    a();
    shell.fire.get("perf://a")!({ payload: 2 });
    b();
    shell.fire.get("perf://a")!({ payload: 3 });
    expect(seen).toEqual(["a1", "b1", "b2"]);
    // A new subscriber reuses the listener.
    await on<number>("perf://a", (n) => seen.push(`c${n}`));
    shell.fire.get("perf://a")!({ payload: 4 });
    expect(seen.at(-1)).toBe("c4");
    expect(shell.listens.filter((e) => e === "perf://a")).toHaveLength(1);
  });

  it("a failing handler does not stop the others", async () => {
    vi.useFakeTimers();
    const seen: number[] = [];
    await on<number>("perf://b", () => {
      throw new Error("boom");
    });
    await on<number>("perf://b", (n) => seen.push(n));
    shell.fire.get("perf://b")!({ payload: 7 });
    expect(seen).toEqual([7]);
    expect(() => vi.runAllTimers()).toThrow("boom");
    vi.useRealTimers();
  });
});
