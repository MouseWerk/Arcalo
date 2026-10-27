// Settings 1.10 across workspaces and computers: a section shared by every workspace on the
// computer or kept for one („Für alle Arbeitsbereiche / Nur dieser Arbeitsbereich“), and the
// opt-in settings sync through the Git sync between two data folders and a local bare
// repository (merged per setting, no secrets, logged, „Abgleich rückgängig machen“). English too.
import { test as nodeTest, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, guarded } from "../lib/harness.js";
import { germanLeftovers, launchEnglish } from "../lib/english.js";
import { clickUndo, settingsSettled, storedSettings } from "../lib/settings.js";

const test = guarded(nodeTest, () => app);
let app;
const base = fs.mkdtempSync(path.join(os.tmpdir(), "arcalo-e2e-134-"));
const shared = path.join(base, "shared");
const dirA = path.join(base, "a");
const dirB = path.join(base, "b");
const bare = path.join(base, "settings.git");
for (const d of [shared, dirA, dirB]) fs.mkdirSync(d, { recursive: true });
execFileSync("git", ["init", "-q", "--bare", bare]);
const env = { ARCALO_SHARED_SETTINGS_DIR: shared };
after(async () => {
  await app?.close();
  fs.rmSync(base, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const start = async (dataDir) => {
  await app?.close();
  app = await launch({ dataDir, env });
};
const save = async (patch) => {
  const s = await storedSettings(app);
  return app.invoke("settings_save", { settings: { ...s, ...patch } });
};
async function openSection(id) {
  if (!(await app.browser.execute(() => !!document.querySelector(".pane.active > .pane-content:not([hidden]) .settings")))) await app.keys(["Control", ","]);
  await app.waitFor(".pane.active > .pane-content:not([hidden]) .settings");
  await app.browser.execute((s) => document.querySelector(`.pane.active > .pane-content:not([hidden]) .settings-nav-item[data-section="${s}"]`).click(), id);
  await app.waitFor(`.pane.active > .pane-content:not([hidden]) .settings-nav-item.active[data-section="${id}"]`);
}
const scopeButton = (label) =>
  app.browser.execute((l) => [...document.querySelectorAll(".pane.active > .pane-content:not([hidden]) .settings-scope [role=radio]")].find((b) => b.textContent.trim() === l)?.getAttribute("aria-checked"), label);

test("a section for all workspaces or only this one", async () => {
  await start(dirA);
  await openSection("appearance");
  assert.equal(await scopeButton("Für alle Arbeitsbereiche"), "true", "shared by default");
  await save({ theme: "dark" });
  const file = JSON.parse(fs.readFileSync(path.join(shared, "shared-settings.json"), "utf8"));
  assert.equal(file.sections.appearance.theme, "dark");
  assert.equal(file.sections.dashboard, undefined, "the start page stays with its workspace");
  await app.shot("134-scope-appearance");

  // A new workspace takes the shared theme.
  await start(dirB);
  assert.equal((await storedSettings(app)).theme, "dark");
  await openSection("appearance");
  await app.browser.execute(() => [...document.querySelectorAll(".pane.active > .pane-content:not([hidden]) .settings-scope [role=radio]")].find((b) => b.textContent.trim() === "Nur dieser Arbeitsbereich").click());
  await app.waitText(".toast-title", /Gilt jetzt nur für diesen Arbeitsbereich/);
  assert.equal((await app.invoke("settings_get")).scopes.appearance, "workspace");
  await save({ theme: "light" });
  assert.equal(JSON.parse(fs.readFileSync(path.join(shared, "shared-settings.json"), "utf8")).sections.appearance.theme, "dark", "the others keep theirs");

  // The first workspace still has the shared value; B keeps its own after a restart.
  await start(dirA);
  assert.equal((await storedSettings(app)).theme, "dark");
  await start(dirB);
  const b = await app.invoke("settings_get");
  assert.equal(b.settings.theme, "light");
  assert.equal(b.scopes.appearance, "workspace");
  // Back to „Für alle“: the shared value wins.
  await openSection("appearance");
  await app.browser.execute(() => [...document.querySelectorAll(".pane.active > .pane-content:not([hidden]) .settings-scope [role=radio]")].find((b) => b.textContent.trim() === "Für alle Arbeitsbereiche").click());
  await app.waitText(".toast-title", /Gilt jetzt für alle Arbeitsbereiche/);
  assert.equal((await storedSettings(app)).theme, "dark");
});

test("settings sync between two data folders through a bare repository", async () => {
  const git = { enabled: true, remote_url: bare, author_name: "E2E", author_email: "e2e@example.com", sync_settings: true };
  await start(dirA);
  let s = await storedSettings(app);
  await save({ git_sync: { ...s.git_sync, ...git }, editor: { ...s.editor, tab_size: 8 } });
  await app.invoke("git_sync_now", {});
  const onServer = execFileSync("git", ["-C", bare, "show", "main:settings.json"], { encoding: "utf8" });
  const file = JSON.parse(onServer);
  assert.equal(file.settings["editor.tab_size"].value, 8);
  for (const key of Object.keys(file.settings)) {
    assert.ok(!/token|password|secret|credential|api_?key/i.test(key), key);
    assert.ok(!/^(backup_dir|network|git_sync|providers|updates|dashboard|calendar)(\.|$)/.test(key), `machine key synced: ${key}`);
  }
  assert.doesNotMatch(onServer, /"(token|password|api_key)"/);

  await start(dirB);
  s = await storedSettings(app);
  assert.equal(s.editor.tab_size, 4, "the default");
  await save({ git_sync: { ...s.git_sync, ...git } });
  await app.invoke("git_sync_now", {});
  await app.waitText(".toast-title", /Einstellung(en)? von einem anderen Computer übernommen/, 15000);
  const view = await app.invoke("settings_get");
  assert.equal(view.settings.editor.tab_size, 8, "taken from the other computer");
  assert.ok(view.sync_last.changes.some((c) => c.key === "editor.tab_size"), JSON.stringify(view.sync_last));
  const log = fs.readFileSync(path.join(dirB, "logs", "arcalo.log"), "utf8");
  assert.match(log, /settings sync: \d+ taken from the server: .*editor\.tab_size/);
  await app.dismissToasts();

  // Settings → Sicherung shows the merge; „Abgleich rückgängig machen“ takes it back.
  await openSection("backup");
  await app.browser.execute(() => document.querySelector(".pane.active > .pane-content:not([hidden]) .settings-merge-undo")?.scrollIntoView({ block: "center" }));
  await app.waitText(".pane.active > .pane-content:not([hidden]) .set-row", /Letzter Abgleich der Einstellungen/);
  await app.shot("134-sync-merge");
  await app.click(".pane.active > .pane-content:not([hidden]) .settings-merge-undo");
  await app.waitText(".toast-title", /Abgleich der Einstellungen rückgängig gemacht/);
  assert.equal((await storedSettings(app)).editor.tab_size, 4, "undone");
  // The undo counts as the later change: the next sync carries it to the server.
  await app.invoke("git_sync_now", {});
  const after = JSON.parse(execFileSync("git", ["-C", bare, "show", "main:settings.json"], { encoding: "utf8" }));
  assert.equal(after.settings["editor.tab_size"].value, 4);
});

test("English: scope switch, grouped menu, undo toast and reset in English", async () => {
  await app?.close();
  const en = await launchEnglish();
  app = en.app;
  await openSection("appearance");
  const groups = await app.browser.execute(() => [...document.querySelectorAll(".pane.active > .pane-content:not([hidden]) .settings-nav-group-label")].map((g) => g.textContent.trim()));
  assert.deepEqual(groups, ["General", "Work", "AI & language", "Data & security", "System"]);
  assert.equal(await scopeButton("All workspaces"), "true");
  assert.equal(await scopeButton("This workspace only"), "false");
  assert.match(await app.text(".pane.active > .pane-content:not([hidden]) .settings-reset"), /Reset section/);
  await openSection("editor");
  await app.click('.pane.active > .pane-content:not([hidden]) button[role="switch"][aria-label="Smart quotes"]');
  await settingsSettled(app);
  await app.waitText(".toast-title", /Setting changed/);
  assert.deepEqual(await germanLeftovers(app), []);
  await app.shot("134-settings-en");
  await clickUndo(app);
  await app.waitText(".toast-title", /Change undone/);
  await sleep(100);
  fs.rmSync(en.dataDir, { recursive: true, force: true });
});
