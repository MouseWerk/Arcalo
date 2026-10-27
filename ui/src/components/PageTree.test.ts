// „Duplizieren“ and „Markdown kopieren“ in the tree read the stored page: open edits are saved
// first, so the copy has what was typed a moment ago.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PageNode } from "../lib/types";

let stored = "Stand vorher\n";
const typed = "Stand vorher\nGerade getippt\n";
vi.mock("../editor/saves", async (orig) => ({
  ...(await orig<typeof import("../editor/saves")>()),
  flushAllEditors: vi.fn(async () => {
    stored = typed;
  }),
}));
vi.mock("../lib/api", async (orig) => {
  const m = await orig<typeof import("../lib/api")>();
  return {
    ...m,
    api: {
      ...m.api,
      page: vi.fn(async (id: number) => ({ id, title: "Notiz", content: stored })),
      createPage: vi.fn(async () => ({ id: 99 })),
      movePage: vi.fn(async () => {}),
    },
  };
});

const { api } = await import("../lib/api");
const { useApp } = await import("../store/app");
const { copyMarkdown, duplicate } = await import("./PageTree");

const node = { id: 7, title: "Notiz", parent_id: null, icon: null, kind: null, children: [] } as unknown as PageNode;

beforeEach(() => {
  stored = "Stand vorher\n";
  useApp.setState({ tree: [node], toasts: [] } as never);
});

describe("tree actions on a page with open edits", () => {
  it("„Duplizieren“ copies what was just typed", async () => {
    await duplicate(node);
    expect(api.createPage).toHaveBeenCalledWith(expect.any(String), null, null, typed);
  });

  it("„Markdown kopieren“ copies what was just typed", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await copyMarkdown(node);
    expect(writeText).toHaveBeenCalledWith(typed);
  });
});
