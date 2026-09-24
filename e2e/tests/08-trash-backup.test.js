// Data safety: deleted pages go to the trash (undo, restore, purge) and the database is backed up.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
before(async () => (app = await launch()));
after(async () => app?.close());

const PAGE = "Jour fixe 22.09.";
const treeRow = async (title) => {
  for (const r of await app.$$(".sidebar .tree-row")) if ((await app.textOf(r)) === title) return r;
  return null;
};
const deleteFromTree = async (title) => {
  const row = await treeRow(title);
  assert.ok(row, `${title} in tree`);
  await row.click({ button: "right" });
  await app.waitFor(".menu");
  await app.click(".menu-item.danger");
  await app.waitText(".toast-title", /Seite gelöscht/);
  await app.browser.waitUntil(async () => !(await treeRow(title)), { timeoutMsg: "page still in tree" });
};

test("deleting a page can be undone from the toast", async () => {
  await deleteFromTree(PAGE);
  assert.equal(await app.invoke("page_resolve", { title: PAGE, create: false }), null);
  const trash = await app.invoke("trash_list");
  assert.deepEqual(trash.map((e) => e.title), [PAGE]);

  let undo;
  for (const b of await app.$$(".toast .btn")) if ((await app.textOf(b)) === "Rückgängig") undo = b;
  assert.ok(undo, "toast offers undo");
  await undo.click();
  await app.browser.waitUntil(async () => !!(await treeRow(PAGE)), { timeoutMsg: "undo did not restore" });
  assert.equal((await app.invoke("trash_list")).length, 0);
});

test("deleted page appears in the trash and is restored from there", async () => {
  await deleteFromTree(PAGE);
  await app.click('.sidebar-foot [aria-label^="Papierkorb"]');
  await app.waitText(".pane.active .vh-title-text", /Papierkorb/);
  await app.waitText(".trash-item-title", new RegExp(PAGE.replace(/\./g, "\\.")));
  await app.shot("trash");

  await app.click(".trash-item .btn");
  await app.waitText(".toast-title", /wiederhergestellt/);
  await app.browser.waitUntil(async () => !!(await treeRow(PAGE)), { timeoutMsg: "page not back in tree" });
  await app.waitText(".empty-title", /Papierkorb ist leer/);
  const doc = await app.invoke("page_get", { id: (await app.invoke("page_resolve", { title: PAGE, create: false })).id });
  assert.ok(doc.content.length > 0, "content survived");
});

test("purging from the trash deletes the page for good", async () => {
  await deleteFromTree(PAGE);
  await app.click('.sidebar-foot [aria-label^="Papierkorb"]');
  await app.waitFor(".trash-item");
  await app.click('.trash-item [aria-label="Endgültig löschen"]');
  await app.waitFor(".dialog");
  await app.click(".dialog .btn-danger");
  await app.waitText(".empty-title", /Papierkorb ist leer/);
  assert.equal((await app.invoke("trash_list")).length, 0);
  assert.equal(await app.invoke("page_resolve", { title: PAGE, create: false }), null);
});

test("the database is backed up on start and on demand", async () => {
  // The daily backup runs right after start.
  await app.browser.waitUntil(async () => (await app.invoke("backup_list")).length > 0, { timeout: 10000, timeoutMsg: "no startup backup" });
  const b = await app.invoke("backup_now");
  assert.match(b.file_name, /^annalo-\d{8}-\d{6}\.db$/);
  assert.equal(path.dirname(b.path), path.join(app.dataDir, "backups"));
  assert.ok(fs.statSync(b.path).size > 0, "backup file written");

  await app.keys(["Control", ","]);
  await app.waitFor(".settings-nav");
  for (const el of await app.$$(".settings-nav-item")) if ((await app.textOf(el)) === "Sicherung") await el.click();
  await app.waitText(".settings-head h1", /Sicherung/);
  await app.waitFor(".backup-row");
  for (const el of await app.$$(".set-row-control .btn")) if ((await app.textOf(el)) === "Jetzt sichern") await el.click();
  await app.waitText(".toast-title", /Sicherung erstellt/);
  await app.shot("settings-backup");
});
