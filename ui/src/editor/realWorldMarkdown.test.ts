// q124 round 6, hunt A (docs/quality/q124/r6-editor-import-export.md): everyday text that the
// Markdown reading took for syntax, and constructs of Obsidian, Typora and GitHub notes that an
// edit wrote back changed.

import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { buildExtensions, flankedSpan, toMarkdown } from "./schema";
import { setSourceBlocks } from "./sourceStyle";

function open(md: string) {
  return new Editor({ element: document.createElement("div"), extensions: buildExtensions(), content: md, contentType: "markdown" });
}

/** Types `x` before `needle` and saves, as an edit in the note editor does. */
function editAt(md: string, needle: string): string {
  const editor = open(md);
  let at = -1;
  editor.state.doc.descendants((node, pos) => {
    if (at < 0 && node.isText && node.text!.includes(needle)) at = pos + node.text!.indexOf(needle);
    return at < 0;
  });
  expect(at, `no text ${needle}`).toBeGreaterThan(0);
  editor.commands.insertContentAt(at, "x");
  const out = toMarkdown(editor);
  editor.destroy();
  return out;
}

/** The note's text as the editor shows it. */
function shown(md: string): string {
  const editor = open(md);
  const text = editor.state.doc.textBetween(0, editor.state.doc.content.size, "\n");
  editor.destroy();
  return text;
}

/** Marks in the document by name. */
function marks(md: string): string[] {
  const editor = open(md);
  const out: string[] = [];
  editor.state.doc.descendants((node) => {
    for (const m of node.marks) out.push(`${m.type.name}:${node.text}`);
  });
  editor.destroy();
  return out;
}

describe("== and ++ need flanking delimiters (R6A-1)", () => {
  it("operators in text stay text", () => {
    for (const md of ["C++ und C++ sind Sprachen", "C++-Code und C++-Projekte", "Wenn a == b und c == d gilt", "i++ und j++ zählen"]) {
      expect(marks(md), md).toEqual([]);
      expect(shown(md)).toBe(md);
    }
  });
  it("highlight and underline still read and write", () => {
    expect(marks("==gelb== und ++unter++ und Wort==teil== und x==1 und y==2")).toEqual(["highlight:gelb", "underline:unter", "highlight:teil", "highlight:1 und y"]);
  });
  it("an edit writes the operators back as they were (the blanks next to them were lost)", () => {
    expect(editAt("C++ und C++ sind Sprachen\n", "sind")).toBe("C++ und C++ xsind Sprachen\n");
    expect(editAt("Wenn a == b und c == d gilt\n", "gilt")).toBe("Wenn a == b und c == d xgilt\n");
  });
  it("typed text that would open a span is escaped, other text is not", () => {
    const editor = open("\n");
    editor.commands.insertContent("==nicht markiert== und a == b und C++");
    expect(toMarkdown(editor)).toBe("\\=\\=nicht markiert== und a == b und C++\n");
    editor.destroy();
  });
  it("the rules", () => {
    expect(flankedSpan("==a==", "==", "")).toEqual({ raw: "==a==", text: "a" });
    expect(flankedSpan("== a ==", "==", "")).toBeNull();
    expect(flankedSpan("==a ==", "==", "")).toBeNull();
    expect(flankedSpan("++-x++", "++", "C")).toBeNull();
    expect(flankedSpan("+++a+++", "++", "")).toBeNull();
  });
});

describe("a paragraph starting with an abbreviation is no list (R6A-2)", () => {
  it("stays text, also after an edit", () => {
    for (const md of ["ca. 5 bis 10 Minuten", "Fr. Müller kommt", "Mo. Termin mit Anna", "z. B. so", "i. A. Meier", "Dr. Schmidt"]) {
      expect(shown(md), md).toBe(md);
    }
    expect(editAt("ca. 5 bis 10 Minuten\n", "Minuten")).toBe("ca. 5 bis 10 xMinuten\n");
    expect(editAt("Fr. Müller kommt\n", "kommt")).toBe("Fr. Müller xkommt\n");
  });
  it("lists with letters or roman numerals of two or more items from the first stay lists", () => {
    expect(editAt("a. eins\nb. zwei\n", "zwei")).toBe("1. eins\n2. xzwei\n");
    expect(editAt("i. eins\nii. zwei\n", "zwei")).toBe("1. eins\n2. xzwei\n");
    expect(editAt("1. x\n   a. sub\n   b. sub2\n", "sub2")).toBe("1. x\n   1. sub\n   2. xsub2\n");
  });
});

describe("numbered items with a box keep it (R6A-3)", () => {
  it("an edit of the list keeps the boxes and their state", () => {
    expect(editAt("1. [ ] a\n2. [x] b\n", "b")).toBe("1. [ ] a\n2. [x] xb\n");
    expect(editAt("1. [ ] a\n2. [x] b\n   1. [ ] c\n", "b")).toBe("1. [ ] a\n2. [x] xb\n   1. [ ] c\n");
    expect(editAt("Text\n\n1. [ ] a\n\n2. [X] b\n", "b")).toBe("Text\n\n1. [ ] a\n\n2. [X] xb\n");
  });
  it("bullet tasks stay tasks", () => {
    expect(editAt("- [ ] a\n- [x] b\n", "b")).toBe("- [ ] a\n- [x] xb\n");
  });
});

describe("a backslash at the end of a line stays (R6A-4)", () => {
  it("LaTeX line ends in display math", () => {
    const md = "$$\n\\begin{aligned}\na &= b \\\\\nc &= d\n\\end{aligned}\n$$\n";
    expect(editAt(md, "c &")).toBe(md.replace("c &", "xc &"));
  });
  it("written from the document alone too", () => {
    setSourceBlocks(false);
    try {
      const editor = open("Pfad C:\\\\Temp\\\\\nweiter\n");
      // A backslash before a letter needs no escape; the one before the line end does.
      expect(toMarkdown(editor)).toBe("Pfad C:\\Temp\\\\\nweiter\n");
      editor.destroy();
    } finally {
      setSourceBlocks(true);
    }
  });
});

it("a numbered list starting at 0 keeps its numbers", () => {
  expect(editAt("0. null\n1. eins\n", "eins")).toBe("0. null\n1. xeins\n");
});
