// The author's Markdown survives the editor: a page opened and saved without edits stays
// byte-identical (corpus/: notes as Obsidian writes them, GitHub READMEs and guides, notes
// written in VS Code), and an edited block keeps the style it was written in.

import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { buildExtensions, setChunkedLexing, textShape, toMarkdown, withShape } from "./schema";
import { joinFrontmatter, splitFrontmatter } from "./extensions";
import { setSourceBlocks } from "./sourceStyle";
import { CHUNK_LINES } from "./chunkedLex";
import { replaceChanged } from "./replaceChanged";

const CORPUS = import.meta.glob("./corpus/*.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

function open(body: string) {
  return new Editor({ element: document.createElement("div"), extensions: buildExtensions(), content: body, contentType: "markdown" });
}

/** Opens a file like the note editor (frontmatter apart) and saves it again. */
function save(md: string, edit?: (editor: Editor) => void) {
  const { frontmatter, gap, body } = splitFrontmatter(md);
  const editor = open(body);
  edit?.(editor);
  const out = joinFrontmatter(frontmatter, gap, withShape(toMarkdown(editor), textShape(body)));
  editor.destroy();
  return out;
}

/** Saved from the document alone, as if every block had been edited. */
function rewrite(md: string) {
  setSourceBlocks(false);
  try {
    return save(md);
  } finally {
    setSourceBlocks(true);
  }
}

/** Puts `text` at the start of the first paragraph containing `needle`. */
const typeInto = (needle: string, text: string) => (editor: Editor) => {
  let at = -1;
  editor.state.doc.descendants((node, pos) => {
    if (at < 0 && node.type.name === "paragraph" && node.textContent.includes(needle)) at = pos + 1;
    return at < 0;
  });
  if (at < 0) throw new Error(`no paragraph with ${needle}`);
  editor.commands.insertContentAt(at, text);
};

afterEach(() => setChunkedLexing(CHUNK_LINES));

describe("corpus: saved without edits", () => {
  const files = Object.entries(CORPUS);
  it("has files", () => expect(files.length).toBeGreaterThanOrEqual(7));
  for (const [path, md] of files) {
    const name = path.replace("./corpus/", "");
    it(`${name} stays byte-identical`, () => {
      expect(save(md)).toBe(md);
      expect(save(save(md))).toBe(md);
    });
    it(`${name} stays byte-identical, lexed as a whole`, () => {
      setChunkedLexing(0);
      expect(save(md)).toBe(md);
    });
    it(`${name} with Windows line ends and no final line end`, () => {
      const crlf = md.replace(/\n/g, "\r\n").replace(/\r\n$/, "");
      expect(save(crlf)).toBe(crlf);
    });
  }
});

describe("corpus: one edit changes one block", () => {
  const cases: [string, string][] = [
    ["obsidian-daily.md", "Gespräch mit Jonas"],
    ["obsidian-project.md", "Ziel: alle Standorte"],
    ["github-readme.md", "A tiny, dependency-free"],
    ["github-contributing.md", "Thanks for taking"],
    ["vscode-notes.md", "Things to check"],
    ["vscode-meeting.md", "only for idempotent"],
    ["obsidian-zettel.md", "Formel für das nächste"],
  ];
  for (const [file, needle] of cases) {
    it(file, () => {
      const md = CORPUS[`./corpus/${file}`];
      const out = save(md, typeInto(needle, "NEU "));
      const before = md.split("\n");
      const after = out.split("\n");
      expect(after.length).toBe(before.length);
      const changed = after.map((l, i) => (l === before[i] ? -1 : i)).filter((i) => i >= 0);
      expect(changed).toHaveLength(1);
      expect(after[changed[0]]).toBe(`NEU ${before[changed[0]]}`);
    });
  }

  it("a reload from another pane keeps the unchanged blocks as written", () => {
    const md = CORPUS["./corpus/github-readme.md"];
    const editor = open(md);
    const next = md.replace("A tiny, dependency-free", "A small, dependency-free");
    replaceChanged(editor, next);
    expect(toMarkdown(editor)).toBe(next);
    editor.destroy();
  });

  it("undoing an edit gives back the block as written", () => {
    const md = CORPUS["./corpus/vscode-notes.md"];
    const editor = open(md);
    typeInto("Things to check", "x")(editor);
    editor.commands.undo();
    expect(toMarkdown(editor)).toBe(md);
    editor.destroy();
  });
});

describe("source style of edited blocks", () => {
  const STYLE: Record<string, string> = {
    bulletStar: "* eins\n* zwei\n  * tiefer\n",
    bulletPlus: "+ eins\n+ zwei\n",
    tabIndent: "- eins\n\t- tiefer\n\t\t- ganz tief\n",
    fourSpaces: "* eins\n    * tiefer\n",
    tasksStar: "* [ ] offen\n* [x] erledigt\n",
    tasksTab: "- [ ] Aufgabe\n\t- [ ] Teil\n\t- [x] erledigt\n",
    orderedParen: "1) eins\n2) zwei\n3) drei\n",
    orderedLazy: "1. eins\n1. zwei\n1. drei\n",
    orderedStart: "3) drei\n4) vier\n",
    looseList: "- eins\n\n- zwei\n\n- drei\n",
    tildeFence: "~~~js\nconst a = 1;\n~~~\n",
    longFence: "`````\ncode\n`````\n",
    tildeLong: "~~~~\n~~~\n~~~~\n",
    fenceInfoSpace: "``` bash\nnpm test\n```\n",
    indentedCode: "Vorher\n\n    eingerückt\n    zweite Zeile\n",
    emUnderscore: "Das ist _wichtig_ und __sehr wichtig__.\n",
    emStar: "Das ist *wichtig* und **sehr wichtig**.\n",
    emNested: "**fett mit _kursiv_ drin**\n",
    strikeSingle: "Das ~stimmt~ nicht.\n",
    setextH1: "Titel\n=====\n\nText\n",
    setextH2: "Abschnitt\n---------\n\nText\n",
    atxClosed: "## Abschnitt ##\n",
    hrStars: "Oben\n\n***\n\nUnten\n",
    hrUnderscores: "Oben\n\n___\n\nUnten\n",
    hrSpaced: "Oben\n\n* * *\n\nUnten\n",
    refFull: "Siehe [die Doku][doku].\n\n[doku]: https://example.com/doku\n",
    refCollapsed: "Siehe [Doku][].\n\n[doku]: https://example.com/doku\n",
    refShortcut: "Siehe [Doku].\n\n[Doku]: https://example.com/doku \"Titel\"\n",
    refDefsTogether: "[a] und [b]\n\n[a]: https://a.example\n[b]: https://b.example\n",
    autolinkAngle: "Mail <a@example.de> oder <https://example.com>\n",
    explicitSameText: "Datei [INSTALL.md](INSTALL.md) und [https://x.de](https://x.de)\n",
    linkedImage: "[![Status](https://example.com/badge.svg)](https://example.com/ci)\n",
    boldWikiLink: "Öffne **[[Einstellungen]]** und *[[Hilfe|die Hilfe]]*\n",
    backslashBreak: "Zeile eins\\\nZeile zwei\n",
    compactTable: "| A | B |\n|---|---|\n| 1 | 2 |\n",
    pipelessTable: "A | B\n--- | ---\n1 | 2\n",
  };
  for (const [name, md] of Object.entries(STYLE)) {
    it(name, () => {
      expect(rewrite(md)).toBe(md);
      expect(save(md)).toBe(md);
    });
  }

  it("an edited list keeps its markers, an edited fence its fence", () => {
    expect(save("* eins\n* zwei\n", typeInto("zwei", "neu "))).toBe("* eins\n* neu zwei\n");
    expect(save("1) a\n2) b\n", typeInto("b", "c"))).toBe("1) a\n2) cb\n");
    expect(save("- [ ] a\n\t- [ ] b\n", typeInto("b", "c"))).toBe("- [ ] a\n\t- [ ] cb\n");
    expect(save("Text _kursiv_ hier\n", typeInto("hier", "Neu: "))).toBe("Neu: Text _kursiv_ hier\n");
  });

  it("an underscore that would touch a word becomes a star (no emphasis there)", () => {
    const editor = open("_kursiv_ hier\n");
    editor.view.dispatch(editor.state.tr.insert(1, editor.schema.text("a")));
    // `a_kursiv_` would not be emphasis: written with stars.
    expect(toMarkdown(editor)).toBe("a*kursiv* hier\n");
    editor.destroy();
  });

  it("new content uses the default style", () => {
    const editor = open("* alt\n");
    editor.commands.insertContentAt(editor.state.doc.content.size, [
      { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "neu", marks: [{ type: "italic" }] }] }] }] },
      { type: "codeBlock", content: [{ type: "text", text: "x" }] },
      { type: "horizontalRule" },
    ]);
    expect(toMarkdown(editor)).toBe("* alt\n\n- *neu*\n\n```\nx\n```\n\n---\n");
    editor.destroy();
  });

  it("a reference link whose target was changed is written inline", () => {
    const editor = open("Siehe [Doku][d].\n\n[d]: https://example.com/alt\n");
    editor.commands.setTextSelection({ from: 7, to: 11 });
    editor.commands.extendMarkRange("link");
    editor.commands.updateAttributes("link", { href: "https://example.com/neu" });
    expect(toMarkdown(editor)).toBe("Siehe [Doku](https://example.com/neu).\n\n[d]: https://example.com/alt\n");
    editor.destroy();
  });

  it("deleting a definition writes the links that used it inline", () => {
    const editor = open("Siehe [Doku][d].\n\n[d]: https://example.com/doku\n");
    const last = editor.state.doc.lastChild!;
    editor.commands.deleteRange({ from: editor.state.doc.content.size - last.nodeSize, to: editor.state.doc.content.size });
    expect(toMarkdown(editor)).toBe("Siehe [Doku](https://example.com/doku).\n");
    editor.destroy();
  });

  it("blank lines between blocks stay as written while the blocks around them do", () => {
    const md = "# Titel\nText direkt darunter\n\n\n\nNach drei Leerzeilen\n";
    expect(save(md)).toBe(md);
    // Editing the block after the gap keeps the extra blank lines (never fewer than one).
    expect(save(md, typeInto("Nach drei", "x"))).toBe("# Titel\nText direkt darunter\n\n\n\nxNach drei Leerzeilen\n");
    // Editing the text under the heading: it is written apart from the heading.
    expect(save(md, typeInto("Text direkt", "x"))).toBe("# Titel\n\nxText direkt darunter\n\n\n\nNach drei Leerzeilen\n");
  });
});

describe("escaping", () => {
  it("escapes whole runs of stars and underscores that could be emphasis", () => {
    for (const md of ["\\*\\*nicht fett\\*\\*\n", "\\**kursiv mit Sternen*\\*\n", "\\_\\_x\\_\\_ und a_b_c\n"]) {
      expect(rewrite(md)).toBe(md);
      expect(rewrite(rewrite(md))).toBe(md);
    }
  });
});
