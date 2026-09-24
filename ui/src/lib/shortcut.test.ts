import { describe, expect, it } from "vitest";
import { formatShortcut, keys, modLabel, recordShortcut } from "./shortcut";

const key = (code: string, key: string, mods: Partial<Record<"ctrlKey" | "altKey" | "shiftKey" | "metaKey", boolean>> = {}) =>
  recordShortcut({ code, key, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods }, false);

describe("recordShortcut", () => {
  it("builds the spec from modifiers and the physical key", () => {
    expect(key("Space", " ", { ctrlKey: true, shiftKey: true })).toBe("Ctrl+Shift+Space");
    expect(key("KeyY", "z", { ctrlKey: true })).toBe("Ctrl+Y");
    expect(key("Digit1", "!", { altKey: true, shiftKey: true })).toBe("Alt+Shift+1");
    expect(key("ArrowUp", "ArrowUp", { metaKey: true })).toBe("Super+Up");
    expect(key("F9", "F9")).toBe("F9");
  });
  it("waits for a key, clears, and lets Tab/Esc through", () => {
    expect(key("ShiftLeft", "Shift", { shiftKey: true })).toBeNull();
    expect(key("KeyA", "a")).toBeNull();
    expect(key("Backspace", "Backspace")).toBe("");
    expect(key("Delete", "Delete")).toBe("");
    expect(key("Tab", "Tab")).toBeUndefined();
    expect(key("Escape", "Escape")).toBeUndefined();
  });
  it("refuses Ctrl+Alt and AltGr (they type @, € … on German keyboards)", () => {
    expect(key("KeyQ", "@", { ctrlKey: true, altKey: true })).toBeNull();
    expect(key("KeyK", "k", { ctrlKey: true, altKey: true, shiftKey: true })).toBeNull();
    expect(key("AltRight", "AltGraph")).toBeNull();
    const altGr = { code: "KeyE", key: "€", ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, getModifierState: (m: string) => m === "AltGraph" };
    expect(recordShortcut(altGr, false)).toBeNull();
    expect(key("KeyK", "k", { altKey: true, shiftKey: true })).toBe("Alt+Shift+K");
  });
});

describe("recordShortcut on macOS", () => {
  const mac = (code: string, key: string, mods: Partial<Record<"ctrlKey" | "altKey" | "shiftKey" | "metaKey", boolean>> = {}) =>
    recordShortcut({ code, key, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods }, true);
  it("records Command as Cmd, first", () => {
    expect(mac("Space", " ", { metaKey: true, shiftKey: true })).toBe("Cmd+Shift+Space");
    expect(mac("KeyK", "k", { metaKey: true, ctrlKey: true })).toBe("Cmd+Ctrl+K");
  });
  it("allows Ctrl+Option (no AltGr) but refuses Option alone (it types @, € …)", () => {
    expect(mac("KeyK", "k", { ctrlKey: true, altKey: true })).toBe("Ctrl+Alt+K");
    expect(mac("KeyL", "@", { altKey: true })).toBeNull();
    expect(mac("KeyL", "@", { altKey: true, shiftKey: true })).toBeNull();
    expect(mac("KeyL", "l", { altKey: true, metaKey: true })).toBe("Cmd+Alt+L");
  });
});

describe("formatShortcut", () => {
  it("uses glyphs in Apple's order on macOS", () => {
    expect(formatShortcut("Cmd+Shift+Space", true)).toBe("⇧⌘ Space");
    expect(formatShortcut("Ctrl+Shift+K", true)).toBe("⌃⇧K");
    expect(formatShortcut("Super+Alt+k", true)).toBe("⌥⌘K");
    expect(formatShortcut("Meta+Ctrl+Alt+Shift+F9", true)).toBe("⌃⌥⇧⌘F9");
    expect(formatShortcut("Cmd+Enter", true)).toBe("⌘↩");
    expect(formatShortcut("F9", true)).toBe("F9");
  });
  it("keeps names elsewhere", () => {
    expect(formatShortcut("Ctrl+Shift+Space", false)).toBe("Ctrl+Shift+Space");
    expect(formatShortcut("Cmd+K", false)).toBe("Super+K");
    expect(formatShortcut("ctrl+shift+k", false, " ")).toBe("Ctrl Shift K");
  });
  it("hints: Mod is ⌘ on macOS and Ctrl elsewhere", () => {
    expect(keys("Mod Shift D", true)).toBe("⇧⌘D");
    expect(keys("Mod Shift D", false)).toBe("Ctrl Shift D");
    expect(keys("Mod \\", true)).toBe("⌘\\");
    expect(keys("Mod ,", false)).toBe("Ctrl ,");
    expect(keys("Mod Enter", true)).toBe("⌘↩");
    expect(keys("Mod Klick", true)).toBe("⌘ Klick");
    expect(keys("Ctrl Tab", true)).toBe("⌃⇥");
    expect(keys("Mod Shift \\", false)).toBe("Ctrl Shift \\");
    expect(modLabel(true)).toBe("⌘");
    expect(modLabel(false)).toBe("Ctrl");
  });
});

describe("arrow keys", () => {
  it("shows DOM arrow names as arrows on every platform", () => {
    expect(keys("Alt ArrowUp", false)).toBe("Alt ↑");
    expect(keys("Alt ArrowDown", true)).toBe("⌥↓");
    expect(formatShortcut("Ctrl+ArrowLeft", false)).toBe("Ctrl+←");
  });
});
