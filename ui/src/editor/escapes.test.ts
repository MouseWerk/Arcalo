// Text the editor writes must read back as the same document: escapes for what Markdown would
// otherwise take as syntax (backslashes, indentation, link labels, closing hashes, task boxes).

import { describe, expect, it } from "vitest";
import { Editor, type JSONContent } from "@tiptap/core";
import { buildExtensions, toMarkdown } from "./schema";
import { markerLine } from "./blocks";

const parse = (md: string) => {
  const editor = new Editor({ element: document.createElement("div"), extensions: buildExtensions(), content: md, contentType: "markdown" });
  const json = editor.getJSON();
  editor.destroy();
  return json;
};

/** Attributes that only say how a node was written (or are generated) are left out of the comparison. */
const IGNORED = new Set(["src", "gap", "id", "listType", "indent", "tight", "form"]);
const norm = (n: unknown): unknown => {
  if (Array.isArray(n)) return n.map(norm);
  if (!n || typeof n !== "object") return n;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(n)) {
    if (k !== "attrs") out[k] = norm(v);
    else {
      const attrs = Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([a, x]) => x != null && !IGNORED.has(a)));
      if (Object.keys(attrs).length) out.attrs = attrs;
    }
  }
  return out;
};

/** Writes a document built in the editor (as if typed) and reads the Markdown back. */
function rewrite(content: JSONContent[]) {
  const editor = new Editor({ element: document.createElement("div"), extensions: buildExtensions(), content: { type: "doc", content } });
  const before = norm(editor.getJSON());
  const md = toMarkdown(editor);
  editor.destroy();
  return { md, before, after: norm(parse(md)) };
}

const P = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", content });
const T = (text: string, marks?: JSONContent["marks"]): JSONContent => ({ type: "text", text, ...(marks ? { marks } : {}) });
const BR: JSONContent = { type: "hardBreak" };

describe("backslashes before punctuation", () => {
  const texts = [
    "a\\.b",
    "Regex \\d+\\.\\d+",
    "C:\\Program Files\\(x86)",
    "\\*nicht*",
    "Pfad \\\\server\\share",
    "\\_x",
    "ende\\",
    "x \\| y",
    "\\[[Seite]]",
    "\\#tag",
    "Preis 5\\$",
    "100\\%",
    "%APPDATA%\\{id}",
    "\\(\\d+\\)",
    "a\\'b\\\"c\\,d\\/e\\:f\\;g\\?h\\@i\\^j\\&k\\}",
  ];
  for (const text of texts) {
    it(JSON.stringify(text), () => {
      const r = rewrite([P(T(text))]);
      expect(r.after, JSON.stringify(r.md)).toEqual(r.before);
    });
  }
});

describe("indented plain text", () => {
  it("stays paragraphs after a plain-text paste", () => {
    const editor = new Editor({ element: document.createElement("div"), extensions: buildExtensions(), content: "Start\n", contentType: "markdown" });
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    editor.view.pasteText("Sehr geehrte Damen,\n    Max Mustermann\n\tAbteilung IT");
    const before = norm(editor.getJSON());
    const md = toMarkdown(editor);
    editor.destroy();
    expect(norm(parse(md)), JSON.stringify(md)).toEqual(before);
  });

  const cases: Record<string, JSONContent[]> = {
    tab: [P(T("\tTab"))],
    fourSpaces: [P(T("    vier"))],
    eightSpaces: [P(T("        acht"))],
    afterBreak: [P(T("a"), BR, T("    b"))],
    spacesThenTab: [P(T("  \tgemischt"))],
    spacesThenDash: [P(T("    - kein Punkt"))],
  };
  for (const [name, content] of Object.entries(cases)) {
    it(name, () => {
      const r = rewrite(content);
      expect(r.after, JSON.stringify(r.md)).toEqual(r.before);
    });
  }
});

describe("inline cases", () => {
  const cases: Record<string, JSONContent[]> = {
    brDash: [P(T("a"), BR, T("- b"))],
    brHash: [P(T("a"), BR, T("# b"))],
    brNum: [P(T("a"), BR, T("1. b"))],
    brQuote: [P(T("a"), BR, T("> b"))],
    boldStartDash: [P(T("- b", [{ type: "bold" }]))],
    codeBacktick: [P(T("a`b", [{ type: "code" }]))],
    linkWithBracket: [P(T("a]b", [{ type: "link", attrs: { href: "https://x.de/a)b" } }]))],
    linkWithBrackets: [P(T("x [y] ]z[", [{ type: "link", attrs: { href: "https://x.de" } }]))],
    headingTrailingHashes: [{ type: "heading", attrs: { level: 2 }, content: [T("C# ##")] }],
    headingTrailingHash: [{ type: "heading", attrs: { level: 1 }, content: [T("Sprache #")] }],
    headingCSharp: [{ type: "heading", attrs: { level: 2 }, content: [T("C#")] }],
    taskBracket: [{ type: "bulletList", content: [{ type: "listItem", content: [P(T("[ ] kein Task"))] }] }],
    taskBracketChecked: [{ type: "bulletList", content: [{ type: "listItem", content: [P(T("[x] auch nicht"))] }] }],
    footnoteText: [P(T("[^1]: keine Fußnote"))],
  };
  for (const [name, content] of Object.entries(cases)) {
    it(name, () => {
      const r = rewrite(content);
      expect(r.after, JSON.stringify(r.md)).toEqual(r.before);
    });
  }
});

describe("block markers only at the start of a line", () => {
  it("an escaped footnote definition stays one paragraph", () => {
    expect(norm(parse("\\[^1]: x\n"))).toEqual({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "[^1]: x" }] }] });
  });
  it("text before a footnote marker on the same line", () => {
    expect(parse("x[^1]: y\n").content?.map((n) => n.type)).toEqual(["paragraph"]);
  });
  it("text before [TOC] on the same line", () => {
    expect(parse("x[TOC]\n").content?.map((n) => n.type)).toEqual(["paragraph"]);
  });
  it("a definition on the next line still starts there", () => {
    expect(parse("Text\n[^1]: y\n").content?.map((n) => n.type)).toEqual(["paragraph", "footnoteDefinition"]);
  });
  it("markerLine as a block start skips index 0", () => {
    expect(markerLine("[TOC]", "[TOC]", false)).toBe(0);
    expect(markerLine("[TOC]\n[TOC]", "[TOC]", false, false)).toBe(6);
    expect(markerLine("  <!-- spalten -->", "<!-- spalten -->", true, false)).toBe(-1);
  });
});
