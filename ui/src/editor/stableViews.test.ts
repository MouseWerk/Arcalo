// Tiptap's React binding hands the editor its node views again when the content mounts and takes them
// away when it unmounts: neither may draw the note anew (in a long note each took as long as opening it).

import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { buildExtensions } from "./schema";

describe("node views", () => {
  it("stay as created when the content mounts and unmounts", () => {
    const md = Array.from({ length: 30 }, (_, i) => `## Teil ${i}\n\nText ${i} mit [[Seite ${i}]].\n\n- [ ] Aufgabe ${i}`).join("\n\n");
    const editor = new Editor({ element: document.createElement("div"), extensions: buildExtensions(), content: md, contentType: "markdown" });
    const blocks = () => [...editor.view.dom.children];
    const before = blocks();
    const task = editor.view.dom.querySelector("li[data-checked]");
    expect(task).not.toBeNull();
    // What EditorContent does on mount (`createNodeViews`) and on unmount.
    editor.createNodeViews();
    editor.view.setProps({ nodeViews: {} });
    expect(blocks()).toEqual(before);
    expect(blocks().every((b, i) => b === before[i])).toBe(true);
    expect(editor.view.dom.querySelector("li[data-checked]")).toBe(task);
    // Other props still apply.
    editor.view.setProps({ editable: () => false });
    expect(editor.view.dom.getAttribute("contenteditable")).toBe("false");
    editor.destroy();
  });
});
