// Markdown fidelity: what goes into the editor must come out unchanged, so
// notes stay compatible with Obsidian and plain Markdown tools.

import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { buildExtensions, toMarkdown } from "./schema";
import { splitFrontmatter } from "./extensions";

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
  taskMeta: "- [ ] Angebot an [[Kunde X]] 📅 2026-09-30 !! #vertrieb\n- [x] Review due:2026-09-01 !\n",
  quote: "> Ein Zitat\n> über zwei Zeilen\n",
  callout: "> [!note] Hinweis\n> Callout-Text\n",
  calloutWarning: "> [!warning] Achtung\n> Nicht löschen\n",
  code: "```ts\nconst x = 42;\n```\n",
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
