import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { api } from "../../lib/api";
import type { PageDoc } from "../../lib/types";
import { Ctx, type MobileContext } from "../context";
import { PageBody } from "./Notes";

vi.mock("../../lib/api", async (orig) => {
  const m = await orig<typeof import("../../lib/api")>();
  return { ...m, api: { ...m.api, savePage: vi.fn() } };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const doc = (content: string) => ({ id: 7, title: "Notiz", content, kind: null }) as unknown as PageDoc;
const saved = (merged?: string) => ({ id: 7, updated_at: "", tags: [], unresolved_links: [], merged });

describe("Mobile page editor and the sync", () => {
  let root: Root | null = null;
  let host: HTMLElement | null = null;
  const toast = vi.fn();
  const ctx = { toast, refresh: vi.fn(), onBack: () => () => {} } as unknown as MobileContext;
  const render = (content: string) =>
    act(() =>
      root!.render(
        createElement(Ctx.Provider, { value: ctx }, createElement(PageBody, { doc: doc(content), editing: true, onSaved: () => {}, onDone: () => {} })),
      ),
    );
  const field = () => host!.querySelector("textarea")!;
  const type = (value: string) =>
    act(() => {
      const el = field();
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  const blur = () => act(async () => void field().dispatchEvent(new FocusEvent("focusout", { bubbles: true })));

  beforeEach(() => {
    vi.mocked(api.savePage).mockReset();
    toast.mockReset();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = host = null;
  });

  it("saves with the text it started from, so a change made elsewhere is merged", async () => {
    vi.mocked(api.savePage).mockResolvedValue(saved());
    await render("Anfang\n");
    await type("Anfang\nvom Handy\n");
    await blur();
    expect(api.savePage).toHaveBeenCalledWith(7, "Anfang\nvom Handy\n", "Anfang\n");
    // The next save starts from what was stored.
    await type("Anfang\nvom Handy\nmehr\n");
    await blur();
    expect(api.savePage).toHaveBeenLastCalledWith(7, "Anfang\nvom Handy\nmehr\n", "Anfang\nvom Handy\n");
  });

  it("shows a text the sync took over while nothing typed waits", async () => {
    vi.mocked(api.savePage).mockResolvedValue(saved());
    await render("Anfang\n");
    await render("Anfang\nvom Desktop\n");
    expect(field().value).toBe("Anfang\nvom Desktop\n");
    await type("Anfang\nvom Desktop\nvom Handy\n");
    await blur();
    expect(api.savePage).toHaveBeenCalledWith(7, "Anfang\nvom Desktop\nvom Handy\n", "Anfang\nvom Desktop\n");
  });

  it("ignores a read of the page that started before a save and arrived after it", async () => {
    vi.mocked(api.savePage).mockResolvedValue(saved());
    await render("Anfang\n");
    await type("Anfang\nvom Handy\n");
    await blur();
    // The screen took the saved text over, then a refresh that read the page before the save
    // was stored arrives.
    await render("Anfang\nvom Handy\n");
    await render("Anfang\n");
    expect(field().value).toBe("Anfang\nvom Handy\n");
    // The same while the save is still on its way.
    let finish: (v: ReturnType<typeof saved>) => void = () => {};
    vi.mocked(api.savePage).mockImplementation(() => new Promise((r) => (finish = r)));
    await type("Anfang\nvom Handy\nmehr\n");
    await blur();
    await render("Anfang\nvom Handy\n");
    await render("Anfang\n");
    expect(field().value).toBe("Anfang\nvom Handy\nmehr\n");
    await act(async () => finish(saved()));
    await render("Anfang\nvom Handy\nmehr\n");
    await render("Anfang\nvom Handy\n");
    expect(field().value).toBe("Anfang\nvom Handy\nmehr\n");
  });

  it("reports a save that ends after the screen moved on to the screen's latest handler", async () => {
    vi.mocked(api.savePage).mockResolvedValue(saved());
    const first = vi.fn();
    const second = vi.fn();
    const body = (onSaved: (c: string) => void) =>
      createElement(Ctx.Provider, { value: ctx }, createElement(PageBody, { doc: doc("Anfang\n"), editing: true, onSaved, onDone: () => {} }));
    await act(() => root!.render(body(first)));
    await act(() => root!.render(body(second)));
    await type("Anfang\nzuletzt\n");
    // The screen closes before the pause in typing ran out: the save on the way out.
    await act(async () => root!.unmount());
    root = null;
    await act(async () => {});
    expect(api.savePage).toHaveBeenCalledWith(7, "Anfang\nzuletzt\n", "Anfang\n");
    expect(second).toHaveBeenCalledWith("Anfang\nzuletzt\n");
    expect(first).not.toHaveBeenCalled();
  });

  it("keeps typed text when the sync changed the page, and shows both once merged", async () => {
    vi.mocked(api.savePage).mockResolvedValue(saved("Anfang\nvom Desktop\nvom Handy\n"));
    await render("Anfang\n");
    await type("Anfang\nvom Handy\n");
    // The sync took the desktop's text over before the pause in typing ran out.
    await render("Anfang\nvom Desktop\n");
    expect(field().value).toBe("Anfang\nvom Handy\n");
    await blur();
    // Saved against the text it started from: the shell merges instead of overwriting.
    expect(api.savePage).toHaveBeenCalledWith(7, "Anfang\nvom Handy\n", "Anfang\n");
    expect(field().value).toBe("Anfang\nvom Desktop\nvom Handy\n");
    expect(toast).not.toHaveBeenCalled();
  });
});
