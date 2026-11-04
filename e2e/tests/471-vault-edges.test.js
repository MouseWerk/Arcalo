// q124 round 2, H5: an Obsidian vault with the hard parts (frontmatter with aliases and nested
// tags, embeds of files whose names have spaces and umlauts, Markdown images with encoded paths,
// notes and attachments of the same name in different folders, CRLF and a BOM, Japanese names)
// imports with every page, link and file, shows its images, and exports to the same files again.

import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app, vault, out, report;

// A 1x1 PNG; bytes after IEND make a second, different file that still shows.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const PNG2 = Buffer.concat([PNG, Buffer.from("zweites Bild")]);
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");

const write = (rel, data) => {
  const p = path.join(vault, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
};

const ALPHA = [
  "---",
  "aliases: [A1, Alpha Projekt]",
  "tags: [projekt/alpha, team]",
  "---",
  "# Alpha",
  "",
  "Bereich #bereich/it/netz und [[Beta#Ziele|zu Beta]].",
  "",
  "![[Bild mit Leerzeichen.png|200]]",
  "",
  "![Plan](assets/Mein%20Plan.png)",
  "",
  "![[Übersicht äöü.pdf]]",
  "",
  "![[Notiz]]",
  "",
].join("\n");

before(async () => {
  vault = fs.mkdtempSync(path.join(os.tmpdir(), "vault-edges-"));
  out = fs.mkdtempSync(path.join(os.tmpdir(), "vault-edges-out-"));
  fs.mkdirSync(path.join(vault, ".obsidian"));
  write("Projekte/Alpha.md", ALPHA);
  write("Projekte/assets/Mein Plan.png", PNG);
  write("Bild mit Leerzeichen.png", PNG);
  write("Übersicht äöü.pdf", PDF);
  write("Beta.md", "﻿# Beta\r\n\r\n## Ziele\r\n\r\n- [ ] eins\r\n- [x] zwei\r\n");
  write("Notiz.md", "Notiz oben\n");
  write("Projekte/Notiz.md", "Notiz in Projekte\n");
  write("A/Seite A.md", "![[Bild.png]]\n");
  write("A/Bild.png", PNG);
  write("B/Seite B.md", "![[Bild.png]]\n");
  write("B/Bild.png", PNG2);
  write("会議/会議メモ 2026.md", "# 会議\n\n[[Alpha]] と [[Beta]]\n");
  app = await launch({ demo: false });
  report = await app.invoke("vault_import", { path: vault });
});

after(async () => {
  await app?.close();
  for (const d of [vault, out]) if (d) fs.rmSync(d, { recursive: true, force: true });
});

/** Every page of the workspace as {id, title, parent}. */
async function pages() {
  const rows = await app.invoke("workspace_tree_compact");
  const all = [];
  const walk = (list, parent) => {
    for (const r of list) {
      all.push({ id: r[0], title: r[2], parent });
      walk(r[12] ?? [], r[0]);
    }
  };
  walk(rows, null);
  return all;
}
const byTitle = async (title) => (await pages()).filter((p) => p.title === title);
const content = async (id) => (await app.invoke("page_get", { id })).content;

test("every note, folder and file arrives", async () => {
  assert.deepEqual(report.warnings, []);
  assert.equal(report.skipped, 0, "no file left out");
  assert.equal(report.attachments, 5, "both Bild.png, the plan, the picture and the PDF");
  for (const t of ["Alpha", "Beta", "Seite A", "Seite B", "会議メモ 2026", "会議", "Projekte"]) assert.equal((await byTitle(t)).length, 1, `${t} once`);
  // Two notes called Notiz in different folders: both kept, with their own text.
  const notes = await byTitle("Notiz");
  assert.equal(notes.length, 2, "both notes named Notiz");
  const texts = await Promise.all(notes.map((n) => content(n.id)));
  assert.deepEqual(texts.sort(), ["Notiz in Projekte\n", "Notiz oben\n"]);
});

test("the note's text is kept as written, the BOM and CRLF of another one read", async () => {
  const [alpha] = await byTitle("Alpha");
  assert.equal(await content(alpha.id), ALPHA);
  const [beta] = await byTitle("Beta");
  const text = await content(beta.id);
  assert.ok(!text.startsWith("﻿"), "no BOM in the page");
  assert.match(text, /^# Beta\r?\n/);
});

test("nested and frontmatter tags are indexed, aliases known", async () => {
  const tags = Object.fromEntries(await app.invoke("tags_list"));
  for (const t of ["bereich/it/netz", "projekt/alpha", "team"]) assert.ok(tags[t] >= 1, `tag ${t}: ${JSON.stringify(tags)}`);
  const hits = await app.invoke("tag_pages", { tag: "projekt/alpha" });
  assert.deepEqual(
    hits.map((p) => p.title),
    ["Alpha"],
  );
});

test("a second Bild.png with other bytes is stored apart and its note points to it", async () => {
  const [a] = await byTitle("Seite A");
  const [b] = await byTitle("Seite B");
  const ca = await content(a.id);
  const cb = await content(b.id);
  assert.notEqual(ca, cb, "the notes name different files");
  const name = (c) => /!\[\[([^\]|]+)/.exec(c)[1];
  const sizes = [await app.invoke("attachment_size", { name: name(ca) }), await app.invoke("attachment_size", { name: name(cb) })];
  assert.deepEqual(sizes.sort((x, y) => x - y), [PNG.length, PNG2.length]);
});

test("images with spaces in their names and encoded paths show", async () => {
  const [alpha] = await byTitle("Alpha");
  await app.invoke("search_open", { target: { kind: "page", page_id: alpha.id, new_tab: false } });
  await app.waitFor(".pane.active .ProseMirror");
  await app.browser.waitUntil(
    () =>
      app.browser.execute(() => {
        const imgs = [...document.querySelectorAll(".pane.active .ProseMirror img[src]")];
        return imgs.length >= 2 && imgs.every((i) => i.complete && i.naturalWidth > 0);
      }),
    { timeout: 10000, timeoutMsg: "an image of Alpha does not load" },
  );
  // The PDF with umlauts in its name is found (a file card, not a missing file).
  await app.waitFor(".pane.active .ProseMirror .pdf-embed");
  const missing = await app.browser.execute(() => document.querySelectorAll(".pane.active .ProseMirror .is-missing").length);
  assert.equal(missing, 0, "no file shown as missing");
});

test("the export writes every note and the files they embed, under their names", async () => {
  const n = await app.invoke("vault_export", { path: out });
  assert.equal(n, 7, "seven notes");
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else files.push(path.relative(out, p));
    }
  };
  walk(out);
  const md = files.filter((f) => f.endsWith(".md"));
  const find = (re) => md.find((f) => re.test(f));
  assert.ok(find(/Projekte\/Alpha\.md$/), `Alpha exported: ${md.join(", ")}`);
  assert.ok(find(/会議\/会議メモ 2026\.md$/), "Japanese names stay");
  assert.equal(md.filter((f) => /(^|\/)Notiz\.md$/.test(f)).length, 2, "both Notiz notes");
  const alpha = fs.readFileSync(path.join(out, find(/Projekte\/Alpha\.md$/)), "utf8");
  assert.equal(alpha, ALPHA, "Alpha written as it was imported");
  const att = files.filter((f) => /(^|\/)attachments\//.test(f)).map((f) => path.basename(f));
  for (const f of ["Bild mit Leerzeichen.png", "Mein Plan.png", "Übersicht äöü.pdf"]) assert.ok(att.includes(f), `${f} exported: ${att.join(", ")}`);
});

test("no console errors", async () => {
  assert.deepEqual(await app.consoleErrors(), []);
});
