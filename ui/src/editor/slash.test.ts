import { describe, expect, it } from "vitest";
import { slashItems, wordStarts } from "./extensions";

describe("slashItems", () => {
  it("gives every command an icon for the toolbar menus", () => {
    const on = () => {};
    const items = slashItems({ onTemplate: on, onImage: on, onAi: on, onSummary: on, onDrawing: on, onFile: on });
    expect(items.filter((it) => !it.Icon).map((it) => it.id)).toEqual([]);
  });
});

describe("wordStarts", () => {
  it("matches the start of a title word, umlaut-tolerant", () => {
    expect(wordStarts("Zeichnung", "zeichn")).toBe(true);
    expect(wordStarts("Inhaltsverzeichnis", "zeichn")).toBe(false);
    expect(wordStarts("Überschrift 2", "über")).toBe(true);
    expect(wordStarts("Überschrift 2", "ueber")).toBe(true);
    expect(wordStarts("2 Spalten", "spal")).toBe(true);
  });
});
