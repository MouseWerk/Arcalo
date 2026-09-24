// Columns, table of contents, footnotes and foldable callouts: parsing, commands, display.

import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { buildExtensions, toMarkdown } from "./schema";
import { footnoteNumbers, headingsOf, insertColumns, insertFootnote, matchDefinition, nextFootnoteLabel, splitColumns, tocTree } from "./blocks";
import { insertFoldable, toggleCalloutFold } from "./extensions";

const editorFor = (md: string) => new Editor({ element: document.createElement("div"), extensions: buildExtensions(), content: md, contentType: "markdown" });
const types = (editor: Editor) => {
  const out: string[] = [];
  editor.state.doc.descendants((n) => void out.push(n.type.name));
  return out;
};

describe("columns", () => {
  it("splits at markers, keeps nested blocks and code fences together", () => {
    const src = "<!-- spalten -->\n\nA\n\n<!-- spalte -->\n\n```\n<!-- /spalten -->\n```\n\n<!-- /spalten -->\nRest";
    const s = splitColumns(src)!;
    expect(s.parts).toEqual(["A", "```\n<!-- /spalten -->\n```"]);
    expect(src.slice(s.raw.length)).toBe("Rest");
    expect(splitColumns("<!-- spalten -->\nohne Ende\n")).toBeNull();
  });
  it("parses into a columns node with one column per part", () => {
    const editor = editorFor("<!-- spalten -->\n\nA\n\n<!-- spalte -->\n\nB\n\n<!-- spalte -->\n\n<!-- /spalten -->\n");
    const cols = editor.state.doc.firstChild!;
    expect(cols.type.name).toBe("columns");
    expect(cols.childCount).toBe(3);
    expect(cols.child(2).firstChild!.type.name).toBe("paragraph");
    editor.destroy();
  });
  it("inserts two columns with the caret in the first", () => {
    const editor = editorFor("Oben\n\n");
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    insertColumns(editor, 2);
    editor.commands.insertContent("Links");
    expect(toMarkdown(editor)).toBe("Oben\n\n<!-- spalten -->\n\nLinks\n\n<!-- spalte -->\n\n<!-- /spalten -->\n");
    editor.destroy();
  });
  it("degrades to plain Markdown elsewhere (markers are HTML comments on their own lines)", () => {
    const editor = editorFor("<!-- spalten -->\n\nA\n\n<!-- spalte -->\n\nB\n\n<!-- /spalten -->\n");
    for (const line of toMarkdown(editor).split("\n").filter((l) => l.startsWith("<"))) expect(line).toMatch(/^<!-- \/?spalten? -->$/);
    editor.destroy();
  });
});

describe("table of contents", () => {
  it("parses [TOC] as a block and nests the headings", () => {
    const editor = editorFor("[TOC]\n\n# A\n\n## A1\n\n#### tief\n\n## A2\n\n# B\n");
    expect(types(editor)[0]).toBe("tableOfContents");
    const tree = tocTree(headingsOf(editor.state.doc));
    expect(tree.map((t) => t.entry.text)).toEqual(["A", "B"]);
    expect(tree[0].children.map((t) => t.entry.text)).toEqual(["A1", "A2"]);
    expect(tree[0].children[0].children.map((t) => t.entry.text)).toEqual(["tief"]);
    editor.destroy();
  });
  it("renders the headings live and updates while typing", () => {
    const editor = editorFor("[TOC]\n\n## Eins\n");
    const toc = () => [...editor.view.dom.querySelectorAll(".toc-link")].map((b) => b.textContent);
    expect(toc()).toEqual(["Eins"]);
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    editor.commands.insertContent("s und zwei");
    expect(toc()).toEqual(["Einss und zwei"]);
    editor.destroy();
  });
  it("does not take [TOC] inside a paragraph", () => {
    const editor = editorFor("Siehe [TOC] hier\n");
    expect(types(editor)).not.toContain("tableOfContents");
    editor.destroy();
  });
});

describe("footnotes", () => {
  it("reads definitions with continuation lines", () => {
    expect(matchDefinition("[^1]: a\n    b\nc")).toEqual({ raw: "[^1]: a\n    b\n", label: "1", text: "a\nb" });
    expect(matchDefinition("[^x]:\n")).toEqual({ raw: "[^x]:\n", label: "x", text: "" });
    expect(matchDefinition("[^1] kein")).toBeNull();
  });
  it("numbers references in order, then unused definitions", () => {
    const editor = editorFor("B[^b] A[^a] B[^b]\n\n[^a]: a\n[^b]: b\n[^c]: c\n");
    expect([...footnoteNumbers(editor.state.doc)]).toEqual([["b", 1], ["a", 2], ["c", 3]]);
    expect(nextFootnoteLabel(editor.state.doc)).toBe("1");
    const refs = [...editor.view.dom.querySelectorAll<HTMLElement>(".footnote-ref")].map((r) => r.dataset.num);
    expect(refs).toEqual(["1", "2", "1"]);
    expect(editor.view.dom.querySelectorAll(".footnotes-head").length).toBe(1);
    expect(editor.view.dom.querySelectorAll(".footnote-back").length).toBe(2);
    editor.destroy();
  });
  it("/Fußnote inserts a reference and its definition, caret in the definition", () => {
    const editor = editorFor("Text[^1]\n\n[^1]: Eins\n");
    editor.commands.setTextSelection(6);
    insertFootnote(editor);
    editor.commands.insertContent("Zwei");
    expect(toMarkdown(editor)).toBe("Text[^1][^2]\n\n[^1]: Eins\n[^2]: Zwei\n");
    editor.destroy();
  });
  it("keeps a footnote behind a bare URL separate", () => {
    const editor = editorFor("Doku\n\n[^1]: Quelle\n");
    editor.commands.setContent([{ type: "paragraph", content: [{ type: "text", text: "https://example.com", marks: [{ type: "link", attrs: { href: "https://example.com" } }] }, { type: "footnoteRef", attrs: { label: "1" } }] }, { type: "footnoteDefinition", attrs: { label: "1" }, content: [{ type: "text", text: "Quelle" }] }]);
    const md = toMarkdown(editor);
    expect(md).toBe("[https://example.com](https://example.com)[^1]\n\n[^1]: Quelle\n");
    const again = editorFor(md);
    expect(toMarkdown(again)).toBe(md);
    again.destroy();
    editor.destroy();
  });
  it("Enter in a definition leaves it", () => {
    const editor = editorFor("A[^1]\n\n[^1]: Eins\n");
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    editor.view.someProp("handleKeyDown", (f) => f(editor.view, new KeyboardEvent("keydown", { key: "Enter" })));
    editor.commands.insertContent("Weiter");
    expect(toMarkdown(editor)).toBe("A[^1]\n\n[^1]: Eins\n\nWeiter\n");
    editor.destroy();
  });
});

describe("foldable callouts", () => {
  it("hides the content of a collapsed callout and toggles the marker", () => {
    const editor = editorFor("> [!note]- Details\n> Versteckt\n>\n> Mehr\n");
    const quote = () => editor.view.dom.querySelector("blockquote")!;
    expect(quote().classList.contains("is-folded")).toBe(true);
    expect(editor.view.dom.querySelectorAll(".callout-folded-rest").length).toBe(2);
    expect(editor.view.dom.querySelector(".callout-fold")).not.toBeNull();
    toggleCalloutFold(editor.view, 0);
    expect(toMarkdown(editor)).toBe("> [!note]+ Details\n> Versteckt\n>\n> Mehr\n");
    expect(quote().classList.contains("is-folded")).toBe(false);
    toggleCalloutFold(editor.view, 0);
    expect(toMarkdown(editor)).toBe("> [!note]- Details\n> Versteckt\n>\n> Mehr\n");
    editor.destroy();
  });
  it("plain callouts are not foldable", () => {
    const editor = editorFor("> [!note] Hinweis\n> Text\n");
    expect(toggleCalloutFold(editor.view, 0)).toBe(false);
    expect(editor.view.dom.querySelector(".callout-fold")).toBeNull();
    editor.destroy();
  });
  it("/Aufklappbar inserts an expanded callout with the title selected", () => {
    const editor = editorFor("Oben\n\n/auf\n");
    const end = editor.state.doc.content.size - 1;
    editor.commands.setTextSelection(end);
    insertFoldable(editor, { from: end - 4, to: end });
    editor.commands.insertContent("Mein Titel");
    expect(toMarkdown(editor)).toBe("Oben\n\n> [!note]+ Mein Titel\n");
    editor.destroy();
  });
});
