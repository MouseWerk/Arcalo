// The window backdrop (Settings → Darstellung „Hintergrundeffekt“ and „Deckkraft“): Mica or
// Acrylic on Windows 11. With an effect on, the page paints one tinted base layer on the body
// (the chrome: ribbon, sidebar, side panel, splitters) and a second one on the content column;
// every panel is transparent above them, so nothing between the panels can leave a hole.
// The opacity is the CSS variable --glass (styles in app.css, "window backdrop").

import { mix, parseHex, toHex, type Rgb } from "./color";

export type WindowEffect = "none" | "mica" | "acrylic";

export interface Backdrop {
  /** Effects this system offers; empty: always opaque (Windows 10, macOS, Linux). */
  effects: WindowEffect[];
  /** The effect the window shows now. */
  active: WindowEffect;
}

/** Opacity range in percent: 100 covers the effect completely; below 40 text loses contrast. */
export const OPACITY_MIN = 40;
export const OPACITY_DEFAULT = 80;

/** The opacity as the CSS factor --glass (0.4–1). */
export function glassAlpha(percent: number | null | undefined): number {
  const p = Number.isFinite(percent) ? (percent as number) : OPACITY_DEFAULT;
  return Math.round(Math.min(100, Math.max(OPACITY_MIN, p))) / 100;
}

/**
 * How much of the effect the theme covers. The chrome is the base layer at the opacity; the
 * content column adds a second layer with the same alpha, so it is always clearly more opaque
 * than the sidebar (80 %: 96 %, 40 %: 64 %) and both reach 100 % together.
 */
export function glassCoverage(alpha: number): { chrome: number; content: number } {
  const a = Math.min(1, Math.max(0, alpha));
  return { chrome: a, content: 1 - (1 - a) * (1 - a) };
}

/**
 * The color a pixel shows: the layers' colors over the effect (`#rrggbb`), as the CSS does it
 * (the chrome color at `alpha` over the effect; content: the canvas at `alpha` over that).
 */
export function glassComposite(effect: string, sidebar: string, alpha: number, canvas?: string): string {
  const c = (hex: string): Rgb => parseHex(hex) ?? [0, 0, 0];
  const base = mix(c(effect), c(sidebar), alpha);
  return toHex(canvas ? mix(base, c(canvas), alpha) : base);
}

/** The effect's own color when nothing of the desktop shows (Windows 11 Mica tint). */
export const EFFECT_TINT = { light: "#f3f3f3", dark: "#202020" } as const;

// ------------------------------------------------------------------ applying

const KEY = "arcalo.backdrop";
let enabled = false;
/** The chosen effect; null until the settings are known. */
let effect: WindowEffect | null = null;
let dark: boolean | null = null;
let lastKey = "";
let state: Backdrop = { effects: [], active: "none" };
const listeners = new Set<(b: Backdrop) => void>();

const root = () => document.documentElement;

function show(active: WindowEffect) {
  if (active === "none") delete root().dataset.backdrop;
  else root().dataset.backdrop = active;
}

/** The opacity, live (also while the slider is dragged; nothing is saved). */
export function previewOpacity(percent: number) {
  root().style.setProperty("--glass", String(glassAlpha(percent)));
}

function remember() {
  try {
    localStorage.setItem(KEY, JSON.stringify({ active: state.active, glass: root().style.getPropertyValue("--glass") }));
  } catch {
    // Private mode or full storage: the next start begins opaque.
  }
}

function publish(next: Backdrop) {
  state = next;
  show(next.active);
  remember();
  listeners.forEach((l) => l(next));
}

/**
 * Main window only (not quick capture, search or presenter): the backdrop of the last start
 * right away, so the first frame already looks like the app will; the shell confirms it.
 */
export function initBackdrop() {
  enabled = true;
  try {
    const last = JSON.parse(localStorage.getItem(KEY) ?? "{}") as { active?: WindowEffect; glass?: string };
    if (last.glass) root().style.setProperty("--glass", last.glass);
    if (last.active && last.active !== "none") show(last.active);
  } catch {
    // Nothing remembered.
  }
  import("@tauri-apps/api/core")
    .then(({ invoke }) => invoke<Backdrop>("window_backdrop"))
    .then((b) => {
      // The settings may have applied an effect meanwhile.
      if (!lastKey) publish(b);
    })
    .catch(() => show("none"));
}

function sync() {
  if (!enabled || dark === null || effect === null) return;
  const key = `${effect}|${dark}`;
  if (key === lastKey) return;
  lastKey = key;
  import("@tauri-apps/api/core")
    .then(({ invoke }) => invoke<Backdrop>("window_set_backdrop", { effect, dark }))
    .then((b) => key === lastKey && publish(b))
    .catch(() => {});
}

/** The chosen effect and opacity (Settings → Darstellung). Safe to call repeatedly. */
export function setBackdropPrefs(next: WindowEffect | undefined, opacity: number | undefined) {
  previewOpacity(opacity ?? OPACITY_DEFAULT);
  effect = next ?? "none";
  if (enabled) remember();
  sync();
}

/** The theme turned light or dark: the Mica variant follows. */
export function setBackdropDark(isDark: boolean) {
  dark = isDark;
  sync();
}

export function backdropState(): Backdrop {
  return state;
}

/** Follows the backdrop (the settings show only what this system offers). */
export function onBackdrop(fn: (b: Backdrop) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
