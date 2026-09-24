import { describe, expect, it } from "vitest";
import { citedNumbers, citeNeedles, linkCitations, plainInline } from "./citations";
import { renderMarkdown } from "./markdown";

const chips = (html: string) => [...html.matchAll(/<sup class="cite" data-cite="(\d+)"/g)].map((m) => Number(m[1]));

describe("linkCitations", () => {
  it("turns [n] after statements into chips", () => {
    const html = linkCitations(renderMarkdown("Der Go-Live ist am 1. Oktober [1]. Budget: 120 h [2][3]."), 3);
    expect(chips(html)).toEqual([1, 2, 3]);
    expect(html).toContain('aria-label="Quelle 1"');
    expect(html).not.toContain("[1]");
  });

  it("splits lists and ignores numbers without a source", () => {
    const html = linkCitations(renderMarkdown("A [1, 3]. B [7]. C [0]."), 3);
    expect(chips(html)).toEqual([1, 3]);
    expect(html).toContain("[7]");
    expect(html).toContain("[0]");
  });

  it("leaves code, links and answers without sources alone", () => {
    const md = "Array `a[1]` und\n\n```\nx[2]\n```\n\n[[Architektur]] [Doku](https://x.de) Punkt [1]";
    const html = linkCitations(renderMarkdown(md), 2);
    expect(chips(html)).toEqual([1]);
    expect(html).toContain("a[1]");
    expect(html).toContain("x[2]");
    expect(linkCitations(renderMarkdown("Text [1]"), 0)).not.toContain("cite");
  });

  it("works in lists and tables", () => {
    const html = linkCitations(renderMarkdown("- Punkt eins [2]\n\n| a | b |\n|---|---|\n| x [1] | y |"), 2);
    expect(chips(html)).toEqual([2, 1]);
  });

  it("finds cited numbers in order", () => {
    expect(citedNumbers("a [2] b [1][2] c [9] d [3, 1]", 3)).toEqual([2, 1, 3]);
  });
});

describe("citeNeedles", () => {
  it("takes the first sentence of the paragraph, its start and the heading", () => {
    const n = citeNeedles("# Netzplan\n\nNetzplan **NP-8801** wird im [[Oktober|Herbst]] freigegeben. Danach folgt die Abnahme.");
    expect(n).toEqual(["Netzplan NP-8801 wird im Herbst freigegeben.", "Netzplan NP-8801 wird im Herbst", "Netzplan"]);
  });

  it("strips list markers, tasks, quotes and callouts", () => {
    expect(citeNeedles("- [ ] Angebot senden due:2026-09-30 !!")[0]).toBe("Angebot senden due:2026-09-30 !!");
    expect(citeNeedles("> [!note] Wichtig: bitte lesen")[0]).toBe("Wichtig: bitte lesen");
    expect(citeNeedles("1. Erster Schritt")[0]).toBe("Erster Schritt");
  });

  it("skips frontmatter and code, falls back to the heading", () => {
    expect(citeNeedles("---\nvorgang: NP-8801/1020\n---\n## Nur Code\n\n```\nlet x = 1;\n```")).toEqual(["Nur Code"]);
  });

  it("cuts long sentences at a word boundary", () => {
    const long = `${"Wort ".repeat(40)}Ende.`;
    const [first] = citeNeedles(long);
    expect(first.length).toBeLessThanOrEqual(90);
    expect(first.endsWith("Wort")).toBe(true);
  });

  it("plainInline matches what the editor shows", () => {
    expect(plainInline("Siehe [[Architektur#Datenbank]] und [Doku](https://x) mit *kursiv* und `code`")).toBe("Siehe Architektur › Datenbank und Doku mit kursiv und code");
    expect(plainInline('Gebucht <time-entry id="1" hours="2" target="NP">x</time-entry> heute')).toBe("Gebucht heute");
  });
});
