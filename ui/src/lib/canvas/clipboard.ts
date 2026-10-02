// Copy, paste and duplicate on a canvas. The clipboard holds a small JSON Canvas document (the
// cards, the cards inside copied groups, and the edges between them) under its own type and as
// text, so a copy also pastes into Obsidian's canvas and into another Arcalo canvas.

import { movingIds } from "./geometry";
import { newId, type CanvasDoc, type CanvasEdge, type CanvasNode } from "./model";

export const CLIP_MIME = "application/x-arcalo-canvas";

export interface ClipPayload {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

/** The selected nodes (with their groups' cards) and the edges among them. */
export function copyPayload(doc: CanvasDoc, nodeIds: Iterable<string>): ClipPayload {
  const ids = movingIds(doc.nodes, nodeIds);
  return {
    nodes: doc.nodes.filter((n) => ids.has(n.id)),
    edges: doc.edges.filter((e) => ids.has(e.fromNode) && ids.has(e.toNode)),
  };
}

/** Reads a payload from clipboard text (ours or an Obsidian canvas copy); null when it is none. */
export function readPayload(text: string): ClipPayload | null {
  try {
    const v = JSON.parse(text) as Partial<ClipPayload>;
    if (!v || !Array.isArray(v.nodes) || !v.nodes.length) return null;
    const nodes = v.nodes.filter((n) => n && typeof n.id === "string" && typeof n.type === "string" && Number.isFinite(n.x) && Number.isFinite(n.y));
    if (!nodes.length) return null;
    const ids = new Set(nodes.map((n) => n.id));
    const edges = (Array.isArray(v.edges) ? v.edges : []).filter((e) => e && ids.has(e.fromNode) && ids.has(e.toNode));
    return { nodes, edges };
  } catch {
    return null;
  }
}

/**
 * Adds a copy of `payload` with new ids: moved by `offset`, or with its top-left corner at `at`.
 * Returns the new document and the ids of the pasted nodes.
 */
export function pastePayload(doc: CanvasDoc, payload: ClipPayload, place: { offset: { x: number; y: number } } | { at: { x: number; y: number } }): { doc: CanvasDoc; ids: string[] } {
  const minX = Math.min(...payload.nodes.map((n) => n.x));
  const minY = Math.min(...payload.nodes.map((n) => n.y));
  const dx = "offset" in place ? place.offset.x : place.at.x - minX;
  const dy = "offset" in place ? place.offset.y : place.at.y - minY;
  const map = new Map<string, string>();
  const nodes = payload.nodes.map((n) => {
    const id = newId();
    map.set(n.id, id);
    return { ...structuredClone(n), id, x: n.x + dx, y: n.y + dy };
  });
  const edges = payload.edges.map((e) => ({ ...structuredClone(e), id: newId(), fromNode: map.get(e.fromNode)!, toNode: map.get(e.toNode)! }));
  // Pasted groups go below the cards like the others.
  const groups = nodes.filter((n) => n.type === "group");
  const cards = nodes.filter((n) => n.type !== "group");
  const firstCard = doc.nodes.findIndex((n) => n.type !== "group");
  const before = firstCard < 0 ? doc.nodes : doc.nodes.slice(0, firstCard);
  const after = firstCard < 0 ? [] : doc.nodes.slice(firstCard);
  return {
    doc: { ...doc, nodes: [...before, ...groups, ...after, ...cards], edges: [...doc.edges, ...edges] },
    ids: nodes.map((n) => n.id),
  };
}
