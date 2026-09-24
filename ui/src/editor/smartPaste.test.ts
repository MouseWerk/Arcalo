import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { Slice } from "@tiptap/pm/model";
import { buildExtensions, toMarkdown } from "./schema";
import { cleanTitle } from "./smartPaste";

function setup(md: string, fetchTitle?: (url: string) => Promise<string | null>) {
  const el = document.createElement("div");
  document.body.append(el);
  const editor = new Editor({ element: el, extensions: buildExtensions({ fetchTitle }), content: md, contentType: "markdown" });
  editor.commands.setTextSelection(editor.state.doc.content.size - 1);
  return editor;
}

/** Runs the editor's paste handlers like ProseMirror does for a paste event. */
function paste(editor: Editor, text: string, html = "") {
  const event = { clipboardData: { getData: (t: string) => (t === "text/plain" ? text : t === "text/html" ? html : ""), files: [] }, preventDefault() {} } as unknown as ClipboardEvent;
  return editor.view.someProp("handlePaste", (f) => f(editor.view, event, Slice.empty)) ?? false;
}

describe("smart paste", () => {
  it("turns Excel rows into a table with a header row", () => {
    const editor = setup("Daten:\n\n");
    expect(paste(editor, "Name\tStunden\nAnna\t2,5\n")).toBe(true);
    expect(toMarkdown(editor)).toBe("Daten:\n\n| Name | Stunden |\n| ---- | ------- |\n| Anna | 2,5     |\n");
    expect(document.querySelector(".paste-hint")?.textContent).toBe("Als Text einfügen");
    editor.destroy();
  });

  it("turns a stack trace into a code block", () => {
    const editor = setup("\n");
    paste(editor, "Traceback (most recent call last):\n  File \"a.py\", line 1, in <module>\nNameError: x");
    expect(toMarkdown(editor)).toBe('```python\nTraceback (most recent call last):\n  File "a.py", line 1, in <module>\nNameError: x\n```\n');
    editor.destroy();
  });

  it("turns a Teams copy into a list with muted times", () => {
    const editor = setup("\n");
    paste(editor, "[10:32] Max Mustermann\nHallo\n[10:33] Erika Musterfrau\nHi\nwie geht's?\n");
    expect(toMarkdown(editor)).toBe("- **Max Mustermann** (10:32): Hallo\n- **Erika Musterfrau** (10:33): Hi  \nwie geht's?\n");
    expect([...editor.view.dom.querySelectorAll(".chat-time")].map((e) => e.textContent)).toEqual(["(10:32)", "(10:33)"]);
    editor.destroy();
  });

  it("gives a pasted URL the page title, keeps it undoable to plain text", async () => {
    let resolve!: (t: string) => void;
    const editor = setup("Siehe \n", () => new Promise((r) => (resolve = r)));
    editor.commands.setTextSelection(7);
    paste(editor, "https://example.com/a");
    expect(toMarkdown(editor)).toBe("Siehe https://example.com/a\n");
    resolve("  Beispiel\n Seite ");
    await new Promise((r) => setTimeout(r, 0));
    expect(toMarkdown(editor)).toBe("Siehe [Beispiel Seite](https://example.com/a)\n");
    // „Als Text einfügen“
    document.querySelector<HTMLElement>(".paste-hint")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(toMarkdown(editor)).toBe("Siehe https://example.com/a\n");
    expect(editor.state.doc.textContent).toBe("Siehe https://example.com/a");
    expect(document.querySelector(".paste-hint")).toBeNull();
    editor.destroy();
  });

  it("undoes a table into the plain text", () => {
    const editor = setup("Vorher\n\n");
    paste(editor, "A\tB\nC\tD");
    document.querySelector<HTMLElement>(".paste-hint")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(editor.state.doc.textContent).toContain("A\tB");
    expect(editor.getJSON().content?.some((n) => n.type === "table")).toBe(false);
    editor.destroy();
  });

  it("leaves prose, pastes inside code and in-editor copies to the normal paste", () => {
    const editor = setup("```\nx\n```\n");
    expect(paste(editor, "A\tB\nC\tD")).toBe(false);
    editor.destroy();
    const e2 = setup("\n");
    expect(paste(e2, "Ein Absatz.\nNoch einer.")).toBe(false);
    expect(paste(e2, "A\tB\nC\tD", '<table data-pm-slice="0 0 []"></table>')).toBe(false);
    e2.destroy();
  });

  it("cleans titles", () => {
    expect(cleanTitle("  a \n b ", "u")).toBe("a b");
    expect(cleanTitle("u", "u")).toBeNull();
    expect(cleanTitle(null, "u")).toBeNull();
    expect(cleanTitle("x".repeat(300), "u")!.length).toBe(200);
  });
});
