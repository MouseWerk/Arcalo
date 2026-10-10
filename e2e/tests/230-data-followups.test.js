// Data follow-ups (1.12): a failed save keeps SQLite's English text behind „Details“; files only
// old page versions use are not „unused“ and come back with such a version; a large vault import
// is written in batches (the app answers meanwhile, cancelling removes it again); and after a
// restored backup the Git sync compares with the server and asks instead of pushing the old state.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "arcalo-e2e-data2-"));
const dataDir = path.join(root, "daten");
fs.mkdirSync(dataDir, { recursive: true });
before(async () => (app = await launch({ dataDir, env: { ARCALO_BACKUP_DELAY_SECS: "3600" } })));
after(async () => {
  await app?.close();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const DISK_FULL = path.join(dataDir, "test-disk-full");
const pageId = async (title) => (await app.invoke("page_resolve", { title, create: false })).id;
const content = async (title) => (await app.invoke("page_get", { id: await pageId(title) })).content;
const open = async (title) => {
  await app.invoke("search_open", { target: { kind: "page", page_id: await pageId(title), new_tab: false } });
  await app.browser.waitUntil(async () => (await app.text(".pane.active .tab.active .tab-title")) === title, { timeoutMsg: `${title} not open` });
  await app.waitFor(".pane.active > .pane-content:not([hidden]) .ProseMirror");
};
const palette = async (command, wait) => {
  await app.keys(["Control", "k"]);
  const input = await app.waitFor(".palette input");
  await input.setValue(command);
  await app.waitText(".pal-item.sel", new RegExp(command));
  await app.keys(["Enter"]);
  await app.waitFor(wait, 10000);
};

test("a failed save says what to do; SQLite's English text stays behind „Details“", async () => {
  await open("Architektur");
  await app.caretToEnd();
  await app.keys(["Enter"]);
  fs.writeFileSync(DISK_FULL, "");
  await app.type("Auf vollem Datenträger");
  await app.waitText(".toast-danger .toast-title", /Speichern fehlgeschlagen/);
  const detail = await app.text(".toast-danger .toast-detail");
  assert.match(detail, /Datenträger ist voll.*Gib Speicherplatz frei/s);
  assert.doesNotMatch(detail, /Error code|database or disk|Details/, "no English SQLite text after the German message");
  await app.shot("230-error-toast");
  await app.click(".toast-danger .toast-tech-toggle");
  await app.waitText(".toast-danger .toast-tech", /Error code 13/);
  await app.shot("230-error-details");
  fs.rmSync(DISK_FULL);
  await app.browser.waitUntil(async () => /Auf vollem Datenträger/.test(await content("Architektur")), { timeout: 15000, timeoutMsg: "not saved once the disk had room" });
  await app.dismissToasts();
});

test("files only old versions use are not „unused“ and come back with such a version", async () => {
  const att = path.join(dataDir, "attachments");
  fs.mkdirSync(att, { recursive: true });
  fs.writeFileSync(path.join(att, "Kalkulation-alt.xlsx"), "PK alte Kalkulation");
  fs.writeFileSync(path.join(att, "Restposten.xlsx"), "PK frei");
  const page = await app.invoke("page_create", { parentId: null, title: "Kalkulation", icon: null, content: "Stand Mai\n\n![[Kalkulation-alt.xlsx]]\n" });
  await app.invoke("page_snapshot", { pageId: page.id });
  await app.invoke("page_save", { id: page.id, content: "Stand Juni, ohne Anhang\n" });

  await palette("Anhänge verwalten", ".att-table");
  await app.waitFor('.att-row[data-file="Kalkulation-alt.xlsx"]');
  await app.shot("230-attachments-versions");
  const list = await app.invoke("attachments_list");
  const get = (n) => list.files.find((f) => f.name === n);
  assert.deepEqual(get("Kalkulation-alt.xlsx").used_in, []);
  assert.deepEqual(get("Kalkulation-alt.xlsx").in_versions.map((u) => u.title), ["Kalkulation"]);
  assert.equal(get("Restposten.xlsx").in_versions.length, 0);
  await app.waitText('.att-row[data-file="Kalkulation-alt.xlsx"] .att-c-used', /Nur in alten Versionen/);
  await app.waitText('.att-row[data-file="Restposten.xlsx"] .att-c-used', /Nicht verwendet/);
  assert.match(await app.text(".att-summary"), /1 nur in alten Versionen/);
  // „Unbenutzt“ and „Aufräumen“ leave it out.
  await app.click(".att-chip");
  const shown = await app.browser.execute(() => [...document.querySelectorAll(".att-row[data-file]")].map((r) => r.dataset.file));
  assert.ok(shown.includes("Restposten.xlsx") && !shown.includes("Kalkulation-alt.xlsx"), shown.join(", "));
  await app.click(".att-chip");

  // Deleted anyway: restoring the version brings it back from the file trash.
  await app.invoke("attachment_trash", { names: ["Kalkulation-alt.xlsx"] });
  assert.ok(!fs.existsSync(path.join(att, "Kalkulation-alt.xlsx")));
  const versions = await app.invoke("page_versions", { pageId: page.id });
  let old = null;
  for (const v of versions) if (/Kalkulation-alt/.test(await app.invoke("page_version_content", { versionId: v.id }))) old = v;
  assert.ok(old, "the old version is there");
  await app.invoke("page_version_restore", { pageId: page.id, versionId: old.id });
  assert.ok(fs.existsSync(path.join(att, "Kalkulation-alt.xlsx")), "file back from the trash");
});

test("a large vault import is written in batches: the app answers meanwhile, cancelling removes it", async () => {
  const vault = path.join(root, "Grosser Vault");
  for (let i = 0; i < 4000; i++) {
    const dir = path.join(vault, `Bereich ${i % 20}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `Notiz ${i}.md`), `# Notiz ${i}\n\nText mit [[Notiz ${(i + 1) % 4000}]] und #tag${i % 7}\n`);
  }
  const pages = async () => (await app.invoke("workspace_tree")).length;
  const all = async () => {
    const walk = (nodes) => nodes.reduce((n, p) => n + 1 + walk(p.children ?? []), 0);
    return walk(await app.invoke("workspace_tree"));
  };
  const before = await pages();
  // Progress events, collected in the page.
  await app.browser.execute(() => {
    const w = window;
    w.__progress = [];
    const id = w.__TAURI_INTERNALS__.transformCallback((e) => w.__progress.push(e.payload));
    return w.__TAURI_INTERNALS__.invoke("plugin:event|listen", { event: "vault://progress", target: { kind: "Any" }, handler: id });
  });
  const startImport = () =>
    app.browser.execute((p) => {
      window.__import = null;
      window.__TAURI_INTERNALS__.invoke("vault_import", { path: p }).then(
        (r) => (window.__import = { ok: r }),
        (e) => (window.__import = { err: String(e) }),
      );
    }, vault);
  const result = () => app.browser.execute(() => window.__import);
  const writing = () => app.browser.execute(() => window.__progress.filter((p) => p.writing));

  await startImport();
  await app.browser.waitUntil(async () => (await writing()).length > 0, { timeout: 60000, timeoutMsg: "writing never started" });
  // While the pages are written, a command that needs the database answers quickly.
  const waits = [];
  while (!(await result())) {
    const t0 = Date.now();
    await app.invoke("page_snapshot", { pageId: await pageId("Architektur") });
    waits.push(Date.now() - t0);
    await app.browser.pause(30);
  }
  const done = await result();
  assert.ok(done.ok, done.err);
  assert.equal(done.ok.pages, 4000);
  const steps = await writing();
  assert.ok(steps.length >= 10, `progress while writing: ${steps.length} events`);
  assert.deepEqual(steps.at(-1), { done: 4020, total: 4020, writing: true });
  console.log(`database waits during the import (ms): max ${Math.max(...waits)}, ${waits.length} calls`);
  assert.ok(waits.length >= 3 && Math.max(...waits) < 1500, `the app waited ${Math.max(...waits)} ms for the database`);
  const after = await pages();
  assert.equal(after, before + 1);

  // A second import, cancelled while it writes: nothing of it stays.
  const total = await all();
  await app.browser.execute(() => (window.__progress = []));
  await startImport();
  await app.browser.waitUntil(async () => (await writing()).some((p) => p.done > 0), { timeout: 60000, timeoutMsg: "second import did not write" });
  await app.invoke("vault_import_cancel");
  await app.browser.waitUntil(async () => !!(await result()), { timeout: 30000, timeoutMsg: "cancel not answered" });
  assert.match((await result()).err ?? "", /Import abgebrochen/);
  assert.equal(await pages(), after, "the cancelled import left no top page");
  assert.equal(await all(), total, "nor pages");
});

test("after a restored backup the Git sync asks instead of pushing the old state", async () => {
  const bare = path.join(root, "notizen.git");
  execFileSync("git", ["init", "-q", "--bare", bare]);
  const git = (...args) => execFileSync("git", ["-C", bare, ...args], { encoding: "utf8" });
  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", {
    settings: { ...view.settings, markdown_mirror: true, git_sync: { ...view.settings.git_sync, enabled: true, remote_url: bare, author_name: "E2E", author_email: "e2e@example.com" } },
  });
  const plan = await app.invoke("page_create", { parentId: null, title: "Planung", icon: null, content: "Stand der Sicherung\n" });
  const backup = await app.invoke("backup_now");
  await app.invoke("git_sync_now");
  // Work after the backup, synced.
  await app.invoke("page_save", { id: plan.id, content: "Neuer Stand vom Dienstag\n" });
  await app.invoke("page_create", { parentId: null, title: "Nach der Sicherung", icon: null, content: "Neu angelegt\n" });
  await app.invoke("git_sync_now");
  const commits = git("rev-list", "--count", "main");

  // Restore the backup (applied at the next start).
  const staged = await app.invoke("backup_restore", { path: backup.path });
  assert.ok(staged.ok, JSON.stringify(staged));
  await app.close();
  app = await launch({ dataDir, env: { ARCALO_BACKUP_DELAY_SECS: "3600" } });
  assert.equal(await content("Planung"), "Stand der Sicherung\n");
  assert.ok(fs.existsSync(path.join(dataDir, "sync-after-restore.json")), "the restore is noted for the sync");

  await assert.rejects(app.invoke("git_sync_now"), /Nach der Wiederherstellung angehalten/);
  assert.equal(git("rev-list", "--count", "main"), commits, "nothing pushed");
  assert.equal(git("show", "main:Planung.md"), "Neuer Stand vom Dienstag\n");
  await app.waitText(".toast", /wartet auf deine Entscheidung/);
  await app.shot("230-restore-toast");
  // The toast leads to the decision.
  await app.browser.execute(() => [...document.querySelectorAll(".toast button")].find((b) => b.textContent === "Entscheiden")?.click());
  await app.waitText(".set-row", /Nach der Wiederherstellung[\s\S]*abweichende Notizen: 1, nur dort: 1/, 10000);
  await app.shot("230-restore-decision");

  for (const b of await app.$$(".git-restored-actions button")) if (/Neueren Stand/.test(await app.textOf(b))) await b.click();
  await app.waitText(".toast", /Neuerer Stand übernommen/, 20000);
  assert.equal(await content("Planung"), "Neuer Stand vom Dienstag\n");
  assert.ok(await pageId("Nach der Sicherung"), "the note made after the backup is back");
  // The restored text is kept as a version.
  const versions = await app.invoke("page_versions", { pageId: await pageId("Planung") });
  const texts = await Promise.all(versions.map((v) => app.invoke("page_version_content", { versionId: v.id })));
  assert.ok(texts.includes("Stand der Sicherung\n"), "restored text in the versions");
  assert.equal(git("rev-list", "--count", "main"), commits, "pulling pushed nothing");
  assert.ok(!fs.existsSync(path.join(dataDir, "sync-after-restore.json")));
  const status = await app.invoke("git_sync_status");
  assert.equal(status.after_restore, null);
  assert.deepEqual(await app.consoleErrors(), []);
});
