import { describe, expect, it, vi } from "vitest";
import { api } from "./api";
import type { PageNode } from "./types";
import { useApp } from "../store/app";
import { inOrder } from "./inorder";

const node = (id: number, title: string): PageNode => ({ id, title, parent_id: null, children: [] }) as unknown as PageNode;

describe("inOrder", () => {
  it("two pages opened one after the other end up as asked, also when the first tree answer comes last", async () => {
    // `search://open` (App.tsx) for pages the tree does not know yet: each waits for a tree
    // refresh. Unordered, the first page, answered last, took over the second one's new tab.
    const answers: ((t: PageNode[]) => void)[] = [];
    const spy = vi.spyOn(api, "tree").mockImplementation(() => new Promise<PageNode[]>((r) => answers.push(r)));
    const open = inOrder(async (t: { id: number; newTab: boolean }) => {
      const st = useApp.getState();
      if (!st.pages.has(t.id)) await st.refreshTree();
      st.openPage(t.id, { newTab: t.newTab });
    });
    const tree = [node(1, "Eltern"), node(3, "Andere")];
    const first = open({ id: 3, newTab: false });
    const second = open({ id: 1, newTab: true });
    await vi.waitFor(() => expect(answers.length).toBeGreaterThan(0));
    // The second request's tree (if it asked at all) answers before the first one's.
    answers.slice(1).forEach((r) => r(tree));
    answers[0](tree);
    await first;
    await second;
    const s = useApp.getState();
    expect(s.tabs.map((t) => (t.kind === "page" ? t.pageId : t.kind))).toEqual([3, 1]);
    expect(s.tabs.find((t) => t.id === s.activeTabId)?.pageId).toBe(1);
    spy.mockRestore();
  });

  it("a failed call does not stop the next one", async () => {
    const seen: number[] = [];
    const run = inOrder(async (n: number) => {
      if (n === 1) throw new Error("x");
      seen.push(n);
    });
    await expect(run(1)).rejects.toThrow("x");
    await run(2);
    expect(seen).toEqual([2]);
  });
});
