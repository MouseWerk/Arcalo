// In-app keyboard shortcuts: the commands, their default combos, recording combos from key
// events and conflict detection (Settings → Tastatur). Combos are written like
// "Ctrl+Shift+D"; Ctrl stands for Ctrl or Cmd. Ctrl+Alt is never allowed: it is AltGr on
// German keyboards and types characters like \ | [ ] @.

import { IS_MAC } from "./platform";
import { formatShortcut } from "./shortcut";
import type { TKey } from "./i18n";

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
  { id: "tasks", label: "cmd.tasks", combo: "Ctrl+Shift+A" },
  { id: "search", label: "cmd.search", combo: "Ctrl+Shift+F" },
  { id: "new_tab", label: "cmd.newTab", combo: "Ctrl+T" },
  { id: "close_tab", label: "cmd.closeTab", combo: "Ctrl+W" },
  { id: "next_tab", label: "cmd.nextTab", combo: "Ctrl+Tab" },
  { id: "prev_tab", label: "cmd.prevTab", combo: "Ctrl+Shift+Tab" },
  { id: "back", label: "cmd.back", combo: "Alt+ArrowLeft" },
  { id: "forward", label: "cmd.forward", combo: "Alt+ArrowRight" },
  { id: "timer", label: "cmd.timer", combo: "Ctrl+Shift+T" },
  { id: "assistant", label: "cmd.assistant", combo: "Ctrl+J" },
  { id: "toggle_sidebar", label: "cmd.toggleSidebar", combo: "Ctrl+\\" },
  { id: "toggle_panel", label: "cmd.togglePanel", combo: "Ctrl+Shift+\\" },
  { id: "add_property", label: "cmd.addProperty", combo: "Ctrl+;" },
  { id: "focus_mode", label: "cmd.focusMode", combo: "Ctrl+." },
  { id: "toggle_source", label: "cmd.toggleSource", combo: "Ctrl+Shift+M" },
  { id: "full_width", label: "cmd.fullWidth", combo: "Ctrl+Shift+L" },
  { id: "present", label: "cmd.present", combo: "Ctrl+Shift+P" },
  { id: "settings", label: "cmd.settings", combo: "Ctrl+," },
];

/**
 * Defaults that differ on macOS: Option+←/→ jumps by word there, so back/forward use ⌘[ and
 * ⌘] (as Safari and Finder do).
 */
export const MAC_DEFAULTS: Record<string, string> = { back: "Ctrl+[", forward: "Ctrl+]" };

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
  other?: TKey | "global.capture" | "global.palette";
}

/** Combos used twice, or taken by the editor or a global shortcut. */
export function findConflicts(map: Record<string, string>, globals: { capture?: string | null; palette?: string | null } = {}): Conflict[] {
  const byCombo = new Map<string, string[]>();
  for (const [id, combo] of Object.entries(map)) {
    if (!combo) continue;
    byCombo.set(combo, [...(byCombo.get(combo) ?? []), id]);
  }
  const out: Conflict[] = [];
  const g = (s?: string | null) => (s ? normalizeCombo(s) : null);
  const capture = g(globals.capture);
  const palette = g(globals.palette);
  for (const [combo, ids] of byCombo) {
    if (ids.length > 1) out.push({ combo, commands: ids });
    if (RESERVED[combo]) out.push({ combo, commands: ids, other: RESERVED[combo] });
    if (capture && combo === capture) out.push({ combo, commands: ids, other: "global.capture" });
    // The global palette shortcut may equal the in-app palette command.
    if (palette && combo === palette && !(ids.length === 1 && ids[0] === "palette")) out.push({ combo, commands: ids, other: "global.palette" });
  }
  return out;
}

const SYMBOLS: Record<string, string> = { ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓" };

/** "Ctrl Shift D" as shown in tooltips and menus ("⌘ ⇧ D" on macOS, where ⌘ acts as Ctrl); "" for none. */
export function comboLabel(combo: string | null | undefined, mac = IS_MAC): string {
  if (!combo) return "";
  if (mac) {
    const parts = combo.split("+");
    const key = parts.pop()!;
    const mods = parts.map((p) => (p === "Ctrl" ? "Mod" : p)).join(" ");
    return formatShortcut(`${mods} ${SYMBOLS[key] ?? key}`.trim(), true, " ");
  }
  return combo
    .split("+")
    .map((p, i, all) => (i === all.length - 1 ? (SYMBOLS[p] ?? p) : p))
    .join(" ")
    .replace(/  +/g, " + ");
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

/** Whether command `id` runs for a key event with the focus on `target`. */
export function commandAllowed(id: string, target: Element | null): boolean {
  return !(TEXT_KEEPS.has(id) && isTextTarget(target));
}

/** Current keymap for hints outside React (set by `applyPrefs`). */
let current: Record<string, string> = { ...DEFAULT_KEYMAP };
export const setCurrentKeymap = (m: Record<string, string>) => (current = m);
export const currentKeymap = () => current;
/** Shortcut hint of a command, e.g. "Ctrl Shift D" ("" when unbound). */
export const hint = (id: string) => comboLabel(current[id]);
/** "Label (Ctrl N)" or just "Label" when the command has no shortcut. */
export const withHint = (label: string, id: string) => (hint(id) ? `${label} (${hint(id)})` : label);
