// Markdown typed in the visual editor becomes what it names (q124 H1): `- [ ] ` a task, also as the
// next item of a bullet list, and `[[Seite]]` typed in full a wiki link.

import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { buildExtensions, toMarkdown } from "./schema";

let editor: Editor | null = null;
afterEach(() => {
  editor?.destroy();
  editor = null;
});

function setup(md: string) {
  const el = document.createElement("div");
  document.body.append(el);
  editor = new Editor({ element: el, extensions: buildExtensions(), content: md, contentType: "markdown" });
  return editor;
}

/** Caret after (or `offset` into) the first text `text`. */
function caretAt(e: Editor, text: string, offset = text.length) {
  let at = -1;
  e.state.doc.descendants((n, pos) => {
    if (at < 0 && n.isText && n.text!.includes(text)) at = pos + n.text!.indexOf(text) + offset;
  });
  e.view.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc, at)));
}

/** Types like the keyboard: each character through the editor's text input handlers (input rules). */
function type(e: Editor, text: string) {
  for (const ch of text) {
    const { from, to } = e.state.selection;
    const done = e.view.someProp("handleTextInput", (f) => f(e.view, from, to, ch, () => e.state.tr.insertText(ch, from, to)));
    if (!done) e.view.dispatch(e.state.tr.insertText(ch, from, to));
  }
}

function key(e: Editor, k: string) {
  const ev = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
  e.view.someProp("handleKeyDown", (f) => f(e.view, ev));
}

describe("`- [ ] ` makes a task (H1-2)", () => {
  it("typed on an empty line", () => {
    const e = setup("\n");
    e.commands.focus("end");
    type(e, "- [ ] Milch");
    expect(toMarkdown(e)).toBe("- [ ] Milch\n");
    const done = setup("\n");
    done.commands.focus("end");
    type(done, "* [x] erledigt");
    expect(toMarkdown(done)).toBe("- [x] erledigt\n");
    done.destroy();
  });

  it("as the next item of a bullet list, the bullets around it stay bullets", () => {
    const e = setup("- a\n- b\n- c\n");
    caretAt(e, "b", 0);
    type(e, "[ ] ");
    expect(toMarkdown(e)).toBe("- a\n- [ ] b\n- c\n");
    caretAt(e, "c");
    key(e, "Enter");
    type(e, "neu");
    expect(toMarkdown(e)).toBe("- a\n- [ ] b\n- c\n- neu\n");
  });

  it("nested, in a callout and with sub-items; the caret stays in the task", () => {
    const nested = setup("- a\n  - b\n");
    caretAt(nested, "b", 0);
    type(nested, "[ ] x");
    expect(toMarkdown(nested)).toBe("- a\n  - [ ] xb\n");
    nested.destroy();
    const callout = setup("> [!todo] T\n>\n> - a\n");
    caretAt(callout, "a", 0);
    type(callout, "[ ] ");
    expect(toMarkdown(callout)).toBe("> [!todo] T\n>\n> - [ ] a\n");
    callout.destroy();
    const parent = setup("- a\n  - c\n- b\n");
    caretAt(parent, "a", 0);
    type(parent, "[ ] ");
    expect(toMarkdown(parent)).toBe("- [ ] a\n  - c\n- b\n");
  });

  it("Backspace right after it gives the typed text back", () => {
    const e = setup("- a\n");
    caretAt(e, "a", 0);
    type(e, "[ ] ");
    key(e, "Backspace");
    expect(e.state.doc.textContent).toBe("[ ] a");
  });
});

describe("`[[Seite]]` typed in full is a link (H1-3)", () => {
  it("with anchor and alias, on the same page, in a table cell", () => {
    const e = setup("\n");
    e.commands.focus("end");
    type(e, "Siehe [[Seite]], [[Seite#Kopf|Alias]] und [[#Abschnitt]] x");
    expect(toMarkdown(e)).toBe("Siehe [[Seite]], [[Seite#Kopf|Alias]] und [[#Abschnitt]] x\n");
    expect(e.state.doc.firstChild!.content.content.filter((n) => n.type.name === "wikiLink").length).toBe(3);
    const table = setup("| A |\n| --- |\n| 1 |\n");
    caretAt(table, "1");
    type(table, " [[Seite|Al]]");
    expect(toMarkdown(table)).toBe("| A |\n| --- |\n| 1 [[Seite\\|Al]] |\n");
    expect(table.state.doc.textContent).toBe("A1 ");
    table.destroy();
  });

  it("stays text in code, after a backslash, as an embed and when empty", () => {
    for (const [typed, out] of [
      ["`[[Seite]]` x", "`[[Seite]]` x\n"],
      ["![[Seite]] x", "!\\[\\[Seite]] x\n"],
      ["[[]] x", "\\[\\[]] x\n"],
    ]) {
      const e = setup("\n");
      e.commands.focus("end");
      type(e, typed);
      expect(toMarkdown(e)).toBe(out);
      e.destroy();
    }
    const code = setup("```\na\n```\n");
    caretAt(code, "a");
    type(code, " [[Seite]]");
    expect(toMarkdown(code)).toBe("```\na [[Seite]]\n```\n");
    code.destroy();
  });

  it("Backspace right after it gives the typed text back", () => {
    const e = setup("\n");
    e.commands.focus("end");
    type(e, "[[Seite]]");
    key(e, "Backspace");
    expect(e.state.doc.textContent).toBe("[[Seite]]");
  });
});
