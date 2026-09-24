// Long notes are lexed in pieces: the result must be exactly that of the whole note.

import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { buildExtensions, setChunkedLexing, tableStart, toMarkdown } from "./schema";
import { CHUNK_LINES, chunkCuts } from "./chunkedLex";
import { markerLine } from "./blocks";

// Every construct of the editor, and those that run across blank lines.
const CORPUS: string[] = [
  "# Überschrift\n\nErster Absatz mit **fett**, *kursiv*, ~~durch~~, ==markiert== und `code`.",
  "Setext\n===\n\nNoch einer\n---",
  "Siehe [[Architektur]], [[Jour fixe|den Jour fixe]] und #projekt/phase-2 sowie \\#kein-tag.",
  "- eins\n- zwei\n\n  Fortsetzung nach Leerzeile\n\n  - verschachtelt\n\n    tiefer\n- drei",
  "1. eins\n\n2. zwei\n\n   mit Absatz\n3. drei\n\na. Buchstabe\nb. zweiter\n\niv. römisch",
  "- [ ] offen\n- [x] erledigt\n  - [ ] Unteraufgabe\n\n- [ ] nach Leerzeile\n- [ ]",
  "```ts\nconst a = 1;\n\n\nconst b = 2;\n\n# kein Titel\n```",
  "~~~\nTilde\n\n```\ninnen\n```\n\n~~~",
  "````md\n```\nverschachtelt\n\n```\n````",
  "    eingerückter Code\n\n    nach Leerzeile\n\nText danach",
  "| A | B |\n| --- | :-: |\n| 1 | `a|b` |\n| [[S\\|x]] | 2 |\n\n| C |\n|---|\n| 3 |",
  "> Zitat\n> zweite Zeile\n\n> anderes Zitat",
  "> [!note] Hinweis\n> Text\n>\n> - Liste im Callout\n\n> [!warning]- Einklappbar\n> versteckt\n\n> [!tip]+ Offen\n> sichtbar",
  "<!-- spalten -->\n\nLinks\n\nmit zwei Absätzen\n\n<!-- spalte -->\n\n```\ncode\n\n<!-- /spalten -->\n```\n\n<!-- spalten -->\n\ninnen\n\n<!-- spalte -->\n\nrechts innen\n\n<!-- /spalten -->\n\n<!-- /spalten -->",
  "Text mit Fußnote[^1] und noch einer[^lang].\n\n[^1]: Erste\n[^lang]: Lange Fußnote\n    mit Fortsetzung\n\n[^3]: Nach Leerzeile",
  "[TOC]\n\nText\n\n[TOC]  ",
  "<details>\n<summary>Mehr</summary>\n\nInhalt\n\n</details>",
  "<!--\nKommentar\n\nüber Leerzeilen\n-->\n\nText",
  "<pre>\nvor\n\nformatiert\n</pre>\n\n<script>\nlet a = 1;\n\nlet b = 2;\n</script>",
  "<div class=\"x\">\nBlock\n</div>\n\nInline <kbd>Strg</kbd> und <span>a</span> und a<b und c>d",
  "Referenz [Link][ref] und [ref] und ![Bild][img].\n\n[ref]: https://example.com \"Titel\"\n[img]: bild.png",
  "![[bild.png|300]] ![[Plan.excalidraw]] ![[datei.pdf#page=3]] ![[notiz.txt]]",
  'Gebucht: <time-entry id="12" hours="2,50" target="NP-8801/1020">Systemintegration</time-entry>',
  "Web: [Anthropic](https://www.anthropic.com) und https://example.com/a_b und max@example.de",
  "---\n\n***\n\n___",
  "Zeile mit Umbruch  \nzweite<br>dritte\\\nvierte",
  "Absatz direkt\n# gefolgt von Titel\n- und Liste\n> und Zitat",
  "   \n\t\n\nLeerzeilen mit Leerzeichen\n \nweiter",
  " \nNBSP-Zeile\n \n\nText",
  "Ende ohne Zeilenumbruch",
];

function editor() {
  return new Editor({ element: document.createElement("div"), extensions: buildExtensions(), content: "" });
}

/** JSON of `md` as the editor parses it, lexed whole (0) or in pieces of `lines` lines. */
function parse(ed: Editor, md: string, lines: number) {
  setChunkedLexing(lines);
  try {
    return (ed as unknown as { markdown: { parse: (md: string) => unknown } }).markdown.parse(md);
  } finally {
    setChunkedLexing(CHUNK_LINES);
  }
}

/** A seeded random generator, so failures reproduce. */
function rng(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}

afterEach(() => setChunkedLexing(CHUNK_LINES));

describe("chunked lexing", () => {
  it("parses every corpus note like the whole note", () => {
    const ed = editor();
    for (const md of CORPUS) for (const lines of [1, 2, 3]) expect(parse(ed, md, lines), `${lines}: ${md}`).toEqual(parse(ed, md, 0));
    ed.destroy();
  });

  it("parses the whole corpus in one note, cut wherever possible, like the whole note", () => {
    const ed = editor();
    const all = CORPUS.join("\n\n");
    expect(chunkCuts(all, 1).length).toBeGreaterThan(20);
    expect(parse(ed, all, 1)).toEqual(parse(ed, all, 0));
    expect(parse(ed, all, CHUNK_LINES)).toEqual(parse(ed, all, 0));
    ed.destroy();
  });

  it("parses random mixes of the corpus like the whole note", () => {
    const ed = editor();
    const rand = rng(42);
    const seps = ["\n\n", "\n", "\n\n\n", "\n\n  ", "\n\n    "];
    for (let n = 0; n < 150; n++) {
      const parts: string[] = [];
      const count = 2 + Math.floor(rand() * 7);
      for (let i = 0; i < count; i++) parts.push(CORPUS[Math.floor(rand() * CORPUS.length)] + seps[Math.floor(rand() * seps.length)]);
      const md = parts.join("");
      expect(parse(ed, md, 1), md).toEqual(parse(ed, md, 0));
    }
    ed.destroy();
  });

  it("parses random lines of every kind like the whole note", () => {
    const ed = editor();
    const rand = rng(1234);
    const pool = ["", "", "", "Text", "Mehr Text", "  eingerückt", "    Code", "\tTab", "- Punkt", "  - tiefer", "1. Nummer", "a) Buchstabe", "- [ ] Aufgabe", "> Zitat", "> [!note] Callout", ">", "```", "```js", "  ```", "~~~", "````", "``` x `", "<!--", "-->", "<!-- Kommentar -->", "<pre>", "</pre>", "<div>", "</div>", "<!-- spalten -->", "<!-- spalte -->", "<!-- /spalten -->", "[^1]: Fußnote", "    Fortsetzung", "[TOC]", "| a | b |", "| --- | --- |", "---", "===", "[ref]: https://x.de", "[x][ref] und [[Wiki]]", "# Titel", "<?php", "?>", "<![CDATA[", "]]>"];
    for (let n = 0; n < 400; n++) {
      const md = Array.from({ length: 5 + Math.floor(rand() * 40) }, () => pool[Math.floor(rand() * pool.length)]).join("\n");
      expect(parse(ed, md, 1), JSON.stringify(md)).toEqual(parse(ed, md, 0));
    }
    ed.destroy();
  });

  it("keeps a code fence that is cut short together (an open fence runs to its end)", () => {
    const ed = editor();
    // The list item's fence ends with the item, the bare fence after it runs on over the blank lines.
    const md = "- item\n\n  ```\n  code\n\nplain\n```\nstuff\n\nmore\n\n# Titel\n\n```\nnie geschlossen\n\nText";
    expect(parse(ed, md, 1)).toEqual(parse(ed, md, 0));
    // Closing fences as marked reads them: a tab behind the backticks does not close.
    const tab = "```\na\n```\t\n\nb\n\n```\n\nc";
    expect(parse(ed, tab, 1)).toEqual(parse(ed, tab, 0));
    ed.destroy();
  });

  it("round-trips a long note unchanged", () => {
    const ed = editor();
    const body = Array.from({ length: 60 }, (_, i) => `## Abschnitt ${i}\n\nAbsatz ${i} mit [[Seite ${i}]] und #tag${i}.\n\n- a\n- b\n\n| A | B |\n| --- | --- |\n| ${i} | x |`).join("\n\n") + "\n";
    ed.commands.setContent(body, { contentType: "markdown" });
    const chunked = toMarkdown(ed);
    setChunkedLexing(0);
    ed.commands.setContent(body, { contentType: "markdown" });
    expect(chunked).toBe(toMarkdown(ed));
    ed.destroy();
  });

  it("cuts only at plain lines after a blank line, outside fences, HTML and columns", () => {
    const md = ["a", "", "- b", "", "  c", "", "```", "", "x", "```", "", "<!--", "", "y", "-->", "", "<!-- spalten -->", "", "z", "", "<!-- /spalten -->", "", "[^1]: f", "", "ok"].join("\n");
    const cuts = chunkCuts(md, 1).map((at) => md.slice(at, md.indexOf("\n", at) < 0 ? undefined : md.indexOf("\n", at)));
    expect(cuts).toEqual(["```", "<!--", "<!-- spalten -->", "ok"]);
    // Frontmatter is never cut.
    expect(chunkCuts("---\na: 1\n\nb: 2\n---\n\nText", 1)).toEqual([20]);
  });

  it("lexes long notes in linear time", () => {
    const ed = editor();
    const note = (n: number) => Array.from({ length: n }, (_, i) => `Absatz ${i} mit etwas Text und einem [[Link ${i}]].`).join("\n\n");
    const time = (md: string) => {
      const t = performance.now();
      parse(ed, md, CHUNK_LINES);
      return performance.now() - t;
    };
    time(note(200));
    const small = time(note(400));
    const large = time(note(1600));
    // Quadratic lexing would take 16 times as long for four times the text.
    expect(large).toBeLessThan(small * 10 + 50);
    ed.destroy();
  });
});

describe("block start() without regexes over the rest", () => {
  const rand = rng(7);
  const pieces = ["<!-- spalten -->", "[TOC]", "[^1]:", "[^a b]:", "[^x]", " ", "\t", "\n", "\r", " ", "x", "|", "-", ":", "| --- |", "a | b"];
  const sample = () => Array.from({ length: 1 + Math.floor(rand() * 12) }, () => pieces[Math.floor(rand() * pieces.length)]).join("");

  it("finds the columns and TOC markers where the regexes did", () => {
    for (let n = 0; n < 3000; n++) {
      const s = sample();
      expect(markerLine(s, "<!-- spalten -->", true), JSON.stringify(s)).toBe(/^[ \t]*<!-- spalten -->[ \t]*$/m.exec(s)?.index ?? -1);
      expect(markerLine(s, "[TOC]", false), JSON.stringify(s)).toBe(/^\[TOC\][ \t]*$/m.exec(s)?.index ?? -1);
    }
  });

  it("finds footnote definitions where the regex did", () => {
    const ed = editor();
    const ext = ed.extensionManager.extensions.find((e) => e.name === "footnoteDefinition")!;
    const start = (ext.config as { markdownTokenizer: { start: (s: string) => number } }).markdownTokenizer.start;
    for (let n = 0; n < 3000; n++) {
      const s = sample();
      expect(start(s), JSON.stringify(s)).toBe(/^\[\^[^\]\s^]+\]:/m.exec(s)?.index ?? -1);
    }
    ed.destroy();
  });

  it("detects tables like Tiptap's line split", () => {
    const orig = (src: string) => {
      const lines = src.split("\n");
      if (lines.length < 2) return -1;
      const sep = lines[1];
      if (!/^[ \t|:]*-[ \t|:-]*$/.test(sep) || !sep.includes("|")) return -1;
      return lines[0].includes("|") ? 0 : -1;
    };
    for (let n = 0; n < 3000; n++) {
      const s = sample();
      expect(tableStart(s), JSON.stringify(s)).toBe(orig(s));
    }
  });
});
