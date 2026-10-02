import { describe, expect, it } from "vitest";
import { copyPayload, pastePayload, readPayload } from "./clipboard";
import { alignNodes, anchor, arrowHead, autoSides, distributeNodes, edgePath, fitView, groupChildren, moveNodes, movingIds, nearestSide, resizeRect, snap, snapRect, visibleNodes, zoomAt } from "./geometry";
import { CanvasHistory } from "./history";
import { cardKind, colorValue, parseCanvas, patchNode, removeItems, serializeCanvas, withNode, type CanvasDoc, type CanvasNode } from "./model";

const node = (id: string, x: number, y: number, width = 100, height = 50, extra: Partial<CanvasNode> = {}): CanvasNode => ({ id, type: "text", text: id, x, y, width, height, ...extra });

describe("canvas model", () => {
  it("keeps unknown fields and their order through parse, patch and serialize", () => {
    const text = JSON.stringify({ nodes: [{ id: "a", type: "text", text: "Hi", x: 1, y: 2, width: 3, height: 4, plugin: { z: [1] } }], edges: [], extra: true });
    const doc = parseCanvas(text);
    expect(JSON.stringify(doc)).toBe(text);
    const moved = patchNode(doc, "a", { x: 10, color: "3" });
    expect(Object.keys(moved.nodes[0])).toEqual(["id", "type", "text", "x", "y", "width", "height", "plugin", "color"]);
    expect(patchNode(moved, "a", { color: undefined }).nodes[0].color).toBeUndefined();
    expect(serializeCanvas(doc)).toContain('\t"nodes"');
    expect(parseCanvas("kaputt")).toEqual({ nodes: [], edges: [] });
  });

  it("hides edges to missing nodes, keeps them in the file, and removes edges with their nodes", () => {
    const doc = parseCanvas(JSON.stringify({ nodes: [node("a", 0, 0), node("b", 0, 0)], edges: [{ id: "e", fromNode: "a", toNode: "b" }, { id: "x", fromNode: "a", toNode: "zz" }] }));
    expect(doc.edges.map((e) => e.id)).toEqual(["e"]);
    expect(removeItems(doc, new Set(["b"])).edges).toEqual([]);
    // The next save writes the edge it could not show (its card may come back by a merge).
    const saved = JSON.parse(serializeCanvas(patchNode(doc, "a", { x: 5 })));
    expect(saved.edges.map((e: { id: string }) => e.id)).toEqual(["e", "x"]);
    expect(Object.keys(saved)).toEqual(["nodes", "edges"]);
    expect(parseCanvas(serializeCanvas(doc))).toEqual(doc);
  });

  it("tells card kinds and colors apart", () => {
    expect(cardKind({ ...node("a", 0, 0), type: "file", file: "Ordner/Plan.md" })).toBe("note");
    expect(cardKind({ ...node("a", 0, 0), type: "file", file: "attachments/bild.PNG" })).toBe("image");
    expect(cardKind({ ...node("a", 0, 0), type: "file", file: "a.pdf" })).toBe("file");
    expect(cardKind({ ...node("a", 0, 0), type: "link", url: "https://x", issue: "SAP-1" })).toBe("issue");
    expect(colorValue("4")).toBe("var(--cv-c4)");
    expect(colorValue("#AABBCC")).toBe("#AABBCC");
    expect(colorValue("rot")).toBeNull();
  });

  it("puts groups below the cards", () => {
    const doc = withNode({ nodes: [node("a", 0, 0)], edges: [] }, { ...node("g", 0, 0), type: "group" });
    expect(doc.nodes.map((n) => n.id)).toEqual(["g", "a"]);
  });
});

describe("canvas geometry", () => {
  it("snaps to the grid", () => {
    expect(snap(29)).toBe(20);
    expect(snap(31)).toBe(40);
    expect(snapRect({ x: 11, y: 9, width: 95, height: 3 })).toEqual({ x: 20, y: 0, width: 80, height: 20 });
  });

  it("moves a group with the cards inside it, and only those", () => {
    const g = { ...node("g", 0, 0, 500, 300), type: "group" };
    const inner = node("in", 20, 20);
    const nested = { ...node("g2", 200, 100, 200, 150), type: "group" };
    const deep = node("deep", 220, 120);
    const outside = node("out", 600, 0);
    const half = node("half", 450, 250);
    const doc: CanvasDoc = { nodes: [g, nested, inner, deep, outside, half], edges: [] };
    expect(groupChildren(doc.nodes, g).map((n) => n.id).sort()).toEqual(["deep", "g2", "in"]);
    const ids = movingIds(doc.nodes, ["g"]);
    const moved = moveNodes(doc, ids, 40, -20);
    const at = (id: string) => moved.nodes.find((n) => n.id === id)!;
    expect([at("g").x, at("in").x, at("deep").y, at("g2").x]).toEqual([40, 60, 100, 240]);
    expect(at("out")).toBe(outside);
    expect(at("half")).toBe(half);
  });

  it("anchors edges on the sides and chooses facing sides", () => {
    const a = { x: 0, y: 0, width: 100, height: 50 };
    const b = { x: 300, y: 10, width: 100, height: 50 };
    expect(anchor(a, "right")).toEqual({ x: 100, y: 25 });
    expect(anchor(a, "top")).toEqual({ x: 50, y: 0 });
    expect(autoSides(a, b)).toEqual(["right", "left"]);
    expect(autoSides(a, { x: 0, y: 400, width: 10, height: 10 })).toEqual(["bottom", "top"]);
    expect(nearestSide(b, { x: 395, y: 30 })).toBe("right");
    const curve = edgePath(anchor(a, "right"), "right", anchor(b, "left"), "left");
    expect(curve.d.startsWith("M100,25 C")).toBe(true);
    expect(curve.dirTo).toEqual({ x: 1, y: -0 });
    const line = edgePath({ x: 0, y: 0 }, "right", { x: 100, y: 0 }, "left", true);
    expect(line.d).toBe("M0,0 L100,0");
    expect(line.mid).toEqual({ x: 50, y: 0 });
    expect(arrowHead({ x: 100, y: 0 }, { x: 1, y: 0 })).toBe("M100,0 L90,5.5 L90,-5.5 Z");
  });

  it("resizes from any handle without going below the minimum", () => {
    const r = { x: 0, y: 0, width: 200, height: 100 };
    expect(resizeRect(r, "se", 50, 20)).toEqual({ x: 0, y: 0, width: 250, height: 120 });
    expect(resizeRect(r, "nw", 30, 10)).toEqual({ x: 30, y: 10, width: 170, height: 90 });
    expect(resizeRect(r, "w", 500, 0)).toEqual({ x: 140, y: 0, width: 60, height: 100 });
  });

  it("aligns and distributes", () => {
    const ns = [node("a", 0, 0, 100, 50), node("b", 50, 100, 50, 50), node("c", 400, 30, 100, 50)];
    expect(alignNodes(ns, "left").get("c")).toEqual({ x: 0, y: 30 });
    expect(alignNodes(ns, "right").get("b")).toEqual({ x: 450, y: 100 });
    expect(alignNodes(ns, "vcenter").get("a")).toEqual({ x: 0, y: 50 });
    const d = distributeNodes(ns, "x");
    // Span 0…500, widths 250: gaps of 125.
    expect([d.get("a")!.x, d.get("b")!.x, d.get("c")!.x]).toEqual([0, 225, 400]);
    expect(distributeNodes(ns.slice(0, 2), "x").size).toBe(0);
  });

  it("culls, fits and zooms around the pointer", () => {
    const ns = [node("a", 0, 0), node("b", 5000, 5000)];
    expect(visibleNodes(ns, { x: 0, y: 0, width: 800, height: 600 }).map((n) => n.id)).toEqual(["a"]);
    const f = fitView({ x: 0, y: 0, width: 1000, height: 500 }, 1120, 620, 60);
    expect(f.zoom).toBe(1);
    const z = zoomAt({ zoom: 1, x: 0, y: 0 }, 2, { x: 100, y: 100 });
    expect(z).toEqual({ zoom: 2, x: -100, y: -100 });
  });
});

describe("canvas history", () => {
  it("undoes and redoes snapshots and ignores no-op gestures", () => {
    const h = new CanvasHistory(3);
    expect(h.undo("A")).toBeNull();
    h.record("A");
    h.record("A");
    expect(h.undo("B")).toBe("A");
    expect(h.redo("A")).toBe("B");
    expect(h.canRedo).toBe(false);
    h.record("B");
    h.settle("B");
    expect(h.undo("B")).toBe("A");
    // A new change drops the redo list; the limit keeps the newest.
    h.record("A");
    for (const s of ["1", "2", "3", "4"]) h.record(s);
    expect(h.canRedo).toBe(false);
    expect([h.undo("5"), h.undo("4"), h.undo("3"), h.undo("2")]).toEqual(["4", "3", "2", null]);
  });
});

describe("canvas clipboard", () => {
  const doc: CanvasDoc = {
    nodes: [{ ...node("g", 0, 0, 400, 300), type: "group", label: "G" }, node("a", 10, 10), node("b", 200, 10), node("c", 900, 0)],
    edges: [
      { id: "e1", fromNode: "a", toNode: "b", label: "x" },
      { id: "e2", fromNode: "b", toNode: "c" },
    ],
  };

  it("copies a group with its cards and the edges inside", () => {
    const p = copyPayload(doc, ["g"]);
    expect(p.nodes.map((n) => n.id)).toEqual(["g", "a", "b"]);
    expect(p.edges.map((e) => e.id)).toEqual(["e1"]);
    expect(readPayload(JSON.stringify(p))).toEqual(p);
    expect(readPayload("Hallo")).toBeNull();
    expect(readPayload('{"nodes":[]}')).toBeNull();
  });

  it("pastes with new ids and remapped edges, groups below cards", () => {
    const { doc: next, ids } = pastePayload(doc, copyPayload(doc, ["g"]), { at: { x: 1000, y: 500 } });
    expect(ids).toHaveLength(3);
    expect(new Set([...doc.nodes.map((n) => n.id), ...ids]).size).toBe(7);
    const pasted = next.nodes.filter((n) => ids.includes(n.id));
    expect(pasted.find((n) => n.type === "group")).toMatchObject({ x: 1000, y: 500, label: "G" });
    expect(next.nodes.findIndex((n) => n.id === ids[0])).toBeLessThan(next.nodes.findIndex((n) => n.id === "a"));
    const e = next.edges[next.edges.length - 1];
    expect(ids).toContain(e.fromNode);
    expect(ids).toContain(e.toNode);
    expect(e.label).toBe("x");
    const dup = pastePayload(doc, copyPayload(doc, ["c"]), { offset: { x: 20, y: 20 } });
    expect(dup.doc.nodes[dup.doc.nodes.length - 1]).toMatchObject({ x: 920, y: 20, text: "c" });
  });
});
