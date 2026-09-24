import { describe, expect, it } from "vitest";
import { changeCase, sortOrder, textStats, uniqueOrder } from "./tools";

describe("editor tools", () => {
  it("changes case, German-aware", () => {
    expect(changeCase("straße und über", "upper")).toBe("STRASSE UND ÜBER");
    expect(changeCase("ÄRGER im BÜRO", "lower")).toBe("ärger im büro");
    expect(changeCase("das ist ein test-fall (neu)", "title")).toBe("Das Ist Ein Test-Fall (Neu)");
  });
  it("sorts naturally, umlauts next to their base letter", () => {
    const lines = ["Zebra", "äpfel", "Apfel 10", "Apfel 2", "banane"];
    expect(sortOrder(lines).map((i) => lines[i])).toEqual(["äpfel", "Apfel 2", "Apfel 10", "banane", "Zebra"]);
    expect(sortOrder(lines, true).map((i) => lines[i])[0]).toBe("Zebra");
  });
  it("keeps the first of duplicate lines", () => {
    expect(uniqueOrder(["a", "B", " a ", "b", "c"])).toEqual([0, 1, 4]);
  });
  it("counts words, characters and reading time", () => {
    const s = textStats("Hallo Welt.\n\nZweiter Absatz mit 5 Wörtern");
    expect(s).toMatchObject({ words: 7, paragraphs: 2, readingMinutes: 1 });
    expect(s.charsNoSpaces).toBe("HalloWelt.ZweiterAbsatzmit5Wörtern".length);
    expect(textStats("").readingMinutes).toBe(0);
  });
});
