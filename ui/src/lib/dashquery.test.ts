import { describe, expect, it } from "vitest";
import { applyLine, bars, displayProblem, emptyQuery, filterText, normalizeQuery, parseFilter, parseQueryLine, queryLine, tokenize } from "./dashquery";

describe("dashquery", () => {
  it("tokenizes words, quotes and `key: value` with a blank", () => {
    expect(tokenize('#projekt status: offen "neues Angebot" titel:"A B" prio >= 1')).toEqual(["#projekt", "status:offen", '"neues Angebot"', 'titel:"A B"', "prio", ">=", "1"]);
    expect(tokenize("fällig:  woche  x")).toEqual(["fällig:woche", "x"]);
  });

  it("reads filters with every operator", () => {
    expect(parseFilter("status:offen")).toEqual({ field: "status", op: "ist", value: "offen" });
    expect(parseFilter("Status:!Fertig")).toEqual({ field: "status", op: "ist nicht", value: "Fertig" });
    expect(parseFilter("status!=Fertig")).toEqual({ field: "status", op: "ist nicht", value: "Fertig" });
    expect(parseFilter("titel:~login")).toEqual({ field: "titel", op: "enthält", value: "login" });
    expect(parseFilter("titel:!~alt")).toEqual({ field: "titel", op: "enthält nicht", value: "alt" });
    expect(parseFilter("aufwand>3")).toEqual({ field: "aufwand", op: ">", value: "3" });
    expect(parseFilter("aufwand>=3,5")).toEqual({ field: "aufwand", op: ">=", value: "3,5" });
    expect(parseFilter("fällig<2026-10-01")).toEqual({ field: "fällig", op: "<", value: "2026-10-01" });
    expect(parseFilter("wer:leer")).toEqual({ field: "wer", op: "ist leer", value: "" });
    expect(parseFilter("wer:!leer")).toEqual({ field: "wer", op: "ist nicht leer", value: "" });
    expect(parseFilter('titel:"Neues Angebot"')).toEqual({ field: "titel", op: "ist", value: "Neues Angebot" });
    expect(parseFilter("einfach")).toBeNull();
  });

  it("parses a query line into tag, filters, range, days and text", () => {
    const p = parseQueryLine('#Projekt status: offen fällig:woche zeitraum:monat tage:14 "Angebot Müller" rest');
    expect(p.tag).toBe("projekt");
    expect(p.filters).toEqual([
      { field: "status", op: "ist", value: "offen" },
      { field: "fällig", op: "ist", value: "woche" },
    ]);
    expect(p.range).toBe("month");
    expect(p.days).toBe(14);
    expect(p.text).toBe("Angebot Müller rest");
    expect(p.problems).toEqual([]);
    const bad = parseQueryLine("#a #b tage:99 zeitraum:gestern");
    expect(bad.tag).toBe("a");
    expect(bad.problems).toEqual(["#b", "tage:99", "zeitraum:gestern"]);
  });

  it("writes a query back as the same line", () => {
    for (const line of ["#projekt status:offen", "prio>=1 fällig:überfällig", 'titel:~"neues Angebot" wer:!leer', "status!=Fertig aufwand<=3 Suche"]) {
      const q = applyLine(emptyQuery("pages"), line);
      expect(queryLine(q)).toBe(line);
      expect(applyLine(emptyQuery("pages"), queryLine(q))).toEqual(q);
    }
    const e = applyLine(emptyQuery("entries"), "zeitraum:30tage netzplan:NP-8801");
    expect(e.range).toBe("last30");
    expect(queryLine(e)).toBe("netzplan:NP-8801 zeitraum:30tage");
    // The default range is left out; text with a colon is quoted so it stays text.
    expect(queryLine(applyLine(emptyQuery("entries"), "zeitraum:woche"))).toBe("");
    expect(queryLine({ ...emptyQuery("pages"), text: "a:b" })).toBe('"a:b"');
    expect(filterText({ field: "x", op: "vor", value: "2026-01-01" })).toBe("x<2026-01-01");
  });

  it("normalizes stored queries", () => {
    const q = normalizeQuery({ source: "tasks", tag: "#Kunde", filters: [{ field: " Prio ", op: ">=", value: "1" }, { nope: 1 }, null], limit: 999, days: -1, columns: ["a", 3, " "] });
    expect(q).toMatchObject({ source: "tasks", tag: "kunde", filters: [{ field: "prio", op: ">=", value: "1" }], limit: 200, days: 0, columns: ["a"] });
    expect(normalizeQuery(null)).toEqual(emptyQuery("pages"));
    expect(normalizeQuery({ source: "entries", range: "decade" }).range).toBe("week");
    expect(normalizeQuery({ source: "events" }).days).toBe(7);
  });

  it("knows what a display needs and scales bars", () => {
    expect(displayProblem(emptyQuery("tasks"), "bar")).toBe("dash.q.needGroup");
    expect(displayProblem({ ...emptyQuery("tasks"), group: "prio" }, "bar")).toBeNull();
    expect(displayProblem(emptyQuery("pages"), "table")).toBe("dash.q.needColumns");
    expect(displayProblem(emptyQuery("tasks"), "table")).toBeNull();
    expect(bars([{ label: "a", value: 2 }, { label: "b", value: 4 }]).map((b) => b.share)).toEqual([0.5, 1]);
    expect(bars([{ label: "a", value: 0 }])[0].share).toBe(0);
  });
});
