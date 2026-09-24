import { describe, expect, it } from "vitest";
import { AI_PRESETS, bookingSuggestion, cleanAiMarkdown, meetingMinutes, meetingSummaryInstruction, summaryPageContent, summaryPageTitle, transformInstruction, zeitDuration } from "./aitext";

describe("inline AI instructions", () => {
  it("has the preset actions", () => {
    expect(AI_PRESETS.map((p) => p.label)).toEqual([
      "Verbessern",
      "Kürzen",
      "Ausführlicher",
      "Übersetzen DE↔EN",
      "In Stichpunkte",
      "Als Tabelle",
      "Rechtschreibung korrigieren",
      "Freundlicher",
      "Förmlicher",
    ]);
  });

  it("resolves presets and free text", () => {
    expect(transformInstruction("shorten")).toMatch(/^Kürze den Text/);
    expect(transformInstruction("  Mach daraus ein Haiku ")).toBe("Mach daraus ein Haiku");
    expect(transformInstruction("   ")).toBeNull();
  });

  it("strips an outer markdown fence, also while streaming", () => {
    expect(cleanAiMarkdown("```markdown\n## A\n- b\n```")).toBe("## A\n- b");
    expect(cleanAiMarkdown("```md\n## A\n- b")).toBe("## A\n- b");
    expect(cleanAiMarkdown("  Nur Text \n")).toBe("Nur Text");
    expect(cleanAiMarkdown("```ts\nconst a = 1;\n```")).toBe("```ts\nconst a = 1;\n```");
  });
});

describe("meeting summary", () => {
  it("asks for the four sections and our task syntax", () => {
    const p = meetingSummaryInstruction();
    for (const h of ["## Zusammenfassung", "## Entscheidungen", "## Aufgaben", "## Offene Punkte"]) expect(p).toContain(h);
    expect(p).toContain("- [ ] Text @Person due:JJJJ-MM-TT");
    expect(p).toMatch(/!! \(hoch\) oder ! \(mittel\)/);
    expect(p).toMatch(/3–5 Sätze/);
  });

  it("builds the summary page", () => {
    expect(summaryPageTitle("Jour fixe 22.09.")).toBe("Jour fixe 22.09. – Zusammenfassung");
    expect(summaryPageContent("Jour fixe", "## Zusammenfassung\n\nKurz.\n\n")).toBe("Zusammenfassung von [[Jour fixe]]\n\n## Zusammenfassung\n\nKurz.\n");
  });

  it("derives the meeting duration", () => {
    expect(meetingMinutes("Termin 10:00–11:30 Uhr im Raum 2")).toBe(90);
    expect(meetingMinutes("9.15 - 10.00")).toBe(45);
    expect(meetingMinutes("von 14:00 bis 15:00")).toBe(60);
    expect(meetingMinutes("Dauer: 1,5 h")).toBe(90);
    expect(meetingMinutes("Dauer 50 min")).toBe(50);
    expect(meetingMinutes("Version 1.2 - 3.4 und NP-8801/1020")).toBeNull();
    expect(meetingMinutes("11:00–10:00")).toBeNull();
    expect(meetingMinutes("Kein Zeitraum")).toBeNull();
  });

  it("formats /zeit durations", () => {
    expect(zeitDuration(90)).toBe("1.5h");
    expect(zeitDuration(60)).toBe("1h");
    expect(zeitDuration(45)).toBe("0.75h");
    expect(zeitDuration(50)).toBe("50m");
  });

  it("suggests a booking only with a Vorgang and a duration", () => {
    expect(bookingSuggestion("NP-8801/1020", "10:00-11:00 Abstimmung", "Jour fixe 22.09.")).toBe("Buchungsvorschlag: `/zeit NP-8801/1020 1h Jour fixe 22.09.`");
    expect(bookingSuggestion(null, "10:00-11:00", "X")).toBeNull();
    expect(bookingSuggestion("NP-8801/1020", "ohne Zeit", "X")).toBeNull();
  });
});
