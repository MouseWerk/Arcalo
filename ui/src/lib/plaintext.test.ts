import { describe, expect, it } from "vitest";
import { stripMarkdown } from "./plaintext";

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
  it("keeps FTS hit markers", () => {
    expect(stripMarkdown("…mit **\u0002fett\u0003** und")).toBe("…mit \u0002fett\u0003 und");
  });
});
