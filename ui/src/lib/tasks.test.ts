import { afterEach, describe, expect, it } from "vitest";
import { fromTaskTable, nextMonday, recurLabel, recurTokens, selectClick, taskGroup, taskSegments, type TaskTable } from "./tasks";
import { isoDay, setFormatPrefs } from "./format";
import { setLang } from "./i18n";
import type { Recurrence } from "./types";

describe("taskGroup", () => {
  const wed = new Date(2026, 8, 23, 15, 0); // Mittwoch, 23.09.2026
  const cases: [string | null, string][] = [
    [null, "none"],
    ["2026-09-22", "overdue"],
    ["2026-09-23", "today"],
    ["2026-09-24", "week"],
    ["2026-09-27", "week"],
    ["2026-09-28", "later"],
  ];
  for (const [due, group] of cases) it(`${due} → ${group}`, () => expect(taskGroup(due, wed)).toBe(group));
  it("am Sonntag ist nichts mehr diese Woche", () => expect(taskGroup("2026-09-28", new Date(2026, 8, 27))).toBe("later"));
});

describe("taskSegments", () => {
  it("erkennt Links mit Alias und Tags", () => {
    expect(taskSegments("Angebot an [[Kunde X#Kontakt|Kunde]] senden #vertrieb/b2b- (#eilig) #1")).toEqual([
      { kind: "text", text: "Angebot an " },
      { kind: "link", text: "Kunde", target: "Kunde X" },
      { kind: "text", text: " senden " },
      { kind: "tag", text: "#vertrieb/b2b", tag: "vertrieb/b2b" },
      { kind: "text", text: "- (" },
      { kind: "tag", text: "#eilig", tag: "eilig" },
      { kind: "text", text: ") #1" },
    ]);
  });
  it("ignoriert # mitten im Wort", () => {
    expect(taskSegments("C#Sharp")).toEqual([{ kind: "text", text: "C#Sharp" }]);
  });
  it("erkennt Links auf E-Mails", () => {
    expect(taskSegments("Angebot prüfen [E-Mail: Angebot (Anna, 24.09.2026)](arcalo-mail://k3v9x2qa) [[Angebot]] #kunde")).toEqual([
      { kind: "text", text: "Angebot prüfen " },
      { kind: "mail", text: "E-Mail: Angebot (Anna, 24.09.2026)", id: "k3v9x2qa" },
      { kind: "text", text: " " },
      { kind: "link", text: "Angebot", target: "Angebot" },
      { kind: "text", text: " " },
      { kind: "tag", text: "#kunde", tag: "kunde" },
    ]);
    expect(taskSegments("[Doku](https://x.de)")).toEqual([{ kind: "text", text: "[Doku](https://x.de)" }]);
  });
});

describe("repeat rules", () => {
  const rule = (r: Partial<Recurrence>): Recurrence => ({ unit: "week", interval: 1, weekdays: [], month_day: null, until: null, when_done: false, ...r });
  afterEach(() => (setLang("de"), setFormatPrefs({ lang: "de" })));

  it("labels them readably in both languages", () => {
    setLang("de");
    setFormatPrefs({ lang: "de", dateFormat: "de" });
    expect(recurLabel(rule({}))).toBe("Wöchentlich");
    expect(recurLabel(rule({ weekdays: [0, 2] }))).toBe("Wöchentlich · Mo, Mi");
    expect(recurLabel(rule({ weekdays: [0, 1, 2, 3, 4] }))).toBe("Wöchentlich · werktags");
    expect(recurLabel(rule({ unit: "day", interval: 3, when_done: true }))).toBe("Alle 3 Tage · ab Erledigung");
    expect(recurLabel(rule({ unit: "month", month_day: 31, until: "2026-12-31" }))).toBe("Monatlich · am 31. · bis 31.12.2026");
    setLang("en");
    setFormatPrefs({ lang: "en" });
    expect(recurLabel(rule({ interval: 2, weekdays: [4] }))).toBe("Every 2 weeks · Fri");
    expect(recurLabel(rule({ unit: "year" }))).toBe("Yearly");
  });

  it("writes the tokens the core reads", () => {
    expect(recurTokens(rule({}))).toBe("every:weekly");
    expect(recurTokens(rule({ interval: 2, weekdays: [0, 2] }))).toBe("every:2w,mo,we");
    expect(recurTokens(rule({ unit: "month", month_day: 31, when_done: true }))).toBe("every:monthly,31,done");
    expect(recurTokens(rule({ unit: "day", interval: 3, until: "2026-12-31" }))).toBe("every:3d until:2026-12-31");
    expect(recurTokens(rule({ unit: "year", interval: 2 }))).toBe("every:2y");
    expect(recurTokens(rule({ unit: "year", month_day: 29 }))).toBe("every:yearly,29");
  });

  it("decodes the compact task table into the task objects", () => {
    const table: TaskTable = {
      pages: { "1": ["Seite 1", null], "2": ["Seite 2", "star"] },
      rows: [
        [2, 0, 3, "zwei", false, "2026-10-09", 2, "a b", null],
        [1, 4, 9, "eins", true, null, 0, "", { unit: "week", interval: 1, weekdays: [], month_day: null, until: null, when_done: false }],
      ],
    };
    const list = fromTaskTable(table);
    expect(list[0]).toEqual({ page_id: 2, page_title: "Seite 2", page_icon: "star", ordinal: 0, line: 3, text: "zwei", done: false, due: "2026-10-09", priority: 2, tags: ["a", "b"], recur: null });
    expect([list[1].page_title, list[1].tags, list[1].recur?.unit]).toEqual(["Seite 1", [], "week"]);
  });

  it("next week starts on Monday", () => {
    expect(isoDay(nextMonday(new Date(2026, 9, 7)))).toBe("2026-10-12");
    expect(isoDay(nextMonday(new Date(2026, 9, 11)))).toBe("2026-10-12");
  });
});

describe("selectClick", () => {
  const order = ["a", "b", "c", "d"];
  it("toggles one and selects ranges from the anchor", () => {
    expect([...selectClick(new Set(), order, "b", null, false)]).toEqual(["b"]);
    expect([...selectClick(new Set(["b"]), order, "b", "b", false)]).toEqual([]);
    expect([...selectClick(new Set(["b"]), order, "d", "b", true)].sort()).toEqual(["b", "c", "d"]);
    expect([...selectClick(new Set(["d"]), order, "a", "c", true)].sort()).toEqual(["a", "b", "c", "d"]);
    // An anchor that left the list: a plain toggle.
    expect([...selectClick(new Set(), order, "c", "x", true)]).toEqual(["c"]);
  });
});
