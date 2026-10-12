import { describe, expect, it, vi } from "vitest";
import type { PageNode } from "./types";
import { filterIds, folderOptions, fuzzyScore, matchRanges, pickFolders, planDrop, isWithin, rangeIds, renameProblem, sortNodes, topSelected, typeahead, typeFiling } from "./filing";
import { examplePath, isoWeek, monthFolder } from "../views/settings/FilingSection";

const node = (id: number, title: string, children: PageNode[] = [], extra: Partial<PageNode> = {}): PageNode => ({
  id,
  parent_id: null,
  title,
  icon: null,
  position: id,
  updated_at: `2026-10-0${id % 9}T10:00:00Z`,
  favorite: false,
  daily_date: null,
  children,
  created_at: `2026-09-${String(30 - id).padStart(2, "0")}T10:00:00Z`,
  ...extra,
});

describe("folder sort", () => {
  const list = [node(3, "beta"), node(1, "Gamma", [node(9, "x")]), node(2, "alpha 10"), node(4, "alpha 9")];
  it("keeps the manual order", () => {
    expect(sortNodes(list, null)).toBe(list);
  });
  it("sorts by name with numbers, folders first", () => {
    expect(sortNodes(list, { sort: "name", folders_first: false, color: null }).map((n) => n.title)).toEqual(["alpha 9", "alpha 10", "beta", "Gamma"]);
    expect(sortNodes(list, { sort: "name", folders_first: true, color: null }).map((n) => n.title)).toEqual(["Gamma", "alpha 9", "alpha 10", "beta"]);
  });
  it("sorts by name in the app's language, whatever the system locale", async () => {
    // A C/POSIX system locale: the default collator compares code points (capitals first).
    const Real = Intl.Collator;
    const spy = vi.spyOn(Intl, "Collator").mockImplementation(function (locales?: string | string[], options?: Intl.CollatorOptions) {
      return locales ? new Real(locales, options) : { compare: (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0) };
    } as unknown as typeof Intl.Collator);
    try {
      vi.resetModules();
      const fresh = await import("./filing");
      (await import("./i18n")).setLang("de");
      const names = [node(1, "b-Seite"), node(2, "C-Seite"), node(3, "Äpfel"), node(4, "a-Seite"), node(5, "Zettel")];
      expect(fresh.sortNodes(names, { sort: "name", folders_first: false, color: null }).map((n) => n.title)).toEqual(["a-Seite", "Äpfel", "b-Seite", "C-Seite", "Zettel"]);
    } finally {
      spy.mockRestore();
      vi.resetModules();
    }
  });
  it("sorts by modified and created, newest first", () => {
    expect(sortNodes(list, { sort: "modified", folders_first: false, color: null }).map((n) => n.id)).toEqual([4, 3, 2, 1]);
    expect(sortNodes(list, { sort: "created", folders_first: false, color: null }).map((n) => n.id)).toEqual([1, 2, 3, 4]);
    expect(sortNodes(list, { sort: "manual", folders_first: true, color: null }).map((n) => n.id)).toEqual([1, 3, 2, 4]);
  });
});

describe("tree filter", () => {
  const tree = [node(1, "Projekte", [node(2, "Kunde Müller", [node(3, "Angebot")]), node(4, "Intern")]), node(5, "Journal")];
  it("keeps the ancestors of a hit and folds accents", () => {
    const f = filterIds(tree, "muller")!;
    expect([...f.hits]).toEqual([2]);
    expect([...f.shown].sort()).toEqual([1, 2]);
    expect(filterIds(tree, "  ")).toBeNull();
    expect([...filterIds(tree, "ang")!.shown].sort()).toEqual([1, 2, 3]);
    expect(filterIds(tree, "kunde ang")!.hits.size).toBe(0);
  });
  it("matches a path: the parts before the last name ancestors, in order", () => {
    const f = filterIds(tree, "Kunde/Angebot")!;
    expect([...f.hits]).toEqual([3]);
    expect([...f.shown].sort()).toEqual([1, 2, 3]);
    expect([...filterIds(tree, "proj / ang")!.hits]).toEqual([3]);
    expect([...filterIds(tree, "projekte/kunde/ang")!.hits]).toEqual([3]);
    // The order counts, and every part must match.
    expect(filterIds(tree, "kunde/projekte/ang")!.hits.size).toBe(0);
    expect(filterIds(tree, "intern/angebot")!.hits.size).toBe(0);
    expect(filterIds(tree, "/angebot/")!.hits.size).toBe(1);
  });
  it("falls back to similar titles when no title contains the words", () => {
    const f = filterIds(tree, "angbt")!;
    expect(f.fuzzy).toBe(true);
    expect([...f.hits]).toEqual([3]);
    expect(filterIds(tree, "ang")!.fuzzy).toBe(false);
    // Letters scattered over a title are no hit.
    expect(filterIds(tree, "pkt")!.hits.size).toBe(0);
  });
  it("finds the matched parts of a title for highlighting", () => {
    expect(matchRanges("Kunde Müller", "muller")).toEqual([[6, 12]]);
    expect(matchRanges("Angebot Müller", "müll ang")).toEqual([[0, 3], [8, 12]]);
    expect(matchRanges("Angebot", "x/geb")).toEqual([[2, 5]]);
    expect(matchRanges("Angebot", "angbt", true)).toEqual([[0, 3], [4, 5], [6, 7]]);
    // Overlapping words become one range; accents in decomposed form keep their place.
    expect(matchRanges("Angebot", "ange geb")).toEqual([[0, 5]]);
    expect(matchRanges("Müller", "mull")).toEqual([[0, 5]]);
    expect(matchRanges("Angebot", "")).toEqual([]);
  });
});

describe("typeahead", () => {
  const rows = ["Angebot", "Abnahme", "Besprechung", "Bäckerei", "Kunde"];
  it("goes to the next row starting with the letters typed", () => {
    expect(typeahead(rows, 0, "a")).toBe(1);
    expect(typeahead(rows, 1, "a")).toBe(0);
    expect(typeahead(rows, -1, "b")).toBe(2);
    expect(typeahead(rows, 2, "ba")).toBe(3);
    expect(typeahead(rows, 2, "be")).toBe(2);
    expect(typeahead(rows, 0, "bb")).toBe(2);
    expect(typeahead(rows, 0, "x")).toBe(-1);
    expect(typeahead([], 0, "a")).toBe(-1);
  });
});

describe("drop planning", () => {
  const row = { id: 7, parent_id: 2 };
  it("before, inside and after a row in a folder in its own order", () => {
    expect(planDrop(0.1, row, false, [{ parent_id: 2 }])).toEqual({ kind: "at", parent: 2, pos: "before", row: 7 });
    expect(planDrop(0.5, row, false, [{ parent_id: 2 }])).toEqual({ kind: "at", parent: 7, pos: "inside", row: 7 });
    expect(planDrop(0.9, row, false, [{ parent_id: 2 }])).toEqual({ kind: "at", parent: 2, pos: "after", row: 7 });
  });
  it("in a sorted folder: into the folder from elsewhere, refused from inside it", () => {
    expect(planDrop(0.1, row, true, [{ parent_id: 3 }])).toEqual({ kind: "into", parent: 2 });
    expect(planDrop(0.9, row, true, [{ parent_id: 2 }, { parent_id: 2 }])).toEqual({ kind: "refused", folder: 2 });
    expect(planDrop(0.9, row, true, [{ parent_id: 2 }, { parent_id: null }])).toEqual({ kind: "into", parent: 2 });
    // Into a page is always possible.
    expect(planDrop(0.5, row, true, [{ parent_id: 2 }]).kind).toBe("at");
  });
});

describe("folder picker", () => {
  const tree = [node(1, "Projekte", [node(2, "Kunde X", [node(3, "Protokolle")])]), node(4, "Journal")];
  const opts = folderOptions(tree);
  it("lists every page with its path", () => {
    expect(opts.map((o) => o.path)).toEqual(["Projekte", "Projekte / Kunde X", "Projekte / Kunde X / Protokolle", "Journal"]);
  });
  it("scores letters in order, word starts and runs higher", () => {
    expect(fuzzyScore("kx", "Kunde X")).toBeGreaterThan(0);
    expect(fuzzyScore("xk", "Kunde X")).toBe(-1);
    expect(fuzzyScore("pro", "Projekte")).toBeGreaterThan(fuzzyScore("pro", "Kunde X / Protokolle xyz"));
  });
  it("picks folders first without a query", () => {
    expect(pickFolders(opts, "", new Set([1, 2])).map((o) => o.id)).toEqual([1, 2]);
    expect(pickFolders(opts, "prot", new Set([1, 2]))[0].id).toBe(3);
    expect(pickFolders(opts, "zzz", new Set())).toEqual([]);
  });
});

describe("selection", () => {
  it("selects ranges both ways", () => {
    expect(rangeIds([5, 6, 7, 8], 6, 8)).toEqual([6, 7, 8]);
    expect(rangeIds([5, 6, 7, 8], 8, 5)).toEqual([5, 6, 7, 8]);
    expect(rangeIds([5, 6, 7, 8], null, 7)).toEqual([7]);
  });
  it("moves only the topmost selected pages", () => {
    const parent: Record<number, number | null> = { 1: null, 2: 1, 3: 2, 4: null };
    expect(topSelected([3, 1, 4], (id) => parent[id])).toEqual([1, 4]);
  });
  it("knows a page's own subtree (no drop target)", () => {
    const parent: Record<number, number | null> = { 1: null, 2: 1, 3: 2, 4: null };
    expect(isWithin(3, 1, (id) => parent[id])).toBe(true);
    expect(isWithin(1, 1, (id) => parent[id])).toBe(true);
    expect(isWithin(4, 1, (id) => parent[id])).toBe(false);
    expect(isWithin(1, 3, (id) => parent[id])).toBe(false);
  });
});

describe("settings examples", () => {
  it("names months and weeks like the core", () => {
    expect(monthFolder(10, "de")).toBe("10 – Oktober");
    expect(monthFolder(3, "en")).toBe("03 – March");
    expect(isoWeek(new Date(2026, 9, 2))).toEqual({ year: 2026, week: 40 });
    expect(isoWeek(new Date(2027, 0, 1))).toEqual({ year: 2026, week: 53 });
  });
  it("builds example paths", () => {
    const d = new Date(2026, 9, 2);
    expect(examplePath("Journal", "none", null, d, (n) => `KW ${n}`)).toBe("Journal");
    expect(examplePath("Jira", "none", "ABC Portal", d, (n) => `KW ${n}`)).toBe("Jira / ABC Portal");
    expect(examplePath("Besprechungen", "week", null, d, (n) => `KW ${n}`)).toBe("Besprechungen / 2026 / KW 40");
    expect(typeFiling(undefined, "voice")).toEqual({ folder: "", granularity: "month" });
    expect(typeFiling({ types: { jira: { folder: "J", granularity: "year" } }, rules: [] }, "jira").granularity).toBe("year");
  });
});

describe("renameProblem (rename in the tree)", () => {
  const pages = new Map([
    [1, { id: 1, title: "Angebot Süd" }],
    [2, { id: 2, title: "Protokoll" }],
  ]);
  it("refuses an empty name and one another page has (any case), allows the page's own", () => {
    expect(renameProblem(2, "   ", pages)).toMatch(/leer|empty/);
    expect(renameProblem(2, " angebot süd ", pages)).toContain("Angebot Süd");
    expect(renameProblem(1, "ANGEBOT SÜD", pages)).toBeNull();
    expect(renameProblem(2, "Protokoll 2", pages)).toBeNull();
  });
});
