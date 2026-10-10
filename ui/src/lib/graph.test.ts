import { describe, expect, it } from "vitest";
import {
  sentences,
  activeFilterCount,
  applyPatch,
  buildModel,
  defaultFilter,
  defaultOptions,
  folderPalette,
  fromGraphTable,
  listRows,
  matchesQuery,
  matchesRule,
  nearestInDirection,
  nodeColors,
  placeLabel,
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

describe("placeLabel", () => {
  const measure = (t: string) => Array.from(t).length * 6;
  it("stays centered under a node in the middle", () => {
    expect(placeLabel("Projekt", 150, 300, measure)).toEqual({ text: "Projekt", x: 150, width: 42 });
  });
  it.each([
    [2, 4 + 60],
    [-40, 4 + 60],
    [298, 300 - 4 - 60],
    [340, 300 - 4 - 60],
  ])("is kept inside the canvas for a node at %d", (sx, x) => {
    const p = placeLabel("Zwanzig Zeichen lang", sx, 300, measure);
    expect(p.x).toBe(x);
    expect(p.x - p.width / 2).toBeGreaterThanOrEqual(4);
    expect(p.x + p.width / 2).toBeLessThanOrEqual(296);
  });
  it("is shortened when wider than the canvas", () => {
    const p = placeLabel("x".repeat(80), 10, 200, measure);
    expect(p.width).toBeLessThanOrEqual(192);
    expect(p.text.endsWith("…")).toBe(true);
    expect(p.x).toBeGreaterThanOrEqual(4 + p.width / 2);
  });
});

describe("announcements", () => {
  it("joins parts as sentences without a double period", () => {
    expect(sentences(["Jour fixe 22.09.", "3 Verknüpfungen", ""])).toBe("Jour fixe 22.09. 3 Verknüpfungen");
    expect(sentences(["Architektur", "1 Verknüpfung", "Ordner Projekte"])).toBe("Architektur. 1 Verknüpfung. Ordner Projekte");
  });
});

describe("compact graph", () => {
  it("decodes the table of graph_compact into the objects of graph_data", () => {
    const d = fromGraphTable({
      folders: ["", "Projekte/Kunde"],
      nodes: [
        [1, "Start", null, null, 0, [], [], null, false, 1, 2],
        [7, "Portal", "star", 3, 1, ["projekt"], ["NP-1"], "ABC-1", true, 0, 1],
      ],
      links: [1, 7, 7, 1],
      unresolved: [[7, "fehlt", "Fehlt"]],
      files: [[1, "a.pdf"]],
      removed: [9],
    });
    expect(d.nodes[1]).toEqual({ id: 7, title: "Portal", icon: "star", parent_id: 3, folder: "Projekte/Kunde", tags: ["projekt"], netzplan: ["NP-1"], jira: "ABC-1", daily: true, links_in: 0, links_out: 1 });
    expect(d.nodes[0].folder).toBe("");
    expect(d.links).toEqual([{ from: 1, to: 7 }, { from: 7, to: 1 }]);
    expect(d.unresolved).toEqual([{ from: 7, key: "fehlt", title: "Fehlt" }]);
    expect(d.files).toEqual([{ from: 1, name: "a.pdf" }]);
    expect(d.removed).toEqual([9]);
  });
});
