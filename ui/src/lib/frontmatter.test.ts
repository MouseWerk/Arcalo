import { describe, expect, it } from "vitest";
import { FIRST_LINE_RE, edited, isValidKey, parseFrontmatter, propertyValue, serializeFrontmatter, splitItems, withTag, type Property } from "./frontmatter";

const OBSIDIAN = `---
title: Kickoff Systemintegration
created: 2026-09-23
tags: [projekt, "kunde a", sap]
aliases:
  - Kickoff
  - "SI: Start"
vorgang: NP-8801/1020
url: https://example.com/a?b=c
empty:
author:
  name: Anna
  mail: anna@example.com
summary: |
  Zeile eins
  Zeile zwei
note: Meeting #1
# ein Kommentar
cssclasses: []
---
`;

describe("parseFrontmatter", () => {
  const props = parseFrontmatter(OBSIDIAN);
  const by = (k: string) => props.find((p) => p.key === k)!;

  it("reads typical Obsidian properties", () => {
    expect(by("title")).toMatchObject({ type: "text", value: "Kickoff Systemintegration" });
    expect(by("created")).toMatchObject({ type: "date", value: "2026-09-23" });
    expect(by("tags")).toMatchObject({ type: "list", items: ["projekt", "kunde a", "sap"] });
    expect(by("aliases")).toMatchObject({ type: "list", items: ["Kickoff", "SI: Start"] });
    expect(by("url").value).toBe("https://example.com/a?b=c");
    expect(by("empty")).toMatchObject({ type: "text", value: "" });
    expect(by("cssclasses")).toMatchObject({ type: "list", items: [] });
    expect(propertyValue(props, "vorgang")).toBe("NP-8801/1020");
  });

  it("keeps complex YAML as raw rows", () => {
    expect(by("author")).toMatchObject({ type: "raw", value: "author:\n  name: Anna\n  mail: anna@example.com" });
    expect(by("summary").type).toBe("raw");
    expect(by("note").type).toBe("raw");
    expect(props.find((p) => !p.key)).toMatchObject({ type: "raw", value: "# ein Kommentar" });
  });

  it("round-trips unchanged properties exactly", () => {
    expect(serializeFrontmatter(props)).toBe(OBSIDIAN);
    expect(serializeFrontmatter(parseFrontmatter("---\r\na: 1\r\nb:\r\n- x\r\n---\r\n"))).toBe("---\na: 1\nb:\n- x\n---\n");
  });

  it("accepts the inner block without delimiters and empty input", () => {
    expect(parseFrontmatter("a: b\n")).toMatchObject([{ key: "a", value: "b" }]);
    expect(parseFrontmatter("")).toEqual([]);
    expect(parseFrontmatter("---\n---\n")).toEqual([]);
  });
});

describe("serializeFrontmatter", () => {
  it("writes edited properties canonically and keeps the rest", () => {
    const props = parseFrontmatter(OBSIDIAN);
    const i = props.findIndex((p) => p.key === "tags");
    props[i] = edited(props[i], { items: ["projekt", "b, c"] });
    const t = props.findIndex((p) => p.key === "title");
    props[t] = edited(props[t], { key: "titel", value: "Kickoff: Start" });
    const out = serializeFrontmatter(props);
    expect(out).toContain('tags: [projekt, "b, c"]');
    expect(out).toContain('titel: "Kickoff: Start"');
    expect(out).toContain("author:\n  name: Anna\n  mail: anna@example.com");
    expect(out).toContain("summary: |\n  Zeile eins\n  Zeile zwei");
    const again = parseFrontmatter(out);
    expect(again.find((p) => p.key === "tags")!.items).toEqual(["projekt", "b, c"]);
    expect(propertyValue(again, "titel")).toBe("Kickoff: Start");
  });

  it("quotes values that would not read back", () => {
    const vals = ["#tag", "a: b", "[x]", "  lead", "x #y", '"q"', "- a", "Zeile\nzwei", "'s"];
    const props: Property[] = vals.map((v, i) => edited({ key: `k${i}`, type: "text", value: "", items: [] }, { value: v }));
    const back = parseFrontmatter(serializeFrontmatter(props));
    expect(back.map((p) => p.value)).toEqual(vals);
    expect(back.every((p) => p.type === "text")).toBe(true);
  });

  it("types dates, drops empty blocks and keeps a key line first", () => {
    const p = edited({ key: "due", type: "text", value: "", items: [] }, { value: "2026-10-01" });
    expect(p.type).toBe("date");
    expect(serializeFrontmatter([])).toBe("");
    const props = parseFrontmatter("---\na: 1\n# note\nb: 2\n---\n").slice(1);
    expect(serializeFrontmatter(props)).toBe("---\nb: 2\n# note\n---\n");
  });

  it("quotes text YAML would read as another type, but not dates", () => {
    const vals = ["true", "No", "null", "~", "42", "-1.5", "1e3", "08:30", "2026-10-01T08:00"];
    const props: Property[] = vals.map((v, i) => edited({ key: `k${i}`, type: "text", value: "", items: [] }, { value: v }));
    const out = serializeFrontmatter(props);
    expect(out).toContain('k0: "true"');
    expect(out).toContain("k1: No");
    expect(out).toContain('k4: "42"');
    expect(out).toContain('k7: "08:30"');
    expect(parseFrontmatter(out).map((p) => p.value)).toEqual(vals);
    const date = edited({ key: "due", type: "text", value: "", items: [] }, { value: "2026-10-01" });
    expect(serializeFrontmatter([date])).toBe("---\ndue: 2026-10-01\n---\n");
    const list = edited({ key: "tags", type: "list", value: "", items: [] }, { items: ["2026", "a"] });
    expect(serializeFrontmatter([list])).toBe('---\ntags: ["2026", a]\n---\n');
  });

  it("quotes YAML's other number forms: .5, hex, octal, infinity, NaN", () => {
    const vals = [".5", "-.5", "0x10", "0X1F", "0o17", ".inf", "+.inf", "-.INF", ".Inf", ".nan", ".NaN"];
    const props: Property[] = vals.map((v, i) => edited({ key: `k${i}`, type: "text", value: "", items: [] }, { value: v }));
    const out = serializeFrontmatter(props);
    vals.forEach((v, i) => expect(out).toContain(`k${i}: "${v}"`));
    expect(parseFrontmatter(out).map((p) => p.value)).toEqual(vals);
    // Text that merely starts like a number stays plain.
    const plain = ["0xyz", ".info", "v1.5", ".nanny"];
    const out2 = serializeFrontmatter(plain.map((v, i) => edited({ key: `p${i}`, type: "text", value: "", items: [] }, { value: v })));
    plain.forEach((v, i) => expect(out2).toContain(`p${i}: ${v}\n`));
  });

  it("keeps a block whose first key is not ASCII", () => {
    const fm = "---\nPriorität: hoch\ndue date: 2026-10-01\n---\n";
    const props = parseFrontmatter(fm);
    expect(props.map((p) => p.key)).toEqual(["Priorität", "due date"]);
    expect(serializeFrontmatter(props)).toBe(fm);
    expect(FIRST_LINE_RE.test("Priorität: hoch")).toBe(true);
    expect(FIRST_LINE_RE.test("due date: x")).toBe(true);
    expect(FIRST_LINE_RE.test("- a: b")).toBe(false);
    expect(FIRST_LINE_RE.test("# x: y")).toBe(false);
  });

  it("validates property names", () => {
    for (const k of ["vorgang", "Priorität", "due date", "a-b", "x#y", "ä"]) expect(isValidKey(k), k).toBe(true);
    for (const k of ["", " a", "#a", "-a", "a:b", "[a", "{a", "'a", '"a', "&a", "*a", "!a", "|a", ">a", "%a", "@a", "`a", "?a", ",a"]) expect(isValidKey(k), k).toBe(false);
  });

  it("splits typed lists", () => {
    expect(splitItems("a, #b ,, c")).toEqual(["a", "b", "c"]);
  });
});

describe("adding a tag (the sidebar's selection)", () => {
  it("creates the tags list, appends to it and leaves the rest as it was", () => {
    expect(withTag("", "#projekt")).toBe("---\ntags: [projekt]\n---\n");
    expect(withTag("---\nstatus: offen\n---\n", "kunde")).toBe("---\nstatus: offen\ntags: [kunde]\n---\n");
    expect(withTag("---\ntags: [a, b]\nstatus: offen\n---\n", "c")).toBe("---\ntags: [a, b, c]\nstatus: offen\n---\n");
    expect(withTag("---\ntags:\n  - a\n---\n", "b")).toBe("---\ntags: [a, b]\n---\n");
    // Already there (any case), or nothing to add: unchanged.
    const fm = "---\ntags: [Kunde]\n---\n";
    expect(withTag(fm, "kunde")).toBe(fm);
    expect(withTag(fm, "  ")).toBe(fm);
  });
});

describe("selection action: tag into frontmatter", () => {
  const tagsOf = (fm: string) => parseFrontmatter(fm).find((p) => p.key === "tags");

  it("keeps the existing tags of a block list with a comment (raw property)", () => {
    const fm = "---\ntitle: Angebot\ntags:\n  - projekt # wichtig\n  - kunde\n---\n";
    const next = withTag(fm, "neu");
    expect(next).toContain("projekt");
    expect(next).not.toContain('"tags:');
    // The editor cannot read the comment, so the tag becomes one more item of the block list; the
    // comment and the other items stay as written.
    expect(next).toBe("---\ntitle: Angebot\ntags:\n  - projekt # wichtig\n  - kunde\n  - neu\n---\n");
    expect(tagsOf(next!)?.type).toBe("raw");
    // Already there (behind a comment or not): unchanged.
    expect(withTag(fm, "Projekt")).toBe(fm);
    expect(withTag(fm, "kunde")).toBe(fm);
  });

  it("keeps a nested flow list", () => {
    const next = withTag("---\ntags: [a, [b, c]]\n---\n", "neu");
    expect(next ?? "").not.toContain('"tags:');
    expect(next ?? "").not.toContain('"[a');
    // Not safe to change: the page is skipped.
    expect(next).toBeNull();
  });

  it("skips other raw tags it cannot extend safely", () => {
    expect(withTag("---\ntags: # keine\n  - a\n---\n", "neu")).toBeNull();
    expect(withTag("---\ntags:\n  - a\n  # Kommentar\n---\n", "neu")).toBeNull();
  });
});
