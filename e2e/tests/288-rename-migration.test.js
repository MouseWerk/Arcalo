// 1.15 renamed the internal names (app identifier app.annalo.desktop → de.mousewerk.arcalo,
// localStorage keys annalo.* → arcalo.*, markers, credential service): an installation of 1.14
// opens unchanged. The layout of 1.14 is made with this build under the new names and then given
// the old ones, as 1.14 leaves them on Linux: data and WebView storage in
// ~/.local/share/app.annalo.desktop, the config in ~/.config/app.annalo.desktop, the secrets in
// secrets.json (no Secret Service), an encrypted workspace, the update marker `.annalo-update`.
// The app runs as installed (no ARCALO_DATA_DIR), with a home folder of its own.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { APP, launch, guarded, homeDataDir } from "../lib/harness.js";

let app;
const test = guarded(nodeTest, () => app);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OLD = "app.annalo.desktop";
const NEW = "de.mousewerk.arcalo";
const ENV = { ARCALO_SECRET_STORE: "file", ARCALO_BACKUP_DELAY_SECS: "3600" };

const home = fs.mkdtempSync(path.join(os.tmpdir(), "arcalo-e2e-288-home-"));
const share = path.join(home, ".local", "share");
const oldData = path.join(share, OLD);
const newData = homeDataDir(home);
const roots = [share, path.join(home, ".config"), path.join(home, ".cache")];
let customHome;
let customDir;
let pageIds;
let version;

const killApp = () => {
  try {
    execSync(`pkill -f "${APP}"`, { stdio: "ignore" });
  } catch {
    /* none running */
  }
};
const logOf = (dir) => {
  try {
    return fs.readFileSync(path.join(dir, "logs", "arcalo.log"), "utf8");
  } catch {
    return "";
  }
};
async function until(what, fn, timeout = 40000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await fn()) return;
    await sleep(200);
  }
  throw new Error(`timed out: ${what}\n${logOf(newData).slice(-2500)}`);
}
const titles = async () => (await app.invoke("workspace_tree")).map((p) => p.title);
const isPlain = (f) => fs.readFileSync(f).subarray(0, 16).toString("latin1") === "SQLite format 3\0";
const start = (opts = {}) => launch({ demo: false, home, env: ENV, ...opts });

/** The WebView's localStorage databases (WebKitGTK: `localstorage/*.localstorage`). */
function storageFiles(dir) {
  const ls = path.join(dir, "localstorage");
  return fs.existsSync(ls) ? fs.readdirSync(ls).filter((f) => f.endsWith(".localstorage")).map((f) => path.join(ls, f)) : [];
}

before(async () => {
  killApp();
  // Written by this build under the new names first.
  app = await start();
  const notiz = await app.invoke("page_create", { parentId: null, title: "Notiz aus 1.14", icon: null, content: "geschrieben mit 1.14" });
  const geheim = await app.invoke("page_create", { parentId: null, title: "Geheime Notiz", icon: null, content: "Kontonummer 4711-0815" });
  pageIds = { notiz: notiz.id, geheim: geheim.id };
  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", { settings: { ...view.settings, daily_target_hours: 7.5, theme: "dark" } });
  await app.browser.execute(() => {
    localStorage.setItem("arcalo.calendar.view", "week");
    localStorage.setItem("arcalo.sidebar-w", "333");
  });
  version = /Arcalo ([\d.]+[^ ]*) started/.exec(logOf(newData))?.[1];
  assert.ok(version, "version in the log");
  // Encrypted, as Settings → Sicherheit does it: the key is stored, the app restarts and switches.
  await app.invoke("cipher_recovery_key", { create: true });
  await app.browser.execute(() => setTimeout(() => window.__TAURI_INTERNALS__.invoke("cipher_switch", { encrypt: true }), 50));
  await until("encrypted", () => /database encrypted/.test(logOf(newData)));
  await until("restarted", () => (logOf(newData).match(/Arcalo [\d.]+\S* started/g) ?? []).length >= 2);
  await sleep(2500);
  await app.close().catch(() => {});
  app = null;
  killApp();
  await sleep(800);
  assert.ok(!isPlain(path.join(newData, "workspace.db")), "encrypted");

  // ... and given the names of 1.14.
  for (const root of roots) if (fs.existsSync(path.join(root, NEW))) fs.renameSync(path.join(root, NEW), path.join(root, OLD));
  for (const file of storageFiles(oldData)) {
    const db = new DatabaseSync(file);
    db.exec("DELETE FROM ItemTable WHERE key = 'arcalo.storage-copied'");
    db.exec("UPDATE ItemTable SET key = 'annalo.' || substr(key, 8) WHERE key LIKE 'arcalo.%'");
    db.close();
  }
  assert.ok(storageFiles(oldData).length > 0, "WebView storage in the data folder");
  if (fs.existsSync(path.join(oldData, ".arcalo-health"))) fs.renameSync(path.join(oldData, ".arcalo-health"), path.join(oldData, ".annalo-health"));
  // 1.14 notes the update before it installs 1.15.
  fs.writeFileSync(path.join(oldData, ".annalo-update"), `${version}\nfrom=1.14.1`);
  // A token next to the database key (Linux without a Secret Service keeps both in the file).
  const secrets = JSON.parse(fs.readFileSync(path.join(oldData, "secrets.json"), "utf8"));
  assert.ok(secrets.db_key, "the database key is in the file");
  fs.writeFileSync(path.join(oldData, "secrets.json"), JSON.stringify({ ...secrets, git_token: "ghp-aus-1-14" }), { mode: 0o600 });
  assert.ok(!fs.existsSync(newData), "only the folders of 1.14");
});

after(async () => {
  await app?.close();
  killApp();
  for (const d of [home, customHome, customDir]) if (d) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

test("an installation of 1.14 opens unchanged: pages, settings, the encrypted workspace, the secret", async () => {
  app = await start();
  const status = await app.invoke("data_dir_status");
  assert.equal(status.data_dir, newData, "the folder of the new identifier");
  assert.ok((await titles()).includes("Notiz aus 1.14"));
  // The encrypted workspace opened with the key that came along.
  assert.ok(!isPlain(path.join(newData, "workspace.db")), "still encrypted");
  assert.match((await app.invoke("page_get", { id: pageIds.geheim })).content, /Kontonummer 4711-0815/);
  const s = (await app.invoke("settings_get")).settings;
  assert.equal(s.daily_target_hours, 7.5);
  assert.equal(s.theme, "dark");
  assert.equal((await app.invoke("git_sync_status")).token_set, true, "the token of 1.14 is found");
  // The WebView's storage came along, under the new key names.
  const stored = await app.browser.execute(() => ({
    view: localStorage.getItem("arcalo.calendar.view"),
    width: localStorage.getItem("arcalo.sidebar-w"),
    copied: localStorage.getItem("arcalo.storage-copied"),
    old: localStorage.getItem("annalo.calendar.view"),
  }));
  assert.deepEqual(stored, { view: "week", width: "333", copied: "1", old: "week" });
  // The update of 1.14 is recognised by its old marker.
  const log = logOf(newData);
  assert.match(log, new RegExp(`first start after the update to ${version.replaceAll(".", "\\.")}: installed`));
  assert.match(log, new RegExp(`${OLD.replaceAll(".", "\\.")} copied to .*${NEW.replaceAll(".", "\\.")}`));
  // The old folder stays as it was (an older version started again finds its data).
  assert.ok(fs.existsSync(path.join(oldData, "workspace.db")) && fs.existsSync(path.join(oldData, ".annalo-update")));
  assert.ok(fs.existsSync(path.join(newData, ".arcalo-migrated.json")));
  assert.ok(!fs.existsSync(path.join(newData, ".annalo-update")), "the marker was read");
  assert.deepEqual(await app.consoleErrors(), []);
  await app.shot("288-after-rename");
});

test("the next start copies nothing again and keeps what was written since", async () => {
  await app.invoke("page_create", { parentId: null, title: "Nach dem Umzug", icon: null, content: "neu" });
  const copies = () => (logOf(newData).match(/ copied to /g) ?? []).length;
  // Data (with the WebView storage) and config are two folders on Linux.
  assert.equal(copies(), 2);
  await app.close();
  app = await start();
  const now = await titles();
  assert.ok(now.includes("Nach dem Umzug") && now.includes("Notiz aus 1.14"));
  assert.equal(copies(), 2, "copied once");
  assert.equal(await app.browser.execute(() => localStorage.getItem("arcalo.sidebar-w")), "333");
  await app.close();
  app = null;
});

test("a data folder chosen in 1.14 (location.json) stays in use", async () => {
  customDir = fs.mkdtempSync(path.join(os.tmpdir(), "arcalo-e2e-288-eigen-"));
  app = await launch({ demo: false, dataDir: customDir, env: ENV });
  await app.invoke("page_create", { parentId: null, title: "Notiz im eigenen Ordner", icon: null, content: "D:" });
  await app.close();
  app = null;
  customHome = fs.mkdtempSync(path.join(os.tmpdir(), "arcalo-e2e-288-home2-"));
  const oldConfig = path.join(customHome, ".config", OLD);
  fs.mkdirSync(oldConfig, { recursive: true });
  fs.writeFileSync(path.join(oldConfig, "location.json"), JSON.stringify({ data_dir: customDir }));
  app = await launch({ demo: false, home: customHome, env: ENV });
  assert.equal((await app.invoke("data_dir_status")).data_dir, customDir);
  assert.ok((await titles()).includes("Notiz im eigenen Ordner"));
  assert.ok(fs.existsSync(path.join(customHome, ".config", NEW, "location.json")), "location.json came along");
});
