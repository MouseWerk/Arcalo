// Canvas geometry: snapping, bounds, group membership, moving a selection with its groups'
// cards, edge anchors and paths, resizing, align and distribute. Pure functions over canvas units.

import type { CanvasDoc, CanvasNode, Side } from "./model";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface Point {
  x: number;
  y: number;
}

export const GRID = 20;
export const MIN_W = 60;
export const MIN_H = 40;

export const snap = (v: number, grid = GRID) => Math.round(v / grid) * grid;

export function snapRect(r: Rect, grid = GRID): Rect {
  const x = snap(r.x, grid);
  const y = snap(r.y, grid);
  return { x, y, width: Math.max(grid, snap(r.x + r.width, grid) - x), height: Math.max(grid, snap(r.y + r.height, grid) - y) };
}

export function bounds(rects: Rect[]): Rect | null {
  if (!rects.length) return null;
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const r of rects) {
    x1 = Math.min(x1, r.x);
    y1 = Math.min(y1, r.y);
    x2 = Math.max(x2, r.x + r.width);
    y2 = Math.max(y2, r.y + r.height);
  }
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

export const intersects = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

export const contains = (outer: Rect, inner: Rect) =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;

export const center = (r: Rect): Point => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });

/** A rectangle from two corners. */
export function boxOf(a: Point, b: Point): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}

/** Cards a group holds: every other node lying wholly inside it (nested groups with their cards). */
export function groupChildren(nodes: CanvasNode[], group: CanvasNode): CanvasNode[] {
  return nodes.filter((n) => n.id !== group.id && contains(group, n));
}

/** The ids a move of `ids` takes along: the nodes themselves and everything inside selected groups. */
export function movingIds(nodes: CanvasNode[], ids: Iterable<string>): Set<string> {
  const out = new Set<string>();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const id of ids) {
    const n = byId.get(id);
    if (!n) continue;
    out.add(id);
    if (n.type === "group") for (const c of groupChildren(nodes, n)) out.add(c.id);
  }
  return out;
}

/** Moves the nodes of `ids` (see `movingIds`) by dx, dy. Untouched nodes keep their objects. */
export function moveNodes(doc: CanvasDoc, ids: Set<string>, dx: number, dy: number): CanvasDoc {
  if (!dx && !dy) return doc;
  return { ...doc, nodes: doc.nodes.map((n) => (ids.has(n.id) ? { ...n, x: n.x + dx, y: n.y + dy } : n)) };
}

/** The point on `r`'s side where an edge attaches. */
export function anchor(r: Rect, side: Side): Point {
  switch (side) {
    case "top":
      return { x: r.x + r.width / 2, y: r.y };
    case "bottom":
      return { x: r.x + r.width / 2, y: r.y + r.height };
    case "left":
      return { x: r.x, y: r.y + r.height / 2 };
    case "right":
      return { x: r.x + r.width, y: r.y + r.height / 2 };
  }
}

const NORMAL: Record<Side, Point> = { top: { x: 0, y: -1 }, bottom: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };

/** Sides for an edge without stored sides: facing each other along the larger distance. */
export function autoSides(a: Rect, b: Rect): [Side, Side] {
  const ca = center(a);
  const cb = center(b);
  const dx = cb.x - ca.x;
  const dy = cb.y - ca.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? ["right", "left"] : ["left", "right"];
  return dy >= 0 ? ["bottom", "top"] : ["top", "bottom"];
}

/** The side of `r` nearest to `p` (where a dragged connection lands). */
export function nearestSide(r: Rect, p: Point): Side {
  const d: [Side, number][] = [
    ["top", Math.abs(p.y - r.y)],
    ["bottom", Math.abs(p.y - (r.y + r.height))],
    ["left", Math.abs(p.x - r.x)],
    ["right", Math.abs(p.x - (r.x + r.width))],
  ];
  return d.sort((a, b) => a[1] - b[1])[0][0];
}

export interface EdgeGeometry {
  /** SVG path data. */
  d: string;
  /** Where the label sits. */
  mid: Point;
  from: Point;
  to: Point;
  /** Direction the line arrives at `to` (unit vector), for the arrow head. */
  dirTo: Point;
  /** Direction the line leaves `from` towards it (for an arrow at the start). */
  dirFrom: Point;
}

/** An edge from `a`'s side to `b`'s side: a cubic curve leaving along the sides' normals, or a straight line. */
export function edgePath(from: Point, fromSide: Side, to: Point, toSide: Side, straight = false): EdgeGeometry {
  const unit = (v: Point): Point => {
    const l = Math.hypot(v.x, v.y) || 1;
    return { x: v.x / l, y: v.y / l };
  };
  if (straight) {
    const dir = unit({ x: to.x - from.x, y: to.y - from.y });
    return { d: `M${from.x},${from.y} L${to.x},${to.y}`, mid: { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }, from, to, dirTo: dir, dirFrom: { x: -dir.x, y: -dir.y } };
  }
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  const k = Math.max(40, Math.min(220, dist * 0.45));
  const n1 = NORMAL[fromSide];
  const n2 = NORMAL[toSide];
  const c1 = { x: from.x + n1.x * k, y: from.y + n1.y * k };
  const c2 = { x: to.x + n2.x * k, y: to.y + n2.y * k };
  // Point at t = 0.5 of the cubic.
  const mid = { x: (from.x + 3 * c1.x + 3 * c2.x + to.x) / 8, y: (from.y + 3 * c1.y + 3 * c2.y + to.y) / 8 };
  return {
    d: `M${from.x},${from.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${to.x},${to.y}`,
    mid,
    from,
    to,
    dirTo: { x: -n2.x, y: -n2.y },
    dirFrom: { x: -n1.x, y: -n1.y },
  };
}

/** The arrow head at `tip`, pointing along `dir`: a small closed triangle. */
export function arrowHead(tip: Point, dir: Point, size = 10): string {
  const back = { x: tip.x - dir.x * size, y: tip.y - dir.y * size };
  const px = -dir.y * size * 0.55;
  const py = dir.x * size * 0.55;
  const r = (v: number) => Math.round(v * 100) / 100;
  return `M${r(tip.x)},${r(tip.y)} L${r(back.x + px)},${r(back.y + py)} L${r(back.x - px)},${r(back.y - py)} Z`;
}

export type Handle = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";
export const HANDLES: Handle[] = ["n", "ne", "e", "se", "s", "sw", "w", "nw"];

/** `r` resized by dragging `handle` by dx, dy, never below the minimum size. */
export function resizeRect(r: Rect, handle: Handle, dx: number, dy: number, min = { width: MIN_W, height: MIN_H }): Rect {
  let { x, y, width, height } = r;
  if (handle.includes("e")) width = Math.max(min.width, r.width + dx);
  if (handle.includes("s")) height = Math.max(min.height, r.height + dy);
  if (handle.includes("w")) {
    width = Math.max(min.width, r.width - dx);
    x = r.x + r.width - width;
  }
  if (handle.includes("n")) {
    height = Math.max(min.height, r.height - dy);
    y = r.y + r.height - height;
  }
  return { x, y, width, height };
}

export type Align = "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom";

/** New positions that line the nodes up along their common bounds. */
export function alignNodes(nodes: CanvasNode[], how: Align): Map<string, Point> {
  const b = bounds(nodes);
  const out = new Map<string, Point>();
  if (!b) return out;
  for (const n of nodes) {
    let { x, y } = n;
    if (how === "left") x = b.x;
    if (how === "right") x = b.x + b.width - n.width;
    if (how === "hcenter") x = b.x + (b.width - n.width) / 2;
    if (how === "top") y = b.y;
    if (how === "bottom") y = b.y + b.height - n.height;
    if (how === "vcenter") y = b.y + (b.height - n.height) / 2;
    out.set(n.id, { x, y });
  }
  return out;
}

/** Equal gaps between the nodes along an axis; the outermost two stay. */
export function distributeNodes(nodes: CanvasNode[], axis: "x" | "y"): Map<string, Point> {
  const out = new Map<string, Point>();
  if (nodes.length < 3) return out;
  const size = axis === "x" ? "width" : "height";
  const sorted = [...nodes].sort((a, b) => a[axis] - b[axis]);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const span = last[axis] + last[size] - first[axis];
  const total = sorted.reduce((s, n) => s + n[size], 0);
  const gap = (span - total) / (sorted.length - 1);
  let at = first[axis];
  for (const n of sorted) {
    out.set(n.id, axis === "x" ? { x: at, y: n.y } : { x: n.x, y: at });
    at += n[size] + gap;
  }
  return out;
}

/** Nodes touching `view` (with `margin` around it): the cards worth rendering. */
export function visibleNodes(nodes: CanvasNode[], view: Rect, margin = 200): CanvasNode[] {
  const v = { x: view.x - margin, y: view.y - margin, width: view.width + 2 * margin, height: view.height + 2 * margin };
  return nodes.filter((n) => intersects(n, v));
}

/** Zoom and pan that fit `r` into a `w` × `h` viewport with padding (zoom within limits). */
export function fitView(r: Rect, w: number, h: number, pad = 60, minZoom = 0.1, maxZoom = 1): { zoom: number; x: number; y: number } {
  const zoom = Math.max(minZoom, Math.min(maxZoom, (w - 2 * pad) / Math.max(1, r.width), (h - 2 * pad) / Math.max(1, r.height)));
  return { zoom, x: w / 2 - (r.x + r.width / 2) * zoom, y: h / 2 - (r.y + r.height / 2) * zoom };
}

/** Zoom around a screen point: the canvas point under it stays under it. */
export function zoomAt(view: { zoom: number; x: number; y: number }, next: number, at: Point): { zoom: number; x: number; y: number } {
  const wx = (at.x - view.x) / view.zoom;
  const wy = (at.y - view.y) / view.zoom;
  return { zoom: next, x: at.x - wx * next, y: at.y - wy * next };
}
