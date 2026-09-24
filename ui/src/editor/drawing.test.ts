import { describe, expect, it } from "vitest";
import { drawingLabel, drawingTitle, isDrawingName } from "./drawing";

describe("drawing names", () => {
  it("accepts plain .excalidraw file names", () => {
    for (const ok of ["Zeichnung 2026-09-24 14.05.excalidraw", "a.excalidraw", "Skizze.Excalidraw", "Ablauf (v2).excalidraw"]) expect(isDrawingName(ok), ok).toBe(true);
  });
  it("rejects folders, hidden files and other types", () => {
    const bad = ["", ".excalidraw", "a.png", "a.excalidraw.svg", "a.excalidraw.md", "../a.excalidraw", "ordner/a.excalidraw", "ordner\\a.excalidraw", "C:a.excalidraw", ".versteckt.excalidraw", "zeile\nzwei.excalidraw", `${"x".repeat(200)}.excalidraw`];
    for (const name of bad) expect(isDrawingName(name), JSON.stringify(name)).toBe(false);
  });
  it("titles new drawings by date and time", () => {
    expect(drawingTitle(new Date(2026, 8, 24, 14, 5))).toBe("Zeichnung 2026-09-24 14.05");
    expect(isDrawingName(`${drawingTitle()}.excalidraw`)).toBe(true);
  });
  it("labels drawings without folder and suffix", () => {
    expect(drawingLabel("Skizzen/Plan.excalidraw")).toBe("Plan");
  });
});
