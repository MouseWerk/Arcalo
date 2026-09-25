import { describe, expect, it } from "vitest";
import { taskGroup, taskSegments } from "./tasks";

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
    expect(taskSegments("Angebot prüfen [E-Mail: Angebot (Anna, 24.09.2026)](annalo-mail://k3v9x2qa) [[Angebot]] #kunde")).toEqual([
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
