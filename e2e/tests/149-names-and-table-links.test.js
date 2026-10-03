// 1.11 fixes around names and links: page titles that are Windows device names (CON, NUL.txt)
// get safe file names in the Markdown copy, a decomposed „ü“ (macOS file names) is stored
// composed, a `[[link\|alias]]` in a table cell counts as a backlink and is renamed with its
// page, and a task in a `~~~` code block is code.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;

function files(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...files(p));
    else out.push(p);
  }
  return out;
}

before(async () => {
  app = await launch({ width: 1480, demo: false });
});
after(async () => {
  await app?.close();
});

test("Gerätenamen und zerlegte Umlaute ergeben sichere, gleiche Namen", async () => {
  const con = await app.invoke("page_create", { parentId: null, title: "CON", icon: null, content: "Konsole" });
  const nul = await app.invoke("page_create", { parentId: null, title: "nul.txt", icon: null, content: "Nichts" });
  const mueller = await app.invoke("page_create", { parentId: null, title: "Müller", icon: null, content: "Kunde" });
  assert.equal(mueller.title, "Müller", "stored composed");
  await app.invoke("page_create", { parentId: null, title: "Log 149", icon: null, content: "Siehe [[Müller]]." });
  assert.equal((await app.invoke("page_get", { id: mueller.id })).backlinks.length, 1, "a typed link finds the page");
  await app.invoke("backup_now");
  const status = await app.invoke("mirror_status");
  const names = files(status.path).map((f) => path.basename(f));
  for (const name of ["CON_.md", "nul_.txt.md", "Müller.md"]) assert.ok(names.includes(name), `${name} in ${names.join(", ")}`);
  assert.ok(!names.includes("CON.md") && !names.includes("nul.txt_.md"));
  assert.ok(con.id && nul.id);
});

test("Link mit Alias in einer Tabellenzelle: Rückverweis und Umbenennen", async () => {
  const target = await app.invoke("page_create", { parentId: null, title: "Ziel 149", icon: null, content: "Ziel" });
  const src = await app.invoke("page_create", {
    parentId: null,
    title: "Tabelle 149",
    icon: null,
    content: "| Wer | Seite |\n| --- | --- |\n| Anna | [[Ziel 149\\|das Ziel]] |\n\n~~~\n- [ ] Kein Task\n~~~\n- [ ] Echter Task\n",
  });
  const doc = await app.invoke("page_get", { id: target.id });
  assert.ok(doc.backlinks.some((b) => b.page_id === src.id), "the table link is a backlink");
  await app.invoke("page_rename", { id: target.id, title: "Neues Ziel 149", updateLinks: true });
  const renamed = await app.invoke("page_get", { id: src.id });
  assert.match(renamed.content, /\[\[Neues Ziel 149\\\|das Ziel\]\]/);
  const tasks = await app.invoke("tasks_list", { filter: { status: "all" } });
  assert.deepEqual(tasks.filter((t) => t.page_id === src.id).map((t) => t.text), ["Echter Task"], "the task in the ~~~ block is code");
});
