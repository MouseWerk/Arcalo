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

describe("pinned tabs", () => {
  const reset = () => {
    const pane = { id: "p1", tabs: [], activeTabId: "" };
    useApp.setState({ panes: [pane], activePaneId: "p1", paneSizes: [1], tabs: [], activeTabId: "" });
  };
  const kinds = () => useApp.getState().tabs.map((t) => `${t.kind}${t.pinned ? "*" : ""}`);
  const open = (kind: "tasks" | "calendar" | "activity" | "graph" | "trash") => useApp.getState().openTab({ kind }, { newTab: true });
  const idOf = (kind: string) => useApp.getState().panes.flatMap((p) => p.tabs).find((t) => t.kind === kind)!.id;

  it("sit left in pin order and come back on unpin as the first unpinned tab", () => {
    reset();
    for (const k of ["tasks", "calendar", "activity", "graph"] as const) open(k);
    const s = useApp.getState();
    s.togglePin(idOf("activity"));
    s.togglePin(idOf("calendar"));
    expect(kinds()).toEqual(["activity*", "calendar*", "tasks", "graph"]);
    s.togglePin(idOf("activity"));
    expect(kinds()).toEqual(["calendar*", "activity", "tasks", "graph"]);
  });

  it("are kept by „Andere Tabs schließen“, „Alle Tabs schließen“ and dragging into the pinned group", () => {
    reset();
    for (const k of ["tasks", "calendar", "activity", "graph"] as const) open(k);
    const s = useApp.getState();
    s.togglePin(idOf("calendar"));
    s.closeOthers(idOf("graph"));
    expect(kinds()).toEqual(["calendar*", "graph"]);
    open("trash");
    // A tab dropped in front of a pinned one lands after the pinned group.
    s.moveTab(idOf("trash"), "p1", 0);
    expect(kinds()).toEqual(["calendar*", "trash", "graph"]);
    s.closeAll();
    expect(kinds()).toEqual(["calendar*"]);
    expect(useApp.getState().activeTabId).toBe(idOf("calendar"));
  });

  it("keep their place: navigating from a pinned tab opens a new tab after the pinned ones", () => {
    reset();
    open("tasks");
    const s = useApp.getState();
    s.togglePin(idOf("tasks"));
    s.openTab({ kind: "calendar" });
    expect(kinds()).toEqual(["tasks*", "calendar"]);
    expect(useApp.getState().activeTabId).toBe(idOf("calendar"));
    // A new tab opened from the pinned tab also goes after the pinned group.
    s.activateTab(idOf("tasks"));
    open("graph");
    expect(kinds()).toEqual(["tasks*", "graph", "calendar"]);
  });

  it("survive a restart (the stored layout) and moving to another pane", () => {
    reset();
    open("tasks");
    open("calendar");
    const s = useApp.getState();
    s.togglePin(idOf("calendar"));
    const stored = JSON.parse(localStorage.getItem("arcalo.layout") ?? "null");
    expect(stored.panes[0].tabs.map((t: { kind: string; pinned?: boolean }) => [t.kind, !!t.pinned])).toEqual([
      ["calendar", true],
      ["tasks", false],
    ]);
    s.splitTab(idOf("tasks"));
    const right = useApp.getState().panes[1];
    const leftTasks = useApp.getState().panes[0].tabs.find((t) => t.kind === "tasks")!.id;
    s.moveTab(useApp.getState().panes[0].tabs[0].id, right.id, right.tabs.length);
    const moved = useApp.getState().panes.find((p) => p.id === right.id)!;
    expect(moved.tabs.map((t) => `${t.kind}${t.pinned ? "*" : ""}`)).toEqual(["calendar*", "tasks"]);
    expect(useApp.getState().panes[0].tabs.map((t) => t.id)).toEqual([leftTasks]);
  });
});
