import { describe, expect, it } from "vitest";
import { COMMANDS, DEFAULT_KEYMAP, commandAllowed, comboFromEvent, comboLabel, comboProblem, commandFor, defaultKeymap, effectiveKeymap, findConflicts, isTextTarget, keymapOverrides, normalizeCombo } from "./keymap";

const ev = (key: string, code: string, mods: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean; altGr?: boolean } = {}) => ({
  key,
  code,
  ctrlKey: !!mods.ctrl,
  shiftKey: !!mods.shift,
  altKey: !!mods.alt,
  metaKey: !!mods.meta,
  getModifierState: (k: string) => k === "AltGraph" && !!mods.altGr,
});

describe("keymap", () => {
  it("records combos from key events", () => {
    expect(comboFromEvent(ev("d", "KeyD", { ctrl: true, shift: true }))).toBe("Ctrl+Shift+D");
    expect(comboFromEvent(ev("D", "KeyD", { ctrl: true, shift: true }))).toBe("Ctrl+Shift+D");
    // QWERTZ: the character decides, not the key position.
    expect(comboFromEvent(ev("z", "KeyY", { ctrl: true }))).toBe("Ctrl+Z");
    expect(comboFromEvent(ev("k", "KeyK", { meta: true }))).toBe("Ctrl+K");
    expect(comboFromEvent(ev("ArrowLeft", "ArrowLeft", { alt: true }))).toBe("Alt+ArrowLeft");
    expect(comboFromEvent(ev("Tab", "Tab", { ctrl: true, shift: true }))).toBe("Ctrl+Shift+Tab");
    expect(comboFromEvent(ev("#", "Backslash", { ctrl: true }))).toBe("Ctrl+\\");
    expect(comboFromEvent(ev("!", "Digit1", { ctrl: true, shift: true }))).toBe("Ctrl+Shift+1");
    // ";" is Shift+, on German keyboards: Shift is part of the character.
    expect(comboFromEvent(ev(";", "Comma", { ctrl: true, shift: true }))).toBe("Ctrl+;");
    expect(comboFromEvent(ev(",", "Comma", { ctrl: true }))).toBe("Ctrl+,");
    expect(comboFromEvent(ev("F5", "F5"))).toBe("F5");
  });

  it("rejects AltGr / Ctrl+Alt and lone modifiers", () => {
    expect(comboFromEvent(ev("@", "KeyQ", { ctrl: true, alt: true }))).toBeNull();
    expect(comboFromEvent(ev("\\", "Minus", { altGr: true }))).toBeNull();
    expect(comboFromEvent(ev("Control", "ControlLeft", { ctrl: true }))).toBeNull();
    expect(comboFromEvent(ev("Shift", "ShiftLeft", { shift: true }))).toBeNull();
    expect(comboProblem("Ctrl+Alt+K")).toBe("keys.problem.altgr");
    expect(comboProblem("Shift+K")).toBe("keys.problem.modifier");
    expect(comboProblem("K")).toBe("keys.problem.modifier");
    expect(comboProblem("F7")).toBeNull();
    expect(comboProblem("Alt+ArrowLeft")).toBeNull();
  });

  it("normalizes written combos", () => {
    expect(normalizeCombo("shift + ctrl + d")).toBe("Ctrl+Shift+D");
    expect(normalizeCombo("Strg+Umschalt+K")).toBe("Ctrl+Shift+K");
    expect(normalizeCombo("cmd+arrowleft")).toBe("Ctrl+ArrowLeft");
    expect(normalizeCombo("Ctrl+K+J")).toBeNull();
    expect(normalizeCombo("")).toBeNull();
    expect(comboLabel("Ctrl+Shift+D")).toBe("Ctrl Shift D");
    expect(comboLabel("Alt+ArrowLeft")).toBe("Alt ←");
    expect(comboLabel("")).toBe("");
  });

  it("macOS: back/forward default to Cmd+[ / Cmd+] (Option+arrows jump by word there)", () => {
    const mac = defaultKeymap(true);
    const other = defaultKeymap(false);
    expect(mac.back).toBe("Ctrl+[");
    expect(mac.forward).toBe("Ctrl+]");
    expect(other.back).toBe("Alt+ArrowLeft");
    expect(other.forward).toBe("Alt+ArrowRight");
    expect(findConflicts(mac)).toEqual([]);
    for (const c of Object.values(mac)) expect(comboProblem(c)).toBeNull();
    // Cmd+[ by key position (Ü on German keyboards), as the recorder in Settings sees it.
    expect(comboFromEvent(ev("[", "BracketLeft", { meta: true }))).toBe("Ctrl+[");
    expect(comboFromEvent(ev("ü", "BracketLeft", { meta: true }))).toBe("Ctrl+[");
    expect(commandFor(ev("]", "BracketRight", { meta: true }), mac)).toBe("forward");
    expect(commandFor(ev("ArrowLeft", "ArrowLeft", { alt: true }), mac)).toBeNull();
    expect(normalizeCombo("cmd+[")).toBe("Ctrl+[");
    expect(comboLabel("Ctrl+[", true)).toContain("[");
  });

  it("back/forward stay with text fields and the editor", () => {
    const input = document.createElement("input");
    const box = document.createElement("input");
    box.type = "checkbox";
    const area = document.createElement("textarea");
    const editable = document.createElement("div");
    editable.contentEditable = "true";
    document.body.append(editable);
    const button = document.createElement("button");
    for (const el of [input, area, editable]) {
      expect(isTextTarget(el)).toBe(true);
      expect(commandAllowed("back", el)).toBe(false);
      expect(commandAllowed("forward", el)).toBe(false);
      expect(commandAllowed("palette", el)).toBe(true);
    }
    expect(commandAllowed("back", box)).toBe(true);
    expect(commandAllowed("back", button)).toBe(true);
    expect(commandAllowed("back", document.body)).toBe(true);
    editable.remove();
  });

  it("defaults match the documented shortcuts and have no conflicts", () => {
    expect(COMMANDS.length).toBe(Object.keys(DEFAULT_KEYMAP).length);
    expect(DEFAULT_KEYMAP.palette).toBe("Ctrl+K");
    expect(DEFAULT_KEYMAP.daily_note).toBe("Ctrl+Shift+D");
    expect(findConflicts(DEFAULT_KEYMAP, { capture: "Ctrl+Shift+Space", palette: null })).toEqual([]);
    for (const c of Object.values(DEFAULT_KEYMAP)) expect(comboProblem(c)).toBeNull();
  });

  it("detects conflicts between commands, with the editor and with global shortcuts", () => {
    const map = effectiveKeymap({ new_page: "Ctrl+K", tasks: "Ctrl+B", timer: "Ctrl+Shift+Space" });
    const conflicts = findConflicts(map, { capture: "Ctrl+Shift+Space", palette: "Ctrl+Shift+K" });
    expect(conflicts).toContainEqual({ combo: "Ctrl+K", commands: ["palette", "new_page"] });
    expect(conflicts).toContainEqual({ combo: "Ctrl+B", commands: ["tasks"], other: "keys.reserved.bold" });
    expect(conflicts).toContainEqual({ combo: "Ctrl+Shift+Space", commands: ["timer"], other: "global.capture" });
    // „Auswahl übernehmen“ is a global shortcut too.
    const sel = findConflicts({ ...DEFAULT_KEYMAP, timer: "Ctrl+Shift+Y" }, { selection: "ctrl+shift+y" });
    expect(sel).toContainEqual({ combo: "Ctrl+Shift+Y", commands: ["timer"], other: "global.selection" });
    const mail = findConflicts({ ...DEFAULT_KEYMAP, timer: "Ctrl+Shift+J" }, { mail: "ctrl+shift+j" });
    expect(mail).toContainEqual({ combo: "Ctrl+Shift+J", commands: ["timer"], other: "global.mail" });
    // The palette may share its global shortcut with the in-app palette command.
    const same = effectiveKeymap({ palette: "Ctrl+Shift+K" });
    expect(findConflicts(same, { palette: "Ctrl+Shift+K" })).toEqual([]);
  });

  it("stores only overrides; empty = off; resolves events", () => {
    const map = effectiveKeymap({ daily_note: "ctrl+alt+x".replace("alt+", ""), focus_mode: "", unknown: "Ctrl+Q" });
    expect(map.daily_note).toBe("Ctrl+X");
    expect(map.focus_mode).toBe("");
    expect("unknown" in map).toBe(false);
    expect(keymapOverrides(map)).toEqual({ daily_note: "Ctrl+X", focus_mode: "" });
    expect(keymapOverrides(DEFAULT_KEYMAP)).toEqual({});
    expect(commandFor(ev("x", "KeyX", { ctrl: true }), map)).toBe("daily_note");
    expect(commandFor(ev("d", "KeyD", { ctrl: true, shift: true }), map)).toBeNull();
    expect(commandFor(ev(".", "Period", { ctrl: true }), map)).toBeNull();
  });
});
