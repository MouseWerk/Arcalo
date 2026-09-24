import { describe, expect, it } from "vitest";
import {
  cellOf,
  columnKeys,
  defaultView,
  filterRows,
  groupRows,
  groupWrite,
  inferKind,
  makeRow,
  matches,
  parseNumber,
  parseSchema,
  parseView,
  setSchema,
  setView,
  sortRows,
  validate,
  writeFromText,
  writeValue,
  type PropDef,
  type Row,
} from "./collection";
import { dumpFlow, parseBlock, parseEntry, parseInline } from "./yaml";

const PARENT = [
  "---",
  "tags: [projekt]",
  "eigenschaften:",
  "  status: {typ: auswahl, optionen: {Offen: grau, In Arbeit: blau, Fertig: grün}}",
  "  aufwand: zahl",
  "  fällig: {typ: datum}",
  '  themen: {typ: mehrfachauswahl, optionen: [UI, "API, intern"]}',
  "  wer: person",
  "  erledigt: checkbox",
  "  quelle: link",
  "ansicht: tabelle",
  "---",
  "",
].join("\n");

const schema = parseSchema(PARENT)!;
const row = (id: number, title: string, fm: string, position = id): Row => makeRow({ id, title, icon: null, position, updated_at: "" }, fm ? `---\n${fm}\n---\n` : "");

describe("yaml subset", () => {
  it("reads flow and block values like the core", () => {
    expect(parseInline(`[a, "b, c", 'd''e']`)).toEqual(["a", "b, c", "d'e"]);
    expect(parseInline("{typ: zahl, optionen: {A: rot}} # Kommentar")).toEqual({ entries: [["typ", "zahl"], ["optionen", { entries: [["A", "rot"]] }]] });
    expect(parseInline("https://example.org/a:b")).toBe("https://example.org/a:b");
    expect(parseInline("[a, b")).toBeNull();
    expect(parseBlock(["  x: 1", "  y:", "    - z"])).toEqual({ entries: [["x", "1"], ["y", ["z"]]] });
    expect(parseEntry("tags:\n- a\n- b")).toEqual(["a", "b"]);
    expect(dumpFlow({ entries: [["a b", ["x, y", "z"]]] })).toBe('{a b: ["x, y", z]}');
  });
});

describe("schema", () => {
  it("parses types and options", () => {
    expect(schema.map((p) => [p.key, p.kind])).toEqual([
      ["status", "select"],
      ["aufwand", "number"],
      ["fällig", "date"],
      ["themen", "multi_select"],
      ["wer", "person"],
      ["erledigt", "checkbox"],
      ["quelle", "link"],
    ]);
    expect(schema[0].options[1]).toEqual({ name: "In Arbeit", color: "blau" });
    expect(schema[3].options).toEqual([{ name: "UI", color: "grau" }, { name: "API, intern", color: "braun" }]);
    expect(parseSchema("---\nstatus: Offen\n---\n")).toBeNull();
  });

  it("round-trips through the frontmatter and keeps the other lines", () => {
    const next = setSchema(PARENT, schema);
    // Written in canonical form: bare types, options with their colors.
    expect(next).toBe(PARENT.replace('[UI, "API, intern"]', '{UI: grau, "API, intern": braun}').replace("{typ: datum}", "datum"));
    expect(setSchema(next, parseSchema(next))).toBe(next);
    expect(parseSchema(next)).toEqual(schema);
    // A new property with odd option names.
    const more: PropDef[] = [...schema, { key: "phase", kind: "select", options: [{ name: "[x] \"a\" #1", color: "rot" }, { name: "true", color: "gelb" }] }];
    const fm = setSchema(next, more);
    expect(parseSchema(fm)).toEqual(more);
    expect(fm).toContain("tags: [projekt]\n");
    expect(fm).toContain("ansicht: tabelle\n");
    // No properties left: back to free text.
    expect(parseSchema(setSchema(fm, []))).toBeNull();
  });
});

describe("view settings", () => {
  it("writes the short form and the full block, and reads them back", () => {
    const v = parseView(PARENT);
    expect(v.type).toBe("tabelle");
    expect(setView(PARENT, v)).toBe(PARENT);
    const full = { ...v, type: "board" as const, sort: { field: "fällig", dir: "ab" as const }, filters: [{ field: "status", op: "ist nicht", value: "Fertig" }, { field: "fällig", op: "vor", value: "heute" }], columns: ["titel", "fällig", "status"], hidden: ["quelle"], widths: { titel: 260, "fällig": 120 }, group: "status", cards: ["fällig", "wer"], collapsed: ["Fertig", ""] };
    const fm = setView(PARENT, full);
    expect(fm).toContain("ansicht:\n  typ: board\n  sortierung: {feld: fällig, richtung: ab}\n  filter: [{feld: status, op: ist nicht, wert: Fertig}, {feld: fällig, op: vor, wert: heute}]\n");
    expect(parseView(fm)).toEqual(full);
    expect(setView(fm, parseView(fm))).toBe(fm);
    // Unknown keys survive.
    const withExtra = fm.replace('  eingeklappt: [Fertig, ""]\n', '  eingeklappt: [Fertig, ""]\n  zukunft: {a: 1}\n');
    expect(withExtra).not.toBe(fm);
    expect(setView(withExtra, parseView(withExtra))).toBe(withExtra);
    // Back to the plain list: the key goes away.
    expect(setView(PARENT, defaultView())).not.toContain("ansicht");
  });
});

describe("cells", () => {
  it("validates like the core and never changes invalid values", () => {
    const r = row(1, "A", 'status: in arbeit\naufwand: 1,5\nfällig: 2026-02-30\nthemen: [UI, Doku]\nwer: "@Anna"\nerledigt: ja\nquelle: "[[Konzept]]"');
    const c = (k: string) => cellOf(r, k, schema.find((d) => d.key === k));
    expect(c("status").value).toEqual({ kind: "select", value: "In Arbeit" });
    expect(c("aufwand").value).toEqual({ kind: "number", value: 1.5 });
    expect(c("fällig").error).toBe("Kein Datum (JJJJ-MM-TT)");
    expect(c("fällig").text).toBe("2026-02-30");
    expect(c("themen").error).toBe("„Doku“ ist keine Option");
    expect(c("wer").value).toEqual({ kind: "person", value: "Anna" });
    expect(c("erledigt").value).toEqual({ kind: "checkbox", value: true });
    expect(c("quelle").value).toEqual({ kind: "link", value: "[[Konzept]]" });
    expect(validate(schema[4], { items: ["A", "B"], list: true }).error).toBe("Liste statt einzelnem Wert");
    expect(validate(schema[1], { items: ["viel"], list: false }).error).toBe("Keine Zahl");
    expect(parseNumber("1.234,5")).toBe(1234.5);
    expect(parseNumber("1e9")).toBeNull();
  });

  it("writes one property and keeps the rest of the frontmatter", () => {
    const fm = "---\nstatus: Offen\nnotiz: \"a: b\"\n---\n";
    expect(writeValue(fm, "status", "Fertig")).toBe("---\nstatus: Fertig\nnotiz: \"a: b\"\n---\n");
    expect(writeValue(fm, "aufwand", 2.5)).toBe("---\nstatus: Offen\nnotiz: \"a: b\"\naufwand: 2.5\n---\n");
    expect(writeValue(fm, "erledigt", true)).toContain("erledigt: true\n");
    expect(writeValue(fm, "themen", ["UI", "API, intern"])).toContain('themen: [UI, "API, intern"]\n');
    expect(writeValue(fm, "status", null)).toBe("---\nstatus:\nnotiz: \"a: b\"\n---\n");
    expect(writeValue(fm, "neu", null)).toBe(fm);
    expect(writeValue("", "fällig", "2026-10-01")).toBe("---\nfällig: 2026-10-01\n---\n");
    expect(writeValue(fm, "quelle", "[[Seite]]")).toContain('quelle: "[[Seite]]"\n');
    expect(writeFromText(schema[1], "3,5")).toBe(3.5);
    expect(writeFromText(schema[1], "drei")).toBe("drei");
    expect(writeFromText(schema[3], "UI, API")).toEqual(["UI", "API"]);
  });
});

describe("filter, sort, group", () => {
  const rows = [
    row(1, "Login", "status: Offen\naufwand: 3\nfällig: 2026-09-20\nwer: Max"),
    row(2, "Export", "status: Fertig\naufwand: 1\nfällig: 2026-10-02\nerledigt: true"),
    row(3, "Suche", "status: In Arbeit\naufwand: 8\nwer: Anna"),
    row(4, "Druck", "status: Später\naufwand: viel"),
    row(5, "Hilfe", ""),
  ];
  const today = "2026-09-24";
  const titles = (rs: Row[]) => rs.map((r) => r.title);

  it("filters by typed values", () => {
    expect(titles(filterRows(rows, [{ field: "status", op: "ist", value: "offen" }], schema, today))).toEqual(["Login"]);
    expect(titles(filterRows(rows, [{ field: "fällig", op: "vor", value: "heute" }], schema, today))).toEqual(["Login"]);
    expect(titles(filterRows(rows, [{ field: "aufwand", op: ">", value: "2,5" }], schema, today))).toEqual(["Login", "Suche"]);
    expect(titles(filterRows(rows, [{ field: "status", op: "ist nicht", value: "Fertig" }, { field: "wer", op: "ist nicht leer", value: "" }], schema, today))).toEqual(["Login", "Suche"]);
    expect(titles(filterRows(rows, [{ field: "titel", op: "enthält", value: "u" }], schema, today))).toEqual(["Suche", "Druck"]);
    expect(titles(filterRows(rows, [{ field: "erledigt", op: "ist", value: "ja" }], schema, today))).toEqual(["Export"]);
    expect(matches(null, "ist leer", "", today)).toBe(true);
    // A condition without its value does not filter yet.
    expect(filterRows(rows, [{ field: "status", op: "ist", value: "" }], schema, today)).toHaveLength(5);
  });

  it("sorts with empty and invalid values last", () => {
    expect(titles(sortRows(rows, { field: "aufwand", dir: "auf" }, schema))).toEqual(["Export", "Login", "Suche", "Druck", "Hilfe"]);
    expect(titles(sortRows(rows, { field: "aufwand", dir: "ab" }, schema))).toEqual(["Suche", "Login", "Export", "Druck", "Hilfe"]);
    // Selects sort by option order, titles alphabetically.
    expect(titles(sortRows(rows, { field: "status", dir: "auf" }, schema))).toEqual(["Login", "Suche", "Export", "Druck", "Hilfe"]);
    expect(titles(sortRows(rows, { field: "titel", dir: "auf" }, schema))).toEqual(["Druck", "Export", "Hilfe", "Login", "Suche"]);
    expect(sortRows(rows, null, schema)).toBe(rows);
  });

  it("groups into option columns plus „Ohne Wert“", () => {
    const g = groupRows(rows, schema[0]);
    expect(g.map((x) => [x.label, titles(x.rows), !!x.invalid])).toEqual([
      ["Offen", ["Login"], false],
      ["In Arbeit", ["Suche"], false],
      ["Fertig", ["Export"], false],
      ["Später", ["Druck"], true],
      ["Ohne Wert", ["Hilfe"], false],
    ]);
    expect(groupRows(rows, schema[4]).map((x) => x.label)).toEqual(["Anna", "Max", "Ohne Wert"]);
    expect(groupRows(rows, schema[5]).map((x) => [x.label, x.rows.length])).toEqual([["Ja", 1], ["Nein", 4]]);
    expect(groupWrite(schema[0], "")).toBeNull();
    expect(groupWrite(schema[5], "ja")).toBe(true);
  });

  it("infers a kind and lists columns in the saved order", () => {
    expect(inferKind(["3", "4,5"])).toBe("number");
    expect(inferKind(["2026-01-01"])).toBe("date");
    expect(inferKind(["ja", "nein"])).toBe("checkbox");
    expect(inferKind(["https://a.de", "[[B]]"])).toBe("link");
    expect(inferKind(["frei"])).toBe("text");
    const extra = [...rows, row(6, "X", "notiz: frei\nansicht: board")];
    const v = { ...defaultView(), columns: ["titel", "aufwand", "status"], hidden: ["quelle"] };
    expect(columnKeys(schema, extra, v)).toEqual(["titel", "aufwand", "status", "fällig", "themen", "wer", "erledigt", "notiz"]);
  });
});
