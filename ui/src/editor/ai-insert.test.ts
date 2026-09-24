import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { buildExtensions, toMarkdown } from "./schema";
import { aiRange, appendMarkdown, insertMarkdownBelow, rangeMarkdown, replaceWithMarkdown } from "./ai-insert";

let editor: Editor | null = null;
afterEach(() => {
  editor?.destroy();
  editor = null;
});

function make(md: string) {
  editor = new Editor({ element: document.createElement("div"), extensions: buildExtensions(), content: md, contentType: "markdown" });
  return editor;
}

/** Selects the first occurrence of `text` in the document. */
function select(e: Editor, text: string) {
  let found: { from: number; to: number } | null = null;
  e.state.doc.descendants((node, pos) => {
    if (found || !node.isText) return !found;
    const i = node.text!.indexOf(text);
    if (i >= 0) found = { from: pos + i, to: pos + i + text.length };
    return false;
  });
  if (!found) throw new Error(`${text} not found`);
  e.commands.setTextSelection(found);
  return found as { from: number; to: number };
}

const undo = (e: Editor) => e.commands.undo();

describe("aiRange / rangeMarkdown", () => {
  it("uses the selection, keeping formatting and links as Markdown", () => {
    const e = make("Erster **fetter** Satz mit [[Architektur]] und [Link](https://example.com).\n\nZweiter Absatz.\n");
    e.commands.setTextSelection({ from: 1, to: e.state.doc.child(0).nodeSize - 1 });
    const r = aiRange(e)!;
    expect(rangeMarkdown(e, r)).toBe("Erster **fetter** Satz mit [[Architektur]] und [Link](https://example.com).");
  });

  it("takes the current block when nothing is selected", () => {
    const e = make("Eins.\n\nZwei ist hier.\n\nDrei.\n");
    select(e, "ist");
    e.commands.setTextSelection(e.state.selection.from);
    const r = aiRange(e)!;
    expect(rangeMarkdown(e, r)).toBe("Zwei ist hier.");
  });

  it("serializes lists across blocks", () => {
    const e = make("- eins\n- zwei\n\nDanach.\n");
    e.commands.setTextSelection({ from: 0, to: e.state.doc.child(0).nodeSize });
    expect(rangeMarkdown(e, aiRange(e)!)).toBe("- eins\n- zwei");
  });
});

describe("replaceWithMarkdown", () => {
  it("replaces inline inside a paragraph without splitting it", () => {
    const e = make("Vorher ein sehr langer Text nachher.\n");
    const r = select(e, "ein sehr langer Text");
    replaceWithMarkdown(e, r, "**kurz** mit [[Seite]]");
    expect(toMarkdown(e)).toBe("Vorher **kurz** mit [[Seite]] nachher.\n");
  });

  it("replaces a whole block with blocks (list, table)", () => {
    const e = make("Oben.\n\nA, B und C.\n\nUnten.\n");
    select(e, "B und");
    e.commands.setTextSelection(e.state.selection.from);
    replaceWithMarkdown(e, aiRange(e)!, "- A\n- B\n- C");
    expect(toMarkdown(e)).toBe("Oben.\n\n- A\n- B\n- C\n\nUnten.\n");

    const e2 = make("Oben.\n\nZeile.\n");
    const r2 = select(e2, "Zeile.");
    replaceWithMarkdown(e2, r2, "| A | B |\n| --- | --- |\n| 1 | 2 |");
    expect(toMarkdown(e2)).toMatch(/^Oben\.\n\n\| A +\| B +\|\n/);
    expect(toMarkdown(e2)).not.toMatch(/Zeile/);
  });

  it("is a single undo step", () => {
    const e = make("Alpha Beta Gamma.\n\nZweiter.\n");
    const before = toMarkdown(e);
    e.commands.setTextSelection({ from: 0, to: e.state.doc.content.size });
    replaceWithMarkdown(e, aiRange(e)!, "## Neu\n\n- a\n- b\n\nText mit *kursiv*.");
    expect(toMarkdown(e)).toBe("## Neu\n\n- a\n- b\n\nText mit *kursiv*.\n");
    undo(e);
    expect(toMarkdown(e)).toBe(before);
  });
});

describe("insertMarkdownBelow / appendMarkdown", () => {
  it("inserts after the top-level block of the selection", () => {
    const e = make("- eins\n- zwei\n\nEnde.\n");
    const r = select(e, "eins");
    insertMarkdownBelow(e, r, "**Neu** darunter");
    expect(toMarkdown(e)).toBe("- eins\n- zwei\n\n**Neu** darunter\n\nEnde.\n");
    undo(e);
    expect(toMarkdown(e)).toBe("- eins\n- zwei\n\nEnde.\n");
  });

  it("appends a summary with headings and tasks at the end", () => {
    const e = make("Notizen.\n");
    appendMarkdown(e, "## Zusammenfassung\n\nKurz.\n\n## Aufgaben\n\n- [ ] Angebot senden @Max due:2026-09-30 !!");
    expect(toMarkdown(e)).toBe("Notizen.\n\n## Zusammenfassung\n\nKurz.\n\n## Aufgaben\n\n- [ ] Angebot senden @Max due:2026-09-30 !!\n");
  });
});
