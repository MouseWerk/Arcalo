import { describe, expect, it } from "vitest";
import { COMMANDS, DEFAULT_KEYMAP, MAC_RESERVED, commandAllowed, comboFromEvent, comboLabel, comboProblem, commandFor, defaultKeymap, effectiveKeymap, findConflicts, imeNote, isTextTarget, keymapOverrides, modalLayer, normalizeCombo, positionLabel } from "./keymap";
import { setLang, t } from "./i18n";

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
    expect(comboLabel("Ctrl+Shift+D", false)).toBe("Strg Umschalt D");
    expect(comboLabel("Alt+ArrowLeft", false)).toBe("Alt ←");
    setLang("en");
    expect(comboLabel("Ctrl+Shift+Space", false, "en")).toBe("Ctrl Shift Space");
    setLang("de");
    expect(comboLabel("")).toBe("");
  });

  it("labels keys stored by position the way the keyboard shows them (German: Strg+# toggles the sidebar)", () => {
    expect(comboLabel("Ctrl+\\", false, "de")).toBe("Strg #");
    expect(comboLabel("Ctrl+Shift+\\", false, "de")).toBe("Strg Umschalt #");
    expect(comboLabel("Ctrl+[", true, "de")).toBe("⌘Ü");
    expect(comboLabel("Ctrl+]", true, "de")).toBe("⌘+");
    setLang("en");
    expect(comboLabel("Ctrl+\\", false, "en")).toBe("Ctrl \\");
    setLang("de");
    expect(comboLabel("Ctrl+[", true, "en")).toBe("⌘[");
    // Not positional: the character itself.
    expect(positionLabel(",", "de")).toBe(",");
    // The German key reached with Strg+# is the one the recorder stores as Ctrl+\.
    expect(comboFromEvent(ev("#", "Backslash", { ctrl: true }))).toBe("Ctrl+\\");
  });

  it("no macOS default is a combo macOS takes for itself (⌘⇥, ⌘H, ⌘M, ⌘Q, ⌘Space)", () => {
    const mac = defaultKeymap(true);
    for (const [id, combo] of Object.entries(mac)) expect(MAC_RESERVED[combo], id).toBeUndefined();
    expect(mac.next_tab).toBe("Ctrl+Shift+]");
    expect(mac.prev_tab).toBe("Ctrl+Shift+[");
    expect(comboLabel(mac.next_tab, true, "en")).toBe("⇧⌘]");
    expect(findConflicts(mac, {}, true)).toEqual([]);
    // Rebinding onto one of them, or onto a menu key of another command, is a conflict there only.
    expect(findConflicts({ ...mac, tasks: "Ctrl+H" }, {}, true)).toContainEqual({ combo: "Ctrl+H", commands: ["tasks"], other: "keys.reserved.hide" });
    expect(findConflicts({ ...mac, tasks: "Ctrl+H" }, {}, false)).toEqual([]);
    expect(findConflicts({ ...mac, focus_mode: "", tasks: "Ctrl+." }, {}, true)).toContainEqual({ combo: "Ctrl+.", commands: ["tasks"], other: "cmd.focusMode" });
    // Input methods: a note, not a conflict.
    expect(imeNote("Ctrl+Shift+F", false)).toBe("keys.imeNote");
    expect(imeNote("Ctrl+Shift+F", true)).toBeNull();
    expect(imeNote("Ctrl+K", false)).toBeNull();
  });

  it("macOS: back/forward default to Cmd+[ / Cmd+] (Option+arrows jump by word there)", () => {
    const mac = defaultKeymap(true);
    const other = defaultKeymap(false);
    expect(mac.back).toBe("Ctrl+[");
    expect(mac.forward).toBe("Ctrl+]");
    expect(other.back).toBe("Alt+ArrowLeft");
    expect(other.forward).toBe("Alt+ArrowRight");
    expect(findConflicts(mac)).toEqual([]);
    for (const c of Object.values(mac).filter(Boolean)) expect(comboProblem(c)).toBeNull();
    // Cmd+[ by key position (Ü on German keyboards), as the recorder in Settings sees it.
    expect(comboFromEvent(ev("[", "BracketLeft", { meta: true }))).toBe("Ctrl+[");
    expect(comboFromEvent(ev("ü", "BracketLeft", { meta: true }))).toBe("Ctrl+[");
    expect(commandFor(ev("]", "BracketRight", { meta: true }), mac)).toBe("forward");
    expect(commandFor(ev("ArrowLeft", "ArrowLeft", { alt: true }), mac)).toBeNull();
    expect(normalizeCombo("cmd+[")).toBe("Ctrl+[");
    expect(comboLabel("Ctrl+[", true, "en")).toContain("[");
  });

  it("labels every default command the platform's way: ⌘ on macOS, Strg / Ctrl elsewhere", () => {
    for (const [id, combo] of Object.entries(defaultKeymap(true))) {
      const label = comboLabel(combo, true);
      expect(label, id).not.toMatch(/Ctrl|Strg|Alt|Shift|Umschalt/);
      if (combo.startsWith("Ctrl+")) expect(label, id).toContain("⌘");
    }
    for (const [id, combo] of Object.entries(defaultKeymap(false))) {
      const label = comboLabel(combo, false);
      expect(label, id).not.toMatch(/[⌘⌥⇧⌃]/);
      // German keyboards say Strg and Umschalt (q116 T1).
      expect(label, id).not.toMatch(/\b(Ctrl|Shift)\b/);
      if (combo.startsWith("Ctrl+")) expect(label, id).toMatch(/^Strg /);
      setLang("en");
      expect(comboLabel(combo, false, "en"), id).not.toMatch(/Strg|Umschalt/);
      setLang("de");
    }
    expect(comboLabel("Ctrl+Shift+D", true)).toBe("⇧⌘D");
    expect(comboLabel("Ctrl+W", true)).toBe("⌘W");
    expect(comboLabel("Ctrl+Shift+D", false)).toBe("Strg Umschalt D");
    setLang("en");
    expect(comboLabel("Ctrl+Shift+D", false)).toBe("Ctrl Shift D");
    setLang("de");
  });

  it("names every command differently in both languages (Settings → Tastatur, the palette)", () => {
    for (const lang of ["de", "en"] as const) {
      setLang(lang);
      // „Kalender“ and „Kalender öffnen“ cannot be told apart either: the verb does not count.
      const labels = COMMANDS.map((c) => t(c.label).replace(/\b(öffnen|anzeigen|zeigen|open|show)\b/gi, "").trim().toLowerCase());
      expect(labels.filter((l, i) => labels.indexOf(l) !== i), lang).toEqual([]);
    }
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

  it("no command runs behind a dialog or the setup; over the palette only the palette commands", () => {
    expect(modalLayer()).toBeNull();
    const palette = document.createElement("div");
    palette.className = "palette";
    palette.setAttribute("aria-modal", "true");
    document.body.append(palette);
    expect(modalLayer()).toBe("palette");
    expect(commandAllowed("close_tab", document.body)).toBe(false);
    expect(commandAllowed("new_page", document.body)).toBe(false);
    expect(commandAllowed("palette", document.body)).toBe(true);
    expect(commandAllowed("quick_switcher", document.body)).toBe(true);
    const dialog = document.createElement("div");
    dialog.className = "dialog";
    dialog.setAttribute("aria-modal", "true");
    document.body.append(dialog);
    expect(modalLayer()).toBe("modal");
    expect(commandAllowed("palette", document.body)).toBe(false);
    palette.remove();
    dialog.remove();
    // A dialog inside a hidden kept tab is not in front: the shortcuts work.
    const kept = document.createElement("div");
    kept.hidden = true;
    const behind = document.createElement("div");
    behind.setAttribute("aria-modal", "true");
    kept.append(behind);
    document.body.append(kept);
    expect(modalLayer()).toBeNull();
    expect(commandAllowed("close_tab", document.body)).toBe(true);
    kept.remove();
    // The setup counts even while the focus is outside it.
    const setup = document.createElement("div");
    setup.className = "fr-overlay";
    document.body.append(setup);
    expect(commandAllowed("close_tab", document.body)).toBe(false);
    setup.remove();
    expect(commandAllowed("close_tab", document.body)).toBe(true);
  });

  it("defaults match the documented shortcuts and have no conflicts", () => {
    expect(COMMANDS.length).toBe(Object.keys(DEFAULT_KEYMAP).length);
    expect(DEFAULT_KEYMAP.palette).toBe("Ctrl+K");
    expect(DEFAULT_KEYMAP.daily_note).toBe("Ctrl+Shift+D");
    expect(DEFAULT_KEYMAP.chat_view).toBe("Ctrl+Shift+J");
    expect(findConflicts(DEFAULT_KEYMAP, { capture: "Ctrl+Shift+Space", palette: null })).toEqual([]);
    // Every default is usable; a command without a default is listed unbound („Tab anheften“).
    for (const c of Object.values(DEFAULT_KEYMAP).filter(Boolean)) expect(comboProblem(c)).toBeNull();
    expect(DEFAULT_KEYMAP.pin_tab).toBe("");
    expect(Object.values(DEFAULT_KEYMAP).filter((c) => !c)).toEqual([""]);
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
    const mail = findConflicts({ ...DEFAULT_KEYMAP, timer: "Ctrl+Shift+U" }, { mail: "ctrl+shift+u" });
    expect(mail).toContainEqual({ combo: "Ctrl+Shift+U", commands: ["timer"], other: "global.mail" });
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
