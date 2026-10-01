import { describe, expect, it } from "vitest";
import type { QuickLink } from "./types";
import { allLeaves, bookmarkIcon, checkState, indexTree, pageMarkdown, planImport, toggleEntry, unitsOf, urlKey, visibleFor, type BmNode, type BmTree, type PlanOptions } from "./bookmarks";

const bm = (title: string, url = `https://${title.toLowerCase().replace(/\s+/g, "-")}.de/`): BmNode => ({ title, url });
const folder = (title: string, children: BmNode[], role?: string): BmNode => ({ title, children, ...(role ? { role } : {}) });
const tree = (roots: BmNode[]): BmTree => ({ roots, skipped: [], links: 0, truncated: false });

// Lesezeichenleiste: Jira, Arbeit (Fiori, Wiki, Tools (Grafana)), News; Weitere: Handbuch, Privat (Bank)
const sample = () =>
  indexTree(
    tree([
      folder("Bookmarks bar", [bm("Jira"), folder("Arbeit", [bm("Fiori", "https://fiori.firma.de/sap/flp"), bm("Wiki"), folder("Tools", [bm("Grafana")])]), bm("News")], "bar"),
      folder("Other", [bm("Handbuch"), folder("Privat", [bm("Bank")])], "other"),
    ]),
    (n) => ({ bar: "Lesezeichenleiste", other: "Weitere Lesezeichen" })[n.role as "bar" | "other"] ?? n.title,
  );
const byTitle = (idx: ReturnType<typeof sample>, title: string) => [...idx.entries.values()].find((e) => e.title === title)!.id;
const opts = (p: Partial<PlanOptions> = {}): PlanOptions => ({ split: false, overflow: "pages", dest: {}, ...p });
const names = (l: QuickLink[]) => l.map((x) => x.name);

describe("tree and selection", () => {
  it("indexes paths, leaves and role titles", () => {
    const idx = sample();
    expect(idx.roots).toEqual(["0", "1"]);
    const grafana = idx.entries.get(byTitle(idx, "Grafana"))!;
    expect(grafana.path).toEqual(["Lesezeichenleiste", "Arbeit", "Tools"]);
    expect(grafana.depth).toBe(3);
    expect(idx.entries.get("0")!.leaves).toHaveLength(5);
    expect(allLeaves(idx)).toHaveLength(7);
  });

  it("folders are tri-state and toggle all their bookmarks", () => {
    const idx = sample();
    const arbeit = byTitle(idx, "Arbeit");
    let sel = toggleEntry(idx, byTitle(idx, "Wiki"), new Set());
    expect(checkState(idx.entries.get(arbeit)!, sel)).toBe("some");
    expect(checkState(idx.entries.get("0")!, sel)).toBe("some");
    // A partly ticked folder: a click ticks everything.
    sel = toggleEntry(idx, arbeit, sel);
    expect(checkState(idx.entries.get(arbeit)!, sel)).toBe("all");
    expect(sel.size).toBe(3);
    sel = toggleEntry(idx, arbeit, sel);
    expect(checkState(idx.entries.get(arbeit)!, sel)).toBe("none");
    expect(sel.size).toBe(0);
  });

  it("search keeps the path to hits, and a folder hit shows its contents", () => {
    const idx = sample();
    const v = visibleFor(idx, "graf")!;
    expect([...v].map((id) => idx.entries.get(id)!.title).sort()).toEqual(["Arbeit", "Grafana", "Lesezeichenleiste", "Tools"]);
    const p = visibleFor(idx, "privat")!;
    expect([...p].map((id) => idx.entries.get(id)!.title).sort()).toEqual(["Bank", "Privat", "Weitere Lesezeichen"]);
    expect(visibleFor(idx, "  ")).toBeNull();
    // Toggling while searching only touches what is shown.
    const sel = toggleEntry(idx, "0", new Set(), v);
    expect([...sel].map((id) => idx.entries.get(id)!.title)).toEqual(["Grafana"]);
    expect(checkState(idx.entries.get("0")!, sel, v)).toBe("all");
    expect(checkState(idx.entries.get("0")!, sel)).toBe("some");
  });
});

describe("mapping to groups, links and pages", () => {
  it("bar links become ribbon links, folders groups with the subfolder before the name", () => {
    const idx = sample();
    const sel = new Set(allLeaves(idx));
    const units = unitsOf(idx, sel, false);
    expect(units.map((u) => [u.key.startsWith("loose") ? "loose" : "folder", u.kind, u.name, u.items.length])).toEqual([
      ["loose", "links", "Lesezeichenleiste", 2],
      ["folder", "group", "Arbeit", 3],
      ["loose", "group", "Weitere Lesezeichen", 1],
      ["folder", "group", "Privat", 1],
    ]);
    const plan = planImport(idx, sel, [], opts());
    expect(names(plan.links)).toEqual(["Jira", "News", "Arbeit", "Weitere Lesezeichen", "Privat"]);
    expect(plan.links[2]).toEqual({
      name: "Arbeit",
      url: "",
      icon: "folder",
      kind: "group",
      items: [
        { name: "Fiori", url: "https://fiori.firma.de/sap/flp", icon: "briefcase" },
        { name: "Wiki", url: "https://wiki.de/", icon: "book-open" },
        { name: "Tools / Grafana", url: "https://grafana.de/", icon: "chart" },
      ],
    });
    expect(plan.newEntries).toBe(5);
    expect(plan.newLinks).toBe(7);
    expect(plan.pages).toEqual([]);
  });

  it("split makes subfolders groups of their own", () => {
    const idx = sample();
    const plan = planImport(idx, new Set(allLeaves(idx)), [], opts({ split: true }));
    expect(names(plan.links)).toEqual(["Jira", "News", "Arbeit", "Arbeit / Tools", "Weitere Lesezeichen", "Privat"]);
    expect(plan.links[3].items?.map((i) => i.name)).toEqual(["Grafana"]);
  });

  it("a unit sent to a page leaves the ribbon alone", () => {
    const idx = sample();
    const arbeit = byTitle(idx, "Arbeit");
    const plan = planImport(idx, new Set(allLeaves(idx)), [], opts({ dest: { [arbeit]: "page" } }));
    expect(names(plan.links)).not.toContain("Arbeit");
    expect(plan.pages).toHaveLength(1);
    expect(plan.pages[0].title).toBe("Arbeit");
    expect(plan.overflow).toBe(0);
    expect(pageMarkdown(plan.pages[0].items, "Aus Chrome.")).toBe(
      "Aus Chrome.\n\n- [Fiori](https://fiori.firma.de/sap/flp)\n- [Wiki](https://wiki.de/)\n\n## Tools\n\n- [Grafana](https://grafana.de/)\n",
    );
  });

  it("page Markdown escapes brackets and parentheses", () => {
    const md = pageMarkdown([{ name: "A [B]", url: "https://x.de/a (1)", icon: "globe", sub: [] }], "x");
    expect(md).toContain("- [A \\[B\\]](https://x.de/a%20%281%29)");
  });
});

describe("limits", () => {
  const many = (n: number, prefix = "L") => Array.from({ length: n }, (_, i) => bm(`${prefix}${i + 1}`));

  it("ribbon links beyond 40 go to a page, or are left out", () => {
    const existing: QuickLink[] = Array.from({ length: 35 }, (_, i) => ({ name: `E${i}`, url: `https://e${i}.de`, icon: "" }));
    const idx = indexTree(tree([folder("Bar", many(8), "bar")]));
    const sel = new Set(allLeaves(idx));
    const plan = planImport(idx, sel, existing, opts());
    expect(plan.links).toHaveLength(40);
    expect(plan.units[0]).toMatchObject({ inRibbon: 5, toPage: 3, over: true });
    expect(plan.overflow).toBe(3);
    expect(plan.pages[0].items.map((i) => i.name)).toEqual(["L6", "L7", "L8"]);
    const dropped = planImport(idx, sel, existing, opts({ overflow: "drop" }));
    expect(dropped.pages).toEqual([]);
    expect(dropped.dropped).toBe(3);
  });

  it("a group holds 60; the rest goes to a page; no room for a group means all to a page", () => {
    const idx = indexTree(tree([folder("Riesig", many(70))]));
    const plan = planImport(idx, new Set(allLeaves(idx)), [], opts());
    expect(plan.links[0].items).toHaveLength(60);
    expect(plan.units[0]).toMatchObject({ inRibbon: 60, toPage: 10 });
    const full: QuickLink[] = Array.from({ length: 40 }, (_, i) => ({ name: `E${i}`, url: `https://e${i}.de`, icon: "" }));
    const none = planImport(idx, new Set(allLeaves(idx)), full, opts());
    expect(none.links).toHaveLength(40);
    expect(none.units[0]).toMatchObject({ inRibbon: 0, toPage: 70, over: true });
  });

  it("a group of the same name takes the links (up to its room) and needs no slot", () => {
    const existing: QuickLink[] = [{ name: "arbeit", url: "", icon: "wrench", kind: "group", items: [{ name: "Alt", url: "https://alt.de", icon: "" }] }];
    const idx = sample();
    const plan = planImport(idx, new Set(idx.entries.get(byTitle(idx, "Arbeit"))!.leaves), existing, opts());
    expect(plan.links).toHaveLength(1);
    expect(plan.units[0].merge).toBe(0);
    expect(plan.links[0].items?.map((i) => i.name)).toEqual(["Alt", "Fiori", "Wiki", "Tools / Grafana"]);
    expect(plan.newEntries).toBe(0);
    // The plan does not change the list it was given.
    expect(existing[0].items).toHaveLength(1);
  });
});

describe("duplicates", () => {
  it("addresses already in the ribbon (also in groups, other spelling) are skipped and counted", () => {
    const existing: QuickLink[] = [
      { name: "Jira", url: "jira.de", icon: "" },
      { name: "G", url: "", icon: "folder", kind: "group", items: [{ name: "W", url: "http://www.WIKI.de", icon: "" }] },
    ];
    const idx = sample();
    const plan = planImport(idx, new Set(allLeaves(idx)), existing, opts());
    expect(plan.duplicates).toBe(2);
    expect(names(plan.links)).toEqual(["Jira", "G", "News", "Arbeit", "Weitere Lesezeichen", "Privat"]);
    expect(plan.links[3].items?.map((i) => i.name)).toEqual(["Fiori", "Tools / Grafana"]);
    // A second import of the same selection adds nothing.
    const again = planImport(idx, new Set(allLeaves(idx)), plan.links, opts());
    expect(again.newLinks).toBe(0);
    expect(again.newEntries).toBe(0);
    expect(again.duplicates).toBe(7);
    expect(again.links).toEqual(plan.links);
  });

  it("the same address twice in the selection is taken once", () => {
    const idx = indexTree(tree([folder("Bar", [bm("A", "https://a.de/"), folder("F", [bm("A again", "https://a.de")])], "bar")]));
    const plan = planImport(idx, new Set(allLeaves(idx)), [], opts());
    expect(plan.duplicates).toBe(1);
    expect(names(plan.links)).toEqual(["A"]);
  });

  it("urlKey compares loosely", () => {
    expect(urlKey("https://www.Example.de/a/")).toBe(urlKey("example.de/a"));
    expect(urlKey("http://x.de")).toBe(urlKey("https://x.de/"));
    expect(urlKey("https://x.de/?a=1")).not.toBe(urlKey("https://x.de/?a=2"));
  });
});

describe("icons", () => {
  it("picks an icon by the domain", () => {
    expect(bookmarkIcon("https://fiori.firma.de/sap/bc/ui2/flp")).toBe("briefcase");
    expect(bookmarkIcon("https://s4.firma.de/x")).toBe("briefcase");
    expect(bookmarkIcon("https://outlook.office.com/mail/")).toBe("mail");
    expect(bookmarkIcon("https://mail.firma.de/")).toBe("mail");
    expect(bookmarkIcon("https://jira.firma.de/")).toBe("ticket");
    expect(bookmarkIcon("https://gitlab.firma.de/")).toBe("code");
    expect(bookmarkIcon("file:///C:/x.pdf")).toBe("folder");
    expect(bookmarkIcon("https://example.org/")).toBe("globe");
  });
});
