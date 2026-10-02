import { beforeEach, describe, expect, it } from "vitest";
import { saveUpdateSession, takeUpdateSession } from "./updatesession";

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) },
  });
});

describe("update session", () => {
  it("is taken once by the start right after the restart", () => {
    saveUpdateSession(1000);
    expect(takeUpdateSession(1000 + 60_000)).toBe(true);
    expect(takeUpdateSession(1000 + 60_000)).toBe(false);
  });
  it("a stale mark (the restart never happened) is ignored", () => {
    saveUpdateSession(0);
    expect(takeUpdateSession(60 * 60_000)).toBe(false);
    expect(takeUpdateSession()).toBe(false);
  });
});
