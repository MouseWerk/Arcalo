import { describe, expect, it } from "vitest";
import { foldPlain, foldWritten, fuzzy } from "./fuzzy";

describe("palette ranking", () => {
  it("folds case, accents and ß", () => {
    expect(foldPlain("Übersicht Straße Café")).toBe("ubersicht strasse cafe");
    expect(foldWritten("Übersicht Ärger Öl")).toBe("uebersicht aerger oel");
  });

  it("finds umlaut titles typed without umlauts, both spellings", () => {
    expect(fuzzy("Übersicht", "ubersicht")).toBeGreaterThan(90);
    expect(fuzzy("Übersicht", "uebersicht")).toBeGreaterThan(90);
    expect(fuzzy("Straße", "strasse")).toBeGreaterThan(90);
    expect(fuzzy("Grüße an Jörg", "jorg")).toBeGreaterThan(70);
    expect(fuzzy("Grüße an Jörg", "joerg")).toBeGreaterThan(70);
  });

  it("still finds plain titles typed with umlauts", () => {
    expect(fuzzy("Uebersicht", "Übersicht")).toBeGreaterThan(90);
  });

  it("ranks prefix over word start over inner match over subsequence", () => {
    const prefix = fuzzy("Projektplan", "pro");
    const word = fuzzy("Neues Projekt", "pro");
    const inner = fuzzy("Reprojektion", "pro");
    const sub = fuzzy("Protokoll Review", "prv");
    expect(prefix).toBeGreaterThan(word);
    expect(word).toBeGreaterThan(inner);
    expect(inner).toBeGreaterThan(sub);
    expect(sub).toBeGreaterThan(0);
    expect(fuzzy("Projekt", "xyz")).toBe(0);
  });

  it("an empty query matches everything", () => {
    expect(fuzzy("Alles", "")).toBe(1);
  });
});
