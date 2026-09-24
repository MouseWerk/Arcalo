// Color themes (Settings → Darstellung): the built-in themes, custom themes from the settings,
// the full token set derived from a theme's main colors, and applying the active theme and
// accent to the document.
//
// A theme is nine main colors (background, surface, text, muted, border, accent, success,
// warning, danger) plus optional fine-tuning; everything else (hover and selection tints,
// strong borders, raised surfaces, soft status colors, shadows) is derived, with contrast
// guarantees for text. The Annalo themes are tokens.css itself (their CSS stays empty).

import type { AppearancePrefs, CustomTheme, Settings, ThemeColors } from "./types";
import { accentHex, accentTokens, contrast, ensureContrast, mix, parseHex, toHex, type Rgb } from "./color";
import { rememberSplash } from "./splash";

export interface ThemeDef {
  id: string;
  name: string;
  dark: boolean;
  colors: ThemeColors;
  /** Window frame behind the panes (default: a shade of the surface). */
  app?: string;
  /** Cards and grouped settings (default: derived from the background). */
  raised?: string;
  /** Menus, dialogs, popovers. */
  overlay?: string;
  /** Secondary text (default: halfway between text and muted). */
  text2?: string;
  info?: string;
  /** The theme's accent cannot be replaced (high contrast). */
  fixedAccent?: boolean;
  custom?: boolean;
}

const c = (background: string, surface: string, text: string, muted: string, border: string, accent: string, success: string, warning: string, danger: string): ThemeColors => ({
  background,
  surface,
  text,
  muted,
  border,
  accent,
  success,
  warning,
  danger,
});

/** Built-in themes. Colors follow each theme's published palette; muted text is lifted where the original is too faint to read. */
export const BUILTIN_THEMES: ThemeDef[] = [
  { id: "annalo-light", name: "Annalo Hell", dark: false, colors: c("#ffffff", "#f5f5f6", "#18181b", "#6b6b74", "#e6e6e8", "#6366f1", "#157034", "#a14a08", "#dc2626"), app: "#f4f4f5", text2: "#52525b", info: "#0284c7" },
  { id: "annalo-dark", name: "Annalo Dunkel", dark: true, colors: c("#16171a", "#121316", "#ececef", "#8b8e98", "#26272b", "#818cf8", "#4ade80", "#fbbf24", "#f87171"), app: "#0e0f11", raised: "#1c1d21", overlay: "#202126", text2: "#a7a9b1", info: "#38bdf8" },
  { id: "catppuccin-latte", name: "Catppuccin Latte", dark: false, colors: c("#eff1f5", "#e6e9ef", "#4c4f69", "#6c6f85", "#ccd0da", "#8839ef", "#40a02b", "#df8e1d", "#d20f39"), app: "#dce0e8", raised: "#f5f6f9", overlay: "#f8f9fb", text2: "#5c5f77", info: "#1e66f5" },
  { id: "catppuccin-mocha", name: "Catppuccin Mocha", dark: true, colors: c("#1e1e2e", "#181825", "#cdd6f4", "#a6adc8", "#313244", "#cba6f7", "#a6e3a1", "#f9e2af", "#f38ba8"), app: "#11111b", raised: "#24243a", overlay: "#28283d", text2: "#bac2de", info: "#89dceb" },
  { id: "nord", name: "Nord", dark: true, colors: c("#2e3440", "#292e39", "#eceff4", "#a3adc2", "#3b4252", "#88c0d0", "#a3be8c", "#ebcb8b", "#bf616a"), app: "#242933", raised: "#343b48", overlay: "#3b4252", text2: "#d8dee9", info: "#81a1c1" },
  { id: "dracula", name: "Dracula", dark: true, colors: c("#282a36", "#21222c", "#f8f8f2", "#a3abcc", "#3a3c4e", "#bd93f9", "#50fa7b", "#ffb86c", "#ff5555"), app: "#191a21", raised: "#2e303e", overlay: "#343746", text2: "#e2e2dc", info: "#8be9fd" },
  { id: "solarized-light", name: "Solarized Light", dark: false, colors: c("#fdf6e3", "#eee8d5", "#073642", "#586e75", "#e0d9c3", "#268bd2", "#859900", "#b58900", "#dc322f"), app: "#e6dfca", raised: "#fffbf0", overlay: "#fffbf0", text2: "#3f5962", info: "#2aa198" },
  { id: "solarized-dark", name: "Solarized Dark", dark: true, colors: c("#002b36", "#00252f", "#b9c4c4", "#8a9b9c", "#0e3f4b", "#268bd2", "#859900", "#b58900", "#dc322f"), app: "#001f27", raised: "#073642", overlay: "#0a3d4a", text2: "#a2b0b0", info: "#2aa198" },
  { id: "gruvbox-light", name: "Gruvbox Light", dark: false, colors: c("#fbf1c7", "#f2e5bc", "#3c3836", "#7c6f64", "#e0d0a8", "#af3a03", "#79740e", "#b57614", "#9d0006"), app: "#ebdbb2", raised: "#fdf6dc", overlay: "#fdf6dc", text2: "#504945", info: "#076678" },
  { id: "gruvbox-dark", name: "Gruvbox Dark", dark: true, colors: c("#282828", "#1d2021", "#ebdbb2", "#a89984", "#3c3836", "#fe8019", "#b8bb26", "#fabd2f", "#fb4934"), app: "#171919", raised: "#32302f", overlay: "#3c3836", text2: "#d5c4a1", info: "#83a598" },
  { id: "tokyo-night", name: "Tokyo Night", dark: true, colors: c("#1a1b26", "#16161e", "#c0caf5", "#8189b3", "#292e42", "#7aa2f7", "#9ece6a", "#e0af68", "#f7768e"), app: "#121218", raised: "#1f2231", overlay: "#24283b", text2: "#a9b1d6", info: "#7dcfff" },
  { id: "github-light", name: "GitHub Light", dark: false, colors: c("#ffffff", "#f6f8fa", "#1f2328", "#59636e", "#d1d9e0", "#0969da", "#1a7f37", "#9a6700", "#d1242f"), app: "#eff2f5", text2: "#3d444d", info: "#0969da" },
  { id: "github-dark", name: "GitHub Dark", dark: true, colors: c("#0d1117", "#010409", "#f0f6fc", "#9198a1", "#30363d", "#4493f8", "#3fb950", "#d29922", "#f85149"), app: "#010409", raised: "#151b23", overlay: "#1c2128", text2: "#c9d1d9", info: "#4493f8" },
  { id: "one-dark", name: "One Dark", dark: true, colors: c("#282c34", "#21252b", "#d7dae0", "#8b919c", "#3a3f4b", "#61afef", "#98c379", "#e5c07b", "#e06c75"), app: "#1b1e23", raised: "#2c313a", overlay: "#333842", text2: "#abb2bf", info: "#56b6c2" },
  { id: "rose-pine-dawn", name: "Rosé Pine Dawn", dark: false, colors: c("#faf4ed", "#f2e9e1", "#575279", "#6e6a8a", "#dfdad9", "#907aa9", "#286983", "#ea9d34", "#b4637a"), app: "#ebe3da", raised: "#fffaf3", overlay: "#fffaf3", text2: "#625d84", info: "#56949f" },
  { id: "rose-pine", name: "Rosé Pine", dark: true, colors: c("#191724", "#1f1d2e", "#e0def4", "#908caa", "#2a273f", "#c4a7e7", "#9ccfd8", "#f6c177", "#eb6f92"), app: "#131120", raised: "#211f32", overlay: "#26233a", text2: "#c9c6e0", info: "#9ccfd8" },
  { id: "everforest-light", name: "Everforest Light", dark: false, colors: c("#fdf6e3", "#f4f0d9", "#4f5b62", "#6f7c6c", "#e3dec5", "#8da101", "#35a77c", "#dfa000", "#f85552"), app: "#efebd4", raised: "#fffbef", overlay: "#fffbef", text2: "#5c6a72", info: "#3a94c5" },
  { id: "everforest-dark", name: "Everforest Dark", dark: true, colors: c("#2d353b", "#232a2e", "#d3c6aa", "#9da9a0", "#3d484d", "#a7c080", "#83c092", "#dbbc7f", "#e67e80"), app: "#1e2326", raised: "#343f44", overlay: "#3d484d", text2: "#c5b99e", info: "#7fbbb3" },
  { id: "contrast-light", name: "Hoher Kontrast Hell", dark: false, colors: c("#ffffff", "#f2f2f2", "#000000", "#383838", "#6e6e6e", "#0037da", "#005a18", "#6b4100", "#b00020"), app: "#e6e6e6", text2: "#1a1a1a", info: "#004f8a", fixedAccent: true },
  { id: "contrast-dark", name: "Hoher Kontrast Dunkel", dark: true, colors: c("#000000", "#0b0b0b", "#ffffff", "#d6d6d6", "#8c8c8c", "#1aebff", "#3ff23f", "#ffd500", "#ff6b6b"), app: "#000000", raised: "#111111", overlay: "#141414", text2: "#f0f0f0", info: "#6cc4ff", fixedAccent: true },
];

export const DEFAULT_LIGHT = "annalo-light";
export const DEFAULT_DARK = "annalo-dark";
const ANNALO = new Set([DEFAULT_LIGHT, DEFAULT_DARK]);

/** Colors of a new custom theme: the current Annalo theme. */
export function starterColors(dark: boolean): ThemeColors {
  return { ...BUILTIN_THEMES.find((t) => t.id === (dark ? DEFAULT_DARK : DEFAULT_LIGHT))!.colors };
}

export const customDef = (t: CustomTheme): ThemeDef => ({ id: t.id, name: t.name, dark: t.dark, colors: t.colors, custom: true });

/** Every theme the picker offers: built-ins, then the custom ones. */
export function allThemes(a: Pick<AppearancePrefs, "custom_themes"> | undefined): ThemeDef[] {
  return [...BUILTIN_THEMES, ...(a?.custom_themes ?? []).map(customDef)];
}

/** The theme with this id, else the Annalo theme of that kind. */
export function findTheme(id: string, a: Pick<AppearancePrefs, "custom_themes"> | undefined, dark: boolean): ThemeDef {
  return allThemes(a).find((t) => t.id === id) ?? BUILTIN_THEMES.find((t) => t.id === (dark ? DEFAULT_DARK : DEFAULT_LIGHT))!;
}

/** Whether a background color is dark (for imported or edited themes). */
export const isDarkColor = (hex: string) => {
  const rgb = parseHex(hex);
  if (!rgb) return false;
  return contrast(rgb, [0, 0, 0]) < contrast(rgb, [255, 255, 255]);
};

const rgb = (hex: string): Rgb => parseHex(hex) ?? [128, 128, 128];
const rgba = (col: Rgb, a: number) => `rgb(${col.map(Math.round).join(" ")} / ${a})`;
const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];

/** Moves `color` until it reaches `min` against every background in `bgs`. */
function readable(color: Rgb, bgs: Rgb[], min: number, lighten: boolean): Rgb {
  let out = color;
  for (const bg of bgs) out = ensureContrast(out, bg, min, lighten);
  return out;
}

/** The full token set of tokens.css for one theme. */
export function themeTokens(def: ThemeDef): Record<string, string> {
  const k = def.colors;
  const dark = def.dark;
  const bg = rgb(k.background);
  const surface = rgb(k.surface);
  const text0 = rgb(k.text);
  const raised = def.raised ? rgb(def.raised) : dark ? mix(bg, text0, 0.035) : mix(bg, WHITE, 0.6);
  const overlay = def.overlay ? rgb(def.overlay) : dark ? mix(bg, text0, 0.06) : mix(bg, WHITE, 0.8);
  const app = def.app ? rgb(def.app) : dark ? mix(surface, BLACK, 0.25) : mix(surface, BLACK, 0.025);
  const input = dark ? mix(bg, text0, 0.015) : mix(bg, WHITE, 0.7);
  const bgs = [bg, surface, raised];
  // Text stays readable even for a custom theme with too little contrast.
  const text = readable(text0, bgs, 4.5, dark);
  const muted = readable(rgb(k.muted), bgs, 3, dark);
  const text2 = readable(def.text2 ? rgb(def.text2) : mix(text, muted, 0.5), bgs, 4.5, dark);
  const border = rgb(k.border);
  const status = (hex: string) => readable(rgb(hex), [bg, raised], 4.5, dark);
  const success = status(k.success);
  const warning = status(k.warning);
  const danger = status(k.danger);
  const info = status(def.info ?? k.accent);
  const soft = dark ? 0.14 : 0.1;
  // Code blocks: a quiet background of their own, syntax colors moved until readable on it.
  const codeBg = dark ? (contrast(app, bg) >= 1.04 ? app : mix(bg, text0, 0.07)) : mix(bg, text0, 0.035);
  // 4.6: a little headroom, the hex rounding may cost a few hundredths.
  const code = (light: string, darkHex: string) => toHex(readable(rgb(dark ? darkHex : light), [codeBg], 4.6, dark));
  const violet = readable(rgb(dark ? "#a78bfa" : "#7c3aed"), [bg, raised], 4.5, dark);
  const accent = accentTokens(k.accent, dark ? "dark" : "light", k.background);
  return {
    "color-scheme": dark ? "dark" : "light",
    "--bg-app": toHex(app),
    "--bg-sidebar": toHex(surface),
    "--bg-canvas": toHex(bg),
    "--bg-raised": toHex(raised),
    "--bg-overlay": toHex(overlay),
    "--bg-input": toHex(input),
    "--bg-hover": rgba(text, dark ? 0.05 : 0.045),
    "--bg-active": rgba(text, dark ? 0.085 : 0.075),
    "--bg-current": rgba(text, dark ? 0.12 : 0.1),
    "--border": toHex(border),
    "--border-strong": toHex(mix(border, text, dark ? 0.14 : 0.16)),
    "--text": toHex(text),
    "--text-2": toHex(text2),
    "--text-3": toHex(muted),
    "--star": k.warning,
    "--warning-fill": k.warning,
    "--text-inverse": dark ? toHex(bg) : "#ffffff",
    ...accent,
    "--success": toHex(success),
    "--success-soft": rgba(rgb(k.success), soft),
    "--warning": toHex(warning),
    "--warning-soft": rgba(rgb(k.warning), soft),
    "--danger": toHex(danger),
    "--danger-soft": rgba(rgb(k.danger), soft),
    "--info": toHex(info),
    "--info-soft": rgba(info, soft),
    "--violet": toHex(violet),
    "--code-bg": toHex(codeBg),
    "--code-keyword": code("#9333ea", "#c084fc"),
    "--code-string": code("#15803d", "#4ade80"),
    "--code-number": code("#c2410c", "#fb923c"),
    "--code-title": code("#1d4ed8", "#60a5fa"),
    "--code-type": code("#a16207", "#facc15"),
    "--code-meta": code("#0e7490", "#22d3ee"),
    "--mark": dark ? "rgb(250 204 21 / 0.24)" : "rgb(250 204 21 / 0.38)",
    "--shadow-sm": dark ? "0 1px 2px rgb(0 0 0 / 0.4)" : "0 1px 2px rgb(0 0 0 / 0.06)",
    "--shadow-md": dark ? `0 8px 24px rgb(0 0 0 / 0.45), 0 0 0 1px ${rgba(text, 0.07)}` : "0 8px 24px rgb(0 0 0 / 0.1), 0 0 0 1px rgb(0 0 0 / 0.06)",
    "--shadow-lg": dark ? `0 24px 64px rgb(0 0 0 / 0.55), 0 0 0 1px ${rgba(text, 0.08)}` : "0 24px 64px rgb(0 0 0 / 0.16), 0 0 0 1px rgb(0 0 0 / 0.07)",
  };
}

/** The theme's tokens with the chosen accent on top (theme editor preview). */
export function withAccent(def: ThemeDef, accent: string): Record<string, string> {
  const tokens = themeTokens(def);
  const hex = accentHex(accent);
  if (def.fixedAccent || accent === "theme" || !hex) return tokens;
  return { ...tokens, ...accentTokens(hex, def.dark ? "dark" : "light", def.colors.background) };
}

const block = (tokens: Record<string, string>) =>
  Object.entries(tokens)
    .map(([key, v]) => `${key}: ${v};`)
    .join(" ");

/** The accent the theme shows with these preferences (`#rrggbb`). */
export function effectiveAccent(def: ThemeDef, accent: string): string {
  if (def.fixedAccent || accent === "theme") return def.colors.accent;
  return accentHex(accent) ?? def.colors.accent;
}

/**
 * CSS for the active theme and accent. The Annalo themes with their own (or the indigo) accent
 * need none: tokens.css is tuned for them. `:root:root` wins over tokens.css; the accent comes
 * after the theme, so it wins over the theme's accent.
 */
export function themeCss(def: ThemeDef, accent: string): string {
  const annalo = ANNALO.has(def.id) && !def.custom;
  const parts: string[] = [];
  if (!annalo) parts.push(`:root:root { ${block(themeTokens(def))} }`);
  const own = def.fixedAccent || accent === "theme" || (annalo && accent === "indigo");
  const hex = accentHex(accent);
  if (!own && hex) parts.push(`:root:root { ${block({ ...accentTokens(hex, def.dark ? "dark" : "light", def.colors.background) })} }`);
  return parts.join("\n");
}

// ------------------------------------------------------------------ applying

const STYLE_ID = "annalo-theme";
let mode: Settings["theme"] = "system";
let prefs: AppearancePrefs | null = null;
let lastKey = "";

/** Which theme is shown now: the light or dark slot, by mode and (for „System“) the OS. */
export function activeTheme(m: Settings["theme"], a: AppearancePrefs | null): ThemeDef {
  const dark = m === "dark" || (m !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  return findTheme((dark ? a?.theme_dark : a?.theme_light) ?? "", a ?? undefined, dark);
}

/** Applies the theme for the current mode and appearance; called on every change of either. */
export function applyThemeState(next: { mode?: Settings["theme"]; appearance?: AppearancePrefs | null }) {
  if (next.mode) mode = next.mode;
  if (next.appearance !== undefined) prefs = next.appearance;
  const def = activeTheme(mode, prefs);
  const accent = prefs?.accent ?? "theme";
  const root = document.documentElement;
  root.dataset.theme = def.dark ? "dark" : "light";
  root.dataset.themeId = def.id;
  const css = themeCss(def, accent);
  let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = STYLE_ID;
    document.head.appendChild(style);
  }
  if (style.textContent !== css) style.textContent = css;
  const key = `${def.id}|${def.dark}|${css.length}|${accent}`;
  if (key === lastKey) return;
  lastKey = key;
  // The startup animation of the next start uses the same colors.
  const k = def.colors;
  rememberSplash({ dark: def.dark, accent: effectiveAccent(def, accent), bg: def.app ?? k.background, text: k.text, muted: k.muted });
  import("@tauri-apps/api/core")
    .then(({ invoke }) => invoke("window_set_theme", { dark: def.dark }))
    .catch(() => {});
}

// ------------------------------------------------------------------- editing

export const COLOR_KEYS: (keyof ThemeColors)[] = ["background", "surface", "text", "muted", "border", "accent", "success", "warning", "danger"];

export interface ContrastCheck {
  key: "text" | "muted" | "accent";
  ratio: number;
  min: number;
  ok: boolean;
}

/** Contrast of a theme's text colors against its background (shown in the theme editor). */
export function contrastChecks(k: ThemeColors): ContrastCheck[] {
  const worst = (fg: string) => Math.min(contrast(rgb(fg), rgb(k.background)), contrast(rgb(fg), rgb(k.surface)));
  return [
    { key: "text", min: 4.5 },
    { key: "muted", min: 3 },
    { key: "accent", min: 3 },
  ].map(({ key, min }) => {
    const ratio = worst(k[key as "text"]);
    return { key: key as ContrastCheck["key"], ratio, min, ok: ratio >= min };
  });
}

/** A theme as a custom theme to edit (a copy with a new name). */
export function toCustom(def: ThemeDef, name: string): CustomTheme {
  return { id: "", name, dark: def.dark, colors: { ...def.colors } };
}
