import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { api } from "../../lib/api";
import type { PageDoc } from "../../lib/types";
import { Ctx, type MobileContext } from "../context";
import { PageBody } from "./Notes";

vi.mock("../../lib/api", async (orig) => {
  const m = await orig<typeof import("../../lib/api")>();
  return { ...m, api: { ...m.api, savePage: vi.fn(), page: vi.fn(), taskNextDue: vi.fn() } };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const doc = (content: string) => ({ id: 7, title: "Notiz", content, kind: null }) as unknown as PageDoc;
const saved = (merged?: string) => ({ id: 7, updated_at: "", tags: [], unresolved_links: [], merged });

describe("Mobile page editor and the sync", () => {
  let root: Root | null = null;
  let host: HTMLElement | null = null;
  // The page as stored in the app (what a read returns now).
  let stored = "";
  const toast = vi.fn();
  const ctx = { toast, refresh: vi.fn(), onBack: () => () => {} } as unknown as MobileContext;
  const render = (content: string) =>
    act(async () =>
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
  // A save stores what it sends (or the merged text).
  const saves = (merged?: string) =>
    vi.mocked(api.savePage).mockImplementation(async (_id, content) => {
      stored = merged ?? content;
      return saved(merged);
    });

  beforeEach(() => {
    vi.mocked(api.savePage).mockReset();
    vi.mocked(api.page).mockReset();
    vi.mocked(api.page).mockImplementation(async () => doc(stored));
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
    saves();
    stored = "Anfang\n";
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
    saves();
    stored = "Anfang\n";
    await render("Anfang\n");
    stored = "Anfang\nvom Desktop\n";
    await render("Anfang\nvom Desktop\n");
    expect(field().value).toBe("Anfang\nvom Desktop\n");
    await type("Anfang\nvom Desktop\nvom Handy\n");
    await blur();
    expect(api.savePage).toHaveBeenCalledWith(7, "Anfang\nvom Desktop\nvom Handy\n", "Anfang\nvom Desktop\n");
  });

  it("ignores a read of the page that started before a save and arrived after it", async () => {
    saves();
    stored = "Anfang\n";
    await render("Anfang\n");
    await type("Anfang\nvom Handy\n");
    await blur();
    // The screen took the saved text over, then a refresh that read the page before the save
    // was stored arrives.
    await render("Anfang\nvom Handy\n");
    await render("Anfang\n");
    expect(field().value).toBe("Anfang\nvom Handy\n");
  });

  it("shows a change that brings an earlier text back", async () => {
    saves();
    stored = "Anfang\n";
    await render("Anfang\n");
    await type("Anfang\nvom Handy\n");
    await blur();
    await render("Anfang\nvom Handy\n");
    // The desktop took the line out again, the sync brought that here.
    stored = "Anfang\n";
    await render("Anfang\n");
    expect(field().value).toBe("Anfang\n");
  });

  it("reads the page again after a save when it changed while the save was on its way", async () => {
    stored = "Anfang\n";
    await render("Anfang\n");
    let finish: () => void = () => {};
    vi.mocked(api.savePage).mockImplementation(
      (_id, content) =>
        new Promise((r) => {
          finish = () => {
            stored = content;
            r(saved());
          };
        }),
    );
    await type("Anfang\nvom Handy\n");
    await blur();
    // A sync changes the page while the save is on its way.
    await render("Anfang\nvom Desktop\n");
    expect(field().value).toBe("Anfang\nvom Handy\n");
    await act(async () => {
      finish();
      stored = "Anfang\nvom Handy\nvom Desktop\n";
    });
    await act(async () => {});
    expect(field().value).toBe("Anfang\nvom Handy\nvom Desktop\n");
  });

  it("reports a save that ends after the screen moved on to the screen's latest handler", async () => {
    saves();
    stored = "Anfang\n";
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
    saves("Anfang\nvom Desktop\nvom Handy\n");
    stored = "Anfang\n";
    await render("Anfang\n");
    await type("Anfang\nvom Handy\n");
    // The sync took the desktop's text over before the pause in typing ran out.
    stored = "Anfang\nvom Desktop\n";
    await render("Anfang\nvom Desktop\n");
    expect(field().value).toBe("Anfang\nvom Handy\n");
    await blur();
    // Saved against the text it started from: the shell merges instead of overwriting.
    expect(api.savePage).toHaveBeenCalledWith(7, "Anfang\nvom Handy\n", "Anfang\n");
    expect(field().value).toBe("Anfang\nvom Desktop\nvom Handy\n");
    expect(toast).not.toHaveBeenCalled();
  });
});

describe("Task boxes in a page (A19)", () => {
  let root: Root | null = null;
  let host: HTMLElement | null = null;
  let stored = "";
  const toast = vi.fn();
  const refresh = vi.fn();
  const ctx = { toast, refresh, onBack: () => () => {} } as unknown as MobileContext;
  const read = (content: string, onSaved: (c: string) => void = () => {}) =>
    act(async () =>
      root!.render(createElement(Ctx.Provider, { value: ctx }, createElement(PageBody, { doc: doc(content), editing: false, onSaved, onDone: () => {} }))),
    );
  const boxes = () => [...host!.querySelectorAll<HTMLInputElement>('.m-read input[type="checkbox"]')];
  const tap = (el: Element, init: MouseEventInit = {}) => act(async () => void el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init })));

  beforeEach(() => {
    vi.mocked(api.savePage).mockReset();
    vi.mocked(api.page).mockReset();
    vi.mocked(api.taskNextDue).mockReset();
    vi.mocked(api.page).mockImplementation(async () => doc(stored));
    vi.mocked(api.savePage).mockImplementation(async (_id, content) => {
      stored = content;
      return saved();
    });
    toast.mockReset();
    refresh.mockReset();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = host = null;
  });

  it("ticks a task off in the page, saved with the text it started from", async () => {
    stored = "# Plan\n\n- [ ] Eins\n- [ ] Zwei\n\n```\n- [ ] kein Kasten\n```\n";
    const onSaved = vi.fn();
    await read(stored, onSaved);
    expect(boxes().map((b) => [b.checked, b.disabled])).toEqual([
      [false, false],
      [false, false],
    ]);
    const before = stored;
    await tap(boxes()[1]);
    expect(api.savePage).toHaveBeenCalledWith(7, "# Plan\n\n- [ ] Eins\n- [x] Zwei\n\n```\n- [ ] kein Kasten\n```\n", before);
    expect(boxes().map((b) => b.checked)).toEqual([false, true]);
    expect(onSaved).toHaveBeenCalledWith(stored);
    expect(refresh).toHaveBeenCalled();
    // Open again.
    await tap(boxes()[1]);
    expect(api.savePage).toHaveBeenLastCalledWith(7, before, "# Plan\n\n- [ ] Eins\n- [x] Zwei\n\n```\n- [ ] kein Kasten\n```\n");
  });

  it("merges with a change a sync made meanwhile, and shows both", async () => {
    stored = "- [ ] Eins\n- [ ] Zwei\n";
    await read(stored);
    // The desktop added a line; the shell merges the tick with it.
    vi.mocked(api.savePage).mockImplementation(async () => {
      stored = "- [x] Eins\n- [ ] Zwei\n- [ ] Vom Desktop\n";
      return saved(stored);
    });
    await tap(boxes()[0]);
    expect(api.savePage).toHaveBeenCalledWith(7, "- [x] Eins\n- [ ] Zwei\n", "- [ ] Eins\n- [ ] Zwei\n");
    expect(boxes().map((b) => b.checked)).toEqual([true, false, false]);
    expect(host!.textContent).toContain("Vom Desktop");
  });

  it("a repeating task gets its next occurrence below it, as on the desktop", async () => {
    stored = "- [ ] Bericht every:weekly due:2026-10-12\n  - [ ] Zahlen holen\n- [ ] Danach\n";
    vi.mocked(api.taskNextDue).mockResolvedValue("2026-10-19");
    await read(stored);
    await tap(boxes()[0]);
    expect(api.taskNextDue).toHaveBeenCalledWith("Bericht every:weekly due:2026-10-12");
    expect(api.savePage).toHaveBeenCalledWith(
      7,
      "- [x] Bericht every:weekly due:2026-10-12\n  - [ ] Zahlen holen\n- [ ] Bericht every:weekly due:2026-10-19\n- [ ] Danach\n",
      "- [ ] Bericht every:weekly due:2026-10-12\n  - [ ] Zahlen holen\n- [ ] Danach\n",
    );
  });

  it("counts a tap next to the small box, not one on the task's text or a link", async () => {
    stored = "- [ ] Eins mit [[Link]]\n";
    await read(stored);
    const box = boxes()[0];
    const li = box.closest("li")!;
    const r = box.getBoundingClientRect();
    await tap(li.querySelector("a")!);
    expect(api.savePage).not.toHaveBeenCalled();
    await tap(li, { clientX: r.left + r.width / 2 + 200 });
    expect(api.savePage).not.toHaveBeenCalled();
    await tap(li, { clientX: r.left + r.width / 2 + 10 });
    expect(api.savePage).toHaveBeenCalledWith(7, "- [x] Eins mit [[Link]]\n", "- [ ] Eins mit [[Link]]\n");
  });
});
