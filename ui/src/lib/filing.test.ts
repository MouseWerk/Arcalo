import { describe, expect, it } from "vitest";
import type { PageNode } from "./types";
import { filterIds, folderOptions, fuzzyScore, pickFolders, isWithin, rangeIds, sortNodes, topSelected, typeFiling } from "./filing";
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
