import { describe, expect, it } from "vitest";
import { findHits, matchOffsets } from "./pdfsearch";

describe("PDF search", () => {
  it("finds every match case-insensitively, without overlaps", () => {
    expect(matchOffsets("Annalo annalo ANNALO", "annalo")).toEqual([0, 7, 14]);
    expect(matchOffsets("aaaa", "aa")).toEqual([0, 2]);
    expect(matchOffsets("nichts", "x")).toEqual([]);
    expect(matchOffsets("egal", "")).toEqual([]);
    expect(matchOffsets("日本語のテキスト日本", "日本")).toEqual([0, 8]);
  });
  it("numbers hits by page, item and match", () => {
    const pages = [["Erste Seite", "Suchwort und suchwort"], [], ["kein Treffer", "SUCHWORT"]];
    expect(findHits(pages, "suchwort")).toEqual([
      { page: 1, item: 1, n: 0 },
      { page: 1, item: 1, n: 1 },
      { page: 3, item: 1, n: 0 },
    ]);
  });
});
