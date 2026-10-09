// In-app keyboard shortcuts: the commands, their default combos, recording combos from key
// events and conflict detection (Settings → Tastatur). Combos are written like
// "Ctrl+Shift+D"; Ctrl stands for Ctrl or Cmd. Ctrl+Alt is never allowed: it is AltGr on
// German keyboards and types characters like \ | [ ] @.

import { IS_MAC } from "./platform";
import { formatShortcut } from "./shortcut";
import { currentLang, type Lang, type TKey } from "./i18n";

export interface CommandDef {
  id: string;
  label: TKey;
  combo: string;
}

/** Commands of the main window (handlers live in App.tsx). */
export const COMMANDS: CommandDef[] = [
  { id: "palette", label: "cmd.palette", combo: "Ctrl+K" },
  { id: "quick_switcher", label: "cmd.quickSwitcher", combo: "Ctrl+O" },
  { id: "new_page", label: "cmd.newPage", combo: "Ctrl+N" },
  { id: "daily_note", label: "cmd.dailyNote", combo: "Ctrl+Shift+D" },
  { id: "calendar", label: "cmd.calendar", combo: "Ctrl+Shift+C" },
  { id: "calendar_view", label: "cmd.calendarView", combo: "Ctrl+Shift+E" },
  { id: "tasks", label: "cmd.tasks", combo: "Ctrl+Shift+A" },
  { id: "search", label: "cmd.search", combo: "Ctrl+Shift+F" },
  { id: "new_tab", label: "cmd.newTab", combo: "Ctrl+T" },
  { id: "close_tab", label: "cmd.closeTab", combo: "Ctrl+W" },
  // No default: no free combo says „anheften“ (Ctrl+Shift+P presents, Ctrl+Shift+K is the usual
  // global palette); it can be set in Settings → Tastatur.
  { id: "pin_tab", label: "cmd.pinTab", combo: "" },
  { id: "next_tab", label: "cmd.nextTab", combo: "Ctrl+Tab" },
  { id: "prev_tab", label: "cmd.prevTab", combo: "Ctrl+Shift+Tab" },
  { id: "back", label: "cmd.back", combo: "Alt+ArrowLeft" },
  { id: "forward", label: "cmd.forward", combo: "Alt+ArrowRight" },
  { id: "timer", label: "cmd.timer", combo: "Ctrl+Shift+T" },
  { id: "timer_pause", label: "cmd.timerPause", combo: "Ctrl+Shift+G" },
  { id: "assistant", label: "cmd.assistant", combo: "Ctrl+J" },
  { id: "chat_view", label: "cmd.chatView", combo: "Ctrl+Shift+J" },
  { id: "toggle_sidebar", label: "cmd.toggleSidebar", combo: "Ctrl+\\" },
  { id: "toggle_panel", label: "cmd.togglePanel", combo: "Ctrl+Shift+\\" },
  { id: "add_property", label: "cmd.addProperty", combo: "Ctrl+;" },
  { id: "focus_mode", label: "cmd.focusMode", combo: "Ctrl+." },
  { id: "toggle_source", label: "cmd.toggleSource", combo: "Ctrl+Shift+M" },
  { id: "full_width", label: "cmd.fullWidth", combo: "Ctrl+Shift+L" },
  { id: "present", label: "cmd.present", combo: "Ctrl+Shift+P" },
  { id: "settings", label: "cmd.settings", combo: "Ctrl+," },
  { id: "help", label: "cmd.help", combo: "F1" },
];

/**
 * Defaults that differ on macOS: Option+←/→ jumps by word there, so back/forward use ⌘[ and
 * ⌘] (as Safari and Finder do); ⌘⇥ is the app switcher, so the next and previous tab are ⌘⇧]
 * and ⌘⇧[ (as in Safari, Finder and Xcode).
 */
export const MAC_DEFAULTS: Record<string, string> = { back: "Ctrl+[", forward: "Ctrl+]", next_tab: "Ctrl+Shift+]", prev_tab: "Ctrl+Shift+[" };

/** Combos macOS takes before the window sees them (⌘ is written Ctrl here). */
export const MAC_RESERVED: Record<string, TKey> = {
  "Ctrl+H": "keys.reserved.hide",
  "Ctrl+M": "keys.reserved.minimize",
  "Ctrl+Q": "keys.reserved.quit",
  "Ctrl+Tab": "keys.reserved.appSwitcher",
  "Ctrl+Shift+Tab": "keys.reserved.appSwitcher",
  "Ctrl+Space": "keys.reserved.spotlight",
  "Ctrl+Shift+W": "keys.reserved.closeWindow",
};

/** The macOS menu's fixed key equivalents: they run their command whatever the keymap says. */
const MAC_MENU: Record<string, string> = { "Ctrl+,": "settings", "Ctrl+\\": "toggle_sidebar", "Ctrl+.": "focus_mode" };

/** Combos some input methods take on Windows (switching punctuation or simplified/traditional). */
const IME_TAKEN = new Set(["Ctrl+Shift+F", "Ctrl+.", "Ctrl+Space", "Ctrl+Shift+Space"]);
/** A note for a combo an input method may take (shown under the shortcut, not as a conflict). */
export const imeNote = (combo: string | null | undefined, mac = IS_MAC): TKey | null => (!mac && combo && IME_TAKEN.has(combo) ? "keys.imeNote" : null);

/** The default combos of the platform (Settings → Tastatur shows and resets to these). */
export function defaultKeymap(mac = IS_MAC): Record<string, string> {
  return Object.fromEntries(COMMANDS.map((c) => [c.id, (mac && MAC_DEFAULTS[c.id]) || c.combo]));
}

export const DEFAULT_KEYMAP: Record<string, string> = defaultKeymap();

/** Combos the editor and the system use; binding them to a command is a conflict. */
export const RESERVED: Record<string, TKey> = {
  "Ctrl+Z": "keys.reserved.undo",
  "Ctrl+Y": "keys.reserved.redo",
  "Ctrl+Shift+Z": "keys.reserved.redo",
  "Ctrl+C": "keys.reserved.copy",
  "Ctrl+V": "keys.reserved.paste",
  "Ctrl+X": "keys.reserved.cut",
  "Ctrl+A": "keys.reserved.selectAll",
  "Ctrl+B": "keys.reserved.bold",
  "Ctrl+I": "keys.reserved.italic",
  "Ctrl+U": "keys.reserved.underline",
  "Ctrl+F": "keys.reserved.find",
  "Ctrl+E": "keys.reserved.code",
};

const NAMED: Record<string, string> = {
  Tab: "Tab",
  Enter: "Enter",
  Escape: "Escape",
  Space: "Space",
  ArrowLeft: "ArrowLeft",
  ArrowRight: "ArrowRight",
  ArrowUp: "ArrowUp",
  ArrowDown: "ArrowDown",
  Backslash: "\\",
  // By position, like the backslash: ⌘[ is the key right of P (Ü on German keyboards).
  BracketLeft: "[",
  BracketRight: "]",
  Backspace: "Backspace",
  Delete: "Delete",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
};

/** The key part of an event: letters by character (QWERTZ/QWERTY safe), digits and named keys by position. */
function keyName(e: Pick<KeyboardEvent, "key" | "code">): { key: string; shiftConsumed: boolean } | null {
  if (["Control", "Shift", "Alt", "Meta", "AltGraph", "CapsLock", "Dead", "Unidentified"].includes(e.key)) return null;
  if (NAMED[e.code]) return { key: NAMED[e.code], shiftConsumed: false };
  if (/^F([1-9]|1[0-2])$/.test(e.key)) return { key: e.key, shiftConsumed: false };
  if (/^Digit\d$/.test(e.code)) return { key: e.code.slice(5), shiftConsumed: false };
  if (/^[a-z]$/i.test(e.key)) return { key: e.key.toUpperCase(), shiftConsumed: false };
  if (e.key === " ") return { key: "Space", shiftConsumed: false };
  // Punctuation: Shift is part of how the character is typed (e.g. ";" is Shift+, on German keyboards).
  if (e.key.length === 1) return { key: e.key, shiftConsumed: true };
  return null;
}

type KeyEventLike = Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey"> & { getModifierState?: (k: string) => boolean };

/** "Ctrl+Shift+D" for a key event; null for AltGr/Ctrl+Alt, lone modifiers and unknown keys. */
export function comboFromEvent(e: KeyEventLike): string | null {
  if (e.getModifierState?.("AltGraph") || ((e.ctrlKey || e.metaKey) && e.altKey)) return null;
  const k = keyName(e);
  if (!k) return null;
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey && !k.shiftConsumed) parts.push("Shift");
  parts.push(k.key);
  return parts.join("+");
}

/** Canonical spelling ("ctrl + shift + d" → "Ctrl+Shift+D"); null when unparsable. */
export function normalizeCombo(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  // "Ctrl++" style: a trailing "+" is the key.
  const tokens = s.endsWith("++") ? [...s.slice(0, -2).split("+"), "+"] : s.split("+");
  const mods = new Set<string>();
  let key: string | null = null;
  for (const t0 of tokens.map((t) => t.trim())) {
    const t = t0.toLowerCase();
    if (["ctrl", "control", "strg", "cmd", "meta", "mod"].includes(t)) mods.add("Ctrl");
    else if (["alt", "option"].includes(t)) mods.add("Alt");
    else if (["shift", "umschalt"].includes(t)) mods.add("Shift");
    else if (key !== null || !t0) return null;
    else if (/^[a-z]$/i.test(t0)) key = t0.toUpperCase();
    else if (/^f([1-9]|1[0-2])$/i.test(t0)) key = t0.toUpperCase();
    else {
      const named = Object.values(NAMED).find((n) => n.toLowerCase() === t);
      key = named ?? (t0.length === 1 ? t0 : null);
      if (key === null) return null;
    }
  }
  if (!key) return null;
  return [...["Ctrl", "Alt", "Shift"].filter((m) => mods.has(m)), key].join("+");
}

/** Why a combo cannot be used for a command, or null. */
export function comboProblem(combo: string): TKey | null {
  const parts = combo.split("+");
  const key = parts[parts.length - 1];
  const has = (m: string) => parts.slice(0, -1).includes(m);
  if (has("Ctrl") && has("Alt")) return "keys.problem.altgr";
  // Without Ctrl/Alt only function keys make sense (plain keys and Shift+key type text).
  if (!has("Ctrl") && !has("Alt") && !/^F\d+$/.test(key)) return "keys.problem.modifier";
  return null;
}

/** The effective keymap: defaults with the user's overrides ("" = off). */
export function effectiveKeymap(overrides: Record<string, string> | undefined): Record<string, string> {
  const out = { ...DEFAULT_KEYMAP };
  for (const [id, combo] of Object.entries(overrides ?? {})) {
    if (!(id in out)) continue;
    out[id] = combo === "" ? "" : (normalizeCombo(combo) ?? out[id]);
  }
  return out;
}

/** Only the differences to the defaults (what is stored in the settings). */
export function keymapOverrides(map: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(map).filter(([id, c]) => DEFAULT_KEYMAP[id] !== undefined && DEFAULT_KEYMAP[id] !== c));
}

export interface Conflict {
  combo: string;
  /** Command ids sharing the combo. */
  commands: string[];
  /** Editor/system function or global shortcut it collides with. */
  other?: TKey | "global.capture" | "global.palette" | "global.selection" | "global.mail";
}

/** Combos used twice, or taken by the editor, the system (macOS) or a global shortcut. */
export function findConflicts(
  map: Record<string, string>,
  globals: { capture?: string | null; palette?: string | null; selection?: string | null; mail?: string | null } = {},
  mac = IS_MAC,
): Conflict[] {
  const byCombo = new Map<string, string[]>();
  for (const [id, combo] of Object.entries(map)) {
    if (!combo) continue;
    byCombo.set(combo, [...(byCombo.get(combo) ?? []), id]);
  }
  const out: Conflict[] = [];
  const g = (s?: string | null) => (s ? normalizeCombo(s) : null);
  const capture = g(globals.capture);
  const palette = g(globals.palette);
  const selection = g(globals.selection);
  const mail = g(globals.mail);
  for (const [combo, ids] of byCombo) {
    if (ids.length > 1) out.push({ combo, commands: ids });
    if (RESERVED[combo]) out.push({ combo, commands: ids, other: RESERVED[combo] });
    if (mac && MAC_RESERVED[combo]) out.push({ combo, commands: ids, other: MAC_RESERVED[combo] });
    // The menu's ⌘, ⌘\ ⌘. run their own command first.
    const menu = mac ? MAC_MENU[combo] : undefined;
    if (menu && !(ids.length === 1 && ids[0] === menu)) out.push({ combo, commands: ids, other: COMMANDS.find((c) => c.id === menu)!.label });
    if (capture && combo === capture) out.push({ combo, commands: ids, other: "global.capture" });
    if (selection && combo === selection) out.push({ combo, commands: ids, other: "global.selection" });
    if (mail && combo === mail) out.push({ combo, commands: ids, other: "global.mail" });
    // The global palette shortcut may equal the in-app palette command.
    if (palette && combo === palette && !(ids.length === 1 && ids[0] === "palette")) out.push({ combo, commands: ids, other: "global.palette" });
  }
  return out;
}

const SYMBOLS: Record<string, string> = { ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓" };

/** Keys stored by their position, with the code of that position. */
const POSITIONAL: Record<string, string> = { "\\": "Backslash", "[": "BracketLeft", "]": "BracketRight" };
/** What those positions show on a German keyboard (Strg+# toggles the sidebar there, ⌘Ü goes back). */
const GERMAN_POSITIONS: Record<string, string> = { Backslash: "#", BracketLeft: "Ü", BracketRight: "+" };
/** The keyboard's own characters by position, when the engine tells them (Keyboard API). */
let layoutMap: Map<string, string> | null = null;

/** Learns the characters of the keyboard layout (where the engine offers it; WebKit does not). */
export async function learnKeyboardLayout(): Promise<void> {
  const nav = (typeof navigator === "undefined" ? undefined : navigator) as (Navigator & { keyboard?: { getLayoutMap?: () => Promise<Map<string, string>> } }) | undefined;
  try {
    const map = await nav?.keyboard?.getLayoutMap?.();
    if (map?.size) layoutMap = new Map(map);
  } catch {
    /* not offered */
  }
}

/**
 * The label of a key stored by its position (\ [ ]) on the user's keyboard: the layout's own
 * character when the engine tells it, else the German one with a German UI (most people with a
 * German UI type on a German keyboard), else the US one.
 */
export function positionLabel(key: string, lang: Lang = currentLang()): string {
  const code = POSITIONAL[key];
  if (!code) return key;
  const own = layoutMap?.get(code);
  if (own) return own.toUpperCase();
  return lang === "de" ? GERMAN_POSITIONS[code] : key;
}

/** "Strg+Umschalt+D" as shown in tooltips, menus and hint texts ("⌘⇧D" on macOS, where ⌘ acts as Ctrl); "" for none. */
export function comboLabel(combo: string | null | undefined, mac = IS_MAC, lang: Lang = currentLang()): string {
  if (!combo) return "";
  const parts = combo.endsWith("++") ? [...combo.slice(0, -2).split("+"), "+"] : combo.split("+");
  const key = parts.pop()!;
  const mods = parts.map((p) => (p === "Ctrl" ? "Mod" : p));
  return formatShortcut([...mods, SYMBOLS[key] ?? positionLabel(key, lang)].join(" "), mac);
}

/** The command bound to a key event. */
export function commandFor(e: KeyEventLike, map: Record<string, string>): string | null {
  const combo = comboFromEvent(e);
  if (!combo) return null;
  for (const [id, c] of Object.entries(map)) if (c === combo) return id;
  return null;
}

/** Commands that stay with a text field or the editor when the focus is in one (word jumps). */
const TEXT_KEEPS = new Set(["back", "forward"]);

/** The focus is where text is typed: an input, a text area or the editor. */
export function isTextTarget(el: Element | null): boolean {
  if (!el) return false;
  if ((el as HTMLElement).isContentEditable) return true;
  if (el.tagName === "TEXTAREA") return true;
  if (el.tagName !== "INPUT") return false;
  const type = ((el as HTMLInputElement).type || "text").toLowerCase();
  return !["button", "checkbox", "radio", "range", "color", "file", "submit", "reset", "image"].includes(type);
}

/**
 * Key presses a popup already used (an Escape that closed the slash menu or the find bar). The
 * window's own meaning of the key (Escape ends the focus mode) then does not apply. A mark of its
 * own: the editor calls preventDefault on every Escape, so `defaultPrevented` cannot tell.
 */
const consumed = new WeakSet<Event>();
export const consumeKey = (e: Event | { nativeEvent: Event }) => void consumed.add("nativeEvent" in e ? e.nativeEvent : e);
export const keyConsumed = (e: Event) => consumed.has(e);

/** Commands that also run over the palette: they switch or close it. */
const OVER_PALETTE = new Set(["palette", "quick_switcher"]);

/**
 * The modal layer in front of the window, if any: the palette alone, or another one (a dialog,
 * the setup, a presentation, the lock screen, a full view). Behind it the window's commands and
 * the mouse back/forward buttons wait.
 */
export function modalLayer(root: ParentNode | null = typeof document === "undefined" ? null : document): "palette" | "modal" | null {
  const layers = root ? [...root.querySelectorAll('[aria-modal="true"], .fr-overlay')] : [];
  if (!layers.length) return null;
  return layers.every((el) => el.classList.contains("palette")) ? "palette" : "modal";
}

/** Whether command `id` runs for a key event with the focus on `target` (and `layer` in front). */
export function commandAllowed(id: string, target: Element | null, layer: "palette" | "modal" | null = modalLayer()): boolean {
  if (layer === "modal" || (layer === "palette" && !OVER_PALETTE.has(id))) return false;
  return !(TEXT_KEEPS.has(id) && isTextTarget(target));
}

/** Current keymap for hints outside React (set by `applyPrefs`). */
let current: Record<string, string> = { ...DEFAULT_KEYMAP };
export const setCurrentKeymap = (m: Record<string, string>) => (current = m);
export const currentKeymap = () => current;
/** Shortcut hint of a command, e.g. "Ctrl+Shift+D" ("" when unbound). */
export const hint = (id: string) => comboLabel(current[id]);
/** "Label (Ctrl+N)" or just "Label" when the command has no shortcut. */
export const withHint = (label: string, id: string) => (hint(id) ? `${label} (${hint(id)})` : label);
