import { describe, expect, it } from "vitest";
import { addTagToFrontmatter, findTerms, linkFor, pageRects, pdfAnchor } from "./linking";

describe("addTagToFrontmatter", () => {
  it("creates or extends the tags list", () => {
    expect(addTagToFrontmatter("", "projekt-x")).toBe("---\ntags: [projekt-x]\n---\n");
    expect(addTagToFrontmatter("---\nstatus: offen\ntags: [a]\n---\n", "#b")).toBe("---\nstatus: offen\ntags: [a, b]\n---\n");
    expect(addTagToFrontmatter("---\ntags:\n  - a\n---\n", "b")).toBe("---\ntags: [a, b]\n---\n");
  });
  it("keeps a tag that is already there", () => {
    const fm = "---\ntags: [Projekt-X]\n---\n";
    expect(addTagToFrontmatter(fm, "projekt-x")).toBe(fm);
  });
});

describe("findTerms", () => {
  it("finds terms at word boundaries, longest first", () => {
    const hits = findTerms("Projekt Alpha und das Projekts-Ende, nicht Alphabet", [
      { text: "Projekt", title: "Projekt" },
      { text: "Projekt Alpha", title: "Projekt Alpha" },
      { text: "Alpha", title: "Alpha" },
    ]);
    expect(hits.map((h) => [h.text, h.title])).toEqual([["Projekt Alpha", "Projekt Alpha"]]);
  });
  it("is case-insensitive and keeps the written form", () => {
    expect(findTerms("der server läuft", [{ text: "Server", title: "Server" }])).toEqual([{ from: 4, to: 10, title: "Server", text: "server" }]);
  });
  it("builds the link", () => {
    expect(linkFor("Server", "Server")).toEqual({ target: "Server", alias: null });
    expect(linkFor("Server", "Servers")).toEqual({ target: "Server", alias: "Servers" });
  });
});

describe("pdf highlights", () => {
  it("reads the anchor of a highlight link", () => {
    expect(pdfAnchor("page=12&hl=7")).toEqual({ page: 12, highlight: 7 });
    expect(pdfAnchor("#page=3")).toEqual({ page: 3, highlight: null });
    expect(pdfAnchor(null)).toEqual({ page: null, highlight: null });
  });
  it("reads DOMRect-like objects whose fields are getters", () => {
    class R {
      constructor(private r: number[]) {}
      get left() { return this.r[0]; }
      get top() { return this.r[1]; }
      get width() { return this.r[2]; }
      get height() { return this.r[3]; }
    }
    expect(pageRects([new R([160, 130, 100, 16])], { left: 100, top: 50, width: 600, height: 800 })).toEqual([[0.1, 0.1, 0.1667, 0.02]]);
  });
  it("merges a selection into one rect per line, relative to the page", () => {
    const page = { left: 100, top: 50, width: 600, height: 800 };
    const rects = pageRects(
      [
        { left: 160, top: 130, width: 100, height: 16 },
        { left: 260, top: 131, width: 140, height: 15 },
        { left: 160, top: 150, width: 200, height: 16 },
        { left: 400, top: 131, width: 0.5, height: 15 },
      ],
      page,
    );
    expect(rects).toEqual([
      [0.1, 0.1, 0.4, 0.02],
      [0.1, 0.125, 0.3333, 0.02],
    ]);
  });
});
