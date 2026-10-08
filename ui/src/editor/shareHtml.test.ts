import { describe, expect, it } from "vitest";
import { renderPageHtml, resolveSectionLinks, type AttachmentSource } from "./shareHtml";
import { buildHtmlDocument, dataUri, htmlFileName, mimeOf } from "../lib/htmlExport";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const files = (known: Record<string, Uint8Array>): AttachmentSource => ({
  read: async (n) => known[n] ?? null,
  size: async (n) => known[n]?.length ?? null,
});

const render = (md: string, known: Record<string, Uint8Array> = {}, anchors = new Map<string, string>()) => renderPageHtml(md, { id: "page-1", files: files(known), anchors });

describe("share as HTML", () => {
  it("inlines images and drawing previews, links web images", async () => {
    const html = await render("![[bild.png]] ![[Plan.excalidraw]] ![[fehlt.png]]\n\n![Logo](https://example.com/logo.png)\n", { "bild.png": PNG, "Plan.excalidraw.svg": new TextEncoder().encode("<svg/>") });
    expect(html).toContain(`src="${dataUri(PNG, "image/png")}"`);
    expect(html).toContain('src="data:image/svg+xml;base64,');
    expect(html).toContain("[Bild fehlt: fehlt.png]");
    expect(html).toContain('<a href="https://example.com/logo.png"');
    expect(html).not.toMatch(/src="https?:/);
    expect(html).not.toContain("arcalo-attachment:");
  });

  it("embeds small files, lists them at the end", async () => {
    const html = await render("Angebot: ![[a.pdf]] und ![[gross.zip]]\n", { "a.pdf": new Uint8Array([37, 80, 68, 70]) });
    expect(html).toMatch(/<a class="attachment" href="data:application\/pdf;base64,[^"]+" download="a.pdf">a.pdf <small>4 B<\/small><\/a>/);
    expect(html).toContain('<span class="attachment">gross.zip <small>nicht enthalten</small></span>');
    expect(html).toContain("<h2>Anhänge</h2>");
  });

  it("carries linked files like embedded ones", async () => {
    const html = await render("Siehe [[Ordner/a.pdf|das Angebot]] und [[fehlt.docx]].\n", { "a.pdf": new Uint8Array([1, 2, 3, 4]) });
    expect(html).toMatch(/<a class="attachment" href="data:application\/pdf;base64,[^"]+" download="a.pdf">das Angebot <small>4 B<\/small><\/a>/);
    expect(html).toContain('<span class="attachment">fehlt.docx <small>nicht enthalten</small></span>');
    expect(html).not.toContain('class="wikilink"');
  });

  it("links pages in the file, others stay text", async () => {
    const html = await render("[[Kind]] und [[Anderswo|woanders]]\n", {}, new Map([["kind", "page-2"]]));
    expect(html).toContain('<a class="wikilink" href="#page-2">Kind</a>');
    expect(html).toContain('<span class="wikilink">woanders</span>');
  });

  it("gives headings stable anchors from their text, numbered when repeated", async () => {
    const html = await render("# Über uns\n\n## Ziele & Pläne\n\n## „Zitat“ Ziele\n\n## Über uns\n\n## ???\n");
    expect(html).toContain('<h1 id="page-1-über-uns">Über uns</h1>');
    expect(html).toContain('<h2 id="page-1-ziele-pläne">Ziele &amp; Pläne</h2>');
    expect(html).toContain('<h2 id="page-1-zitat-ziele">„Zitat“ Ziele</h2>');
    expect(html).toContain('<h2 id="page-1-über-uns-2">Über uns</h2>');
    expect(html).toContain('<h2 id="page-1-h5">???</h2>');
  });

  it("links sections of the page in the file: [[#Abschnitt]], [[Seite#Abschnitt]], [[#^block]]", async () => {
    const md = "## Ablauf im Detail\n\nSchritt eins. ^s1\n\n- Punkt ^p2\n\nSiehe [[#ablauf im detail]], [[Seite#Ablauf im Detail|oben]], [[#^s1]], [[#^p2]], [[#Fehlt]] und [[Andere#Ziele]].\n";
    const html = await render(md, {}, new Map([["seite", "page-1"], ["andere", "page-2"]]));
    expect(html).toContain('<h2 id="page-1-ablauf-im-detail">');
    expect(html).toContain('<p id="page-1-block-s1">Schritt eins.</p>');
    expect(html).toContain('<li id="page-1-block-p2"><p>Punkt</p></li>');
    expect(html).toContain('<a class="wikilink" href="#page-1-ablauf-im-detail">ablauf im detail</a>');
    expect(html).toContain('<a class="wikilink" href="#page-1-ablauf-im-detail">oben</a>');
    expect(html).toContain('<a class="wikilink" href="#page-1-block-s1">^s1</a>');
    expect(html).toContain('<a class="wikilink" href="#page-1-block-p2">^p2</a>');
    // A missing section: the page itself.
    expect(html).toContain('<a class="wikilink" href="#page-1">Fehlt</a>');
    // Another page in the file: checked when all pages are rendered.
    expect(html).toContain('href="#page-2-ziele" data-fallback="#page-2"');
    const [a, b] = resolveSectionLinks([
      { id: "page-1", title: "Seite", date: "", depth: 0, body: html },
      { id: "page-2", title: "Andere", date: "", depth: 1, body: '<h2 id="page-2-ziele">Ziele</h2><a class="wikilink" href="#page-1-nichts" data-fallback="#page-1">x</a>' },
    ]);
    expect(a.body).toContain('<a class="wikilink" href="#page-2-ziele">Andere › Ziele</a>');
    expect(b.body).toContain('<a class="wikilink" href="#page-1">x</a>');
  });

  it("leaves out reference definitions, keeps the links", async () => {
    const html = await render("Siehe [Doku][d].\n\n[d]: https://example.com/doku\n");
    expect(html).toContain('href="https://example.com/doku">Doku</a>');
    expect(html).not.toContain("[d]:");
  });

  it("renders callouts, foldable ones as details", async () => {
    const html = await render("> [!warning] Achtung\n> Nicht löschen\n\n> [!note]- Mehr\n> Versteckt\n");
    expect(html).toContain('<div class="callout callout-warning"><div><span class="callout-title">Achtung</span></div><p>Nicht löschen</p></div>');
    expect(html).toContain('<details class="callout callout-note"><summary><span class="callout-title">Mehr</span></summary><p>Versteckt</p></details>');
  });

  it("renders footnotes, [TOC], columns and highlighted code", async () => {
    const md = "[TOC]\n\n## Eins\n\nText[^a]\n\n<!-- spalten -->\n\nL\n\n<!-- spalte -->\n\nR\n\n<!-- /spalten -->\n\n```js\nconst x = 1;\n```\n\n[^a]: Quelle.\n";
    const html = await render(md);
    expect(html).toContain('<nav class="toc" aria-label="Inhaltsverzeichnis"><div class="toc-head">Inhaltsverzeichnis</div><ul><li><a href="#page-1-eins">Eins</a></li></ul></nav>');
    expect(html).toContain('<h2 id="page-1-eins">Eins</h2>');
    expect(html).toContain('<sup class="fn-ref"><a href="#page-1-fn-1" title="Quelle." id="page-1-fn-1-ref">1</a></sup>');
    expect(html).toMatch(/<section class="footnotes"><h2>Fußnoten<\/h2><ol><li id="page-1-fn-1" value="1">Quelle\.<a class="back" href="#page-1-fn-1-ref"/);
    expect(html).toContain('<div class="columns"><div class="column"><p>L</p></div><div class="column"><p>R</p></div></div>');
    expect(html).toContain('<span class="hljs-keyword">const</span>');
  });

  it("builds a self-contained document", async () => {
    const doc = buildHtmlDocument(
      [
        { id: "page-1", title: "Projekt <X>", date: "24.09.2026", depth: 0, body: "<p>a</p>" },
        { id: "page-2", title: "Kind", date: "23.09.2026", depth: 1, body: "<p>b</p>" },
      ],
      { created: "24.09.2026" },
    );
    expect(doc).toContain("<title>Projekt &lt;X&gt;</title>");
    expect(doc).toContain('<a href="#page-2">Kind</a>');
    expect(doc).toContain("Erstellt mit Arcalo am 24.09.2026");
    expect(doc).toContain("prefers-color-scheme:dark");
    expect(doc).not.toMatch(/(src|href)="https?:/);
    expect(doc).not.toMatch(/@import|url\(/);
  });

  it("names files and types", () => {
    expect(htmlFileName('Jour fixe 22.09. / "Q3"')).toBe("Jour fixe 22.09. - -Q3-.html");
    expect(htmlFileName("  ")).toBe("Seite.html");
    expect(mimeOf("x.JPG")).toBe("image/jpeg");
    expect(mimeOf("x.unbekannt")).toBe("application/octet-stream");
  });
});
