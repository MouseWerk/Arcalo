import { describe, expect, it } from "vitest";
import {
  activeFilterCount,
  applyPatch,
  buildModel,
  defaultFilter,
  defaultOptions,
  folderPalette,
  listRows,
  matchesQuery,
  matchesRule,
  nearestInDirection,
  nodeColors,
  normalizePresets,
  normalizeSettings,
  patchScope,
  searchNodes,
  type GraphData,
  type GraphNodeData,
} from "./graph";

const page = (id: number, title: string, extra: Partial<GraphNodeData> = {}): GraphNodeData => ({
  id,
  title,
  icon: null,
  parent_id: null,
  folder: "",
  tags: [],
  netzplan: [],
  jira: null,
  created_at: "2026-09-01T08:00:00Z",
  updated_at: "2026-09-02T08:00:00Z",
  daily: false,
  links_in: 0,
  links_out: 0,
  ...extra,
});

const data = (): GraphData => ({
  nodes: [
    page(1, "Portal", { folder: "Projekte", tags: ["projekt/portal"], jira: "ABC-12", netzplan: ["NP-4711"] }),
    page(2, "Kunde A", { folder: "Kunden", tags: ["kunde"] }),
    page(3, "Konzept", { folder: "Projekte/Portal" }),
    page(4, "Allein", { folder: "Wissen" }),
    page(5, "Übersicht", { folder: "Wissen" }),
  ],
  links: [
    { from: 1, to: 2 },
    { from: 2, to: 1 },
    { from: 1, to: 3 },
    { from: 3, to: 5 },
  ],
  unresolved: [{ from: 3, key: "fehlt", title: "Fehlt" }],
  files: [],
  removed: [],
});

const labels = (m: { nodes: { label: string }[] }) => m.nodes.map((n) => n.label).sort();

describe("graph model", () => {
  it("draws pages and each link pair once", () => {
    const m = buildModel(data(), defaultOptions());
    expect(m.nodes).toHaveLength(5);
    // 1↔2 counts once.
    expect(m.edges.length / 2).toBe(3);
    expect(m.nodes[m.index.get("p:1")!].degree).toBe(2);
  });

  it("adds ghost and tag nodes when switched on", () => {
    const m = buildModel(data(), { ...defaultOptions(), unresolved: true, tagNodes: true });
    expect(labels(m)).toContain("Fehlt");
    expect(m.nodes.find((n) => n.key === "u:fehlt")?.kind).toBe("ghost");
    expect(labels(m)).toEqual(expect.arrayContaining(["#kunde", "#projekt/portal"]));
  });

  it("hides orphans", () => {
    const m = buildModel(data(), { ...defaultOptions(), orphans: false });
    expect(labels(m)).not.toContain("Allein");
    expect(m.nodes).toHaveLength(4);
  });

  it("keeps only the nodes up to the depth from the focus", () => {
    const o = { ...defaultOptions(), depth: 1 };
    expect(labels(buildModel(data(), o, "p:3"))).toEqual(["Konzept", "Portal", "Übersicht"]);
    expect(labels(buildModel(data(), { ...o, depth: 2 }, "p:3"))).toEqual(["Konzept", "Kunde A", "Portal", "Übersicht"]);
    // An orphan in focus stays even without orphans.
    expect(labels(buildModel(data(), { ...o, orphans: false }, "p:4"))).toEqual(["Allein"]);
  });

  it("lists the pages most linked first", () => {
    expect(listRows(buildModel(data(), defaultOptions())).map((n) => n.label)).toEqual(["Konzept", "Portal", "Kunde A", "Übersicht", "Allein"]);
  });
});

describe("incremental updates", () => {
  it("replaces the outgoing links of patched pages and drops removed ones", () => {
    const d = data();
    expect(patchScope(d, [2]).sort()).toEqual([1, 2]);
    const next = applyPatch(d, {
      nodes: [page(2, "Kunde B", { folder: "Kunden" })],
      links: [{ from: 2, to: 4 }],
      unresolved: [],
      files: [],
      removed: [5],
    });
    expect(next.nodes.find((n) => n.id === 2)?.title).toBe("Kunde B");
    expect(next.nodes.some((n) => n.id === 5)).toBe(false);
    expect(next.links).toEqual([
      { from: 1, to: 2 },
      { from: 1, to: 3 },
      { from: 2, to: 4 },
    ]);
    expect(next.unresolved).toHaveLength(1);
  });
});

describe("filters and groups", () => {
  it("counts the active filters", () => {
    expect(activeFilterCount(defaultFilter(), defaultOptions())).toBe(0);
    expect(activeFilterCount({ ...defaultFilter(), tags: ["a"], folder: 3, from: "2026-01-01" }, { ...defaultOptions(), orphans: false })).toBe(4);
  });

  it("matches rules by tag, folder subtree and query", () => {
    const [portal, kunde, konzept] = data().nodes;
    expect(matchesRule(portal, { id: "a", kind: "tag", value: "#projekt", color: "series-1" })).toBe(true);
    expect(matchesRule(kunde, { id: "a", kind: "tag", value: "projekt", color: "series-1" })).toBe(false);
    expect(matchesRule(konzept, { id: "b", kind: "folder", value: "Projekte", color: "series-2" })).toBe(true);
    expect(matchesRule(konzept, { id: "b", kind: "folder", value: "Projekt", color: "series-2" })).toBe(false);
    expect(matchesQuery(portal, "jira:abc tag:projekt")).toBe(true);
    expect(matchesQuery(portal, "netzplan:4711 path:projekte")).toBe(true);
    expect(matchesQuery(portal, "#kunde")).toBe(false);
    expect(matchesQuery(data().nodes[4], "ubersicht")).toBe(true);
  });

  it("colors by the first matching rule, then by top folder", () => {
    const d = data();
    const m = buildModel(d, defaultOptions());
    const palette = folderPalette(d.nodes);
    // Projekte (2 pages) first, then Wissen (2), then Kunden.
    expect([...palette.colors.entries()]).toEqual([
      ["Projekte", "series-1"],
      ["Wissen", "series-2"],
      ["Kunden", "series-3"],
    ]);
    const colors = nodeColors(m.nodes, [{ id: "x", kind: "tag", value: "kunde", color: "series-8" }], palette);
    expect(colors[m.index.get("p:2")!]).toBe("series-8");
    expect(colors[m.index.get("p:3")!]).toBe("series-1");
    expect(nodeColors(m.nodes, [], null).every((c) => c === null)).toBe(true);
  });

  it("splits a top folder holding most pages by its subfolders", () => {
    const pages = [page(1, "a", { folder: "Arbeit/Projekte" }), page(2, "b", { folder: "Arbeit/Projekte/X" }), page(3, "c", { folder: "Arbeit/Kunden" }), page(4, "d", { folder: "Privat" })];
    const p = folderPalette(pages);
    expect([...p.deep]).toEqual(["Arbeit"]);
    expect([...p.colors.keys()]).toEqual(["Arbeit/Projekte", "Arbeit/Kunden", "Privat"]);
  });

  it("finds nodes accent-free, prefix hits first", () => {
    const m = buildModel(data(), defaultOptions());
    expect(searchNodes(m.nodes, "ubers").map((i) => m.nodes[i].label)).toEqual(["Übersicht"]);
    expect(searchNodes(m.nodes, "k").map((i) => m.nodes[i].label)).toEqual(["Konzept", "Kunde A"]);
    expect(searchNodes(m.nodes, "  ")).toEqual([]);
  });

  it("normalizes stored settings and presets", () => {
    const s = normalizeSettings({ filter: { tags: ["#A", "a", 3], from: "2026-13", daily: false }, options: { depth: 9 }, groups: [{ kind: "tag", value: "x", color: "pink" }, { kind: "nope", value: "y" }], display: { repel: 7 } });
    expect(s.filter.tags).toEqual(["a"]);
    expect(s.filter.from).toBeNull();
    expect(s.filter.daily).toBe(false);
    expect(s.options.depth).toBe(5);
    expect(s.groups).toEqual([{ id: "g0", kind: "tag", value: "x", color: "series-1" }]);
    expect(s.display.repel).toBe(1);
    expect(normalizePresets([{ name: " Kunden " }, { name: "" }, null]).map((p) => p.name)).toEqual(["Kunden"]);
  });
});

describe("keyboard navigation", () => {
  it("moves to the nearest node in the arrow's direction", () => {
    const pos = new Float32Array([0, 0, 10, 1, -10, 0, 0, 10, 30, 0]);
    expect(nearestInDirection(pos, 5, 0, "right")).toBe(1);
    expect(nearestInDirection(pos, 5, 0, "left")).toBe(2);
    expect(nearestInDirection(pos, 5, 0, "down")).toBe(3);
    expect(nearestInDirection(pos, 5, 0, "up")).toBe(-1);
  });
});
