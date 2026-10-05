import { afterEach, describe, expect, it } from "vitest";
import { langFromLocale, langOf, noteSystemLang, systemLang } from "./i18n";
import { numberFormatOf, withNumberFormat } from "./prefs";

afterEach(() => noteSystemLang("de"));

describe("„Wie das System“", () => {
  it("reads locale tags as the shell does (POSIX and BCP 47)", () => {
    for (const de of ["de", "de-DE", "DE-at", "de_CH.UTF-8", "de.UTF-8", "de_AT@euro", " de-DE "]) expect(langFromLocale(de), de).toBe("de");
    for (const en of ["en-US", "fr-FR", "", "C", "dex", "deu", null, undefined]) expect(langFromLocale(en), String(en)).toBe("en");
  });

  it("resolves to the system language the shell read; a chosen language stays", () => {
    noteSystemLang("en");
    expect(systemLang()).toBe("en");
    expect([langOf("system"), langOf("de"), langOf("en"), langOf(undefined)]).toEqual(["en", "de", "en", "en"]);
    noteSystemLang("de");
    expect([langOf("system"), langOf("de"), langOf("en")]).toEqual(["de", "de", "en"]);
    // Anything else from the shell is ignored.
    noteSystemLang("fr");
    noteSystemLang(undefined);
    expect(systemLang()).toBe("de");
  });

  it("the number format „as the language writes it“ follows the resolved language", () => {
    noteSystemLang("en");
    expect(numberFormatOf({ language: "system" })).toBe("point");
    expect(withNumberFormat({ language: "system" }, "point")).toEqual({ language: "system" });
    noteSystemLang("de");
    expect(numberFormatOf({ language: "system" })).toBe("comma");
    expect(withNumberFormat({ language: "system" }, "point")).toEqual({ language: "system", number_format: "point" });
  });
});
