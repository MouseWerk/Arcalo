// Recording a global shortcut from a key press (spec format of the Tauri global-shortcut plugin)
// and showing shortcuts the way the platform does (macOS: ⌃⌥⇧⌘ glyphs).

import { IS_MAC } from "./platform";
import { t } from "./i18n";

/**
 * A shortcut from a key press in the recorder field: `"Ctrl+Shift+Space"`, `""` (Entf/Backspace
 * clears), `null` (only modifiers so far: swallow) or `undefined` (let the key through: Tab, Esc).
 * On macOS the Command key is recorded as `Cmd`.
 */
export function recordShortcut(
  e: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey"> & Partial<Pick<KeyboardEvent, "getModifierState">>,
  mac = IS_MAC,
): string | null | undefined {
  if (mac) {
    // Option (+Shift) alone types characters on a Mac (⌥L = @, ⌥E = €): Cmd or Ctrl is needed.
    if (e.altKey && !e.ctrlKey && !e.metaKey) return null;
  } else if (e.getModifierState?.("AltGraph") || e.key === "AltGraph" || (e.ctrlKey && e.altKey)) {
    // Ctrl+Alt is AltGr on German keyboards (@, €, {, [ …): a global shortcut would swallow it.
    return null;
  }
  const mods = (
    mac
      ? [e.metaKey && "Cmd", e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift"]
      : [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Super"]
  ).filter(Boolean) as string[];
  if (e.key === "Tab" || e.key === "Escape") return undefined;
  if (!mods.length && (e.key === "Backspace" || e.key === "Delete")) return "";
  if (["Control", "Alt", "Shift", "Meta", "AltGraph", "OS"].includes(e.key)) return null;
  const key = e.code.replace(/^Key([A-Z])$/, "$1").replace(/^Digit(\d)$/, "$1").replace(/^Arrow/, "");
  if (!key) return null;
  // A global shortcut without modifier would swallow the key everywhere (F-keys excepted).
  if (!mods.length && !/^F\d{1,2}$/.test(key)) return null;
  return [...mods, key].join("+");
}

type Mod = "ctrl" | "alt" | "shift" | "cmd";

const MODS: Record<string, Mod | "mod"> = {
  ctrl: "ctrl",
  control: "ctrl",
  strg: "ctrl",
  alt: "alt",
  option: "alt",
  opt: "alt",
  shift: "shift",
  cmd: "cmd",
  command: "cmd",
  super: "cmd",
  meta: "cmd",
  win: "cmd",
  // The platform's primary modifier: ⌘ on macOS, Ctrl elsewhere (the in-app shortcuts accept both).
  mod: "mod",
  cmdorctrl: "mod",
  cmdorcontrol: "mod",
  commandorctrl: "mod",
  commandorcontrol: "mod",
};
const MAC_ORDER: Mod[] = ["ctrl", "alt", "shift", "cmd"];
const MAC_GLYPH: Record<Mod, string> = { ctrl: "⌃", alt: "⌥", shift: "⇧", cmd: "⌘" };
/** Modifier names as printed on the keys of the UI language's keyboards (Strg, Umschalt). */
const NAME: Record<Mod, () => string> = { ctrl: () => t("keys.ctrl"), alt: () => t("keys.alt"), shift: () => t("keys.shift"), cmd: () => "Super" };
/** Named keys as printed on the keys (Entf, Pos1, Leertaste on German keyboards). */
const KEY_NAMES: Record<string, () => string> = {
  enter: () => t("keys.enter"),
  return: () => t("keys.enter"),
  delete: () => t("keys.delete"),
  entf: () => t("keys.delete"),
  space: () => t("keys.space"),
  backspace: () => t("keys.backspace"),
  escape: () => "Esc",
  esc: () => "Esc",
  home: () => t("keys.home"),
  end: () => t("keys.end"),
  pageup: () => t("keys.pageUp"),
  pagedown: () => t("keys.pageDown"),
};
const MAC_KEYS: Record<string, string> = {
  enter: "↩",
  return: "↩",
  tab: "⇥",
  backspace: "⌫",
  delete: "⌦",
  entf: "⌦",
  escape: "⎋",
  esc: "⎋",
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
};
/** Arrow keys by their DOM name are shown as arrows everywhere („Alt ↑“, not „Alt ArrowUp“). */
const ARROWS: Record<string, string> = { arrowup: "↑", arrowdown: "↓", arrowleft: "←", arrowright: "→" };

/**
 * Shows a shortcut the platform's way. `spec` is a global-shortcut spec (`"Ctrl+Shift+Space"`,
 * `"Cmd+Shift+K"`) or a hint with spaces (`"Mod Shift D"`); `Mod` is ⌘ on macOS and Ctrl elsewhere.
 * macOS: `"⌘⇧D"` (modifiers in Apple's order ⌃⌥⇧⌘); elsewhere the names joined by `sep`.
 */
export function formatShortcut(spec: string, mac = IS_MAC, sep = "+"): string {
  const mods: Mod[] = [];
  const rest: string[] = [];
  for (const t of spec.trim().split(/\s+|\+(?=.)/).filter(Boolean)) {
    const m = MODS[t.toLowerCase()];
    if (m) mods.push(m === "mod" ? (mac ? "cmd" : "ctrl") : m);
    else rest.push(ARROWS[t.toLowerCase()] ?? (t.length === 1 ? t.toUpperCase() : t));
  }
  const named = (k: string) => KEY_NAMES[k.toLowerCase()]?.() ?? k;
  if (!mac) return [...mods.map((m) => NAME[m]()), ...rest.map(named)].join(sep);
  const glyphs = MAC_ORDER.filter((m) => mods.includes(m))
    .map((m) => MAC_GLYPH[m])
    .join("");
  const key = rest.map((k) => MAC_KEYS[k.toLowerCase()] ?? named(k)).join(" ");
  // Words (Space, Klick) keep a gap; single keys, glyphs and F-keys follow the modifiers directly.
  const gap = glyphs && [...key].length > 1 && !/^F\d{1,2}$/.test(key) ? " " : "";
  return glyphs + gap + key;
}

/** An in-app shortcut hint: `keys("Mod Shift D")` is „⌘⇧D“ on macOS and „Strg Umschalt D“ (German) elsewhere. */
export function keys(spec: string, mac = IS_MAC): string {
  return formatShortcut(spec, mac, " ");
}

/** The primary modifier for labels: „⌘“ on macOS, „Strg“ (German) or „Ctrl“ elsewhere. */
export function modLabel(mac = IS_MAC): string {
  return mac ? "⌘" : t("keys.ctrl");
}

/**
 * Find and replace in a note: Ctrl+H, but ⌥⌘F on macOS, where ⌘H hides the app before the page
 * sees it (Apple's own apps use ⌥⌘F).
 */
export function replaceHint(mac = IS_MAC): string {
  return keys(mac ? "Alt Mod F" : "Mod H", mac);
}

/** Whether a key press opens find and replace (see `replaceHint`). */
export function isReplaceKey(e: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">, mac = IS_MAC): boolean {
  if (e.shiftKey) return false;
  // Option changes the character (⌥F types ƒ): the key is told by its position.
  if (mac) return e.metaKey && e.altKey && !e.ctrlKey && e.code === "KeyF";
  return (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "h";
}
