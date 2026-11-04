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

  // q124 H1-1: Word and Outlook copy a list as `•⇥Punkt` lines (and paragraphs in the HTML): a list, not a table.
  const WORD_ITEM = (level: number, mark: string, text: string, list = "l0") =>
    `<p class=MsoListParagraphCxSpMiddle style='margin-left:${18 * level}pt;text-indent:-18.0pt;mso-list:${list} level${level} lfo1'><![if !supportLists]><span style='font-family:Symbol;mso-fareast-font-family:Symbol'><span style='mso-list:Ignore'>${mark}<span style='font:7.0pt "Times New Roman"'>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; </span></span></span><![endif]><span lang=DE>${text}<o:p></o:p></span></p>`;

  it("pastes a Word list as a list with its levels, numbered and bulleted", () => {
    const html =
      `<html xmlns:o="urn:schemas-microsoft-com:office:office"><body><p class=MsoNormal>Vorher<o:p></o:p></p>\n` +
      [WORD_ITEM(1, "·", "Erster"), WORD_ITEM(2, "o", "Unter <b>fett</b>"), WORD_ITEM(3, "§", "Tiefer"), WORD_ITEM(1, "·", "Zweiter")].join("\n") +
      `\n<p class=MsoNormal>Mitte<o:p></o:p></p>\n` +
      [WORD_ITEM(1, "1.", "Eins", "l1"), WORD_ITEM(2, "a.", "Unterpunkt", "l1"), WORD_ITEM(1, "2.", "Zwei", "l1")].join("\n") +
      `\n</body></html>`;
    const text = "Vorher\r\n·\tErster\r\no\tUnter fett\r\n§\tTiefer\r\n·\tZweiter\r\nMitte\r\n1.\tEins\r\na.\tUnterpunkt\r\n2.\tZwei\r\n";
    const editor = setup("\n");
    // Not taken as a table: the HTML paste of ProseMirror runs with the Word lists made real lists.
    expect(paste(editor, "·\tErster\r\n·\tZweiter\r\n", html)).toBe(false);
    expect(paste(editor, text, html)).toBe(false);
    editor.view.pasteHTML(html);
    expect(toMarkdown(editor)).toBe("Vorher\n\n- Erster\n  - Unter **fett**\n    - Tiefer\n- Zweiter\n\nMitte\n\n1. Eins\n   1. Unterpunkt\n2. Zwei\n");
    editor.destroy();
  });

  it("pastes Word's list as plain text (no HTML) as a list", () => {
    const editor = setup("\n");
    expect(paste(editor, "•\tErster Punkt\r\n•\tZweiter Punkt\r\n")).toBe(true);
    expect(toMarkdown(editor)).toBe("- Erster Punkt\n- Zweiter Punkt\n");
    editor.destroy();
    const numbered = setup("\n");
    expect(paste(numbered, "1.\tEins\r\n2.\tZwei\r\n")).toBe(true);
    expect(toMarkdown(numbered)).toBe("1. Eins\n2. Zwei\n");
    numbered.destroy();
    // Two columns that are no list markers stay a table.
    const table = setup("\n");
    paste(table, "Name\tWert\nA\t1\n");
    expect(toMarkdown(table)).toBe("| Name | Wert |\n| ---- | ---- |\n| A    | 1    |\n");
    table.destroy();
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

  it("„Als Text einfügen“ right after typing keeps the typed text", () => {
    const editor = setup("Start\n\n");
    editor.commands.insertContent("Getippt: ");
    paste(editor, "Name\tStunden\nAnna\t2,5\n");
    document.querySelector<HTMLElement>(".paste-hint")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(editor.state.doc.textContent).toContain("Getippt: ");
    expect(editor.state.doc.textContent).toContain("Name\tStunden");
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

  it("shows Markdown copied as plain text formatted, undoable to the text", () => {
    const editor = setup("Vorher\n\n");
    const md = "## Plan\n\n- [ ] Angebot an [[Kunde X]]\n- **wichtig**\n\n| A   | B   |\n| --- | --- |\n| 1   | 2   |\n";
    expect(paste(editor, md)).toBe(true);
    expect(toMarkdown(editor)).toBe("Vorher\n\n" + md);
    document.querySelector<HTMLElement>(".paste-hint")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(editor.state.doc.textContent).toContain("## Plan");
    editor.destroy();
  });

  it("inserts inline Markdown into the line, also from a code editor's HTML", () => {
    const editor = setup("Start \n");
    expect(paste(editor, "mit **fett** und [[Seite]]", '<div style="white-space: pre;"><span>mit **fett** und [[Seite]]</span></div>')).toBe(true);
    expect(toMarkdown(editor)).toBe("Start mit **fett** und [[Seite]]\n");
    editor.destroy();
  });

  it("leaves web pages, lone list-like lines and prose with stars to the normal paste", () => {
    const editor = setup("\n");
    expect(paste(editor, "## Titel\n- a\n- b", "<h2>Titel</h2><ul><li>a</li><li>b</li></ul>")).toBe(false);
    expect(paste(editor, "- nur eine Zeile")).toBe(false);
    expect(paste(editor, "2*3*4 ergibt 24\nund a_b_c bleibt")).toBe(false);
    editor.destroy();
  });

  it("cleans titles", () => {
    expect(cleanTitle("  a \n b ", "u")).toBe("a b");
    expect(cleanTitle("u", "u")).toBeNull();
    expect(cleanTitle(null, "u")).toBeNull();
    expect(cleanTitle("x".repeat(300), "u")!.length).toBe(200);
  });
});
