// q124 H1, editor core: what users type in Markdown becomes the block it names (`- [ ] ` a task,
// `[[Seite]]` a link), lists from Word and Outlook paste as lists, tables take Tab and undo,
// typing with umlauts survives undo and redo, and a note goes to the source view and back unchanged.

import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
before(async () => (app = await launch({ width: 1280, height: 860 })));
after(async () => app?.close());

const ED = ".pane.active > .pane-content:not([hidden]) .ProseMirror";
const ids = {};
const content = async (title) => (await app.invoke("page_get", { id: ids[title] })).content;
const waitContent = (title, test, msg) =>
  app.browser.waitUntil(async () => test(await content(title)), { timeout: 8000, timeoutMsg: msg ?? `${title} not saved as expected` });

async function openPage(title, md) {
  ids[title] = (await app.invoke("page_create", { parentId: null, title, icon: "file-text", content: md })).id;
  // Opened the way quick search opens a hit.
  await app.invoke("search_open", { target: { kind: "page", page_id: ids[title], new_tab: false } });
  await app.browser.waitUntil(() => app.browser.execute((sel, t) => document.querySelector(".pane.active .page-title")?.value === t && !!document.querySelector(sel), ED, title), { timeout: 8000 });
}

/** Caret after `text` in the open note (its editor's selection, then the DOM's). */
async function caretAfter(text, offset = text.length) {
  await app.browser.execute(
    (sel, t, off) => {
      const ed = document.querySelector(sel).editor;
      let at = -1;
      ed.state.doc.descendants((n, pos) => {
        if (at >= 0 || !n.isText) return;
        const i = n.text.indexOf(t);
        if (i >= 0) at = pos + i + off;
      });
      ed.commands.focus();
      ed.commands.setTextSelection(at);
    },
    ED,
    text,
    offset,
  );
  await app.browser.pause(80);
}

/** Dispatches a paste event carrying `text` (and `html`) on the active editor, like Ctrl+V. */
async function paste(text, html = "") {
  return app.browser.execute(
    (sel, t, h) => {
      const dt = new DataTransfer();
      dt.setData("text/plain", t);
      if (h) dt.setData("text/html", h);
      let ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
      if (!ev.clipboardData) {
        ev = new Event("paste", { bubbles: true, cancelable: true });
        Object.defineProperty(ev, "clipboardData", { value: dt });
      }
      document.querySelector(sel).dispatchEvent(ev);
    },
    ED,
    text,
    html,
  );
}

test("`- [ ] ` typed in Markdown makes a task, also as the next item of a bullet list", async () => {
  await openPage("Aufgaben 450", "# Aufgaben 450\n\n- Punkt\n");
  await caretAfter("Punkt");
  await app.keys(["Enter"]);
  await app.type("[ ] Milch kaufen");
  await app.keys(["Enter"]);
  await app.type("Brot");
  await waitContent("Aufgaben 450", (c) => c.includes("Brot"));
  assert.equal(await content("Aufgaben 450"), "# Aufgaben 450\n\n- Punkt\n- [ ] Milch kaufen\n- [ ] Brot\n");
  // A fresh line: `- [x] ` the way it is written in Markdown.
  await app.keys(["Enter"]);
  await app.keys(["Enter"]);
  await app.type("- [x] erledigt");
  await waitContent("Aufgaben 450", (c) => c.includes("erledigt"));
  assert.equal(await content("Aufgaben 450"), "# Aufgaben 450\n\n- Punkt\n- [ ] Milch kaufen\n- [ ] Brot\n\n- [x] erledigt\n");
  assert.equal(await app.browser.execute((sel) => document.querySelectorAll(`${sel} li[data-checked]`).length, ED), 3);
});

test("`[[Seite]]` typed in full is a link, not escaped text", async () => {
  await openPage("Links 450", "# Links 450\n\nSiehe\n");
  await caretAfter("Siehe");
  await app.type(" [[Architektur]] und weiter");
  await waitContent("Links 450", (c) => c.includes("weiter"));
  assert.equal(await content("Links 450"), "# Links 450\n\nSiehe [[Architektur]] und weiter\n");
  assert.equal(await app.browser.execute((sel) => document.querySelector(`${sel} a.wikilink`)?.textContent, ED), "Architektur");
});

test("a list copied from Word pastes as a list with its levels", async () => {
  await openPage("Word 450", "# Word 450\n");
  await caretAfter("Word 450");
  await app.keys(["Enter"]);
  const item = (level, mark, text) =>
    `<p class=MsoListParagraphCxSpMiddle style='margin-left:${18 * level}pt;text-indent:-18.0pt;mso-list:l0 level${level} lfo1'><!--[if !supportLists]--><span style='font-family:Symbol'><span style='mso-list:Ignore'>${mark}<span style='font:7.0pt "Times New Roman"'>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; </span></span></span><!--[endif]--><span lang=DE>${text}<o:p></o:p></span></p>`;
  const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office"><body><!--StartFragment-->${item(1, "·", "Angebot prüfen")}${item(2, "o", "Preise")}${item(1, "·", "Termin")}<!--EndFragment--></body></html>`;
  await paste("·\tAngebot prüfen\r\no\tPreise\r\n·\tTermin\r\n", html);
  await waitContent("Word 450", (c) => c.includes("Termin"));
  assert.equal(await content("Word 450"), "# Word 450\n\n- Angebot prüfen\n  - Preise\n- Termin\n");
  assert.equal(await app.browser.execute((sel) => document.querySelectorAll(`${sel} table`).length, ED), 0);
});

test("HTML from a browser and from Google Docs pastes as its blocks, not all bold", async () => {
  await openPage("Web 450", "# Web 450\n");
  await caretAfter("Web 450");
  await app.keys(["Enter"]);
  await paste(
    "Titel\nText mit Link\na\nb",
    '<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-4a1"><h2 dir="ltr"><span>Titel</span></h2><p dir="ltr"><span style="font-weight:400">Text mit </span><a href="https://example.com/x"><span>Link</span></a><span style="font-weight:700"> fett</span></p><ol><li><p><span>a</span></p><ul><li><p><span>b</span></p></li></ul></li></ol></b>',
  );
  await waitContent("Web 450", (c) => c.includes("Titel"));
  assert.equal(await content("Web 450"), "# Web 450\n\n## Titel\n\nText mit [Link](https://example.com/x) **fett**\n\n1. a\n   - b\n");
});

test("a table: Tab walks the cells and adds a row at the end, undo takes the typing back", async () => {
  await openPage("Tabelle 450", "# Tabelle 450\n\n| Name | Stunden |\n| ---- | ------- |\n| Anna | 2       |\n");
  await caretAfter("Anna");
  await app.keys(["Tab"]);
  await app.keys(["Tab"]);
  await app.type("Jörg");
  await app.keys(["Tab"]);
  await app.type("3,5");
  await waitContent("Tabelle 450", (c) => c.includes("3,5"));
  assert.equal(await content("Tabelle 450"), "# Tabelle 450\n\n| Name | Stunden |\n| ---- | ------- |\n| Anna | 2       |\n| Jörg | 3,5     |\n");
  await app.keys(["Control", "z"]);
  await app.keys(["Control", "z"]);
  await app.keys(["Control", "z"]);
  await waitContent("Tabelle 450", (c) => !c.includes("Jörg"));
  await app.keys(["Control", "Shift", "z"]);
  await app.keys(["Control", "Shift", "z"]);
  await app.keys(["Control", "Shift", "z"]);
  await waitContent("Tabelle 450", (c) => c.includes("3,5"), "redo did not bring the row back");
  assert.equal(await content("Tabelle 450"), "# Tabelle 450\n\n| Name | Stunden |\n| ---- | ------- |\n| Anna | 2       |\n| Jörg | 3,5     |\n");
});

test("umlauts typed, undone and redone come back the same; Ctrl+Y redoes too", async () => {
  await openPage("Umlaute 450", "# Umlaute 450\n\nStart\n");
  await caretAfter("Start");
  await app.keys(["Enter"]);
  await app.type("Grüße aus Köln, Maß und Übergröße: äöüß ÄÖÜ €");
  await waitContent("Umlaute 450", (c) => c.includes("€"));
  const typed = await content("Umlaute 450");
  assert.equal(typed, "# Umlaute 450\n\nStart\n\nGrüße aus Köln, Maß und Übergröße: äöüß ÄÖÜ €\n");
  for (let i = 0; i < 6; i++) await app.keys(["Control", "z"]);
  await waitContent("Umlaute 450", (c) => c === "# Umlaute 450\n\nStart\n", "undo did not take the typing back");
  for (let i = 0; i < 6; i++) await app.keys(["Control", "y"]);
  await waitContent("Umlaute 450", (c) => c === typed, "Ctrl+Y did not redo");
});

test("visual → source → visual keeps a note with every block unchanged", async () => {
  const md = [
    "# Quelle 450",
    "",
    "> [!warning] Achtung",
    "> Text mit **fett** und [[Architektur|Alias]]",
    "",
    "- [ ] Aufgabe due:2026-12-01 !!",
    "  - Unterpunkt",
    "",
    "1. Eins",
    "2. Zwei",
    "",
    "| A   | B             |",
    "| --- | ------------- |",
    "| 1   | [[Seite\\|x]] |",
    "",
    "Fußnote[^1] und ==markiert==, `code` und #tag.",
    "",
    "```ts",
    "const x = 1;",
    "```",
    "",
    "[^1]: Die Fußnote.",
    "",
  ].join("\n");
  await openPage("Quelle 450", md);
  await caretAfter("Zwei");
  await app.type(" neu");
  const expected = md.replace("2. Zwei", "2. Zwei neu");
  await waitContent("Quelle 450", (c) => c.includes("Zwei neu"));
  assert.equal(await content("Quelle 450"), expected);
  // To the source view (the page menu's command) and back: the text there is the file, nothing is saved.
  const shown = ".pane.active > .pane-content:not([hidden])";
  await app.browser.execute(() => window.dispatchEvent(new CustomEvent("arcalo:page-command", { detail: "source" })));
  await app.browser.waitUntil(() => app.browser.execute((s) => !!document.querySelector(`${s} .source-text`)?.value, shown), { timeoutMsg: "no source view" });
  assert.equal(await app.browser.execute((s) => document.querySelector(`${s} .source-text`).value, shown), expected);
  await app.browser.execute(() => window.dispatchEvent(new CustomEvent("arcalo:page-command", { detail: "source" })));
  await app.browser.waitUntil(() => app.browser.execute((s) => !document.querySelector(`${s} .source-text`) && !!document.querySelector(`${s} .ProseMirror`), shown), { timeoutMsg: "not back in the visual view" });
  // Typing after the way back still changes only that line.
  await caretAfter("Eins");
  await app.type("!");
  await waitContent("Quelle 450", (c) => c.includes("Eins!"));
  assert.equal(await content("Quelle 450"), expected.replace("1. Eins", "1. Eins!"));
});

test("renaming a linked page while its link is open: undo takes back only the typing", async () => {
  ids["Ziel 450"] = (await app.invoke("page_create", { parentId: null, title: "Ziel 450", icon: "file-text", content: "# Ziel 450\n" })).id;
  await openPage("Quelle Link 450", "# Quelle Link 450\n\nNach [[Ziel 450]] hier\n");
  await caretAfter("hier");
  await app.type(" getippt");
  await waitContent("Quelle Link 450", (c) => c.includes("getippt"));
  // What the rename in the tree does: the command, then the open editors reload.
  await app.invoke("page_rename", { id: ids["Ziel 450"], title: "Ziel neu 450", updateLinks: true });
  await app.browser.execute(() => window.dispatchEvent(new CustomEvent("arcalo:reload-pages", { detail: {} })));
  await app.browser.waitUntil(() => app.browser.execute((sel) => document.querySelector(`${sel} a.wikilink`)?.textContent === "Ziel neu 450", ED), { timeoutMsg: "the open note did not take the renamed link" });
  await caretAfter("getippt");
  await app.keys(["Control", "z"]);
  await waitContent("Quelle Link 450", (c) => !c.includes("getippt"), "undo did not take the typing back");
  assert.equal(await content("Quelle Link 450"), "# Quelle Link 450\n\nNach [[Ziel neu 450]] hier\n");
});

test("no console errors", async () => {
  assert.deepEqual(await app.consoleErrors(), []);
});
