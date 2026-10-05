// The rename from Annalo to Arcalo (1.7): the window, About and the HTML title say Arcalo; a data
// folder written by 1.6 (settings, notes, credentials, `annalo-….db` backups, an autostart entry
// of the old name) opens unchanged, and the notice „Annalo heißt jetzt Arcalo“ shows exactly once.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launch, guarded } from "../lib/harness.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const test = guarded(nodeTest, () => app);
let app;
let dataDir;
let home;
let before16;

const notices = () =>
  app.browser.execute(() => [...document.querySelectorAll(".toast")].filter((t) => /Annalo heißt jetzt Arcalo/.test(t.textContent)).length);
const log = () => fs.readFileSync(path.join(dataDir, "logs", "arcalo.log"), "utf8");
const titles = async () => (await app.invoke("workspace_tree")).map((p) => p.title);
// The autostart entry of the old name, as auto-launch wrote it for Annalo 1.6.
const oldAutostart = () => path.join(home, ".config", "autostart", "Annalo.desktop");
const newAutostart = () => path.join(home, ".config", "autostart", "Arcalo.desktop");
const start = (opts = {}) => launch({ demo: false, onboarding: true, dataDir, env: { HOME: home }, ...opts });

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "annalo-e2e-113-"));
  home = fs.mkdtempSync(path.join(os.tmpdir(), "annalo-e2e-113-home-"));
  // A workspace as 1.6 left it: notes and settings written, the intro classified.
  app = await launch({ demo: true, onboarding: false, dataDir, env: { HOME: home } });
  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", { settings: { ...view.settings, daily_target_hours: 7.5, theme: "dark" } });
  await app.invoke("page_create", { parentId: null, title: "Notiz aus 1.6", icon: null, content: "geschrieben mit Annalo" });
  before16 = { settings: (await app.invoke("settings_get")).settings, pages: (await titles()).sort() };
  await app.close();
  app = null;

  // What 1.7 adds is not there yet (1.6 knew no rename notice), plus a backup of 1.6.
  const db = new DatabaseSync(path.join(dataDir, "workspace.db"));
  db.exec("DELETE FROM settings WHERE key = 'meta.rebrand.notice'");
  fs.mkdirSync(path.join(dataDir, "backups"), { recursive: true });
  db.exec(`VACUUM INTO '${path.join(dataDir, "backups", "annalo-20260901-080000.db").replaceAll("'", "''")}'`);
  db.close();
  // Credentials of 1.6 (Linux keeps them in secrets.json; Windows and macOS under the service
  // name „Annalo“, which 1.7 keeps).
  fs.writeFileSync(path.join(dataDir, "secrets.json"), JSON.stringify({ git_token: "ghp-aus-1-6", litellm_api_key: "sk-aus-1-6" }), { mode: 0o600 });
  fs.mkdirSync(path.dirname(oldAutostart()), { recursive: true });
  fs.writeFileSync(
    oldAutostart(),
    "[Desktop Entry]\nType=Application\nVersion=1.0\nName=Annalo\nComment=Annalostartup script\nExec=/opt/Annalo.AppImage --minimized\nStartupNotify=false\nTerminal=false",
  );
});

after(async () => {
  await app?.close();
  for (const d of [dataDir, home]) if (d) fs.rmSync(d, { recursive: true, force: true });
});

test("the data folder of 1.6 opens unchanged, with its credentials and the name Arcalo", async () => {
  app = await start();
  const now = (await app.invoke("settings_get")).settings;
  assert.equal(now.daily_target_hours, 7.5);
  assert.equal(now.theme, "dark");
  assert.deepEqual(now.git_sync, before16.settings.git_sync);
  assert.deepEqual(now.locale, before16.settings.locale);
  assert.deepEqual((await titles()).sort(), before16.pages, "the notes are all there");
  assert.equal((await app.invoke("settings_get")).api_key_set, true, "AI key of 1.6 found");
  assert.equal((await app.invoke("git_sync_status")).token_set, true, "Git token of 1.6 found");

  assert.match(await app.browser.getTitle(), /(^| – )Arcalo$/);
  const native = await app.browser.execute(() => window.__TAURI_INTERNALS__.invoke("plugin:window|title", { label: "main" }));
  assert.match(native, /(^| – )Arcalo$/);
  assert.match(log(), /Arcalo [\d.]+ started/);
  assert.doesNotMatch(log(), /Annalo [\d.]+ started/);

  await app.keys(["Control", ","]);
  await app.waitFor(".pane.active .settings");
  await app.browser.execute(() => document.querySelector('.settings-nav-item[data-section="about"]').click());
  await app.waitText(".settings-head h1", /^Arcalo$/);
  await app.shot("113-about");
});

test("the notice „Annalo heißt jetzt Arcalo“ shows once", async () => {
  await app.waitText(".toast", /Annalo heißt jetzt Arcalo/);
  assert.equal(await notices(), 1);
  const toast = await app.browser.execute(
    () => [...document.querySelectorAll(".toast")].find((t) => /Annalo heißt jetzt Arcalo/.test(t.textContent))?.textContent ?? "",
  );
  assert.match(toast, /Versionshinweise/);
  assert.match(toast, /Zugangsdaten bleiben/);
  await app.shot("113-notice");
  assert.equal((await app.invoke("onboarding_status")).rebrand_notice, false, "marked as shown");

  await app.close();
  app = await start();
  await sleep(1500);
  assert.equal(await notices(), 0, "shown a second time");
});

test("the autostart entry of the old name is renamed", async () => {
  assert.ok(!fs.existsSync(oldAutostart()), "Annalo.desktop removed");
  const entry = fs.readFileSync(newAutostart(), "utf8");
  assert.match(entry, /^Name=Arcalo$/m);
  assert.match(entry, /--minimized/);
  assert.equal((await app.invoke("desktop_info")).autostart, true);
  assert.match(log(), /autostart entry „Annalo“ renamed to „Arcalo“/);
  assert.equal((log().match(/renamed to „Arcalo“/g) ?? []).length, 1, "once, not at every start");
});

test("backups of 1.6 (annalo-….db) are listed and restored; new ones are arcalo-….db", async () => {
  const fresh = await app.invoke("backup_now");
  assert.match(fresh.file_name, /^arcalo-\d{8}-\d{6}\.db$/);
  const list = (await app.invoke("backup_list")).map((b) => b.file_name);
  assert.ok(list.includes("annalo-20260901-080000.db"), `old backup listed: ${list}`);
  assert.equal(list[0], fresh.file_name, "newest first across both names");

  await app.invoke("page_create", { parentId: null, title: "Nach dem Update", icon: null, content: "neu" });
  const staged = await app.invoke("backup_restore", { path: path.join(dataDir, "backups", "annalo-20260901-080000.db") });
  assert.equal(staged.ok, true, JSON.stringify(staged.failure));
  await app.close();
  app = await start();
  const now = await titles();
  assert.ok(now.includes("Notiz aus 1.6"));
  assert.ok(!now.includes("Nach dem Update"), "the state of the old backup");
  assert.match(log(), /database restored from .*annalo-20260901-080000\.db/);
});
