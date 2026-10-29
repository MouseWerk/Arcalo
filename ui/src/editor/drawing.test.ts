import { describe, expect, it } from "vitest";
import { drawingLabel, drawingTitle, inDrawing, isDrawingName, isExternalLink, sceneHasContent } from "./drawing";

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

  it("tells an empty scene from one without a preview", () => {
    expect(sceneHasContent('{"type":"excalidraw","elements":[]}')).toBe(false);
    expect(sceneHasContent('{"elements":[{"id":"a","isDeleted":true}]}')).toBe(false);
    expect(sceneHasContent('{"elements":[{"id":"a","type":"rectangle"}]}')).toBe(true);
    expect(sceneHasContent("")).toBe(false);
    expect(sceneHasContent("kein JSON")).toBe(true);
  });
});

describe("drawing editor bounds", () => {
  it("counts Excalidraw's dialogs on <body> as part of the drawing, the note behind it not", () => {
    document.body.innerHTML = `<div class="ProseMirror"><p>Notiz</p></div><div class="drawing-overlay"><canvas></canvas></div><div class="excalidraw excalidraw-modal-container"><div class="Modal"><textarea class="ttd-dialog-input"></textarea></div></div>`;
    const root = document.querySelector(".drawing-overlay")!;
    expect(inDrawing(root, root.querySelector("canvas"))).toBe(true);
    expect(inDrawing(root, document.querySelector(".ttd-dialog-input"))).toBe(true);
    expect(inDrawing(root, document.querySelector(".ProseMirror p")!.firstChild)).toBe(false);
    expect(inDrawing(root, document.body)).toBe(false);
    expect(inDrawing(root, null)).toBe(false);
  });
  it("opens only web and mail links outside the app", () => {
    for (const ok of ["https://mermaid.js.org/syntax/flowchart.html", "http://example.org", "mailto:a@b.de"]) expect(isExternalLink(ok), ok).toBe(true);
    for (const bad of ["/seite", "#x", "javascript:alert(1)", "tauri://localhost/?element=abc", "file:///etc/passwd"]) expect(isExternalLink(bad), bad).toBe(false);
  });
});
