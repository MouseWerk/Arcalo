// A closed editor whose save failed keeps its edits (saves.ts `keepUnsaved`). An older save that
// fails while a newer one of the same editor is queued must not be kept: the newer text would be
// overwritten by it later. A kept text is merged with what the page holds by then.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { PageDoc } from "../lib/types";

type Call = { content: string; base?: string; settle: (fail?: boolean) => void };
const calls: Call[] = [];
let stored = "base\n";
vi.mock("../lib/api", async (orig) => ({
  ...(await orig<typeof import("../lib/api")>()),
  api: {
    savePage: (_id: number, content: string, base?: string) =>
      new Promise((ok, fail) => {
        calls.push({
          content,
          base,
          settle: (bad) => {
            if (bad) return fail(new Error("Die Datei ist gerade gesperrt"));
            stored = content;
            ok({ id: 7, title: "Notiz", updated_at: "" });
          },
        });
      }),
    page: async () => ({ id: 7, content: stored }),
    chipStates: async () => [],
    devlogWrite: async () => {},
  },
}));

const { SourceEditor } = await import("./SourceEditor");
const { keepUnsaved, retryUnsaved, takeUnsaved, unsavedPages } = await import("./saves");

afterEach(() => {
  for (const id of unsavedPages()) takeUnsaved(id);
  calls.length = 0;
  stored = "base\n";
});

const doc = (content: string) => ({ id: 7, title: "Notiz", content }) as unknown as PageDoc;

async function mount(content: string) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(SourceEditor, { doc: doc(content), onSaved: () => {} })));
  const area = host.querySelector("textarea")!;
  const type = async (text: string) => {
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => {
      set.call(area, text);
      area.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const close = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  return { area, type, close };
}

const settle = async (i: number, fail = false) => {
  await vi.waitFor(() => expect(calls.length).toBeGreaterThan(i));
  await act(async () => {
    calls[i].settle(fail);
    await new Promise((ok) => setTimeout(ok, 0));
  });
};

describe("kept edits of a closed editor", () => {
  it("an older failed save is not kept when a newer one of the editor follows", async () => {
    const ed = await mount("base\n");
    await ed.type("A\n");
    // Save A starts (Ctrl+S) and is still on its way when the tab is closed with more text.
    await act(async () => ed.area.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true })));
    await ed.type("A+B\n");
    await ed.close();
    await settle(0, true);
    await settle(1);
    expect(stored).toBe("A+B\n");
    expect(unsavedPages()).toEqual([]);
    await retryUnsaved();
    expect(stored).toBe("A+B\n");
  });

  it("the last failed save is kept with its base", async () => {
    const ed = await mount("base\n");
    await ed.type("A\n");
    await ed.close();
    await settle(0, true);
    expect(unsavedPages()).toEqual([7]);
    // The retry merges with the page as it is now instead of overwriting it.
    const retry = retryUnsaved();
    await vi.waitFor(() => expect(calls.length).toBe(2));
    expect(calls[1]).toMatchObject({ content: "A\n", base: "base\n" });
    calls[1].settle();
    await retry;
    expect(unsavedPages()).toEqual([]);
  });

  it("an editor opening the page merges the kept text with what the page holds now", () => {
    const save = vi.fn(async () => {
      throw new Error("schreibgeschützt");
    });
    keepUnsaved(7, "eins\nzwei geändert\ndrei\n", save, "eins\nzwei\ndrei\n");
    // Saved elsewhere since: the last line changed.
    expect(takeUnsaved(7, "eins\nzwei\ndrei und mehr\n")).toBe("eins\nzwei geändert\ndrei und mehr\n");
    expect(takeUnsaved(7)).toBeUndefined();
  });
});
