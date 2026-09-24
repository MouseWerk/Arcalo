import { describe, expect, it } from "vitest";
import { markdownStats, stripMarkdown, textStats } from "./plaintext";

describe("stripMarkdown", () => {
  it("drops block markers", () => {
    expect(stripMarkdown("- [ ] Offene Aufgabe")).toBe("Offene Aufgabe");
    expect(stripMarkdown("1. Nummeriert")).toBe("Nummeriert");
    expect(stripMarkdown("## Überschrift")).toBe("Überschrift");
    expect(stripMarkdown("> [!warning] Achtung")).toBe("Achtung");
    expect(stripMarkdown("> Zitat")).toBe("Zitat");
  });
  it("drops emphasis and code marks", () => {
    expect(stripMarkdown("mit **fett**, *kursiv*, _auch_, ~~weg~~, ==markiert== und `code`")).toBe("mit fett, kursiv, auch, weg, markiert und code");
  });
  it("keeps identifiers and arithmetic", () => {
    expect(stripMarkdown("snake_case_name und 5 * 3 * 2")).toBe("snake_case_name und 5 * 3 * 2");
  });
  it("keeps link labels", () => {
    expect(stripMarkdown("siehe [Doku](https://example.com) und ![Logo](a.png)")).toBe("siehe Doku und Logo");
    expect(stripMarkdown("Link auf [[Architektur]] und [[Seite#Teil|hier]]")).toBe("Link auf Architektur und hier");
    expect(stripMarkdown("![[Bild.png|300]] Text")).toBe("Bild.png Text");
  });
  it("can leave wiki links for the caller", () => {
    expect(stripMarkdown("- **Siehe** [[Architektur|Arch]]", { keepWikilinks: true })).toBe("Siehe [[Architektur|Arch]]");
  });
  it("drops footnote marks, column markers and [TOC]", () => {
    expect(stripMarkdown("Aussage[^1] hier")).toBe("Aussage hier");
    expect(stripMarkdown("[^1]: Die Quelle")).toBe("Die Quelle");
    expect(stripMarkdown("<!-- spalten -->")).toBe("");
    expect(stripMarkdown("[TOC]")).toBe("");
  });
  it("keeps FTS hit markers", () => {
    expect(stripMarkdown("…mit **\u0002fett\u0003** und")).toBe("…mit \u0002fett\u0003 und");
  });
});

describe("status bar counts", () => {
  it("counts words and characters without spaces", () => {
    expect(textStats("")).toEqual({ words: 0, chars: 0 });
    expect(textStats("  Zwei  Wörter\n")).toEqual({ words: 2, chars: 10 });
  });
  it("counts Markdown source like the visual editor: text only, no markers", () => {
    const md = ["# Titel", "", "- [ ] **Eine** Aufgabe", "> [!note] Hinweis", "", "```js", "let a = 1;", "```", "", "| A | B |", "| --- | --- |", "| x | y |", "---", "<!-- spalten -->", "[[Seite|Alias]] und `code`"].join("\n");
    expect(markdownStats(md)).toEqual(textStats("Titel Eine Aufgabe Hinweis let a = 1; A B x y Alias und code"));
  });
});
