// Numbers and hours follow the display language unless a separator is chosen: 28.00 h in
// English, 28,00 h in German (the CATS export keeps SAP's comma, see cats.test.ts).

import { afterEach, describe, expect, it } from "vitest";
import { decimal, decimalSep, fmtHours, fmtMinutes, formatPrefs, h1, h2, int, numberLocale, parseGermanNumber, setFormatPrefs, usd } from "./format";

const before = { ...formatPrefs() };
afterEach(() => setFormatPrefs(before));

describe("number format by language", () => {
  it("English shows a decimal point, German a comma", () => {
    setFormatPrefs({ lang: "en", numberFormat: "auto", hours: "decimal" });
    expect([h2(28), fmtMinutes(1680), h1(7.5), decimal(1.25), int(1234), decimalSep(), numberLocale()]).toEqual(["28.00", "28.00", "7.5", "1.25", "1,234", ".", "en-US"]);
    expect(`${fmtHours(28)} h`).toBe("28.00 h");
    expect(usd(0.5)).toBe("$0.50");
    setFormatPrefs({ lang: "de" });
    expect([h2(28), fmtMinutes(1680), h1(7.5), decimal(1.25), int(1234), decimalSep(), numberLocale()]).toEqual(["28,00", "28,00", "7,5", "1,25", "1.234", ",", "de-DE"]);
  });

  it("a chosen separator wins over the language", () => {
    setFormatPrefs({ lang: "en", numberFormat: "comma" });
    expect(h2(28)).toBe("28,00");
    setFormatPrefs({ lang: "de", numberFormat: "point" });
    expect(h2(28)).toBe("28.00");
  });

  it("typed numbers are read in the notation shown", () => {
    setFormatPrefs({ lang: "en", numberFormat: "auto" });
    expect(parseGermanNumber("1,200.5")).toBe(1200.5);
    expect(parseGermanNumber("1.5")).toBe(1.5);
    setFormatPrefs({ lang: "de", numberFormat: "auto" });
    expect(parseGermanNumber("1.200,5")).toBe(1200.5);
    expect(parseGermanNumber("1,5")).toBe(1.5);
  });

  it("clock hours are the same in both languages", () => {
    setFormatPrefs({ lang: "en", numberFormat: "auto", hours: "clock" });
    expect(fmtMinutes(90)).toBe("1:30");
  });
});
