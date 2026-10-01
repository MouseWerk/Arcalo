// Geometry of the start page's small SVG charts (components/dashboard/charts.tsx): nice axis
// steps, bars, lines, donut arcs, sparklines and the year heatmap. Pure functions, so the
// renderer only maps them to elements and the tests check the numbers.

/** One value of a chart. */
export interface Datum {
  /** Stable key (also the color slot's identity). */
  key: string;
  label: string;
  value: number;
  /** A CSS color for the mark (a select option's color); none: the series palette. */
  color?: string;
}

/** Axis steps from 0 to at least `max`: 1, 2, 2.5 or 5 times a power of ten, about `count` of them. */
export function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0) || !Number.isFinite(max)) return [0, 1];
  const raw = max / Math.max(1, count);
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? 10 * pow;
  const ticks: number[] = [];
  for (let v = 0; v < max + step * 1e-9; v += step) ticks.push(Number(v.toPrecision(12)));
  if (ticks[ticks.length - 1] < max) ticks.push(Number((ticks[ticks.length - 1] + step).toPrecision(12)));
  return ticks;
}

export interface Bar {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Center of the bar (labels). */
  cx: number;
}

/**
 * Vertical bars for `values` in a plot of `width` × `height` with the scale's top at `top`:
 * equal slots, bars of at most 28 px with a 2 px gap at least, anchored at the baseline.
 */
export function bars(values: number[], width: number, height: number, top: number): Bar[] {
  const n = values.length;
  if (!n) return [];
  const slot = width / n;
  const w = Math.max(2, Math.min(28, slot * 0.68, slot - 2));
  return values.map((v, i) => {
    const h = top > 0 ? (Math.max(0, v) / top) * height : 0;
    const cx = slot * i + slot / 2;
    return { x: cx - w / 2, y: height - h, w, h, cx };
  });
}

/** Path of a bar with 4 px rounded top corners (data end) and a square base. */
export function barPath(b: Bar, radius = 4): string {
  if (b.h <= 0) return "";
  const r = Math.min(radius, b.w / 2, b.h);
  const { x, y, w, h } = b;
  return `M${x} ${y + h}V${y + r}Q${x} ${y} ${x + r} ${y}H${x + w - r}Q${x + w} ${y} ${x + w} ${y + r}V${y + h}Z`;
}

/** Points of a line through `values` over `width` × `height` (0 at the bottom, `top` at the top). */
export function linePoints(values: number[], width: number, height: number, top: number, min = 0): [number, number][] {
  const n = values.length;
  const span = top - min || 1;
  return values.map((v, i) => [n === 1 ? width / 2 : (i / (n - 1)) * width, height - ((v - min) / span) * height]);
}

/** SVG path through points (straight segments, rounded to 0.1 px). */
export const pathOf = (pts: [number, number][]) => pts.map(([x, y], i) => `${i ? "L" : "M"}${round(x)} ${round(y)}`).join("");

const round = (x: number) => Math.round(x * 10) / 10;

export interface Arc {
  key: string;
  /** Share of the whole, 0..1. */
  share: number;
  path: string;
  /** Middle of the arc (label anchor), relative to the center. */
  mid: [number, number];
}

/**
 * Donut slices for `values` (negative ones count as 0) around the center (0, 0), starting at
 * twelve o'clock, clockwise, with `gap` radians between slices. A single slice is a full ring.
 */
export function arcs(data: Pick<Datum, "key" | "value">[], outer: number, inner: number, gap = 0.02): Arc[] {
  const total = data.reduce((a, d) => a + Math.max(0, d.value), 0);
  if (total <= 0) return [];
  const shown = data.filter((d) => d.value > 0);
  const out: Arc[] = [];
  let a0 = -Math.PI / 2;
  for (const d of data) {
    const share = Math.max(0, d.value) / total;
    if (share <= 0) {
      out.push({ key: d.key, share: 0, path: "", mid: [0, 0] });
      continue;
    }
    const sweep = share * Math.PI * 2;
    const a1 = a0 + sweep;
    const g = shown.length > 1 ? Math.min(gap, sweep / 3) : 0;
    const path = shown.length === 1 ? ring(outer, inner) : sector(a0 + g / 2, a1 - g / 2, outer, inner);
    const m = (a0 + a1) / 2;
    const r = (outer + inner) / 2;
    out.push({ key: d.key, share, path, mid: [round(Math.cos(m) * r), round(Math.sin(m) * r)] });
    a0 = a1;
  }
  return out;
}

const pt = (a: number, r: number) => `${round(Math.cos(a) * r)} ${round(Math.sin(a) * r)}`;

function sector(a0: number, a1: number, outer: number, inner: number): string {
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M${pt(a0, outer)}A${outer} ${outer} 0 ${large} 1 ${pt(a1, outer)}L${pt(a1, inner)}A${inner} ${inner} 0 ${large} 0 ${pt(a0, inner)}Z`;
}

function ring(outer: number, inner: number): string {
  return `M0 ${-outer}A${outer} ${outer} 0 1 1 0 ${outer}A${outer} ${outer} 0 1 1 0 ${-outer}ZM0 ${-inner}A${inner} ${inner} 0 1 0 0 ${inner}A${inner} ${inner} 0 1 0 0 ${-inner}Z`;
}

/** A sparkline of `values`: its path and the y of zero (for a balance that crosses it). */
export function sparkline(values: number[], width: number, height: number, pad = 2): { path: string; zero: number | null; last: [number, number] | null } {
  if (!values.length) return { path: "", zero: null, last: null };
  const lo = Math.min(0, ...values);
  const hi = Math.max(0, ...values);
  const span = hi - lo || 1;
  const h = height - pad * 2;
  const pts: [number, number][] = values.map((v, i) => [values.length === 1 ? width : (i / (values.length - 1)) * width, pad + h - ((v - lo) / span) * h]);
  return { path: pathOf(pts), zero: lo < 0 && hi > 0 ? round(pad + h - ((0 - lo) / span) * h) : null, last: pts[pts.length - 1] };
}

// ------------------------------------------------------------------ heatmap

export interface HeatCell {
  date: string;
  value: number;
  /** 0 nothing, 1..4 quartiles of the largest value. */
  level: 0 | 1 | 2 | 3 | 4;
  /** Column (week) and row (weekday, Monday = 0). */
  col: number;
  row: number;
  future: boolean;
}

/** Level 1–4 of `value` against `max` (GitHub's quartiles); 0 for nothing. */
export function levelOf(value: number, max: number): HeatCell["level"] {
  if (value <= 0 || max <= 0) return 0;
  const q = value / max;
  return q > 0.75 ? 4 : q > 0.5 ? 3 : q > 0.25 ? 2 : 1;
}

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** The Monday of the week `weeks` - 1 weeks before the week of `today` (the heatmap's first day). */
export function heatStart(today: Date, weeks = 53): Date {
  const d = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) - (weeks - 1) * 7);
  return d;
}

/**
 * The cells of a heatmap from the Monday `start` to `today`'s week: one column per week, one
 * row per weekday; days after today are `future`. `values` by `YYYY-MM-DD`. Also where each
 * month's label starts (the first column that holds its first day).
 */
export function heatGrid(start: Date, today: Date, values: Map<string, number>): { cells: HeatCell[]; cols: number; months: { col: number; month: number; year: number }[]; max: number } {
  const t = iso(today);
  const max = Math.max(0, ...values.values());
  const cells: HeatCell[] = [];
  const months: { col: number; month: number; year: number }[] = [];
  const d = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  let i = 0;
  for (;;) {
    const key = iso(d);
    const col = Math.floor(i / 7);
    const row = i % 7;
    if (row === 0 && key > t) break;
    const value = values.get(key) ?? 0;
    cells.push({ date: key, value, level: levelOf(value, max), col, row, future: key > t });
    // A month's label sits over the first week that is all in it (the start's month at once).
    if (i === 0) months.push({ col: 0, month: d.getMonth(), year: d.getFullYear() });
    else if (d.getDate() === 1) months.push({ col: row === 0 ? col : col + 1, month: d.getMonth(), year: d.getFullYear() });
    d.setDate(d.getDate() + 1);
    i++;
    if (i > 7 * 60) break;
  }
  // A month label squeezed in front of the next one is dropped.
  const spaced = months.filter((m, k) => k === months.length - 1 || months[k + 1].col - m.col >= 3);
  return { cells, cols: Math.ceil(cells.length / 7), months: spaced, max };
}
