// The graph on a 2D canvas, for the graph view and the local graph of the side panel: one path
// per color for nodes and per state for links (thousands of each stay smooth), labels from a
// zoom level on (bigger nodes earlier), hover dims all but the neighbors. Pan and zoom with
// mouse, wheel, trackpad and keys; nodes can be dragged; a click opens the page (Ctrl/Cmd: new
// tab). The force layout runs in a Web Worker and arrives progressively.
//
// Keyboard: the arrow keys move from node to node (nearest in that direction), Enter opens,
// Shift+arrows pan, + and - zoom, 0 fits, Home picks the most linked node, Escape clears.

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { GraphDisplay, GraphModel, GroupColor, VNode } from "../../lib/graph";
import { nearestInDirection, nodeRadius, placeLabel } from "../../lib/graph";
import type { ForceParams, LayoutIn, LayoutOut, LayoutPort } from "../../lib/graphLayout";
import { startLayout } from "../../lib/graphLayout";
import { t } from "../../lib/i18n";
import { reducedMotion } from "../../lib/motion";
import { isComposing } from "../../lib/ime";

export interface GraphCanvasHandle {
  fit(animate?: boolean): void;
  zoomBy(factor: number): void;
  /** Centers and zooms to a node and selects it. */
  focusNode(index: number): void;
  /** The current view as PNG at `scale` times its size, on the theme's background. */
  exportPng(scale?: number): Promise<Uint8Array>;
  /** Positions by node key (for the layout cache). */
  positions(): Map<string, [number, number]>;
}

interface Props {
  model: GraphModel;
  colors: (GroupColor | null)[];
  display: GraphDisplay;
  /** Search hits: highlighted, the rest a little dimmed. */
  highlight?: Set<number> | null;
  /** The node of the page in focus (local graph): ringed. */
  current?: number | null;
  /** Known positions (layout cache) by node key. */
  seed?: Map<string, [number, number]> | null;
  /** The layout rests: positions by key. */
  onSettled?: (pos: Map<string, [number, number]>) => void;
  onOpen: (n: VNode, newTab: boolean) => void;
  onSelect?: (index: number | null) => void;
  /** Smaller labels and no hover card (side panel). */
  compact?: boolean;
  label: string;
}

interface Palette {
  bg: string;
  text: string;
  text2: string;
  muted: string;
  edge: string;
  accent: string;
  violet: string;
  font: string;
  series: Record<string, string>;
}

function readPalette(el: Element): Palette {
  const cs = getComputedStyle(el);
  const v = (n: string, d: string) => cs.getPropertyValue(n).trim() || d;
  const series: Record<string, string> = {};
  for (let i = 1; i <= 8; i++) series[`series-${i}`] = v(`--series-${i}`, "#888");
  const dark = document.documentElement.dataset.theme === "dark";
  return {
    bg: v("--bg-canvas", dark ? "#16171a" : "#ffffff"),
    text: v("--text", "#222"),
    text2: v("--text-2", "#555"),
    muted: dark ? "#6b6f7b" : "#a1a1aa",
    edge: dark ? "rgba(255,255,255,0.16)" : "rgba(24,24,27,0.17)",
    accent: v("--accent", "#6366f1"),
    violet: v("--violet", "#7c3aed"),
    font: v("--font-ui", "system-ui, sans-serif"),
    series,
  };
}


const forceParams = (d: GraphDisplay): ForceParams => ({ center: d.center, repel: d.repel, linkDistance: d.linkDistance });

export const GraphCanvas = forwardRef<GraphCanvasHandle, Props>(function GraphCanvas(props, ref) {
  const { model, colors, display, highlight, current, seed, compact, label } = props;
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const cb = useRef(props);
  cb.current = props;
  // Mutable render state (kept out of React: it changes every frame).
  const st = useRef({
    pos: new Float32Array(0) as Float32Array,
    view: { x: 0, y: 0, k: 1 },
    size: { w: 0, h: 0, dpr: 1 },
    hover: -1,
    selected: -1,
    fade: 0,
    autoFit: true,
    dirty: true,
    raf: 0,
    palette: null as Palette | null,
    worker: null as LayoutPort | null,
    radius: new Float32Array(0),
    neighbors: [] as number[][],
    tween: null as null | { from: { x: number; y: number; k: number }; to: { x: number; y: number; k: number }; t0: number },
  });
  const [announce, setAnnounce] = useState("");
  const animate = display.animate && !reducedMotion();

  const request = useCallback(() => {
    const s = st.current;
    s.dirty = true;
    if (!s.raf) s.raf = requestAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- geometry

  const bounds = (only?: number[]) => {
    const { pos } = st.current;
    const n = model.nodes.length;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const each = only ?? [...Array(n).keys()];
    for (const i of each) {
      const x = pos[i * 2], y = pos[i * 2 + 1];
      if (!Number.isFinite(x)) continue;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x);
      y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    return Number.isFinite(x0) ? { x0, y0, x1, y1 } : null;
  };

  const fitView = (): { x: number; y: number; k: number } | null => {
    const s = st.current;
    const b = bounds();
    if (!b || !s.size.w) return null;
    const pad = compact ? 28 : 64;
    const w = Math.max(1, b.x1 - b.x0), h = Math.max(1, b.y1 - b.y0);
    const k = Math.min((s.size.w - pad * 2) / w, (s.size.h - pad * 2) / h, compact ? 2.2 : 3);
    return { k, x: s.size.w / 2 - ((b.x0 + b.x1) / 2) * k, y: s.size.h / 2 - ((b.y0 + b.y1) / 2) * k };
  };

  const moveTo = (to: { x: number; y: number; k: number }, smooth: boolean) => {
    const s = st.current;
    if (smooth && animate) s.tween = { from: { ...s.view }, to, t0: performance.now() };
    else s.view = to;
    request();
  };

  const toWorld = (sx: number, sy: number) => {
    const v = st.current.view;
    return { x: (sx - v.x) / v.k, y: (sy - v.y) / v.k };
  };

  const hit = (sx: number, sy: number): number => {
    const s = st.current;
    const { x, y } = toWorld(sx, sy);
    let best = -1;
    let bestD = Infinity;
    const slack = 5 / s.view.k;
    for (let i = 0; i < model.nodes.length; i++) {
      const dx = s.pos[i * 2] - x, dy = s.pos[i * 2 + 1] - y;
      const d = dx * dx + dy * dy;
      const r = s.radius[i] + slack;
      if (d <= r * r && d < bestD) {
        best = i;
        bestD = d;
      }
    }
    return best;
  };

  // ---- drawing

  const draw = (ctx: CanvasRenderingContext2D, w: number, h: number, scale: number, opaque: boolean) => {
    // Called from animation frames scheduled by older renders: always the latest props.
    const { model, colors, display, highlight, current, compact } = cb.current;
    const s = st.current;
    const p = (s.palette ??= readPalette(wrap.current ?? document.documentElement));
    const { pos, view, radius } = s;
    const n = model.nodes.length;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    if (opaque) {
      ctx.fillStyle = p.bg;
      ctx.fillRect(0, 0, w, h);
    } else ctx.clearRect(0, 0, w, h);
    if (!n || pos.length < n * 2) return;
    const focus = s.hover >= 0 ? s.hover : s.selected;
    const near = focus >= 0 ? new Set([focus, ...(s.neighbors[focus] ?? [])]) : null;
    const fade = s.fade;
    const searching = !!highlight && highlight.size > 0;
    const k = view.k;
    // Visible world rectangle (with a margin for labels).
    const m = 80 / k;
    const wx0 = -view.x / k - m, wy0 = -view.y / k - m, wx1 = (w - view.x) / k + m, wy1 = (h - view.y) / k + m;
    const inView = (i: number) => {
      const x = pos[i * 2], y = pos[i * 2 + 1];
      return x >= wx0 && x <= wx1 && y >= wy0 && y <= wy1;
    };
    ctx.setTransform(k * scale, 0, 0, k * scale, view.x * scale, view.y * scale);

    // Links: rest, then the ones at the focus on top.
    const lw = Math.max(0.6 / k, 0.9 * display.linkWidth * Math.min(1, 1.6 / Math.sqrt(k)));
    const e = model.edges;
    const dimEdges = near ? 1 - 0.75 * fade : searching ? 0.6 : 1;
    ctx.lineWidth = lw;
    ctx.strokeStyle = p.edge;
    ctx.globalAlpha = dimEdges;
    ctx.beginPath();
    const hot: number[] = [];
    for (let j = 0; j < e.length; j += 2) {
      const a = e[j], b = e[j + 1];
      if (near && (a === focus || b === focus)) {
        hot.push(a, b);
        continue;
      }
      if (!inView(a) && !inView(b)) continue;
      ctx.moveTo(pos[a * 2], pos[a * 2 + 1]);
      ctx.lineTo(pos[b * 2], pos[b * 2 + 1]);
    }
    ctx.stroke();
    if (hot.length) {
      ctx.globalAlpha = 0.35 + 0.6 * fade;
      ctx.strokeStyle = p.accent;
      ctx.lineWidth = lw * 1.6;
      ctx.beginPath();
      for (let j = 0; j < hot.length; j += 2) {
        ctx.moveTo(pos[hot[j] * 2], pos[hot[j] * 2 + 1]);
        ctx.lineTo(pos[hot[j + 1] * 2], pos[hot[j + 1] * 2 + 1]);
      }
      ctx.stroke();
    }

    // Nodes, one path per fill and alpha.
    const fillOf = (i: number) => {
      const node = model.nodes[i];
      if (node.kind === "ghost") return p.muted;
      if (node.kind === "tag") return p.violet;
      if (node.kind === "file") return p.muted;
      const c = colors[i];
      return c ? p.series[c] : p.text2;
    };
    const alphaOf = (i: number) => {
      if (near) return near.has(i) ? 1 : 1 - 0.82 * fade;
      if (searching) return highlight!.has(i) ? 1 : 0.28;
      return 1;
    };
    const groups = new Map<string, number[]>();
    for (let i = 0; i < n; i++) {
      if (!inView(i)) continue;
      const key = `${fillOf(i)}|${alphaOf(i).toFixed(2)}`;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = []));
      g.push(i);
    }
    for (const [key, list] of groups) {
      const [fill, a] = key.split("|");
      ctx.globalAlpha = Number(a);
      ctx.fillStyle = fill;
      ctx.beginPath();
      for (const i of list) {
        const r = radius[i];
        const x = pos[i * 2], y = pos[i * 2 + 1];
        if (model.nodes[i].kind === "file") {
          ctx.rect(x - r * 0.85, y - r * 0.85, r * 1.7, r * 1.7);
        } else {
          ctx.moveTo(x + r, y);
          ctx.arc(x, y, r, 0, Math.PI * 2);
        }
      }
      ctx.fill();
    }
    // Ghosts are hollow: a ring in the background color inside.
    ctx.globalAlpha = 1;
    ctx.fillStyle = p.bg;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      if (model.nodes[i].kind !== "ghost" || !inView(i)) continue;
      const r = radius[i] * 0.55;
      ctx.moveTo(pos[i * 2] + r, pos[i * 2 + 1]);
      ctx.arc(pos[i * 2], pos[i * 2 + 1], r, 0, Math.PI * 2);
    }
    ctx.fill();
    // Rings: the current page, the selected node, search hits.
    const ring = (i: number, color: string, width: number, gap: number) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width / k;
      ctx.beginPath();
      ctx.arc(pos[i * 2], pos[i * 2 + 1], radius[i] + gap / k, 0, Math.PI * 2);
      ctx.stroke();
    };
    if (searching) for (const i of highlight!) if (inView(i)) ring(i, p.accent, 1.5, 2.5);
    if (current != null && current >= 0 && current < n) ring(current, p.accent, 2, 3);
    if (s.selected >= 0 && s.selected < n) ring(s.selected, p.text, 1.5, 4.5);

    // Labels in screen space: crisp at any zoom.
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    const fs = compact ? 10.5 : 12;
    ctx.font = `500 ${fs}px ${p.font}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.lineJoin = "round";
    ctx.lineWidth = 3;
    ctx.strokeStyle = p.bg;
    const labelled: number[] = [];
    const must = new Set<number>();
    if (near) near.forEach((i) => must.add(i));
    if (searching) highlight!.forEach((i) => must.add(i));
    if (current != null && current >= 0) must.add(current);
    for (let i = 0; i < n; i++) {
      if (!inView(i)) continue;
      // Bigger nodes show their label earlier.
      const sr = radius[i] * k;
      const show = must.has(i) || sr >= (compact ? 4.5 : 8) || k >= (compact ? 1.6 : 2.2);
      if (show) labelled.push(i);
    }
    // The focus and its neighbors first, then by links; a label that would overlap one already
    // drawn is left out (the hover card and zooming in show it).
    labelled.sort((a, b) => Number(b === focus) - Number(a === focus) || Number(must.has(b)) - Number(must.has(a)) || model.nodes[b].degree - model.nodes[a].degree);
    const max = compact ? 80 : 400;
    const boxes: number[] = [];
    for (const i of labelled.slice(0, max)) {
      const node = model.nodes[i];
      const sy = (pos[i * 2 + 1] + radius[i]) * k + view.y + 4;
      // Kept inside the canvas: a node near the panel's edge keeps its whole label.
      const placed = placeLabel(node.label.length > 42 ? `${node.label.slice(0, 40)}…` : node.label, pos[i * 2] * k + view.x, w, (x) => ctx.measureText(x).width);
      const { text, x: sx, width: tw } = placed;
      const bx0 = sx - tw / 2 - 2, bx1 = sx + tw / 2 + 2, by0 = sy - 1, by1 = sy + fs + 1;
      let hit = false;
      for (let b = 0; b < boxes.length && !hit; b += 4) hit = bx0 < boxes[b + 2] && bx1 > boxes[b] && by0 < boxes[b + 3] && by1 > boxes[b + 1];
      if (hit) continue;
      // Big nodes are labelled at any zoom, the rest fade in when zooming closer.
      const zoomIn = Math.min(1, Math.max(0, (radius[i] * k - (compact ? 3 : 7)) / 3) + Math.max(0, (k - 1.4) / 0.6));
      // With a node in focus only its neighbors keep their labels.
      const a = must.has(i) ? 1 : near ? (1 - fade) * zoomIn : Math.min(alphaOf(i), Math.max(0.15, zoomIn));
      if (a <= 0.05) continue;
      boxes.push(bx0, by0, bx1, by1);
      ctx.globalAlpha = a;
      ctx.strokeText(text, sx, sy);
      ctx.fillStyle = node.kind === "ghost" ? p.muted : p.text;
      ctx.fillText(text, sx, sy);
    }
    // The hovered node's title as a card.
    if (s.hover >= 0 && !compact) {
      const i = s.hover;
      const node = model.nodes[i];
      ctx.globalAlpha = 1;
      ctx.font = `600 13px ${p.font}`;
      const tw = ctx.measureText(node.label).width;
      const sx = pos[i * 2] * k + view.x;
      const sy = (pos[i * 2 + 1] - radius[i]) * k + view.y - 12;
      const bw = tw + 18, bh = 24;
      ctx.fillStyle = p.bg;
      ctx.strokeStyle = p.accent;
      ctx.lineWidth = 1;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(sx - bw / 2, sy - bh, bw, bh, 7);
      else ctx.rect(sx - bw / 2, sy - bh, bw, bh);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = p.text;
      ctx.textBaseline = "middle";
      ctx.fillText(node.label, sx, sy - bh / 2 + 0.5);
    }
    ctx.globalAlpha = 1;
  };

  function frame(now: number) {
    const s = st.current;
    const animate = cb.current.display.animate && !reducedMotion();
    s.raf = 0;
    // Hover fade and view tweens.
    const target = s.hover >= 0 || s.selected >= 0 ? 1 : 0;
    if (s.fade !== target) {
      s.fade = animate ? Math.max(0, Math.min(1, s.fade + (target ? 0.16 : -0.16))) : target;
      s.dirty = true;
    }
    if (s.tween) {
      const tt = Math.min(1, (now - s.tween.t0) / 320);
      const e = 1 - Math.pow(1 - tt, 3);
      const { from, to } = s.tween;
      s.view = { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e, k: from.k + (to.k - from.k) * e };
      if (tt >= 1) s.tween = null;
      s.dirty = true;
    }
    if (s.dirty && canvas.current) {
      s.dirty = false;
      const ctx = canvas.current.getContext("2d");
      if (ctx) draw(ctx, s.size.w, s.size.h, s.size.dpr, false);
      canvas.current.dataset.frames = String(Number(canvas.current.dataset.frames ?? 0) + 1);
    }
    if (s.tween || s.fade !== target) s.raf = requestAnimationFrame(frame);
  }

  // ---- layout worker per model

  useEffect(() => {
    const s = st.current;
    const n = model.nodes.length;
    const prev = new Map<string, [number, number]>();
    const old = (s as { keys?: string[] }).keys;
    if (old) old.forEach((key, i) => prev.set(key, [s.pos[i * 2], s.pos[i * 2 + 1]]));
    const positions = new Float32Array(n * 2);
    const known = new Uint8Array(n);
    let knownCount = 0;
    model.nodes.forEach((node, i) => {
      const p = prev.get(node.key) ?? seed?.get(node.key);
      if (p && Number.isFinite(p[0]) && Number.isFinite(p[1])) {
        positions[i * 2] = p[0];
        positions[i * 2 + 1] = p[1];
        known[i] = 1;
        knownCount++;
      }
    });
    (s as { keys?: string[] }).keys = model.nodes.map((x) => x.key);
    s.pos = positions;
    s.hover = -1;
    if (s.selected >= n) s.selected = -1;
    s.radius = Float32Array.from(model.nodes, (x) => nodeRadius(x, display));
    const nb: number[][] = Array.from({ length: n }, () => []);
    for (let j = 0; j < model.edges.length; j += 2) {
      nb[model.edges[j]].push(model.edges[j + 1]);
      nb[model.edges[j + 1]].push(model.edges[j]);
    }
    s.neighbors = nb;
    const fresh = knownCount < n;
    // All known: no motion at all (instant reopen); a few new: a gentle settle.
    const alpha = !fresh ? 0.001 : knownCount > n * 0.6 ? 0.3 : 1;
    if (!prev.size && !knownCount) s.autoFit = true;
    let first = true;
    const onTick = (m: LayoutOut) => {
      if (m.positions.length !== n * 2) return;
      // A node being dragged keeps the pointer's position.
      const drag = dragRef.current;
      if (drag && drag.index >= 0) {
        m.positions[drag.index * 2] = s.pos[drag.index * 2];
        m.positions[drag.index * 2 + 1] = s.pos[drag.index * 2 + 1];
      }
      s.pos = m.positions;
      if ((first && (s.autoFit || !prev.size)) || (s.autoFit && !m.done)) {
        const v = fitView();
        if (v) s.view = v;
      } else if (s.autoFit && m.done) {
        const v = fitView();
        if (v) moveTo(v, true);
      }
      first = false;
      if (canvas.current) canvas.current.dataset.layout = m.done ? "done" : "running";
      request();
      if (m.done) {
        const out = new Map<string, [number, number]>();
        model.nodes.forEach((x, i) => out.set(x.key, [Math.round(s.pos[i * 2] * 10) / 10, Math.round(s.pos[i * 2 + 1] * 10) / 10]));
        cb.current.onSettled?.(out);
      }
    };
    const w = startLayout(
      onTick,
      () => new Worker(new URL("../../lib/graphLayout.worker.ts", import.meta.url), { type: "module" }),
      (e) => console.warn("graph layout worker failed, computing on the main thread", e),
    );
    s.worker = w;
    const init: LayoutIn = { type: "init", count: n, edges: model.edges, positions, known, params: forceParams(display), animate, alpha };
    w.postMessage(init);
    request();
    return () => {
      w.terminate();
      if (s.worker === w) s.worker = null;
    };
    // The worker restarts for a new graph only; forces and sizes are sent below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model]);

  useEffect(() => {
    st.current.worker?.postMessage({ type: "params", params: forceParams(display) } satisfies LayoutIn);
  }, [display.center, display.repel, display.linkDistance]);

  useEffect(() => {
    st.current.radius = Float32Array.from(model.nodes, (x) => nodeRadius(x, display));
    request();
  }, [display.nodeSize, display.sizeByLinks, display.linkWidth, colors, highlight, current, model, display, request]);

  // ---- size and theme

  useEffect(() => {
    const el = wrap.current;
    const c = canvas.current;
    if (!el || !c) return;
    const resize = () => {
      const r = el.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const s = st.current;
      const was = s.size;
      s.size = { w: r.width, h: r.height, dpr };
      c.width = Math.max(1, Math.round(r.width * dpr));
      c.height = Math.max(1, Math.round(r.height * dpr));
      // Keep the center where it was.
      if (was.w) {
        s.view.x += (r.width - was.w) / 2;
        s.view.y += (r.height - was.h) / 2;
      } else {
        const v = fitView();
        if (v) s.view = v;
      }
      request();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    const mo = new MutationObserver(() => {
      st.current.palette = null;
      request();
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style", "class"] });
    return () => {
      ro.disconnect();
      mo.disconnect();
      cancelAnimationFrame(st.current.raf);
      st.current.raf = 0;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- pointer

  const dragRef = useRef<null | { index: number; sx: number; sy: number; vx: number; vy: number; moved: boolean; id: number }>(null);

  const local = (e: { clientX: number; clientY: number }) => {
    const r = canvas.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const setHover = (i: number) => {
    const s = st.current;
    if (s.hover === i) return;
    s.hover = i;
    if (canvas.current) canvas.current.style.cursor = i >= 0 ? "pointer" : "";
    request();
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.button !== 1) return;
    const { x, y } = local(e);
    const i = hit(x, y);
    const s = st.current;
    dragRef.current = { index: i, sx: x, sy: y, vx: s.view.x, vy: s.view.y, moved: false, id: e.pointerId };
    try {
      canvas.current?.setPointerCapture(e.pointerId);
    } catch {
      // A synthetic pointer (tests) cannot be captured; dragging still works inside the canvas.
    }
    if (e.button === 1) e.preventDefault();
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const { x, y } = local(e);
    const d = dragRef.current;
    const s = st.current;
    if (!d) {
      setHover(hit(x, y));
      return;
    }
    if (!d.moved && Math.hypot(x - d.sx, y - d.sy) < 4) return;
    d.moved = true;
    s.autoFit = false;
    s.tween = null;
    if (d.index >= 0) {
      const w = toWorld(x, y);
      s.pos[d.index * 2] = w.x;
      s.pos[d.index * 2 + 1] = w.y;
      s.worker?.postMessage({ type: "drag", index: d.index, x: w.x, y: w.y } satisfies LayoutIn);
      setHover(d.index);
    } else {
      s.view = { ...s.view, x: d.vx + x - d.sx, y: d.vy + y - d.sy };
    }
    request();
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    if (canvas.current?.hasPointerCapture?.(d.id)) canvas.current.releasePointerCapture(d.id);
    if (d.index >= 0 && d.moved) st.current.worker?.postMessage({ type: "release", index: d.index } satisfies LayoutIn);
    if (!d.moved && d.index >= 0) {
      const node = model.nodes[d.index];
      cb.current.onOpen(node, e.button === 1 || e.ctrlKey || e.metaKey);
    }
  };

  const zoomAt = (sx: number, sy: number, factor: number) => {
    const s = st.current;
    const k = Math.min(12, Math.max(0.04, s.view.k * factor));
    const f = k / s.view.k;
    s.view = { k, x: sx - (sx - s.view.x) * f, y: sy - (sy - s.view.y) * f };
    s.autoFit = false;
    s.tween = null;
    request();
  };

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = c.getBoundingClientRect();
      const sx = e.clientX - r.left, sy = e.clientY - r.top;
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      const dx = e.deltaX * unit, dy = e.deltaY * unit;
      // Pinch (ctrl) and mouse wheels zoom; a trackpad's two-finger scroll pans.
      const trackpad = !e.ctrlKey && e.deltaMode === 0 && (dx !== 0 || (Math.abs(dy) < 40 && !Number.isInteger(dy)));
      const s = st.current;
      if (trackpad) {
        s.view = { ...s.view, x: s.view.x - dx, y: s.view.y - dy };
        s.autoFit = false;
        s.tween = null;
        request();
      } else zoomAt(sx, sy, Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0018)));
    };
    c.addEventListener("wheel", onWheel, { passive: false });
    return () => c.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model]);

  // ---- keyboard

  const describe = (i: number) => {
    const node = model.nodes[i];
    const where = node.page?.folder ? t("graph.a11yFolder", { folder: node.page.folder }) : "";
    return `${node.label}. ${t("graph.a11yLinks", { n: node.degree })}${where ? `. ${where}` : ""}`;
  };

  const select = (i: number, center = false) => {
    const s = st.current;
    s.selected = i;
    cb.current.onSelect?.(i >= 0 ? i : null);
    if (i >= 0) {
      setAnnounce(describe(i));
      if (center) centerOn(i, null);
    }
    request();
  };

  const centerOn = (i: number, k: number | null) => {
    const s = st.current;
    // The node in the middle, zoomed so that its neighbors fit around it.
    let fit = compact ? 1.4 : 2.2;
    const pad = 70;
    for (const j of s.neighbors[i] ?? []) {
      const dx = Math.abs(s.pos[j * 2] - s.pos[i * 2]);
      const dy = Math.abs(s.pos[j * 2 + 1] - s.pos[i * 2 + 1]);
      if (dx > 0) fit = Math.min(fit, (s.size.w / 2 - pad) / dx);
      if (dy > 0) fit = Math.min(fit, (s.size.h / 2 - pad) / dy);
    }
    const kk = k ?? Math.max(0.5, fit);
    s.autoFit = false;
    moveTo({ k: kk, x: s.size.w / 2 - s.pos[i * 2] * kk, y: s.size.h / 2 - s.pos[i * 2 + 1] * kk }, true);
  };

  const ensureVisible = (i: number) => {
    const s = st.current;
    const sx = s.pos[i * 2] * s.view.k + s.view.x;
    const sy = s.pos[i * 2 + 1] * s.view.k + s.view.y;
    if (sx < 40 || sy < 40 || sx > s.size.w - 40 || sy > s.size.h - 40) centerOn(i, s.view.k);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (isComposing(e)) return;
    const s = st.current;
    const n = model.nodes.length;
    if (!n) return;
    const dirs: Record<string, "left" | "right" | "up" | "down"> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };
    const dir = dirs[e.key];
    if (dir && e.shiftKey) {
      const step = 60;
      const d = { left: [step, 0], right: [-step, 0], up: [0, step], down: [0, -step] }[dir];
      s.view = { ...s.view, x: s.view.x + d[0], y: s.view.y + d[1] };
      s.autoFit = false;
      request();
    } else if (dir) {
      let from = s.selected;
      if (from < 0) {
        // Start at the node nearest to the middle of the view.
        const c = toWorld(s.size.w / 2, s.size.h / 2);
        let best = Infinity;
        for (let i = 0; i < n; i++) {
          const d = (s.pos[i * 2] - c.x) ** 2 + (s.pos[i * 2 + 1] - c.y) ** 2;
          if (d < best) {
            best = d;
            from = i;
          }
        }
        select(from);
        ensureVisible(from);
      } else {
        const next = nearestInDirection(s.pos, n, from, dir);
        if (next >= 0) {
          select(next);
          ensureVisible(next);
        }
      }
    } else if (e.key === "Enter" && s.selected >= 0) {
      cb.current.onOpen(model.nodes[s.selected], e.ctrlKey || e.metaKey);
    } else if (e.key === "Escape" && s.selected >= 0) {
      select(-1);
      setAnnounce("");
    } else if (e.key === "Home") {
      let best = 0;
      for (let i = 1; i < n; i++) if (model.nodes[i].degree > model.nodes[best].degree) best = i;
      select(best, true);
    } else if (e.key === "+" || e.key === "=") zoomAt(s.size.w / 2, s.size.h / 2, 1.25);
    else if (e.key === "-" || e.key === "_") zoomAt(s.size.w / 2, s.size.h / 2, 0.8);
    else if (e.key === "0") {
      const v = fitView();
      if (v) moveTo(v, true);
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };

  useImperativeHandle(ref, () => ({
    fit(smooth = true) {
      const v = fitView();
      if (v) moveTo(v, smooth);
      st.current.autoFit = false;
    },
    zoomBy(f) {
      const s = st.current;
      zoomAt(s.size.w / 2, s.size.h / 2, f);
    },
    focusNode(i) {
      if (i < 0 || i >= model.nodes.length) return;
      select(i);
      centerOn(i, null);
    },
    async exportPng(scale = 2) {
      const s = st.current;
      const off = document.createElement("canvas");
      off.width = Math.round(s.size.w * scale);
      off.height = Math.round(s.size.h * scale);
      const ctx = off.getContext("2d")!;
      const hover = s.hover;
      s.hover = -1;
      draw(ctx, s.size.w, s.size.h, scale, true);
      s.hover = hover;
      const blob = await new Promise<Blob | null>((r) => off.toBlob(r, "image/png"));
      if (!blob) throw new Error("PNG");
      return new Uint8Array(await blob.arrayBuffer());
    },
    positions() {
      const s = st.current;
      return new Map(model.nodes.map((x, i) => [x.key, [s.pos[i * 2], s.pos[i * 2 + 1]] as [number, number]]));
    },
  }));

  return (
    <div className={`graph-canvas ${compact ? "compact" : ""}`} ref={wrap}>
      <canvas
        ref={canvas}
        tabIndex={0}
        role="application"
        aria-roledescription={t("graph.roleDesc")}
        aria-label={label}
        aria-describedby={compact ? undefined : "graph-keys-help"}
        data-nodes={model.nodes.length}
        data-edges={model.edges.length / 2}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => (dragRef.current = null)}
        onPointerLeave={() => !dragRef.current && setHover(-1)}
        onKeyDown={onKeyDown}
        onBlur={() => {
          if (st.current.selected >= 0) {
            st.current.selected = -1;
            request();
          }
        }}
        onAuxClick={(e) => e.button === 1 && e.preventDefault()}
      />
      <div className="sr-only" aria-live="polite">
        {announce}
      </div>
    </div>
  );
});
