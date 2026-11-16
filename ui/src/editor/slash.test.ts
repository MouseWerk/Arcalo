import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { slashItems, wordStarts } from "./extensions";
import { buildExtensions, toMarkdown } from "./schema";

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

// q124 R7A-6: in a list or task item the quote commands could not wrap the line; `/callout` wrote
// `[!note] ` into it and `/zitat` did nothing.
describe("quote and callout commands in a list item", () => {
  const run = (md: string, id: string) => {
    const el = document.createElement("div");
    document.body.append(el);
    const editor = new Editor({ element: el, extensions: buildExtensions(), content: md, contentType: "markdown" });
    let at = -1;
    editor.state.doc.descendants((n, pos) => {
      if (at < 0 && n.isText && n.text!.includes("zwei")) at = pos + n.text!.indexOf("zwei") + 4;
      return at < 0;
    });
    editor.commands.insertContentAt(at, "/");
    const on = () => {};
    slashItems({ onTemplate: on, onImage: on, onAi: on, onSummary: on, onDrawing: on, onFile: on }, false, false)
      .find((i) => i.id === id)!
      .run(editor, { from: at, to: at + 1 });
    editor.commands.insertContent("Neu");
    const out = toMarkdown(editor);
    editor.destroy();
    el.remove();
    return out;
  };
  it("adds the quote or callout below the item's line", () => {
    expect(run("- eins\n- zwei\n- drei\n", "callout")).toBe("- eins\n- zwei\n  > [!note] Neu\n- drei\n");
    expect(run("- [ ] eins\n- [ ] zwei\n", "warn")).toBe("- [ ] eins\n- [ ] zwei\n  > [!warning] Neu\n");
    expect(run("1. eins\n2. zwei\n", "quote")).toBe("1. eins\n2. zwei\n   > Neu\n");
  });
  it("still turns a paragraph into a quote or callout", () => {
    expect(run("eins zwei\n", "callout")).toBe("> [!note] eins zweiNeu\n");
    expect(run("eins zwei\n", "quote")).toBe("> eins zweiNeu\n");
  });
  it("makes a quote a callout and keeps a heading a heading", () => {
    expect(run("> eins zwei\n", "callout")).toBe("> [!note] eins zweiNeu\n");
    expect(run("> [!tip] eins\n> zwei\n", "warn")).toBe("> [!tip] eins\n> zweiNeu\n");
    expect(run("## eins zwei\n", "callout")).toBe("> [!note]\n>\n> ## eins zweiNeu\n");
  });
});
