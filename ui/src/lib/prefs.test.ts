import { afterEach, describe, expect, it } from "vitest";
import { exportFileName, numberFormatOf, spellcheckAttrs, withNumberFormat } from "./prefs";
import { fmtDate, fmtHours, fmtMinutes, setFormatPrefs, weekStart, weekdayLabels } from "./format";
import { monthGrid } from "./calendar";
import { dashBefore, lineNumbers, smartQuote } from "../editor/typing";
import { inlinePresets, meetingSummaryInstruction, transformInstruction } from "./aitext";

afterEach(() => setFormatPrefs({ weekStartsOn: 1, hours: "decimal", dateFormat: "de", lang: "de" }));

describe("display preferences", () => {
  it("hours as decimal or clock", () => {
    expect(fmtHours(1.5)).toBe("1,50");
    expect(fmtHours(1.5, "clock")).toBe("1:30");
    expect(fmtMinutes(125, "clock")).toBe("2:05");
    expect(fmtMinutes(-30, "clock")).toBe("−0:30");
    setFormatPrefs({ hours: "clock" });
    expect(fmtMinutes(90)).toBe("1:30");
  });

  it("date format and week start", () => {
    const d = new Date(2026, 8, 24); // Thursday
    expect(fmtDate(d)).toBe("24.09.2026");
    expect(fmtDate(d, "iso")).toBe("2026-09-24");
    expect(weekStart(d).getDate()).toBe(21); // Monday
    setFormatPrefs({ weekStartsOn: 0 });
    expect(weekStart(d).getDate()).toBe(20); // Sunday
    expect(weekdayLabels()[0]).toBe("So");
    expect(monthGrid(2026, 8)[0][0].getDay()).toBe(0);
    expect(weekdayLabels(1, "en")).toEqual(["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"]);
  });

  it("export file names from the pattern", () => {
    const v = { from: "2026-09-21", to: "2026-09-27", format: "sap_cats", week: 39, pernr: "0042" };
    expect(exportFileName("zeiten-{von}-{bis}", v)).toBe("zeiten-2026-09-21-2026-09-27");
    expect(exportFileName("CATS_{pernr}_KW{kw}", v)).toBe("CATS_0042_KW39");
    expect(exportFileName("a/b:{format}", v)).toBe("a-b-sap_cats");
    expect(exportFileName("", v)).toBe("zeiten-2026-09-21-2026-09-27");
  });

  it("spell check attributes", () => {
    expect(spellcheckAttrs("off")).toEqual({ spellcheck: "false", lang: "de" });
    expect(spellcheckAttrs("en")).toEqual({ spellcheck: "true", lang: "en" });
    expect(spellcheckAttrs(undefined).spellcheck).toBe("true");
  });
});

describe("typing aids", () => {
  it("typographic quotes", () => {
    expect(smartQuote('"', "")).toBe("„");
    expect(smartQuote('"', "Er sagte ")).toBe("„");
    expect(smartQuote('"', "Er sagte „Hallo")).toBe("“");
    expect(smartQuote("'", "(")).toBe("‚");
    expect(smartQuote("'", "Das ist ‚gut")).toBe("‘");
    expect(smartQuote("'", "geht")).toBe("’");
    // English: “…” and ‘…’.
    expect(smartQuote('"', "He said ", "en")).toBe("“");
    expect(smartQuote('"', "He said “Hello", "en")).toBe("”");
    expect(smartQuote("'", "(", "en")).toBe("‘");
    expect(smartQuote("'", "It is ‘fine", "en")).toBe("’");
    expect(smartQuote("'", "don", "en")).toBe("’");
    expect(dashBefore("A -")).toBe(true);
    expect(dashBefore("A-")).toBe(false);
  });

  it("line numbers of a code block", () => {
    expect(lineNumbers("a\nb\nc")).toBe("1\n2\n3");
    expect(lineNumbers("")).toBe("1");
  });
});

describe("AI presets and templates", () => {
  it("custom presets replace the built-in ones", () => {
    expect(inlinePresets(null)[0].label).toBe("Verbessern");
    const p = inlinePresets([{ label: " Haiku ", instruction: "Als Haiku" }, { label: "", instruction: "leer" }]);
    expect(p).toEqual([{ id: "custom-0", label: "Haiku", instruction: "Als Haiku" }]);
    expect(transformInstruction("custom-0", p)).toBe("Als Haiku");
    expect(transformInstruction("shorten", p)).toBe("shorten");
    expect(meetingSummaryInstruction("  Nur Stichpunkte ")).toBe("Nur Stichpunkte");
    expect(meetingSummaryInstruction(null)).toMatch(/## Zusammenfassung/);
  });
});

describe("number format", () => {
  it("choosing the language's own notation keeps following the language", () => {
    const de = { language: "de", date_format: "de" };
    expect(withNumberFormat(de, "point")).toEqual({ ...de, number_format: "point" });
    expect(withNumberFormat(withNumberFormat(de, "point"), "comma")).toEqual(de);
    expect(withNumberFormat({ language: "en" }, "comma")).toEqual({ language: "en", number_format: "comma" });
    expect(numberFormatOf(withNumberFormat({ language: "en", number_format: "comma" as const }, "point"))).toBe("point");
  });
});
