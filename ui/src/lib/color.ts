// Accent colors: presets, WCAG contrast and the accent tokens for light and dark mode (applied
// on top of the color theme by lib/themes.ts).

export type Rgb = [number, number, number];

/** Accent presets (Settings → Darstellung). `indigo` is the built-in look of tokens.css. */
export const ACCENT_PRESETS: { id: string; hex: string }[] = [
  { id: "indigo", hex: "#6366f1" },
  { id: "blue", hex: "#2563eb" },
  { id: "teal", hex: "#0d9488" },
  { id: "green", hex: "#16a34a" },
  { id: "amber", hex: "#d97706" },
  { id: "orange", hex: "#ea580c" },
  { id: "rose", hex: "#e11d48" },
  { id: "violet", hex: "#7c3aed" },
  { id: "graphite", hex: "#52525b" },
];

/** Canvas backgrounds of tokens.css the accent text must stand out from. */
export const CANVAS = { light: "#ffffff", dark: "#16171a" } as const;

export function parseHex(hex: string): Rgb | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb;
}

export const toHex = (c: Rgb) => "#" + c.map((x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, "0")).join("");

/** `#rrggbb` of a preset id or a hex color; null when neither. */
export function accentHex(accent: string): string | null {
  const preset = ACCENT_PRESETS.find((p) => p.id === accent.trim().toLowerCase());
  if (preset) return preset.hex;
  const rgb = parseHex(accent);
  return rgb ? toHex(rgb) : null;
}

/** WCAG relative luminance. */
export function luminance([r, g, b]: Rgb): number {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio (1–21). */
export function contrast(a: Rgb | string, b: Rgb | string): number {
  const x = typeof a === "string" ? parseHex(a)! : a;
  const y = typeof b === "string" ? parseHex(b)! : b;
  const [l1, l2] = [luminance(x), luminance(y)].sort((p, q) => q - p);
  return (l1 + 0.05) / (l2 + 0.05);
}

export const mix = (a: Rgb, b: Rgb, t: number): Rgb => [0, 1, 2].map((i) => a[i] + (b[i] - a[i]) * t) as Rgb;

/**
 * Moves `color` towards white (`lighten`) or black until its contrast against `bg` reaches
 * `min`, in small steps so the hue stays recognizable.
 */
export function ensureContrast(color: Rgb, bg: Rgb, min: number, lighten: boolean): Rgb {
  const target: Rgb = lighten ? [255, 255, 255] : [0, 0, 0];
  let c = color;
  for (let t = 0; t <= 1 && contrast(c, bg) < min; t += 0.02) c = mix(color, target, t);
  return c;
}

export interface AccentTokens {
  "--accent": string;
  "--accent-strong": string;
  "--accent-soft": string;
  "--accent-text": string;
  "--border-focus": string;
  "--bg-selected": string;
}

const rgba = (c: Rgb, a: number) => `rgb(${c.map(Math.round).join(" ")} / ${a})`;

/**
 * Accent tokens for one mode. Guarantees: `--accent-text` has ≥ 4.5:1 against the canvas,
 * `--accent` (icons, borders, focus) ≥ 3:1, and white text on `--accent-strong` (primary
 * buttons, switches) ≥ 4.5:1.
 */
export function accentTokens(hex: string, mode: "light" | "dark", canvasHex: string = CANVAS[mode]): AccentTokens {
  const base = parseHex(hex) ?? parseHex("#6366f1")!;
  const white: Rgb = [255, 255, 255];
  const canvas = parseHex(canvasHex) ?? parseHex(CANVAS[mode])!;
  const light = mode === "light";
  const accent = ensureContrast(light ? base : mix(base, white, 0.18), canvas, 3, !light);
  const text = ensureContrast(light ? mix(base, [0, 0, 0], 0.08) : mix(base, white, 0.35), canvas, 4.5, !light);
  const strong = ensureContrast(light ? mix(base, [0, 0, 0], 0.08) : base, white, 4.5, false);
  return {
    "--accent": toHex(accent),
    "--accent-strong": toHex(strong),
    "--accent-soft": rgba(accent, light ? 0.1 : 0.14),
    "--accent-text": toHex(text),
    "--border-focus": toHex(accent),
    "--bg-selected": rgba(accent, light ? 0.1 : 0.14),
  };
}
