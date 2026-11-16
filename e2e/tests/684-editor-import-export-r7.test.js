// q124 round 7, hunt A (docs/quality/q124/r7-editor-import-export.md): a list with letters keeps
// them when edited, an indented line inside a paragraph keeps its blanks, an Obsidian vault's path
// links open the imported page, the Markdown export's links name the files of titles a file name
// cannot hold, a web table with a list in a cell pastes the items on lines of their own, and
// /Hinweisbox in a list item adds a callout instead of writing `[!note]` into the line.

import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app, vault, out;

const ED = ".pane.active > .pane-content:not([hidden]) .ProseMirror";

before(async () => {
  vault = fs.mkdtempSync(path.join(os.tmpdir(), "vault-links-"));
  out = fs.mkdtempSync(path.join(os.tmpdir(), "export-links-"));
  const write = (rel, data) => {
    const p = path.join(vault, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, data);
  };
  fs.mkdirSync(path.join(vault, ".obsidian"));
  write("Projekte 684/Alpha/Plan 684.md", "# Plan\n\nDer Plan.\n");
  write("Start 684.md", "Siehe [[Projekte 684/Alpha/Plan 684]] und [[Projekte 684/Alpha/Plan 684#Plan|den Plan]].\n");
  app = await launch({ demo: false });
});

after(async () => {
  await app?.close();
  for (const d of [vault, out]) if (d) fs.rmSync(d, { recursive: true, force: true });
});

const ids = {};
const content = async (title) => (await app.invoke("page_get", { id: ids[title] })).content;
const activeTitle = () => app.browser.execute(() => document.querySelector(".pane.active .page-title")?.value);

async function show(id, title) {
  await app.invoke("search_open", { target: { kind: "page", page_id: id, new_tab: false } });
  await app.browser.waitUntil(() => app.browser.execute((sel, t) => document.querySelector(".pane.active .page-title")?.value === t && !!document.querySelector(sel), ED, title), { timeout: 8000 });
}

async function openPage(title, md) {
  ids[title] = (await app.invoke("page_create", { parentId: null, title, icon: "file-text", content: md })).id;
  await show(ids[title], title);
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

test("a list with letters keeps them and an indented line keeps its blanks when edited", async () => {
  const md = "a. Angebot\nb. Termin\n\ni. eins\nii. zwei\niii. drei\n\nAdresse:\n    Musterstraße 1\n    12345 Stadt\n";
  await openPage("Buchstaben 684", md);
  const types = await app.browser.execute((sel) => [...document.querySelectorAll(`${sel} ol`)].map((o) => o.getAttribute("type")), ED);
  assert.deepEqual(types, ["a", "i"]);
  for (const [after, typed] of [["Termin", " fix"], ["drei", "!"], ["12345 Stadt", " Mitte"]]) {
    await caretAfter(after);
    await app.type(typed);
  }
  const want = md.replace("Termin", "Termin fix").replace("drei", "drei!").replace("12345 Stadt", "12345 Stadt Mitte");
  await app.browser.waitUntil(async () => (await content("Buchstaben 684")).includes("Stadt Mitte"), { timeout: 8000, timeoutMsg: "the last edit is not saved" });
  assert.equal(await content("Buchstaben 684"), want);
});

test("an Obsidian vault's path links open the imported page", async () => {
  await app.invoke("vault_import", { path: vault });
  const rows = await app.invoke("workspace_tree_compact");
  const all = [];
  const walk = (list) => list.forEach((r) => (all.push({ id: r[0], title: r[2] }), walk(r[12] ?? [])));
  walk(rows);
  const start = all.find((p) => p.title === "Start 684");
  await show(start.id, "Start 684");
  const links = await app.browser.execute((sel) => [...document.querySelectorAll(`${sel} a.wikilink`)].map((a) => ({ text: a.textContent, unresolved: a.classList.contains("unresolved") })), ED);
  assert.deepEqual(links, [
    { text: "Projekte 684/Alpha/Plan 684", unresolved: false },
    { text: "den Plan", unresolved: false },
  ]);
  const before = all.length;
  await (await app.$(`${ED} a.wikilink`)).click();
  await app.browser.waitUntil(async () => (await activeTitle()) === "Plan 684", { timeout: 8000, timeoutMsg: "the link does not open the imported page" });
  const now = [];
  const again = (list) => list.forEach((r) => (now.push(r[0]), again(r[12] ?? [])));
  again(await app.invoke("workspace_tree_compact"));
  assert.equal(now.length, before, "no page is created for the link");
});

test("the Markdown export's links name the file of a title with a colon", async () => {
  ids["Meeting: Kunde 684"] = (await app.invoke("page_create", { parentId: null, title: "Meeting: Kunde 684", icon: "file-text", content: "Notizen\n" })).id;
  ids["Verweis 684"] = (await app.invoke("page_create", { parentId: null, title: "Verweis 684", icon: "file-text", content: "Siehe [[Meeting: Kunde 684]].\n" })).id;
  await app.invoke("vault_export", { path: out });
  const find = (dir, name) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        const hit = find(p, name);
        if (hit) return hit;
      } else if (e.name === name) return p;
    }
    return null;
  };
  const target = find(out, "Meeting- Kunde 684.md");
  assert.ok(target, "the page is exported under a file name without the colon");
  assert.equal(fs.readFileSync(find(out, "Verweis 684.md"), "utf8"), "Siehe [[Meeting- Kunde 684|Meeting: Kunde 684]].\n");
  // The page in the app is unchanged.
  assert.equal(await content("Verweis 684"), "Siehe [[Meeting: Kunde 684]].\n");
});

test("a web table with a list in a cell pastes the items on lines of their own", async () => {
  await openPage("Tabelle 684", "Stand:\n");
  await caretAfter("Stand:");
  const html =
    '<meta charset="utf-8"><table class="confluenceTable"><tbody><tr><th class="confluenceTh">Thema</th><th class="confluenceTh">Punkte</th></tr>' +
    '<tr><td class="confluenceTd"><h4>Rollout</h4><p>Phase 2</p></td><td class="confluenceTd"><ul><li>Server</li><li>Clients</li></ul></td></tr></tbody></table>';
  await app.browser.execute(
    (sel, h) => {
      const dt = new DataTransfer();
      dt.setData("text/plain", "Thema\tPunkte\nRollout\nPhase 2\tServer\nClients\n");
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
  await app.browser.waitUntil(async () => (await content("Tabelle 684")).includes("Thema"), { timeout: 8000, timeoutMsg: "the paste is not saved" });
  const saved = await content("Tabelle 684");
  assert.match(saved, /\| Rollout<br>Phase 2 +\| Server<br>Clients +\|/, saved);
});

test("/Hinweisbox in a list item adds the callout below the item's line", async () => {
  await openPage("Hinweis 684", "- eins\n- zwei\n");
  await caretAfter("zwei");
  await app.type(" /hinweisbox");
  await app.waitText(".sugg-item.sel", /Hinweisbox/);
  await app.keys(["Enter"]);
  await app.type("Achtung");
  await app.browser.waitUntil(async () => (await content("Hinweis 684")).includes("Achtung"), { timeout: 8000, timeoutMsg: "the callout is not saved" });
  const saved = await content("Hinweis 684");
  assert.match(saved, /^- eins\n- zwei ?\n {2}> \[!note\] Achtung\n$/, saved);
  const callouts = await app.browser.execute((sel) => document.querySelectorAll(`${sel} li blockquote`).length, ED);
  assert.equal(callouts, 1);
});
