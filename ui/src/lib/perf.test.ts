// Helpers of the 1.4 speed-ups: row windows of long lists, the title set for link checks, the
// Markdown cache of assistant answers and a page after its own save.

import { describe, expect, it } from "vitest";
import { treeWindow } from "./treeWindow";
import { titleSet } from "./links";
import { renderMarkdown, renderMarkdownCached } from "./markdown";
import { withSaved } from "./pagesave";
import type { PageDoc } from "./types";

describe("treeWindow", () => {
  const view = { top: 0, height: 280, rowH: 28 };
  it("renders the rows in view plus the overscan", () => {
    expect(treeWindow(1000, view, [], 5)).toEqual([...Array(15).keys()]);
    expect(treeWindow(1000, { ...view, top: 2800 }, [], 5)).toEqual(Array.from({ length: 20 }, (_, i) => 95 + i));
  });
  it("clamps at both ends and while the list starts below the view", () => {
    expect(treeWindow(8, { ...view, top: -50 }, [], 5)).toEqual([...Array(8).keys()]);
    // Entirely below the view: nothing.
    expect(treeWindow(100, { ...view, top: -500 }, [], 5)).toEqual([]);
    expect(treeWindow(100, { ...view, top: 1e6 }, [], 5)).toEqual([]);
    expect(treeWindow(0, view, [3], 5)).toEqual([]);
  });
  it("keeps extra rows (dragged, focused) wherever they are, once and in order", () => {
    expect(treeWindow(1000, view, [900, 3, 900, -1, 5000], 2)).toEqual([...Array(12).keys(), 900]);
  });
});

describe("titleSet", () => {
  it("holds the lower-cased titles, built once per page map", () => {
    const pages = new Map([
      [1, { title: "Architektur" }],
      [2, { title: "Jour Fixe KW39" }],
    ]);
    const set = titleSet(pages);
    expect(set.has("architektur")).toBe(true);
    expect(set.has("jour fixe kw39")).toBe(true);
    expect(set.has("Architektur")).toBe(false);
    expect(titleSet(pages)).toBe(set);
    // The store replaces the map on every change: a new map, a new set.
    const next = new Map(pages).set(3, { title: "Neu" });
    expect(titleSet(next).has("neu")).toBe(true);
    expect(set.has("neu")).toBe(false);
  });
});

describe("renderMarkdownCached", () => {
  it("renders like renderMarkdown and returns the same string again", () => {
    const md = "**fett** und [[Seite]]";
    const html = renderMarkdownCached(md);
    expect(html).toBe(renderMarkdown(md));
    expect(renderMarkdownCached(md)).toBe(html);
  });
  it("keeps a bounded number of answers", () => {
    for (let i = 0; i < 400; i++) expect(renderMarkdownCached(`Antwort ${i}`)).toContain(`Antwort ${i}`);
  });
});

describe("withSaved", () => {
  const cur = { id: 1, title: "A", content: "alt", tags: ["x"], backlinks: [], unresolved_links: ["Fehlt"], updated_at: "2026-09-01T10:00:00Z" } as unknown as PageDoc;
  it("takes the stored text and what the server answered", () => {
    const saved = { tags: ["y"], backlinks: [], unresolved_links: [], updated_at: "2026-09-24T12:00:00Z" } as unknown as PageDoc;
    expect(withSaved(cur, saved, "neu")).toMatchObject({ id: 1, title: "A", content: "neu", tags: ["y"], unresolved_links: [], updated_at: "2026-09-24T12:00:00Z" });
  });
  it("keeps what a lean answer leaves out", () => {
    const lean = { updated_at: "2026-09-24T12:00:00Z" } as Partial<PageDoc>;
    expect(withSaved(cur, lean, "neu")).toMatchObject({ content: "neu", tags: ["x"], backlinks: [], unresolved_links: ["Fehlt"], updated_at: "2026-09-24T12:00:00Z" });
    expect(withSaved(cur, null, "neu")).toMatchObject({ content: "neu", tags: ["x"], updated_at: "2026-09-01T10:00:00Z" });
  });
});
