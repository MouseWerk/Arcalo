import { describe, expect, it } from "vitest";
import { anchorLabel, loadPreview, previewMarkdown, type PreviewSource } from "./LinkPreview";
import type { PageDoc } from "../lib/types";
import { markPositions } from "./ScrollOutline";

describe("previewMarkdown", () => {
  it("drops frontmatter and keeps short pages whole", () => {
    expect(previewMarkdown("---\nstatus: x\n---\nHallo\n")).toEqual({ text: "Hallo", more: false });
  });
  it("cuts long pages at a paragraph boundary", () => {
    const md = `${"a".repeat(600)}\n\n${"b".repeat(600)}`;
    const p = previewMarkdown(md, 900);
    expect(p.more).toBe(true);
    expect(p.text).toBe("a".repeat(600));
  });
});

describe("loadPreview", () => {
  const page = { id: 7, title: "Projekt", icon: null, content: "# Projekt\n\nIntro\n\n## Ziele\n\nSchnell sein.\n" } as unknown as PageDoc;
  const src = (section: string | null): PreviewSource => ({
    resolvePage: async (t) => (t === "Projekt" ? { id: 7 } : null),
    page: async () => page,
    pageEmbed: async (target) =>
      target === "Projekt"
        ? { page_id: 7, title: "Projekt", icon: null, updated_at: null, content: section, missing: section == null ? "section" : null }
        : { page_id: null, title: target, icon: null, updated_at: null, content: null, missing: "page" },
  });
  it("shows the page without an anchor", async () => {
    expect(await loadPreview("Projekt", null, src(null))).toMatchObject({ id: 7, content: page.content, anchor: null, sectionMissing: false });
  });
  it("shows the section of [[Seite#Abschnitt]] without repeating its heading", async () => {
    expect(await loadPreview("Projekt", "Ziele", src("## Ziele\n\nSchnell sein."))).toMatchObject({ content: "Schnell sein.", anchor: "Ziele", sectionMissing: false });
  });
  it("shows the block of [[Seite#^id]] as it is", async () => {
    expect(await loadPreview("Projekt", "^r1", src("Zu langsam."))).toMatchObject({ content: "Zu langsam.", anchor: "^r1" });
  });
  it("falls back to the page when the section is gone, nothing for a missing page", async () => {
    expect(await loadPreview("Projekt", "Weg", src(null))).toMatchObject({ content: page.content, sectionMissing: true });
    expect(await loadPreview("Fehlt", "Ziele", src(null))).toBeNull();
  });
  it("labels H1#H2 by the last heading", () => {
    expect(anchorLabel("Projekt#Ziele")).toBe("Ziele");
    expect(anchorLabel("^r1")).toBe("^r1");
  });
});

describe("markPositions", () => {
  it("maps heading offsets to fractions of the document", () => {
    expect(markPositions([0, 500, 2000], 1000)).toEqual([0, 0.5, 1]);
  });
});
