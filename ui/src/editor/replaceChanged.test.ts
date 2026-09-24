import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { buildExtensions, toMarkdown } from "./schema";
import { replaceChanged } from "./replaceChanged";

const editorFor = (md: string) => new Editor({ element: document.createElement("div"), extensions: buildExtensions(), content: md, contentType: "markdown" });

/** Position just behind the first occurrence of `text`. */
function behind(editor: Editor, text: string): number {
  let at = -1;
  editor.state.doc.descendants((n, pos) => {
    if (at < 0 && n.isText && n.text!.includes(text)) at = pos + n.text!.indexOf(text) + text.length;
  });
  return at;
}

describe("replaceChanged (content from another pane)", () => {
  it("keeps the caret on its text when a paragraph above is added", () => {
    const editor = editorFor("Eins\n\nZwei hier\n");
    editor.commands.setTextSelection(behind(editor, "Zwei"));
    replaceChanged(editor, "Neu oben\n\nEins\n\nZwei hier\n");
    expect(toMarkdown(editor)).toBe("Neu oben\n\nEins\n\nZwei hier\n");
    expect(editor.state.selection.from).toBe(behind(editor, "Zwei"));
    editor.destroy();
  });

  it("keeps the caret when text below changes", () => {
    const editor = editorFor("Eins hier\n\nZwei\n");
    const at = behind(editor, "Eins");
    editor.commands.setTextSelection(at);
    replaceChanged(editor, "Eins hier\n\nZwei und mehr\n\nDrei\n");
    expect(toMarkdown(editor)).toBe("Eins hier\n\nZwei und mehr\n\nDrei\n");
    expect(editor.state.selection.from).toBe(at);
    editor.destroy();
  });

  it("does not add the change to the own undo history", () => {
    const editor = editorFor("A\n");
    editor.commands.setTextSelection(2);
    editor.commands.insertContent("x");
    replaceChanged(editor, "Ax\n\nB\n");
    editor.commands.undo();
    expect(toMarkdown(editor)).toBe("A\n\nB\n");
    editor.destroy();
  });
});
