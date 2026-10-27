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

describe("replaceChanged (back from the source view, 1.19)", () => {
  it("is one undo step of its own, between the typing before and after it", () => {
    const editor = editorFor("Eins\n\nZwei\n");
    editor.commands.setTextSelection(behind(editor, "Eins"));
    editor.commands.insertContent(" a");
    replaceChanged(editor, "Eins a\n\nZwei b\n\nDrei\n", true);
    expect(toMarkdown(editor)).toBe("Eins a\n\nZwei b\n\nDrei\n");
    // The caret stayed where it was typed; typing goes on there.
    expect(editor.state.selection.from).toBe(behind(editor, "Eins a"));
    editor.commands.insertContent("c");
    expect(toMarkdown(editor)).toBe("Eins ac\n\nZwei b\n\nDrei\n");
    editor.commands.undo();
    expect(toMarkdown(editor)).toBe("Eins a\n\nZwei b\n\nDrei\n");
    editor.commands.undo();
    expect(toMarkdown(editor)).toBe("Eins a\n\nZwei\n");
    editor.commands.undo();
    expect(toMarkdown(editor)).toBe("Eins\n\nZwei\n");
    editor.commands.redo();
    editor.commands.redo();
    expect(toMarkdown(editor)).toBe("Eins a\n\nZwei b\n\nDrei\n");
    editor.destroy();
  });

  it("neither loses nor doubles text that repeats around the change", () => {
    const editor = editorFor("aa\n\naa\n\naa\n");
    replaceChanged(editor, "aa\n\naa\n\naa\n\naa\n", true);
    expect(toMarkdown(editor)).toBe("aa\n\naa\n\naa\n\naa\n");
    replaceChanged(editor, "aa\n\naa\n", true);
    expect(toMarkdown(editor)).toBe("aa\n\naa\n");
    editor.commands.undo();
    expect(toMarkdown(editor)).toBe("aa\n\naa\n\naa\n\naa\n");
    editor.destroy();
  });

  it("keeps the caret between edits far above and far below it", () => {
    const md = Array.from({ length: 60 }, (_, i) => `Absatz ${i} mit Text.`).join("\n\n") + "\n";
    const editor = editorFor(md);
    const at = behind(editor, "Absatz 30 mit");
    editor.commands.setTextSelection(at);
    const next = md.replace("Absatz 2 mit", "Absatz 2 neu mit").replace("Absatz 55 mit Text.", "Absatz 55 mit Text.\n\nEingefügt");
    replaceChanged(editor, next, true);
    expect(toMarkdown(editor)).toBe(next);
    expect(editor.state.selection.from).toBe(at + "neu ".length);
    editor.destroy();
  });

  it("ends with exactly the given text after random edits", () => {
    let seed = 11;
    const rnd = (n: number) => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
    const pool = ["Eins", "Zwei", "Drei", "- Punkt", "## Titel", "Vier und mehr", "Eins"];
    for (let round = 0; round < 40; round++) {
      const blocks = Array.from({ length: 8 + rnd(10) }, () => pool[rnd(pool.length)] + (rnd(3) ? "" : ` ${rnd(5)}`));
      const editor = editorFor(blocks.join("\n\n") + "\n");
      const next = [...blocks];
      for (let e = rnd(5); e >= 0; e--) {
        const i = rnd(next.length + 1);
        const kind = rnd(3);
        if (kind === 0) next.splice(i, 0, pool[rnd(pool.length)]);
        else if (kind === 1 && next.length > 1) next.splice(Math.min(i, next.length - 1), 1);
        else if (next.length) next[Math.min(i, next.length - 1)] += " x";
      }
      // Blocks next to each other that the parser joins (two lists) are written apart as the editor writes them.
      const target = toMarkdown(editorFor(next.join("\n\n") + "\n"));
      replaceChanged(editor, target, round % 2 === 0);
      expect(toMarkdown(editor), `round ${round}`).toBe(target);
      editor.destroy();
    }
  });

  it("changes nothing and adds no step when the text is the same", () => {
    const editor = editorFor("Eins\n\nZwei\n");
    const before = editor.state.doc;
    replaceChanged(editor, "Eins\n\nZwei\n", true);
    expect(editor.state.doc).toBe(before);
    expect(editor.can().undo()).toBe(false);
    editor.destroy();
  });
});
