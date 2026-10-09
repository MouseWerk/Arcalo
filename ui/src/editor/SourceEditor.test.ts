import { describe, expect, it } from "vitest";
import { continuation, mapCaret, sourceOutline } from "./SourceEditor";
import { saveDelay } from "./saves";
import { useApp } from "../store/app";
import type { SettingsView } from "../lib/types";

describe("continuation", () => {
  it("continues bullets, numbers and tasks with the same indent", () => {
    expect(continuation("- Apfel")).toEqual({ prefix: "- ", empty: false });
    expect(continuation("  * Birne")).toEqual({ prefix: "  * ", empty: false });
    expect(continuation("9. Neun")).toEqual({ prefix: "10. ", empty: false });
    expect(continuation("- [x] erledigt")).toEqual({ prefix: "- [ ] ", empty: false });
  });
  it("marks an empty item (Enter there ends the list) and ignores other lines", () => {
    expect(continuation("- ")).toEqual({ prefix: "- ", empty: true });
    expect(continuation("- [ ] ")).toEqual({ prefix: "- [ ] ", empty: true });
    expect(continuation("Text")).toBeNull();
    expect(continuation("-kein Punkt")).toBeNull();
  });
});

describe("mapCaret (text from another pane)", () => {
  it("keeps the caret on its text when text is added before or after it", () => {
    expect(mapCaret("eins\nzwei", "neu\neins\nzwei", 7)).toBe(11);
    expect(mapCaret("eins\nzwei", "eins\nzwei\ndrei", 3)).toBe(3);
    expect(mapCaret("eins\nzwei", "eins\nzwei", 6)).toBe(6);
  });
  it("puts a caret inside the changed part behind the new text", () => {
    expect(mapCaret("a XX b", "a YYYY b", 3)).toBe(6);
  });
});

describe("sourceOutline", () => {
  it("lists the headings of the source with their offset, not those in code or the properties", () => {
    const text = "---\ntitle: # nein\n---\n# Gamma\nText\n```\n# kein Titel\n```\n## Delta ##\n";
    expect(sourceOutline(text)).toEqual([
      { level: 1, text: "Gamma", pos: text.indexOf("# Gamma") },
      { level: 2, text: "Delta", pos: text.indexOf("## Delta") },
    ]);
    expect(sourceOutline("#Kein Titel\nText")).toEqual([]);
  });
});

describe("saveDelay", () => {
  it("is the autosave delay of Settings → Editor (both editors use it), within 250–3000 ms", () => {
    const view = (autosave_ms: number) => ({ settings: { editor: { autosave_ms } } }) as unknown as SettingsView;
    useApp.setState({ settings: view(1200) });
    expect(saveDelay()).toBe(1200);
    useApp.setState({ settings: view(10) });
    expect(saveDelay()).toBe(250);
    useApp.setState({ settings: null });
    expect(saveDelay()).toBe(450);
  });
});
