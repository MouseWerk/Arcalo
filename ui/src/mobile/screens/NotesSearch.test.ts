// The phone's page search: a reply that comes after the query changed (or was cleared) is dropped.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { api } from "../../lib/api";
import type { SearchHit } from "../../lib/types";
import { Ctx, type MobileContext } from "../context";
import { NotesScreen } from "./Notes";

vi.mock("../../lib/api", async (orig) => {
  const m = await orig<typeof import("../../lib/api")>();
  return { ...m, api: { ...m.api, search: vi.fn(), recentPages: vi.fn(async () => []), tree: vi.fn(async () => []) } };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const hit = (page_id: number, title: string) => ({ kind: "note", page_id, title, icon: null, snippet: title, score: 1 }) as SearchHit;

describe("Mobile page search", () => {
  let root: Root | null = null;
  let host: HTMLElement | null = null;
  const replies = new Map<string, (hits: SearchHit[]) => void>();
  const ctx = { toast: vi.fn(), version: 0, open: vi.fn() } as unknown as MobileContext;
  const input = () => host!.querySelector<HTMLInputElement>('input[type="search"]')!;
  const type = (value: string) =>
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), value);
      input().dispatchEvent(new Event("input", { bubbles: true }));
    });
  const titles = () => [...host!.querySelectorAll(".m-row-title")].map((e) => e.textContent);

  beforeEach(async () => {
    vi.useFakeTimers();
    replies.clear();
    vi.mocked(api.search).mockImplementation((q: string) => new Promise((ok) => replies.set(q, ok)));
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root!.render(createElement(Ctx.Provider, { value: ctx }, createElement(NotesScreen))));
  });
  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = host = null;
    vi.useRealTimers();
  });

  it("shows no hits for a query that was cleared before the reply came", async () => {
    await type("proj");
    await act(async () => void vi.advanceTimersByTime(200));
    expect(replies.has("proj")).toBe(true);
    await act(async () => host!.querySelector<HTMLButtonElement>(".m-search button")!.click());
    await act(async () => replies.get("proj")!([hit(1, "Projektplan")]));
    expect(input().value).toBe("");
    expect(titles()).not.toContain("Projektplan");
  });

  it("an older reply that comes last does not replace the newer one", async () => {
    await type("pro");
    await act(async () => void vi.advanceTimersByTime(200));
    await type("projekt");
    await act(async () => void vi.advanceTimersByTime(200));
    await act(async () => replies.get("projekt")!([hit(2, "Projekt Alpha")]));
    await act(async () => replies.get("pro")!([hit(3, "Protokoll")]));
    expect(titles()).toEqual(["Projekt Alpha"]);
  });
});
