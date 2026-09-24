// Applies the preferences that shape the UI (Settings → Darstellung, Sprache & Format,
// Zeiterfassung, Tastatur) to the document and the formatting helpers.

import type { Settings } from "./types";
import { accentCss } from "./color";
import { setFormatPrefs } from "./format";
import { refreshI18n, setLang } from "./i18n";
import { effectiveKeymap, setCurrentKeymap } from "./keymap";
import { rememberSplash } from "./splash";

const STYLE_ID = "annalo-accent";

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
    let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
    if (!style) {
      style = document.createElement("style");
      style.id = STYLE_ID;
      document.head.appendChild(style);
    }
    const css = accentCss(a.accent);
    if (style.textContent !== css) style.textContent = css;
    setZoom(a.ui_scale);
    // The startup animation of the next start uses the theme and accent color of now.
    requestAnimationFrame(() =>
      rememberSplash({
        dark: root.dataset.theme === "dark",
        accent: getComputedStyle(root).getPropertyValue("--accent").trim(),
        off: a.startup_animation === false,
        reduced: a.reduce_motion,
      }),
    );
  }
  if (s.locale) {
    setLang(s.locale.language);
    setFormatPrefs({ lang: s.locale.language, dateFormat: s.locale.date_format });
  }
  if (s.time) setFormatPrefs({ weekStartsOn: s.time.week_start === "sunday" ? 0 : 1, hours: s.time.hours_display });
  const keymap = effectiveKeymap(s.keymap);
  const key = JSON.stringify(keymap);
  if (key !== lastKeymap) {
    lastKeymap = key;
    setCurrentKeymap(keymap);
  }
  // Labels, shortcut hints and formats may have changed.
  refreshI18n();
  const mica = !!a?.mica;
  if (mica !== lastMica) {
    lastMica = mica;
    // Windows 11 only: the shell reports whether the Mica backdrop is on.
    import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke<boolean>("window_backdrop"))
      .then((on) => root.classList.toggle("os-windows", on))
      .catch(() => {});
  }
}
let lastKeymap = "";
let lastMica: boolean | null = null;

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
