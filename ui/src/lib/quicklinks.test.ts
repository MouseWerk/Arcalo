import { describe, expect, it } from "vitest";
import type { QuickLink } from "./types";
import { filterItems, flatLinks, groupChoices, insertItem, itemAt, moveItem, newGroup, normalizeLinks, removeItem, updateItem, webItems } from "./quicklinks";

const link = (name: string, url = `${name.toLowerCase()}.de`): QuickLink => ({ name, url, icon: "" });
const app = (name: string): QuickLink => ({ name, url: `/usr/bin/${name.toLowerCase()}`, icon: "", kind: "app" });
const names = (l: QuickLink[]) => l.map((x) => x.name);

describe("normalizeLinks", () => {
  it("reads 1.4 links unchanged (no kind, no items)", () => {
    const old = [{ name: "Jira", url: "jira.firma.de", icon: "ticket" }];
    expect(normalizeLinks(old)).toEqual(old);
    expect(normalizeLinks(null)).toEqual([]);
  });

  it("gives groups a list and flattens nested groups", () => {
    const raw = [
      { name: "G", url: "x", icon: "folder", kind: "group", items: [link("A"), { ...newGroup("Innen"), items: [link("B")] }] },
      { name: "Leer", url: "", icon: "", kind: "group" },
      { ...link("C"), kind: "widget" },
    ] as QuickLink[];
    const got = normalizeLinks(raw);
    expect(got[0]).toEqual({ name: "G", url: "", icon: "folder", kind: "group", items: [link("A"), link("B")] });
    expect(got[1].items).toEqual([]);
    expect(got[2]).toEqual(link("C"));
  });

  it("keeps programs and group colors", () => {
    const got = normalizeLinks([{ ...newGroup("G", "rocket", "blau"), items: [app("Calc")] }]);
    expect(got[0].color).toBe("blau");
    expect(got[0].items![0].kind).toBe("app");
  });
});

describe("group operations", () => {
  const base = (): QuickLink[] => [link("A"), { ...newGroup("G"), items: [link("X"), app("Y")] }, link("B"), newGroup("H")];

  it("inserts into a group or the ribbon, never a group into a group", () => {
    let l = insertItem(base(), link("N"), 1);
    expect(names(l[1].items!)).toEqual(["X", "Y", "N"]);
    l = insertItem(l, link("M"), null, 0);
    expect(names(l)).toEqual(["M", "A", "G", "B", "H"]);
    expect(insertItem(base(), newGroup("Z"), 1)).toEqual(base());
    expect(insertItem(base(), link("Z"), 0)).toEqual(base());
  });

  it("updates and removes in place", () => {
    const l = updateItem(base(), { group: 1, index: 0 }, link("X2"));
    expect(itemAt(l, { group: 1, index: 0 })!.name).toBe("X2");
    expect(names(removeItem(l, { group: 1, index: 1 })[1].items!)).toEqual(["X2"]);
    expect(names(removeItem(l, { group: null, index: 0 }))).toEqual(["G", "B", "H"]);
  });

  it("reorders within a list", () => {
    expect(names(moveItem(base(), { group: null, index: 0 }, { group: null, index: 3 }))).toEqual(["G", "B", "A", "H"]);
    expect(names(moveItem(base(), { group: null, index: 3 }, { group: null, index: 0 }))).toEqual(["H", "A", "G", "B"]);
    expect(names(moveItem(base(), { group: 1, index: 1 }, { group: 1, index: 0 })[1].items!)).toEqual(["Y", "X"]);
    expect(names(moveItem(base(), { group: 1, index: 0 }, { group: 1, index: 2 })[1].items!)).toEqual(["Y", "X"]);
  });

  it("moves a ribbon link into a group after it (the group shifts)", () => {
    const l = moveItem(base(), { group: null, index: 0 }, { group: 1, index: 2 });
    expect(names(l)).toEqual(["G", "B", "H"]);
    expect(names(l[0].items!)).toEqual(["X", "Y", "A"]);
  });

  it("moves between groups and out to the ribbon", () => {
    let l = moveItem(base(), { group: 1, index: 0 }, { group: 3, index: 0 });
    expect(names(l[1].items!)).toEqual(["Y"]);
    expect(names(l[3].items!)).toEqual(["X"]);
    l = moveItem(l, { group: 3, index: 0 }, { group: null, index: 0 });
    expect(names(l)).toEqual(["X", "A", "G", "B", "H"]);
    expect(l[4].items).toEqual([]);
  });

  it("does not put a group into a group", () => {
    expect(moveItem(base(), { group: null, index: 3 }, { group: 1, index: 0 })).toEqual(base());
  });

  it("lists groups, filters, flattens and finds web links", () => {
    expect(groupChoices(base())).toEqual([{ index: 1, name: "G" }, { index: 3, name: "H" }]);
    const items = [link("Jira", "jira.firma.de"), link("Wiki", "confluence.firma.de"), app("Calc")];
    expect(filterItems(items, "FIRMA").map((x) => x.index)).toEqual([0, 1]);
    expect(filterItems(items, "calc bin").map((x) => x.item.name)).toEqual(["Calc"]);
    expect(flatLinks(base()).map((x) => [x.item.name, x.group])).toEqual([["A", null], ["X", "G"], ["Y", "G"], ["B", null]]);
    expect(webItems({ ...newGroup("G"), items: [link("W"), app("P"), link("F", "C:\\Daten")] })).toEqual([0]);
  });
});
