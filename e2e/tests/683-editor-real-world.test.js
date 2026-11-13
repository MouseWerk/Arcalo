// q124 round 6, hunt A (docs/quality/q124/r6-editor-import-export.md): everyday text and notes
// from Obsidian and Typora edited in the app keep what they say (`C++`, `a == b`, „ca. 5 Minuten“,
// numbered tasks, LaTeX line ends), a single cell copied from Excel pastes as its text, and an
// Obsidian vault with two images of one name keeps each path embed on its own image.

import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app, vault;

const ED = ".pane.active > .pane-content:not([hidden]) .ProseMirror";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const PNG2 = Buffer.concat([PNG, Buffer.from("zweites Bild")]);

before(async () => {
  vault = fs.mkdtempSync(path.join(os.tmpdir(), "vault-paths-"));
  const write = (rel, data) => {
    const p = path.join(vault, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, data);
  };
  fs.mkdirSync(path.join(vault, ".obsidian"));
  write("Projekt A/assets/bild.png", PNG);
  write("Projekt B/assets/bild.png", PNG2);
  write("Projekt B/Notiz B.md", "![[bild.png]]\n");
  write("Übersicht 683.md", "![[Projekt A/assets/bild.png]]\n\n![[Projekt B/assets/bild.png|200]]\n");
  app = await launch({ demo: false });
});

after(async () => {
  await app?.close();
  if (vault) fs.rmSync(vault, { recursive: true, force: true });
});

const ids = {};
const content = async (title) => (await app.invoke("page_get", { id: ids[title] })).content;

async function openPage(title, md) {
  ids[title] = (await app.invoke("page_create", { parentId: null, title, icon: "file-text", content: md })).id;
  await app.invoke("search_open", { target: { kind: "page", page_id: ids[title], new_tab: false } });
  await app.browser.waitUntil(() => app.browser.execute((sel, t) => document.querySelector(".pane.active .page-title")?.value === t && !!document.querySelector(sel), ED, title), { timeout: 8000 });
}

/** Caret after `text` in the open note. */
async function caretAfter(text) {
  await app.browser.execute(
    (sel, t) => {
      const ed = document.querySelector(sel).editor;
      let at = -1;
      ed.state.doc.descendants((n, pos) => {
        if (at >= 0 || !n.isText) return;
        const i = n.text.indexOf(t);
        if (i >= 0) at = pos + i + t.length;
      });
      ed.commands.focus();
      ed.commands.setTextSelection(at);
    },
    ED,
    text,
  );
  await app.browser.pause(80);
}

const shownText = () => app.browser.execute((sel) => document.querySelector(sel).innerText, ED);

test("operators, abbreviations, numbered tasks and LaTeX stay as written when the note is edited", async () => {
  const md = [
    "C++ und C++ sind Sprachen, a == b und c == d.",
    "",
    "ca. 5 bis 10 Minuten",
    "",
    "Fr. Müller kommt",
    "",
    "1. [ ] Angebot schreiben",
    "2. [x] Termin",
    "",
    "$$",
    "\\begin{aligned}",
    "a &= b \\\\",
    "c &= d",
    "\\end{aligned}",
    "$$",
    "",
  ].join("\n");
  await openPage("Alltag 683", md);
  const shown = await shownText();
  for (const s of ["C++ und C++ sind Sprachen, a == b und c == d.", "ca. 5 bis 10 Minuten", "Fr. Müller kommt", "[ ] Angebot schreiben", "[x] Termin"]) {
    assert.ok(shown.includes(s), `shown: ${s}\n${shown}`);
  }
  const marked = await app.browser.execute((sel) => document.querySelectorAll(`${sel} mark, ${sel} u`).length, ED);
  assert.equal(marked, 0, "nothing highlighted or underlined");
  // One edit in each block.
  for (const [after, typed] of [["Sprachen", "!"], ["Minuten", " Pause"], ["kommt", " heute"], ["Termin", " fix"], ["c &= d", " + e"]]) {
    await caretAfter(after);
    await app.type(typed);
  }
  const want = md
    .replace("Sprachen,", "Sprachen!,")
    .replace("Minuten", "Minuten Pause")
    .replace("kommt", "kommt heute")
    .replace("Termin", "Termin fix")
    .replace("c &= d", "c &= d + e");
  await app.browser.waitUntil(async () => (await content("Alltag 683")).includes("c &= d + e"), { timeout: 8000, timeoutMsg: "the last edit is not saved" });
  assert.equal(await content("Alltag 683"), want);
});

test("a single cell copied from Excel pastes as its text, not as a table", async () => {
  await openPage("Zelle 683", "Wert: \n");
  await caretAfter("Wert: ");
  const html =
    '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel"><body link="#0563C1">' +
    "<table border=0 cellpadding=0 cellspacing=0 width=64><col width=64><!--StartFragment--><tr height=20><td height=20 width=64>42,5 <b>h</b></td></tr><!--EndFragment--></table></body></html>";
  await app.browser.execute(
    (sel, h) => {
      const dt = new DataTransfer();
      dt.setData("text/plain", "42,5 h\r\n");
      dt.setData("text/html", h);
      let ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
      if (!ev.clipboardData) {
        ev = new Event("paste", { bubbles: true, cancelable: true });
        Object.defineProperty(ev, "clipboardData", { value: dt });
      }
      document.querySelector(sel).dispatchEvent(ev);
    },
    ED,
    html,
  );
  await app.browser.waitUntil(async () => (await content("Zelle 683")).includes("42,5"), { timeout: 8000, timeoutMsg: "the paste is not saved" });
  assert.equal(await content("Zelle 683"), "Wert: 42,5 **h**\n");
  const tables = await app.browser.execute((sel) => document.querySelectorAll(`${sel} table`).length, ED);
  assert.equal(tables, 0);
});

test("an Obsidian vault's path embeds of two images of one name show each its own image", async () => {
  const report = await app.invoke("vault_import", { path: vault });
  assert.equal(report.attachments, 2);
  const rows = await app.invoke("workspace_tree_compact");
  const all = [];
  const walk = (list) => list.forEach((r) => (all.push({ id: r[0], title: r[2] }), walk(r[12] ?? [])));
  walk(rows);
  const text = async (title) => (await app.invoke("page_get", { id: all.find((p) => p.title === title).id })).content;
  const overview = await text("Übersicht 683");
  const names = [...overview.matchAll(/!\[\[(?:[^\]|]*\/)?([^\]/|]+)(?:\|[^\]]*)?\]\]/g)].map((m) => m[1]);
  assert.equal(names.length, 2, overview);
  const sizes = await Promise.all(names.map((name) => app.invoke("attachment_size", { name })));
  assert.deepEqual(sizes, [PNG.length, PNG2.length], `A's path shows A's image, B's path B's: ${overview}`);
  const noteB = await text("Notiz B");
  const nameB = /!\[\[([^\]|]+)/.exec(noteB)[1];
  assert.equal(await app.invoke("attachment_size", { name: nameB }), PNG2.length, "the bare name in B's folder is B's image");
});
