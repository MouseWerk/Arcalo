import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app, vault, out;
before(async () => {
  vault = fs.mkdtempSync(path.join(os.tmpdir(), "vault-"));
  fs.mkdirSync(path.join(vault, ".obsidian"));
  fs.mkdirSync(path.join(vault, "Kunden", "Acme"), { recursive: true });
  fs.writeFileSync(path.join(vault, "Kunden.md"), "Alle Kunden. #kunde\n\n- [[Acme Kickoff]]\n");
  fs.writeFileSync(path.join(vault, "Kunden", "Acme", "Acme Kickoff.md"), "---\nstatus: aktiv\n---\n# Kickoff\n\nZurück zu [[Kunden]]. ==Wichtig==\n\n> [!note] Hinweis\n> Callout-Text\n");
  fs.writeFileSync(path.join(vault, "logo.png"), Buffer.alloc(8));
  out = fs.mkdtempSync(path.join(os.tmpdir(), "vault-out-"));
  app = await launch({ demo: false });
});
after(async () => {
  await app?.close();
  fs.rmSync(vault, { recursive: true, force: true });
  fs.rmSync(out, { recursive: true, force: true });
});

test("empty workspace shows the welcome choice", async () => {
  await app.waitText(".home h1", /Willkommen/);
  await app.shot("home-empty");
});

test("imports an Obsidian vault from a path", async () => {
  await app.keys(["Control", ","]);
  await app.click(".settings-nav-item[data-section=\"notes\"]");
  const input = await app.$('input[aria-label="Vault-Pfad"]');
  await input.setValue(vault);
  const rows = await app.$$(".set-row");
  for (const r of rows)
    if (/Pfad direkt angeben/.test(await app.textOf(r))) {
      await (await r.$(".btn-secondary")).click();
      break;
    }
  await app.waitText(".toast-title", /Vault importiert/);
  // Imported folders start collapsed; expand Kunden and Acme.
  for (const folder of ["Kunden", "Acme"]) {
    await app.waitText(".sidebar .tree-row", new RegExp(`^${folder}$`));
    for (const r of await app.$$(".sidebar .tree-row"))
      if ((await app.textOf(r)) === folder) {
        assert.equal(await r.getAttribute("aria-expanded"), "false", `${folder} starts collapsed`);
        await (await r.$(".tree-twisty")).click();
      }
  }
  await app.waitText(".sidebar .tree-row", /Acme Kickoff/);
});

test("imported page keeps frontmatter, links and highlights", async () => {
  for (const r of await app.$$(".sidebar .tree-row")) if ((await app.textOf(r)) === "Acme Kickoff") await r.click();
  await app.waitFor(".ProseMirror h1");
  const html = await (await app.$(".ProseMirror")).getHTML();
  assert.match(html, /<mark>Wichtig<\/mark>/);
  assert.match(html, /data-target="Kunden"/);
  assert.match(html, /callout callout-note/, "Obsidian callouts are rendered");
  // Frontmatter shows up in the property editor.
  await app.waitFor(".properties");
  const keys = await app.browser.execute(() => [...document.querySelectorAll(".properties .prop-key")].map((k) => k.value ?? k.textContent));
  assert.ok(keys.includes("status"), `property keys: ${keys}`);
  await app.waitText(".backlink-title", /Kunden/);
  await app.shot("imported-page");
});

test("editing an imported page keeps its frontmatter", async () => {
  await app.caretToEnd();
  await app.keys(["Enter"]);
  await app.type("Ergänzt in Annalo");
  await app.browser.pause(900);
  const page = await app.invoke("page_resolve", { title: "Acme Kickoff", create: false });
  const doc = await app.invoke("page_get", { id: page.id });
  assert.match(doc.content, /^---\nstatus: aktiv\n---\n/);
  assert.match(doc.content, /\[\[Kunden\]\]/);
  assert.match(doc.content, /==Wichtig==/);
  assert.match(doc.content, /> \[!note\] Hinweis/);
  assert.match(doc.content, /Ergänzt in Annalo/);
});

test("exports the workspace as Markdown files", async () => {
  const n = await app.invoke("vault_export", { path: out });
  assert.ok(n >= 2);
  const root = fs.readdirSync(out)[0];
  const kickoff = fs.readFileSync(path.join(out, root, "Kunden", "Acme", "Acme Kickoff.md"), "utf8");
  assert.match(kickoff, /Ergänzt in Annalo/);
});

test("no console errors", async () => {
  assert.deepEqual(await app.consoleErrors(), []);
});
