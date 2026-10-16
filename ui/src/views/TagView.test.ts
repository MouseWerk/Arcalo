// A tag tab switched quickly: the pages of the tag shown last stay, a late reply for the one
// before is dropped.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Page } from "../lib/types";

const replies = new Map<string, (pages: Page[]) => void>();
vi.mock("../lib/api", async (orig) => ({
  ...(await orig<typeof import("../lib/api")>()),
  api: { tagPages: (tag: string) => new Promise((ok) => replies.set(tag, ok)) },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { TagView } = await import("./TagView");
const page = (id: number, title: string) => ({ id, title, icon: null, updated_at: "2026-10-01T08:00:00Z" }) as unknown as Page;

afterEach(() => replies.clear());

describe("TagView", () => {
  it("drops the reply for the tag shown before", async () => {
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => root.render(createElement(TagView, { tag: "alt" })));
    await act(async () => root.render(createElement(TagView, { tag: "neu" })));
    await act(async () => replies.get("neu")!([page(2, "Neue Seite")]));
    await act(async () => replies.get("alt")!([page(1, "Alte Seite")]));
    expect([...host.querySelectorAll(".page-list-item .grow")].map((e) => e.textContent)).toEqual(["Neue Seite"]);
    act(() => root.unmount());
  });
});
