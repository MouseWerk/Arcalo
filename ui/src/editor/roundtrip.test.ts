// Markdown fidelity: what goes into the editor must come out unchanged, so
// notes stay compatible with Obsidian and plain Markdown tools.

import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { buildExtensions, collapseBlankLines, toMarkdown } from "./schema";
import { splitFrontmatter } from "./extensions";
import { anchorPage, fileExtension, fileKind, formatSize, isFileEmbedName } from "./fileEmbed";

function roundtrip(md: string) {
  const el = document.createElement("div");
  const editor = new Editor({ element: el, extensions: buildExtensions(), content: md, contentType: "markdown" });
  const out = toMarkdown(editor);
  editor.destroy();
  return out;
}

const CASES: Record<string, string> = {
  paragraphs: "Erster Absatz.\n\nZweiter Absatz mit **fett**, *kursiv*, ~~durch~~ und `code`.\n",
  headings: "# H1\n\n## H2\n\n### H3\n\nText\n",
  wikilinks: "Siehe [[Architektur]], [[Jour fixe 22.09.|den Jour fixe]] und [[Seite#Abschnitt]].\n",
  tags: "Notiz #projekt #rollout/phase-2 und #meeting\n",
  highlight: "Das ist ==wichtig== hier.\n",
  bullets: "- eins\n- zwei\n  - verschachtelt\n- drei\n",
  ordered: "1. eins\n2. zwei\n3. drei\n",
  tasks: "- [ ] offen\n- [x] erledigt\n",
  taskMeta: "- [ ] Angebot an [[Kunde X]] due:2026-09-30 !! #vertrieb\n- [x] Review due:2026-09-01 !\n",
  quote: "> Ein Zitat\n> über zwei Zeilen\n",
  callout: "> [!note] Hinweis\n> Callout-Text\n",
  calloutWarning: "> [!warning] Achtung\n> Nicht löschen\n",
  code: "```ts\nconst x = 42;\n```\n",
  codeBlankLines: "```py\nimport os\n\n\ndef main():\n    pass\n```\n\nDanach\n",
  table: "| A   | B   |\n| --- | --- |\n| 1   | 2   |\n",
  link: "Web: [Anthropic](https://www.anthropic.com)\n",
  bareUrl: "Siehe https://example.com/pfad?a=1 für Details\n",
  bareUrlUnderscore: "Doku: https://example.com/snake_case/_intern\n",
  bareEmail: "Mail an max.mustermann@example.de bitte\n",
  bareWww: "Oder www.example.com direkt\n",
  linkTitle: 'Mit [Titel](https://example.com "Hinweis") hier\n',
  hr: "Oben\n\n---\n\nUnten\n",
  timeEntry: 'Gebucht: <time-entry id="12" hours="2,50" target="NP-8801/1020">Systemintegration</time-entry>\n',
  umlauts: "Grüße aus Köln: äöü ß €\n",
  brackets: "Plan [Entwurf] und (Klammern)\n",
  underscores: "Datei snake_case_name und 3 * 4 = 12\n",
  ampersand: "Schulung & Go-Live, a < b\n",
  literalStars: "Kein \\*Fett\\* hier\n",
  literalLinkish: "Text \\[\\[kein Link]]\n",
  mailLink: "- [ ] Prüfen [E-Mail: Angebot (Portal) ＃42 (Müller, Anna, 24.09.2026)](annalo-mail://k3v9x2qa) due:2026-09-25 !!\n\nNotiz: [E-Mail: Kurz](annalo-mail://zz11)\n",
  embed: "![[a1b2c3d4e5f60718.png]]\n",
  embedInline: "Screenshot ![[Bild 1.PNG]] vom Fehler\n",
  embedSize: "![[assets/diagramm.webp|300]] und ![[foto.jpg|Kunde vor Ort]]\n",
  embedNote: "Kein Bild: ![[Notiz]]\n",
  drawing: "![[Zeichnung 2026-09-24 14.05.excalidraw]]\n",
  drawingInline: "Ablauf ![[Plan.excalidraw]] siehe oben\n",
  drawingAlt: "![[Skizzen/Netz.Excalidraw|400]]\n",
  drawingPreview: "![[Plan.excalidraw.svg]]\n",
  tablePipeDrawing: "| A                      | B   |\n| ---------------------- | --- |\n| ![[x.excalidraw\\|300]] | 2   |\n",
  image: "![Logo](https://example.com/logo.png)\n",
  imageRelative: "![Plan](attachments/plan.png \"Titel\")\n",
  tablePipeWiki: "| A                | B   |\n| ---------------- | --- |\n| [[Seite\\|Alias]] | 2   |\n",
  tablePipeText: "| A      | B   |\n| ------ | --- |\n| a \\| b | 2   |\n",
  tablePipeEmbed: "| A               | B   |\n| --------------- | --- |\n| ![[x.png\\|300]] | 2   |\n",
  escapedHeading: "\\# kein Titel\n",
  escapedOrdered: "2026\\. Jahr\n",
  escapedOrderedParen: "1\\) nein\n",
  escapedDash: "\\- x\n",
  escapedPlus: "\\+ x\n",
  escapedQuote: "\\> x\n",
  escapedSetext: "Titel\n\\---\n",
  escapedAfterBreak: "Zeile  \n\\# kein Titel\n",
  hashMidLine: "Nummer # 5 und 3. Platz - gut\n",
  bareUrlParens: "Siehe https://de.wikipedia.org/wiki/Foo_(Bar) hier\n",
  linkTitleQuotes: 'Mit [t](https://example.com "x \\"y\\"") hier\n',
  filePdf: "![[file.pdf]]\n",
  fileDocx: "Angebot: ![[report.docx]] bitte prüfen\n",
  fileNames: "![[Bericht Q3 (final) v2.xlsx]] ![[archiv.tar.gz]] ![[Ordner/Plan.PDF]]\n",
  filePage: "![[Handbuch.pdf#page=3]] und ![[Handbuch.pdf#page=3|Seite drei]]\n",
  fileAlias: "![[daten.csv|Rohdaten]]\n",
  fileNotAFile: "Notiz ![[Version 1.2]] und ![[x.md]]\n",
  tablePipeFile: "| A                         | B   |\n| ------------------------- | --- |\n| ![[report.docx\\|Bericht]] | 2   |\n",
  calloutFolded: "> [!note]- Details\n> Versteckter Inhalt\n",
  calloutExpanded: "> [!tip]+ Mehr dazu\n>\n> Erster Absatz\n>\n> - Punkt\n",
  calloutFoldNoTitle: "> [!faq]-\n> Antwort\n",
  columns2: "<!-- spalten -->\n\nLinks mit **fett**\n\n<!-- spalte -->\n\nRechts\n\n- Punkt\n\n<!-- /spalten -->\n",
  columns3: "Davor\n\n<!-- spalten -->\n\n## Eins\n\n<!-- spalte -->\n\n## Zwei\n\n<!-- spalte -->\n\n```ts\nconst x = 1;\n```\n\n<!-- /spalten -->\n\nDanach\n",
  columnsNested: "<!-- spalten -->\n\nA\n\n<!-- spalten -->\n\nB1\n\n<!-- spalte -->\n\nB2\n\n<!-- /spalten -->\n\n<!-- spalte -->\n\nC\n\n<!-- /spalten -->\n",
  toc: "# Titel\n\n[TOC]\n\n## Abschnitt\n",
  footnotes: "Text mit Fußnote[^1] und zweiter[^note].\n\n[^1]: Erste Fußnote.\n[^note]: Zweite mit **fett** und [[Seite]].\n",
  footnotesLoose: "Siehe[^a].\n\n[^a]: Eins.\n\n[^b]: Zwei.\n",
  footnoteMultiline: "Hier[^1].\n\n[^1]: Erste Zeile\n    zweite Zeile\n",
  footnoteInTable: "| A     | B   |\n| ----- | --- |\n| x[^1] | 2   |\n\n[^1]: Zelle.\n",
  literalFootnote: "Kein \\[^1] Verweis\n",
  tableFilePdf: "| A             | B   |\n| ------------- | --- |\n| ![[file.pdf]] | 2   |\n",
};

describe("markdown round-trip", () => {
  for (const [name, md] of Object.entries(CASES)) {
    it(name, () => {
      expect(roundtrip(md)).toBe(md);
    });
  }

  it("keeps <autolinks> as bare URLs", () => {
    expect(roundtrip("Kurz: <https://example.com>\n")).toBe("Kurz: https://example.com\n");
  });

  it("does not grow escaped time-entry attributes", () => {
    const md = 'Gebucht: <time-entry id="1" hours="1" target="A&quot;B &amp; C">x</time-entry>\n';
    expect(roundtrip(md)).toBe(md);
  });

  it("parses an escaped wiki-link alias in a table cell", () => {
    const el = document.createElement("div");
    const editor = new Editor({ element: el, extensions: buildExtensions(), content: "| A |\n| --- |\n| [[Seite\\|Alias]] |\n", contentType: "markdown" });
    const links: unknown[] = [];
    editor.state.doc.descendants((n) => {
      if (n.type.name === "wikiLink") links.push(n.attrs);
    });
    editor.destroy();
    expect(links).toEqual([expect.objectContaining({ target: "Seite", alias: "Alias" })]);
  });

  it("is stable on a second pass", () => {
    const all = Object.values(CASES).join("\n");
    const once = roundtrip(all);
    expect(roundtrip(once)).toBe(once);
  });
});

describe("image embeds", () => {
  const html = (md: string) => {
    const el = document.createElement("div");
    const editor = new Editor({ element: el, extensions: buildExtensions({ attachmentUrl: (n) => `asset://${n}` }), content: md, contentType: "markdown" });
    const out = editor.getHTML();
    editor.destroy();
    return out;
  };
  it("renders ![[x.png]] as an image of the attachment", () => {
    expect(html("![[ordner/x.png|240]]\n")).toContain('src="asset://ordner/x.png"');
    expect(html("![[x.png|240]]\n")).toMatch(/<img[^>]*width="240"/);
  });
  it("maps relative image paths to attachments, keeps web images", () => {
    expect(html("![a](attachments/x.png)\n")).toContain('src="asset://attachments/x.png"');
    expect(html("![a](https://example.com/x.png)\n")).toContain('src="https://example.com/x.png"');
  });
  it("an image alone on its line stays inside a paragraph (valid document, editable)", () => {
    const editor = new Editor({ element: document.createElement("div"), extensions: buildExtensions(), content: "Text\n\n![Plan](attachments/x.png)\n", contentType: "markdown" });
    expect(() => editor.state.doc.check()).not.toThrow();
    expect(editor.state.doc.lastChild?.type.name).toBe("paragraph");
    // The first edit used to fail („contentMatchAt on a node with invalid content“).
    expect(() => editor.commands.insertContentAt(editor.state.doc.content.size, { type: "paragraph", content: [{ type: "text", text: "neu" }] })).not.toThrow();
    expect(toMarkdown(editor)).toBe("Text\n\n![Plan](attachments/x.png)\n\nneu\n");
    editor.destroy();
  });
});

describe("drawing embeds", () => {
  const editorFor = (md: string) => new Editor({ element: document.createElement("div"), extensions: buildExtensions({ attachmentUrl: (n) => `asset://${n}` }), content: md, contentType: "markdown" });
  it("parses ![[x.excalidraw]] as a drawing showing its SVG preview", () => {
    const editor = editorFor("Vorher ![[Plan 1.excalidraw]] nachher\n");
    const types: string[] = [];
    editor.state.doc.descendants((n) => void types.push(n.type.name));
    expect(types).toContain("drawingEmbed");
    expect(editor.getHTML()).toContain('src="asset://Plan 1.excalidraw.svg"');
    expect(toMarkdown(editor)).toBe("Vorher ![[Plan 1.excalidraw]] nachher\n");
    editor.destroy();
  });
  it("serializes an inserted drawing to exactly its embed", () => {
    const editor = editorFor("");
    editor.commands.insertContent({ type: "drawingEmbed", attrs: { name: "Zeichnung 2026-09-24 14.05.excalidraw" } });
    expect(toMarkdown(editor)).toBe("![[Zeichnung 2026-09-24 14.05.excalidraw]]\n");
    editor.destroy();
  });
  it("keeps the preview SVG an ordinary image", () => {
    const editor = editorFor("![[Plan.excalidraw.svg]]\n");
    expect(editor.getHTML()).toContain('data-embed="Plan.excalidraw.svg"');
    editor.destroy();
  });
});

describe("file embeds", () => {
  const editorFor = (md: string) => new Editor({ element: document.createElement("div"), extensions: buildExtensions(), content: md, contentType: "markdown" });
  const nodes = (editor: Editor) => {
    const out: { type: string; attrs: Record<string, unknown> }[] = [];
    editor.state.doc.descendants((n) => void (n.isAtom && !n.isText && out.push({ type: n.type.name, attrs: n.attrs })));
    return out;
  };
  it("parses files as file embeds, images and drawings keep their nodes", () => {
    const editor = editorFor("![[a.pdf]] ![[b.png]] ![[c.excalidraw]] ![[d.docx#x|y]] ![[Notiz]]\n");
    expect(nodes(editor).map((n) => n.type)).toEqual(["fileEmbed", "imageEmbed", "drawingEmbed", "fileEmbed", "wikiLink"]);
    expect(nodes(editor)[3].attrs).toMatchObject({ name: "d.docx", anchor: "#x", alt: "y" });
    editor.destroy();
  });
  it("shows [[file.ext]] links as file links that open the file, page titles win", async () => {
    const opened: string[] = [];
    const known = new Set(["node.js"]);
    const el = document.createElement("div");
    const md = "[[Ordner/Angebot.pdf#page=3|das Angebot]] [[Daten.xlsx]] [[Fehlt.docx]] [[Node.js]] [[Neu]]\n";
    const editor = new Editor({
      element: el,
      content: md,
      contentType: "markdown",
      extensions: buildExtensions({
        isKnown: (t) => known.has(t.toLowerCase()),
        attachmentSize: async (n) => (n === "Fehlt.docx" ? null : 10),
        onOpenPdf: (n, p) => opened.push(`pdf:${n}:${p}`),
        onOpenFile: (n) => opened.push(`file:${n}`),
        onOpenLink: (t) => opened.push(`page:${t}`),
      }),
    });
    await new Promise((r) => setTimeout(r, 0));
    const links = [...el.querySelectorAll<HTMLElement>("a[data-wikilink]")];
    expect(links.map((a) => a.className)).toEqual(["wikilink file-link", "wikilink file-link", "wikilink file-link is-missing", "wikilink", "wikilink unresolved"]);
    expect(links[0].textContent).toBe("das Angebot");
    expect(links[2].title).toContain("Datei fehlt");
    for (const a of links) a.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true }));
    expect(opened).toEqual(["pdf:Angebot.pdf:3", "file:Daten.xlsx", "file:Fehlt.docx", "page:Node.js", "page:Neu"]);
    expect(toMarkdown(editor)).toBe(md);
    editor.destroy();
  });
  it("serializes an inserted file to exactly its embed", () => {
    const editor = editorFor("");
    editor.commands.insertContent({ type: "fileEmbed", attrs: { name: "Angebot 2.pdf" } });
    expect(toMarkdown(editor)).toBe("![[Angebot 2.pdf]]\n");
    editor.destroy();
  });
  it("parses a file embed in a table cell with an escaped pipe", () => {
    const editor = editorFor("| A |\n| --- |\n| ![[report.docx\\|Bericht]] |\n");
    expect(nodes(editor)).toEqual([{ type: "fileEmbed", attrs: expect.objectContaining({ name: "report.docx", alt: "Bericht" }) }]);
    editor.destroy();
  });
});

describe("file names", () => {
  it("uses the core's extension rule", () => {
    expect(fileExtension("Bericht.PDF")).toBe("pdf");
    expect(fileExtension("x.tar.gz")).toBe("gz");
    for (const no of ["Notiz", "Version 1.2", "x.md", ".pdf", "Dr. Müller", "a.toolongextension"]) expect(fileExtension(no)).toBeNull();
    expect(isFileEmbedName("a.pdf") && isFileEmbedName("a.zip")).toBe(true);
    expect(isFileEmbedName("a.png") || isFileEmbedName("a.excalidraw") || isFileEmbedName("Notiz")).toBe(false);
  });
  it("formats sizes and kinds", () => {
    expect(formatSize(12)).toBe("12 B");
    expect(formatSize(1234)).toBe("1,2 kB");
    expect(formatSize(34_500_000)).toBe("35 MB");
    expect(fileKind("a.xlsx")).toBe("sheet");
    expect(fileKind("a.PDF")).toBe("text");
    expect(fileKind("a.unbekannt")).toBe("file");
    expect(anchorPage("#page=4")).toBe(4);
    expect(anchorPage(null)).toBeNull();
  });
});

describe("splitFrontmatter", () => {
  it("trennt YAML-Frontmatter ab", () => {
    expect(splitFrontmatter("---\ntags: [a]\ntitle: X\n---\n\nText\n")).toEqual({ frontmatter: "---\ntags: [a]\ntitle: X\n---\n", body: "Text\n" });
  });
  it("akzeptiert Frontmatter am Dateiende", () => {
    expect(splitFrontmatter("---\nalias: y\n---")).toEqual({ frontmatter: "---\nalias: y\n---\n", body: "" });
  });
  it("hält eine führende Trennlinie nicht für Frontmatter", () => {
    const md = "---\n\nText\n\n---\n\nMehr\n";
    expect(splitFrontmatter(md)).toEqual({ frontmatter: "", body: md });
  });
  it("verlangt key: in der ersten Zeile", () => {
    const md = "---\nNur ein Absatz\n---\nRest\n";
    expect(splitFrontmatter(md)).toEqual({ frontmatter: "", body: md });
  });
  it("erkennt Schlüssel mit Umlauten und Leerzeichen", () => {
    expect(splitFrontmatter("---\nPriorität: hoch\n---\nText\n")).toEqual({ frontmatter: "---\nPriorität: hoch\n---\n", body: "Text\n" });
    expect(splitFrontmatter("---\ndue date: 2026-10-01\n---\n").frontmatter).toBe("---\ndue date: 2026-10-01\n---\n");
  });
  it("ohne Frontmatter", () => {
    expect(splitFrontmatter("# Titel\n")).toEqual({ frontmatter: "", body: "# Titel\n" });
  });
});

describe("markdown the editor has no block for (kept verbatim)", () => {
  const editorFor = (md: string) => new Editor({ element: document.createElement("div"), extensions: buildExtensions(), content: md, contentType: "markdown" });
  const KEPT: Record<string, string> = {
    htmlInline: "Text mit <kbd>Strg</kbd> und <br> Umbruch\n",
    htmlBlock: "<div>Block</div>\n\nText\n",
    htmlComment: "Text\n\n<!-- Kommentar -->\n\nMehr\n",
    htmlCommentInline: "Text <!-- leise --> weiter\n",
    details: "<details>\n<summary>Mehr</summary>\n\nInhalt\n\n</details>\n",
    lessThan: "wenn a<b und c>d\n",
    angleInText: "a <b> c\n",
    placeholder: "Hallo <Kunde>, danke\n",
    generics: "Typ List<String> und Map<K, V>\n",
    comparison: "wenn x < 3 und y > 2\n",
    codeFenceLong: "````md\n```\ninnen\n```\n````\n",
    codeFenceFive: "`````\n````\nx\n````\n`````\n",
    emptyTask: "- [ ] \n",
    emptyTaskBetween: "- [ ] eins\n- [ ] \n- [x] drei\n",
    escapedHash: "Kein \\#tag hier\n",
    escapedHashAndTag: "\\#nein aber #ja\n",
    columnsWithComment: "<!-- spalten -->\n\nLinks\n\n<!-- Notiz -->\n\n<!-- spalte -->\n\nRechts\n\n<!-- /spalten -->\n",
  };
  for (const [name, md] of Object.entries(KEPT)) {
    it(name, () => {
      expect(roundtrip(md)).toBe(md);
      expect(roundtrip(roundtrip(md))).toBe(md);
    });
  }

  it("code containing ``` in a ~~~ fence gets a longer backtick fence (same code)", () => {
    const out = roundtrip("~~~\n```\nx\n```\n~~~\n");
    expect(out).toBe("````\n```\nx\n```\n````\n");
    const editor = editorFor(out);
    expect(editor.state.doc.childCount).toBe(1);
    expect(editor.state.doc.firstChild?.textContent).toBe("```\nx\n```");
    editor.destroy();
  });

  it("a code block that gets ``` typed into it is saved with a longer fence", () => {
    const editor = editorFor("```\nx\n```\n");
    editor.commands.insertContentAt(editor.state.doc.content.size - 1, "\n```");
    expect(toMarkdown(editor)).toBe("````\nx\n```\n````\n");
    editor.destroy();
  });

  it("reads `- [ ]` without text as an empty task, also without a trailing space", () => {
    for (const md of ["- [ ]\n", "- [ ] \n", "- [x]\n"]) {
      const editor = editorFor(md);
      expect(editor.state.doc.firstChild?.type.name).toBe("taskList");
      expect(editor.state.doc.textContent).toBe("");
      editor.destroy();
    }
    // Inside code it stays as it is.
    expect(roundtrip("```\n- [ ]\n```\n")).toBe("```\n- [ ]\n```\n");
  });

  it("an escaped hash is no tag, a typed one is", () => {
    const editor = editorFor("Kein \\#tag, aber #echt\n");
    expect([...editor.view.dom.querySelectorAll(".tag")].map((t) => t.textContent)).toEqual(["#echt"]);
    editor.commands.insertContentAt(editor.state.doc.content.size - 1, " #neu");
    expect(toMarkdown(editor)).toBe("Kein \\#tag, aber #echt #neu\n");
    editor.destroy();
  });

  it("raw HTML shows as its source text (nothing is rendered as HTML)", () => {
    const editor = editorFor('Vorher <img src="x" onerror="alert(1)"> nachher\n\n<script>alert(1)</script>\n');
    expect(editor.view.dom.querySelector("img, script")).toBeNull();
    expect(editor.view.dom.querySelector(".md-html")?.textContent).toBe('<img src="x" onerror="alert(1)">');
    expect(editor.view.dom.querySelector(".md-html-block")?.textContent).toBe("<script>alert(1)</script>");
    editor.destroy();
  });

  it("text typed with angle brackets is still escaped where it would become HTML", () => {
    const editor = editorFor("");
    editor.commands.insertContent({ type: "text", text: "Tag <b> und a < b" });
    expect(toMarkdown(editor)).toBe("Tag &lt;b> und a < b\n");
    editor.destroy();
  });

  it("line breaks in table cells stay <br>", () => {
    const md = "| A            | B   |\n| ------------ | --- |\n| eins<br>zwei | 2   |\n";
    const editor = editorFor(md);
    let breaks = 0;
    editor.state.doc.descendants((n) => void (n.type.name === "hardBreak" && breaks++));
    expect(breaks).toBe(1);
    expect(toMarkdown(editor)).toContain("eins<br>zwei");
    editor.destroy();
  });

  it("blank lines collapse outside fenced code only", () => {
    expect(collapseBlankLines("a\n\n\n\nb")).toBe("a\n\nb");
    expect(collapseBlankLines("~~~\na\n\n\n\nb\n~~~\n\n\nc")).toBe("~~~\na\n\n\n\nb\n~~~\n\nc");
    expect(collapseBlankLines("````\n```\n\n\nx\n````\n\n\ny")).toBe("````\n```\n\n\nx\n````\n\ny");
    expect(collapseBlankLines("  ```\n\n\n  ```\n\n\nz")).toBe("  ```\n\n\n  ```\n\nz");
  });
});
