// Applies the preferences that shape the UI (Settings → Darstellung, Sprache & Format,
// Zeiterfassung, Tastatur) to the document and the formatting helpers.

import type { Settings } from "./types";
import { setBackdropPrefs } from "./backdrop";
import { setFormatPrefs } from "./format";
import { langOf, refreshI18n, setLang } from "./i18n";
import { effectiveKeymap, setCurrentKeymap } from "./keymap";
import { rememberSplash } from "./splash";
import { applyThemeState, STYLE_ID as THEME_STYLE } from "./themes";

/** Applies appearance, language, formats and keymap. Safe to call repeatedly. */
export function applyPrefs(s: Settings) {
  const root = document.documentElement;
  const a = s.appearance;
  if (a) {
    root.dataset.density = a.density;
    root.dataset.lineWidth = a.line_width;
    root.dataset.editorFont = a.editor_font;
    root.dataset.uiFont = a.ui_font;
    root.dataset.codeFont = a.code_font;
    root.dataset.reduceMotion = a.reduce_motion ? "on" : "off";
    // Color theme and accent (they also remember the splash colors).
    applyThemeState({ mode: s.theme, appearance: a });
    setZoom(a.ui_scale);
    // The startup animation of the next start uses these (written only when they change:
    // this runs often, and the page must not do any extra work while typing).
    rememberSplash({ off: a.startup_animation === false, reduced: a.reduce_motion });
  }
  applyLocale(s);
  // „Zeiterfassung verwenden“ off: time-entry chips in notes look like plain chips (CSS).
  root.toggleAttribute("data-time-off", s.time?.enabled === false);
  const keymap = effectiveKeymap(s.keymap);
  const key = JSON.stringify(keymap);
  if (key !== lastKeymap) {
    lastKeymap = key;
    setCurrentKeymap(keymap);
  }
  // Labels, shortcut hints and formats may have changed.
  refreshI18n();
  // Window backdrop (Windows 11): the effect, and the opacity live.
  setBackdropPrefs(a?.window_effect, a?.window_opacity);
  rememberBootAppearance(s.theme);
}

// ------------------------------------------------------------------ the next start

const BOOT_KEY = "arcalo.boot-appearance";
const BOOT_DATA = ["density", "lineWidth", "editorFont", "uiFont", "codeFont", "reduceMotion", "theme", "themeId"] as const;
let lastBoot = "";

interface BootAppearance {
  data: Partial<Record<(typeof BOOT_DATA)[number], string>>;
  timeOff: boolean;
  css: string;
  /** The theme mode and whether it showed dark (a „System“ theme is reused only while the system agrees). */
  mode: string;
  dark: boolean;
}

/** What the document shows now, for the next start (written only when it changed). */
function rememberBootAppearance(mode: string) {
  const root = document.documentElement;
  const data: BootAppearance["data"] = {};
  for (const k of BOOT_DATA) if (root.dataset[k] != null) data[k] = root.dataset[k];
  const boot: BootAppearance = { data, timeOff: root.hasAttribute("data-time-off"), css: document.getElementById(THEME_STYLE)?.textContent ?? "", mode, dark: root.dataset.theme === "dark" };
  const text = JSON.stringify(boot);
  if (text === lastBoot) return;
  lastBoot = text;
  try {
    localStorage.setItem(BOOT_KEY, text);
  } catch {
    // Private mode or full storage: the next start applies the settings when they arrive.
  }
}

/**
 * Main window, before the first render: the appearance of the last start (density, fonts, theme
 * and its colors). When the settings arrive they match, so the document is not restyled as a
 * whole while the first views render (a full restyle of the app costs a frame of 100 ms and more).
 */
export function applyBootAppearance() {
  try {
    const text = localStorage.getItem(BOOT_KEY);
    const boot = text ? (JSON.parse(text) as BootAppearance) : null;
    if (!boot || typeof boot !== "object" || !boot.data) return;
    const root = document.documentElement;
    const themeOk = boot.mode !== "system" || window.matchMedia("(prefers-color-scheme: dark)").matches === boot.dark;
    for (const k of BOOT_DATA) {
      const v = boot.data[k];
      if (typeof v !== "string" || (!themeOk && (k === "theme" || k === "themeId"))) continue;
      root.dataset[k] = v;
    }
    root.toggleAttribute("data-time-off", boot.timeOff === true);
    if (themeOk && typeof boot.css === "string" && !document.getElementById(THEME_STYLE)) {
      const style = document.createElement("style");
      style.id = THEME_STYLE;
      style.textContent = boot.css;
      document.head.appendChild(style);
    }
    lastBoot = text ?? "";
  } catch {
    // Nothing remembered: the settings apply when they arrive.
  }
}
/** Display language and regional formats (also in the small windows). */
export function applyLocale(s: Settings) {
  if (s.locale) {
    const lang = langOf(s.locale.language);
    setFormatPrefs({ lang, dateFormat: s.locale.date_format, numberFormat: numberFormatOf(s.locale) });
    setLang(lang);
  }
  if (s.time) setFormatPrefs({ weekStartsOn: s.time.week_start === "sunday" ? 0 : 1, hours: s.time.hours_display });
}

/**
 * The quick capture, quick search and presenter windows: language and formats from the
 * settings, again whenever they change (`settings://changed`), so a switch applies there live.
 */
export function followLocale() {
  const load = () =>
    import("./api")
      .then(({ api }) => api.settings())
      .then((v) => {
        applyLocale(v.settings);
        refreshI18n();
      })
      .catch(() => {});
  void load();
  void import("./api").then(({ on }) => on("settings://changed", () => void load()));
}

let lastKeymap = "";

let zoom = 100;
/** UI scale through the webview's zoom (layout and hit testing stay consistent). */
function setZoom(percent: number) {
  const p = Math.min(125, Math.max(90, Math.round(percent || 100)));
  if (p === zoom) return;
  zoom = p;
  document.documentElement.dataset.uiScale = String(p);
  import("@tauri-apps/api/webview")
    .then(({ getCurrentWebview }) => getCurrentWebview().setZoom(p / 100))
    .catch(() => {
      // Fallback (e.g. without the permission): CSS zoom.
      document.documentElement.style.setProperty("zoom", String(p / 100));
    });
}

/** Spellcheck attributes of the editor for Settings → Editor. */
export function spellcheckAttrs(mode: Settings["editor"]["spellcheck"] | undefined): { spellcheck: "true" | "false"; lang: string } {
  switch (mode ?? "de") {
    case "off":
      return { spellcheck: "false", lang: "de" };
    case "en":
      return { spellcheck: "true", lang: "en" };
    case "de-en":
      // WebView2 and WebKit check against the document language plus the system languages.
      return { spellcheck: "true", lang: "de" };
    default:
      return { spellcheck: "true", lang: "de" };
  }
}

/** Default file name of an export (without extension) from the pattern in the settings. */
export function exportFileName(pattern: string, v: { from: string; to: string; format: string; week?: number; pernr?: string | null }): string {
  const name = (pattern || "zeiten-{von}-{bis}")
    .replace(/\{von\}|\{from\}/g, v.from)
    .replace(/\{bis\}|\{to\}/g, v.to)
    .replace(/\{format\}/g, v.format)
    .replace(/\{kw\}/g, v.week != null ? String(v.week).padStart(2, "0") : "")
    .replace(/\{pernr\}/g, v.pernr ?? "")
    // No path separators or characters Windows forbids.
    .replace(/[\\/:*?"<>|]+/g, "-")
    .trim();
  return name || "zeiten";
}

/** The decimal notation: as chosen, else as the display language writes numbers (28.00 / 28,00). */
export const numberFormatOf = (l: { language: string; number_format?: "comma" | "point" | null }): "comma" | "point" => l.number_format ?? (langOf(l.language) === "en" ? "point" : "comma");

/** `l` with the decimal notation `v`: the language's own one stays unset, so it keeps following the language. */
export function withNumberFormat<L extends { language: string; number_format?: "comma" | "point" | null }>(l: L, v: "comma" | "point"): L {
  const out = { ...l };
  if (v === numberFormatOf({ language: l.language })) delete out.number_format;
  else out.number_format = v;
  return out;
}
