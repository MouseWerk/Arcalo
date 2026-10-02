import { describe, expect, it } from "vitest";
import { blockIds, countRichBlocks, embedProblem, markdownHeadings, mermaidKind, pageEmbedMarkdown, parsePageEmbed, richKind, splitTarget } from "./embedSyntax";
import { backendQuery, parseNoteQuery, sortRows } from "../lib/noteQuery";
import type { QueryRow } from "../lib/dashtypes";

describe("page embed syntax", () => {
  it("parses pages, headings and block ids and leaves files alone", () => {
    expect(parsePageEmbed("![[Projekt]] danach")).toEqual({ raw: "![[Projekt]]", target: "Projekt", anchor: null, alt: null });
    expect(parsePageEmbed("![[Projekt#Ziele und Wege]]")).toMatchObject({ target: "Projekt", anchor: "Ziele und Wege" });
    expect(parsePageEmbed("![[Projekt#^abc-1|Kurz]]")).toMatchObject({ target: "Projekt", anchor: "^abc-1", alt: "Kurz" });
    expect(parsePageEmbed("![[Version 1.2]]")?.target).toBe("Version 1.2");
    for (const file of ["![[bild.png]]", "![[a.pdf#page=2]]", "![[Skizze.excalidraw]]", "![[Daten.xlsx]]", "[[Projekt]]", "![[]]"]) expect(parsePageEmbed(file)).toBeNull();
  });

  it("writes the same Markdown back", () => {
    for (const md of ["![[Projekt]]", "![[Projekt#Ziele]]", "![[Projekt#^abc]]", "![[Projekt|Alias]]"]) expect(pageEmbedMarkdown(parsePageEmbed(md)!)).toBe(md);
    expect(pageEmbedMarkdown({ target: "A", anchor: null, alt: "x" }, true)).toBe("![[A\\|x]]");
    expect(splitTarget("Projekt#Zie")).toEqual({ target: "Projekt", anchor: "Zie" });
    expect(splitTarget("Projekt")).toEqual({ target: "Projekt", anchor: null });
  });

  it("detects cycles and the depth limit", () => {
    expect(embedProblem(["a"], 1, "B")).toBeNull();
    expect(embedProblem(["a"], 1, "A")).toBe("cycle");
    expect(embedProblem(["a", "b"], 2, " a ")).toBe("cycle");
    expect(embedProblem(["a", "b", "c"], 3, "D")).toBeNull();
    expect(embedProblem(["a", "b", "c", "d"], 4, "E")).toBe("depth");
  });

  it("lists headings and block ids outside code", () => {
    const md = "# Titel\nText ^t1\n\n```\n## Code\nx ^nein\n```\n## Ziele ^z\n- Punkt ^p\n\n> Zitat\n\n^q\n";
    expect(markdownHeadings(md)).toEqual([
      { level: 1, text: "Titel" },
      { level: 2, text: "Ziele" },
    ]);
    expect(blockIds(md)).toEqual([
      { id: "t1", text: "Text" },
      { id: "z", text: "Ziele" },
      { id: "p", text: "Punkt" },
      { id: "q", text: "Zitat" },
    ]);
  });
});

describe("rich code blocks", () => {
  it("knows mermaid and query blocks", () => {
    expect(richKind("mermaid")).toBe("mermaid");
    expect(richKind("Query")).toBe("query");
    expect(richKind("abfrage")).toBe("query");
    expect(richKind("js")).toBeNull();
    expect(countRichBlocks("```mermaid\ngraph TD\n```\n\n````md\n```mermaid\nx\n```\n````\n\n```query\nfrom: tasks\n```\n")).toEqual({ mermaid: 1, query: 1 });
    expect(countRichBlocks("Nur Text")).toEqual({ mermaid: 0, query: 0 });
  });

  it("reads the diagram type", () => {
    expect(mermaidKind("flowchart LR\n A-->B")).toBe("flowchart");
    expect(mermaidKind("---\ntitle: X\n---\n%% Kommentar\nsequenceDiagram\n")).toBe("sequenceDiagram");
    expect(mermaidKind("  \n")).toBeNull();
  });
});

describe("query blocks", () => {
  it("reads option lines and the query line in both languages", () => {
    const q = parseNoteQuery("from: tasks\nshow: table\nsort: due desc\nlimit: 5\n#projekt status: offen due: week");
    expect(q.display).toBe("table");
    expect(q.sort).toEqual({ key: "date", desc: true });
    expect(q.query).toMatchObject({ source: "tasks", tag: "projekt", limit: 5 });
    expect(q.query.filters).toEqual([
      { field: "status", op: "ist", value: "offen" },
      { field: "fällig", op: "ist", value: "woche" },
    ]);
    expect(q.problems).toEqual([]);
    const de = parseNoteQuery("aus: buchungen\nanzeige: anzahl\nzeitraum: monat");
    expect(de).toMatchObject({ display: "count", query: { source: "entries", range: "month" } });
  });

  it("defaults and problems", () => {
    const q = parseNoteQuery("status: offen");
    expect(q).toMatchObject({ display: "list", sort: null, query: { source: "tasks", limit: 20 } });
    expect(q.query.filters).toHaveLength(1);
    const bad = parseNoteQuery("from: nirgends\nshow: torte\nlimit: 0\n#a #b");
    expect(bad.problems).toEqual(["from: nirgends", "show: torte", "limit: 0", "#b"]);
    expect(parseNoteQuery("from: pages\nshow: chart").query.group).toBe("tag");
    expect(parseNoteQuery("from: pages\nsort: title").query.sort).toBe("title");
  });

  it("sorts what the backend does not", () => {
    const nq = parseNoteQuery("sort: -prio\nlimit: 2");
    expect(backendQuery(nq).limit).toBe(200);
    const row = (title: string, priority: number | null): QueryRow => ({ key: title, title, detail: "", date: null, page_id: 1, icon: null, ordinal: 0, done: false, priority, minutes: null, event_key: null, cells: {} });
    expect(sortRows(nq, [row("a", 1), row("b", null), row("c", 3), row("d", 2)]).map((r) => r.title)).toEqual(["c", "d"]);
  });
});

describe("Markdown stays as written", () => {
  it("round-trips page embeds and rich blocks", async () => {
    const { Editor } = await import("@tiptap/core");
    const { buildExtensions, toMarkdown } = await import("./schema");
    const md =
      "# Seite\n\n![[Projekt]]\n\nText mit ![[Projekt#Ziele|Ziele]] mitten drin\n\n- ![[Liste#^p1]]\n\n> ![[Zitat]]\n\n| A         | B   |\n| --------- | --- |\n| ![[X\\|y]] | 2   |\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\n```query\nfrom: tasks\nstatus: offen\n```\n";
    const editor = new Editor({ element: document.createElement("div"), extensions: buildExtensions(), content: md, contentType: "markdown" });
    const types: string[] = [];
    editor.state.doc.descendants((n) => void (n.type.name === "pageEmbed" && types.push(`${n.attrs.target}#${n.attrs.anchor ?? ""}`)));
    expect(types).toEqual(["Projekt#", "Projekt#Ziele", "Liste#^p1", "Zitat#", "X#"]);
    expect(toMarkdown(editor)).toBe(md);
    editor.destroy();
  });
});

describe("share as HTML with embeds, diagrams and queries", () => {
  it("renders embeds in frames, stops cycles, reports missing pages", async () => {
    const { renderPageHtml } = await import("./shareHtml");
    const pages: Record<string, string> = { b: "Inhalt von B\n\n![[A]]\n\n![[C]]", c: "Tief C" };
    const load = async (target: string) => {
      const content = pages[target.toLowerCase()];
      return { page_id: content ? 1 : null, title: target, icon: null, updated_at: null, content: content ?? null, missing: content ? null : ("page" as const) };
    };
    const html = await renderPageHtml("Vorher\n\n![[B]]\n\n![[Fehlt]]\n\n```mermaid\ngraph TD\nA-->B\n```\n\n```query\nfrom: tasks\n```\n", {
      id: "page-1",
      files: { read: async () => null, size: async () => null },
      anchors: new Map(),
      embeds: { load, stack: ["a"], depth: 1 },
      diagram: async (src) => (src.includes("graph") ? { svg: '<svg id="d"><text>A</text></svg>' } : { error: "x" }),
      query: async () => '<table class="query"><tbody><tr><td>Aufgabe</td></tr></tbody></table>',
    });
    expect(html).toContain('<section class="embed"><div class="embed-title"><span>B</span></div><div class="embed-body"><p>Inhalt von B</p>');
    expect(html).toContain("Tief C");
    expect(html).toMatch(/„A“ wird um diese Einbettung herum schon gezeigt/);
    expect(html).toContain("Eine Seite „Fehlt“ gibt es noch nicht.");
    expect(html).toContain('<figure class="diagram"><svg id="d">');
    expect(html).toContain('<div class="query-result"><table class="query">');
    expect(html).not.toContain("language-mermaid");
  });
});
