// The look of meetings (Kalender, start page, Tagesrückblick): how strongly the calendar color
// tints a meeting's fill in a theme, the secondary text color that stays readable on it, and how
// much text fits in a block of the time grid.
//
// The fill itself is CSS: `color-mix(in srgb, var(--ev) var(--ev-tint), var(--bg-canvas))`, with
// the title in `--text` and time and place in `--ev-meta`. themeTokens() emits both tokens per
// theme from eventTokens(); tokens.css carries the values for the two Arcalo themes.

import { contrast, mix, parseHex, toHex, type Rgb } from "./color";

/** The calendar palette (the core's `PALETTE`, settings → Kalender). */
export const CAL_PALETTE = ["#2563eb", "#0d9488", "#9333ea", "#ea580c", "#db2777", "#65a30d", "#0891b2", "#ca8a04"];

/** How much of the calendar color the fill takes at most: a quiet tint in light, deeper in dark. */
export const TINT_TARGET = { light: 14, dark: 26 } as const;
/** Below this the color would no longer read as the calendar's; the meta text gives way instead. */
const TINT_FLOOR = { light: 8, dark: 12 } as const;
/** WCAG AA for normal text. A little headroom: the browser rounds the mixed color. */
const MIN = 4.6;

function hsl(h: number, s: number, l: number): Rgb {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

/**
 * The colors a meeting can have: the palette, the theme's accent (a calendar without its own
 * color) and a wheel of saturated hues in a darker and a lighter shade (ICS colors, custom accents).
 */
export function probeColors(accent?: string): Rgb[] {
  const wheel: Rgb[] = [];
  for (let h = 0; h < 360; h += 20) wheel.push(hsl(h, 0.75, 0.42), hsl(h, 0.85, 0.6));
  return [...CAL_PALETTE.map((x) => parseHex(x)!), ...(accent && parseHex(accent) ? [parseHex(accent)!] : []), ...wheel];
}

/** The fill of a meeting: `pct` percent of the calendar color over the canvas (as CSS color-mix in srgb). */
export const eventFill = (ev: Rgb, canvas: Rgb, pct: number): Rgb => mix(canvas, ev, pct / 100);

/** The weakest contrast of `fg` on the fill of any of `colors`. */
export function worstContrast(fg: Rgb, canvas: Rgb, pct: number, colors: Rgb[]): number {
  return Math.min(...colors.map((c) => contrast(fg, eventFill(c, canvas, pct))));
}

export interface EventTokens {
  /** `--ev-tint`, e.g. "26%". */
  tint: number;
  /** `--ev-meta`: time and place, `--text-2` or moved towards `--text` until readable. */
  meta: string;
}

/** The share of `--text` in the neutral fill of a meeting marked „nicht buchen“ (CSS: 4%). */
export const SKIPPED_SHARE = 4;

/**
 * The tint and the meta text color of a theme: the target tint unless the title (`--text`) would
 * fall below 4.5:1 on some calendar color; then less, down to a floor. The secondary text is
 * `--text-2` when it reads at that tint (and on the neutral fill of „nicht buchen“), else it is
 * moved towards `--text` until it does. Meetings sit on the canvas (Kalender) and on raised
 * surfaces (start page widgets); both count.
 */
export function eventTokens(t: { canvas: string; raised?: string; text: string; text2: string; accent?: string; dark: boolean }): EventTokens {
  const mode = t.dark ? "dark" : "light";
  const canvas = parseHex(t.canvas) ?? [128, 128, 128];
  const bases = [canvas, ...(t.raised && parseHex(t.raised) ? [parseHex(t.raised)!] : [])];
  const text = parseHex(t.text) ?? (t.dark ? [255, 255, 255] : [0, 0, 0]);
  const text2 = parseHex(t.text2) ?? text;
  const colors = probeColors(t.accent);
  const worst = (fg: Rgb, tint: number) => Math.min(...bases.map((b) => worstContrast(fg, b, tint, colors)));
  let tint: number = TINT_TARGET[mode];
  while (tint > TINT_FLOOR[mode] && worst(text, tint) < MIN) tint--;
  // A theme whose text barely passes on its own canvas: the fill can only be very light.
  while (tint > 0 && worst(text, tint) < MIN) tint--;
  const metaOk = (c: Rgb) => worst(c, tint) >= MIN && bases.every((b) => contrast(c, mix(b, text, SKIPPED_SHARE / 100)) >= MIN);
  let meta = text2;
  for (let i = 1; i <= 20 && !metaOk(meta); i++) meta = mix(text2, text, i / 20);
  return { tint, meta: toHex(meta) };
}

// ------------------------------------------------------------------ blocks in the time grid

export interface BlockFit {
  /** Title and start time on one line (short meetings). */
  oneLine: boolean;
  /** Lines the title may take (line clamp). */
  titleLines: number;
  /** The time range on its own line. */
  time: boolean;
  /** The place on its own line. */
  place: boolean;
}

/** Line heights of the block text (12 px title, 11 px meta) and its vertical padding. */
export const BLOCK = { title: 16, meta: 14, pad: 6 } as const;

/**
 * What fits into a meeting block of `heightPx` pixels lasting `minutes`: a meeting of 30 minutes
 * or less shows title and time on one line; longer ones a title clamped to the room left after
 * the time (and the place, when there is room for it and one title line).
 */
export function blockFit(heightPx: number, minutes: number, hasPlace: boolean): BlockFit {
  const room = heightPx - BLOCK.pad;
  if (minutes <= 30 || room < BLOCK.title + BLOCK.meta) return { oneLine: true, titleLines: 1, time: false, place: false };
  const place = hasPlace && room >= BLOCK.title + BLOCK.meta * 2;
  const left = room - BLOCK.meta - (place ? BLOCK.meta : 0);
  return { oneLine: false, titleLines: Math.max(1, Math.floor(left / BLOCK.title)), time: true, place };
}
