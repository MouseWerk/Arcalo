import { describe, expect, it, vi } from "vitest";
import { api } from "../lib/api";
import type { PageNode } from "../lib/types";
import { useApp } from "./app";

const node = (id: number, title: string): PageNode => ({ id, title, parent_id: null, children: [] }) as unknown as PageNode;

describe("refreshTree", () => {
  it("an older answer arriving last does not replace the newer tree (and keeps fresh tabs)", async () => {
    const answers: ((t: PageNode[]) => void)[] = [];
    const spy = vi.spyOn(api, "tree").mockImplementation(() => new Promise<PageNode[]>((r) => answers.push(r)));
    const s = useApp.getState();
    const older = s.refreshTree();
    const newer = s.refreshTree();
    // The newer request (with a page just created) answers first.
    answers[1]([node(1, "Alt"), node(2, "Neu")]);
    await newer;
    useApp.getState().openPage(2);
    expect(useApp.getState().pages.has(2)).toBe(true);
    // The older one (from before the page existed) answers late: ignored.
    answers[0]([node(1, "Alt")]);
    await older;
    expect(useApp.getState().pages.has(2)).toBe(true);
    expect(useApp.getState().tabs.some((t) => t.kind === "page" && t.pageId === 2)).toBe(true);
    spy.mockRestore();
  });

  it("a superseded call resolves only once the newest tree is in place", async () => {
    const answers: ((t: PageNode[]) => void)[] = [];
    const spy = vi.spyOn(api, "tree").mockImplementation(() => new Promise<PageNode[]>((r) => answers.push(r)));
    const s = useApp.getState();
    const older = s.refreshTree();
    const newer = s.refreshTree();
    answers[0]([node(1, "Alt")]);
    let olderDone = false;
    void older.then(() => (olderDone = true));
    await new Promise((r) => setTimeout(r, 0));
    expect(olderDone).toBe(false);
    answers[1]([node(1, "Alt"), node(3, "Drei")]);
    await older;
    expect(useApp.getState().pages.has(3)).toBe(true);
    await newer;
    spy.mockRestore();
  });
});

describe("toasts", () => {
  it("wait while held (pointer or focus on them) and close after a moment once released", () => {
    vi.useFakeTimers();
    try {
      const s = useApp.getState();
      s.toast({ tone: "info", title: "Seite gelöscht", action: { label: "Rückgängig", run: () => {} } });
      const id = useApp.getState().toasts.at(-1)!.id;
      vi.advanceTimersByTime(3000);
      s.holdToasts(true);
      vi.advanceTimersByTime(60_000);
      expect(useApp.getState().toasts.some((t) => t.id === id)).toBe(true);
      // A toast arriving while held waits as well.
      s.toast({ tone: "success", title: "Kopiert" });
      vi.advanceTimersByTime(10_000);
      expect(useApp.getState().toasts.length).toBeGreaterThanOrEqual(2);
      s.holdToasts(false);
      vi.advanceTimersByTime(3900);
      expect(useApp.getState().toasts.some((t) => t.id === id)).toBe(true);
      vi.advanceTimersByTime(200);
      expect(useApp.getState().toasts.some((t) => t.id === id)).toBe(false);
      vi.advanceTimersByTime(4000);
      expect(useApp.getState().toasts).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("closing one by hand stops its countdown", () => {
    vi.useFakeTimers();
    try {
      const s = useApp.getState();
      s.toast({ tone: "info", title: "Eins" });
      const id = useApp.getState().toasts.at(-1)!.id;
      s.dismissToast(id);
      expect(useApp.getState().toasts.some((t) => t.id === id)).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
