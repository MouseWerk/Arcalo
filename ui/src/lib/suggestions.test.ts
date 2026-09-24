import { describe, expect, it } from "vitest";
import { buildSuggestions, type SuggestionContext } from "./suggestions";

const base: SuggestionContext = { now: new Date(2026, 8, 23, 15, 0), page: null, overdue: 0, dueToday: 0, openTasks: 0, gapDays: [], budget: null, hasBookings: false };
const texts = (c: Partial<SuggestionContext>) => buildSuggestions({ ...base, ...c }).map((s) => s.text);

describe("assistant suggestions", () => {
  it("start with the open page and its Vorgang", () => {
    const t = texts({ page: { title: "Jour fixe", openTasks: 2, reference: "NP-8801/1020" }, budget: "NP-8802/2010" });
    expect(t[0]).toBe("„Jour fixe“ zusammenfassen");
    expect(t[1]).toBe("Wie steht das Budget von NP-8801/1020?");
    expect(t).not.toContain("Wie steht das Budget von NP-8802/2010?");
  });
  it("name overdue tasks, gaps and real budget warnings instead of fixed examples", () => {
    const t = texts({ overdue: 3, gapDays: ["Mo", "Di"], budget: "NP-8801/1010", openTasks: 5, hasBookings: true });
    expect(t).toEqual(["3 überfällige Aufgaben priorisieren", "Lücken in der Zeiterfassung prüfen (Mo, Di)", "Wie steht das Budget von NP-8801/1010?", "Was habe ich diese Woche gebucht?", "Was sollte ich als Nächstes erledigen?"]);
  });
  it("follow the time of day and the week", () => {
    expect(texts({ now: new Date(2026, 8, 25, 9, 0), hasBookings: true })).toEqual(["Wochenbericht erstellen", "Tagesplan für heute erstellen", "Was habe ich diese Woche gebucht?", "Was sollte ich als Nächstes erledigen?"]);
    expect(texts({ dueToday: 1 })[0]).toBe("Was steht heute an? (1 Aufgabe fällig)");
  });
  it("never more than five, never empty", () => {
    expect(texts({}).length).toBeGreaterThan(0);
    expect(texts({ page: { title: "A", openTasks: 1, reference: null }, overdue: 1, gapDays: ["Mo"], budget: "X", openTasks: 3, hasBookings: true, now: new Date(2026, 8, 25, 9) }).length).toBe(5);
  });
});
