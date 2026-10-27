import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { api } from "../../lib/api";
import { flushAll, unsavedLeft } from "../../lib/flush";
import type { PageDoc } from "../../lib/types";
import { Ctx, type MobileContext } from "../context";
import { PageBody } from "./Notes";

vi.mock("../../lib/api", async (orig) => {
  const m = await orig<typeof import("../../lib/api")>();
  return { ...m, api: { ...m.api, savePage: vi.fn(), page: vi.fn(), taskNextDue: vi.fn() } };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The Android app's switch to the full app stores the typed text first (lib/uiswitch.ts): it
// must not go over when that failed.
describe("the phone app's text before the interface switch", () => {
  let root: Root | null = null;
  let host: HTMLElement | null = null;
  const type = (value: string) =>
    act(() => {
      const el = host!.querySelector("textarea")!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });

  beforeEach(() => {
    vi.mocked(api.savePage).mockReset();
    vi.mocked(api.page).mockReset();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = host = null;
  });

  it("a failed save before the interface switch keeps the phone app (flushAll is false)", async () => {
    const doc = { id: 7, title: "Notiz", content: "Anfang\n", kind: null } as unknown as PageDoc;
    vi.mocked(api.page).mockImplementation(async () => doc);
    vi.mocked(api.savePage).mockRejectedValue(new Error("database is locked"));
    const ctx = { toast: vi.fn(), refresh: vi.fn(), onBack: () => () => {} } as unknown as MobileContext;
    await act(async () => root!.render(createElement(Ctx.Provider, { value: ctx }, createElement(PageBody, { doc, editing: true, onSaved: () => {}, onDone: () => {} }))));
    await act(() => {
      const el = host!.querySelector("textarea")!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, "Anfang\nungespeichert\n");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    let ok = true;
    await act(async () => {
      ok = await flushAll();
    });
    expect(api.savePage).toHaveBeenCalled();
    expect(ok).toBe(false);
  });

  it("a stored text lets it go over; text typed after the flush counts as unsaved again", async () => {
    const doc = { id: 7, title: "Notiz", content: "Anfang\n", kind: null } as unknown as PageDoc;
    vi.mocked(api.page).mockImplementation(async () => doc);
    vi.mocked(api.savePage).mockImplementation(async () => ({ id: 7, updated_at: "", tags: [], unresolved_links: [] }));
    const ctx = { toast: vi.fn(), refresh: vi.fn(), onBack: () => () => {} } as unknown as MobileContext;
    await act(async () => root!.render(createElement(Ctx.Provider, { value: ctx }, createElement(PageBody, { doc, editing: true, onSaved: () => {}, onDone: () => {} }))));
    await type("Anfang\ngespeichert\n");
    expect(unsavedLeft()).toBe(true);
    let ok = false;
    await act(async () => {
      ok = await flushAll();
    });
    expect(ok).toBe(true);
    expect(unsavedLeft()).toBe(false);
    await type("Anfang\ngespeichert\nnoch mehr\n");
    expect(unsavedLeft()).toBe(true);
  });
});
