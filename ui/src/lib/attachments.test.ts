import { describe, expect, it } from "vitest";
import { DEFAULT_FILTER, filterAttachments, isUnused, LARGE_BYTES, renameProblem, stemLength, totalSize } from "./attachments";
import type { AttachmentInfo } from "./types";

const file = (name: string, kind: AttachmentInfo["kind"], size: number, modified: string, uses: string[] = []): AttachmentInfo => ({
  name,
  kind,
  size,
  modified,
  preview: null,
  used_in: uses.map((title, i) => ({ id: i + 1, title, trashed: false })),
});

const FILES = [
  file("Bild 10.png", "image", 2000, "2026-09-01T10:00:00Z", ["Notiz"]),
  file("bild 2.png", "image", 3000, "2026-09-03T10:00:00Z"),
  file("Handbuch.pdf", "pdf", LARGE_BYTES + 1, "2026-09-02T10:00:00Z", ["Projekt", "Notiz"]),
  file("Skizze.excalidraw", "drawing", 500, "2026-08-01T10:00:00Z", ["Architektur"]),
  file("daten.xlsx", "other", 100, "2026-07-01T10:00:00Z"),
];
const names = (list: AttachmentInfo[]) => list.map((f) => f.name);

describe("filterAttachments", () => {
  it("sorts names naturally and case-insensitively", () => {
    expect(names(filterAttachments(FILES, DEFAULT_FILTER))).toEqual(["bild 2.png", "Bild 10.png", "daten.xlsx", "Handbuch.pdf", "Skizze.excalidraw"]);
  });
  it("sorts by size, date and usage", () => {
    expect(names(filterAttachments(FILES, { ...DEFAULT_FILTER, sort: "size" }))[0]).toBe("Handbuch.pdf");
    expect(names(filterAttachments(FILES, { ...DEFAULT_FILTER, sort: "date" }))).toEqual(["bild 2.png", "Handbuch.pdf", "Bild 10.png", "Skizze.excalidraw", "daten.xlsx"]);
    expect(names(filterAttachments(FILES, { ...DEFAULT_FILTER, sort: "usage" })).slice(0, 2)).toEqual(["Handbuch.pdf", "Bild 10.png"]);
  });
  it("filters by type, unused, large and search (name or page)", () => {
    expect(names(filterAttachments(FILES, { ...DEFAULT_FILTER, kind: "image" }))).toEqual(["bild 2.png", "Bild 10.png"]);
    expect(names(filterAttachments(FILES, { ...DEFAULT_FILTER, unused: true }))).toEqual(["bild 2.png", "daten.xlsx"]);
    expect(names(filterAttachments(FILES, { ...DEFAULT_FILTER, large: true }))).toEqual(["Handbuch.pdf"]);
    expect(names(filterAttachments(FILES, { ...DEFAULT_FILTER, query: "BILD" }))).toEqual(["bild 2.png", "Bild 10.png"]);
    expect(names(filterAttachments(FILES, { ...DEFAULT_FILTER, query: "archi" }))).toEqual(["Skizze.excalidraw"]);
    expect(names(filterAttachments(FILES, { ...DEFAULT_FILTER, query: "notiz pdf" }))).toEqual(["Handbuch.pdf"]);
  });
  it("counts sizes and usage", () => {
    expect(totalSize(FILES)).toBe(2000 + 3000 + LARGE_BYTES + 1 + 500 + 100);
    expect(FILES.filter(isUnused).length).toBe(2);
  });
});

describe("renameProblem", () => {
  const all = FILES.map((f) => f.name).concat("Skizze.excalidraw.svg", "Plan.excalidraw.svg");
  it("accepts valid names and case-only renames", () => {
    expect(renameProblem("Handbuch.pdf", "Handbuch 2026.pdf", all)).toBeNull();
    expect(renameProblem("Handbuch.pdf", "handbuch.PDF", all)).toBeNull();
    expect(renameProblem("Handbuch.pdf", "Handbuch.pdf", all)).toBeNull();
    expect(renameProblem("Skizze.excalidraw", "Neu.excalidraw", all)).toBeNull();
  });
  it("refuses reserved characters, folders, other extensions and taken names", () => {
    expect(renameProblem("Handbuch.pdf", "", all)).toMatch(/Namen/);
    expect(renameProblem("Handbuch.pdf", "a/b.pdf", all)).toMatch(/Zeichen/);
    expect(renameProblem("Handbuch.pdf", "a:b.pdf", all)).toMatch(/Zeichen/);
    expect(renameProblem("Handbuch.pdf", "[x].pdf", all)).toMatch(/Zeichen/);
    expect(renameProblem("Handbuch.pdf", ".pdf", all)).toMatch(/Punkt/);
    expect(renameProblem("Handbuch.pdf", "CON.pdf", all)).toMatch(/reserviert/);
    expect(renameProblem("Handbuch.pdf", "Handbuch.docx", all)).toMatch(/\.pdf bleiben/);
    expect(renameProblem("Skizze.excalidraw", "Skizze.png", all)).toMatch(/\.excalidraw bleiben/);
    expect(renameProblem("Handbuch.pdf", "DATEN.xlsx", all)).toMatch(/Dateiendung/);
    expect(renameProblem("bild 2.png", "BILD 10.png", all)).toMatch(/gibt es schon/);
    expect(renameProblem("Skizze.excalidraw", "Plan.excalidraw", all)).toMatch(/gibt es schon/);
    expect(renameProblem("Handbuch.pdf", `${"x".repeat(160)}.pdf`, all)).toMatch(/zu lang/);
  });
  it("selects the stem", () => {
    expect(stemLength("Handbuch.pdf")).toBe(8);
    expect(stemLength("Skizze.excalidraw")).toBe(6);
    expect(stemLength("x.tar.gz")).toBe(5);
  });
});
