// Restoring from a backup destination (1.6.0): the backup list in Settings → Sicherung shows the
// copies in the destination with their source; „Wiederherstellen…“ checks the checksum, copies
// the backup into the data folder and restarts, and the next start puts it in place (the previous
// database is kept as workspace.db.before-restore-…). A damaged copy is refused. The start-up
// recovery of a broken database also finds the destination when the local backups are gone.
import { test as nodeTest, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { APP, appEnv, launch, guarded } from "../lib/harness.js";

let app;
const test = guarded(nodeTest, () => app);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "arcalo-e2e-restore-"));
const dataDir = path.join(root, "daten");
const share = path.join(root, "NAS Freigabe", "Arcalo");
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(path.dirname(share), { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const killApp = () => {
  try {
    execSync(`pkill -f "${APP}"`, { stdio: "ignore" });
  } catch {
    /* none running */
  }
};
const log = () => {
  try {
    return fs.readFileSync(path.join(dataDir, "logs", "arcalo.log"), "utf8");
  } catch {
    return "";
  }
};
async function until(what, fn, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await fn()) return;
    await sleep(200);
  }
  throw new Error(`timed out: ${what}\n${log().slice(-2500)}`);
}
const titles = async () => (await app.invoke("workspace_tree")).map((p) => p.title);
const start = () => launch({ demo: false, dataDir, env: { ARCALO_BACKUP_DELAY_SECS: "3600" } });

after(async () => {
  await app?.close();
  killApp();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

let remoteFile;

test("a backup in the destination is restored from the settings after a checksum check", async () => {
  // An app of the previous test file that is still ending would take the single-instance lock.
  killApp();
  await sleep(1000);
  app = await start();
  await app.invoke("page_create", { parentId: null, title: "Stand auf dem NAS", icon: null, content: "gesichert" });
  const view = await app.invoke("settings_get");
  view.settings.backup_targets = { destinations: [{ id: "", path: share, enabled: true, keep: 5, keep_days: 0, attachments: true, markdown: false }], local_latest_only: false };
  await app.invoke("settings_save", { settings: view.settings });
  const b = await app.invoke("backup_now");
  const host = (await app.invoke("backup_destinations"))[0].folder;
  remoteFile = path.join(share, host, b.file_name);
  await until("copy in the destination", () => fs.existsSync(`${remoteFile}.sha256`) && fs.existsSync(remoteFile));
  await app.invoke("page_create", { parentId: null, title: "Nach der Sicherung", icon: null, content: "später" });

  // A damaged copy (same checksum file, other bytes) is refused before anything is replaced.
  const bad = path.join(share, host, "arcalo-20200101-000000.db");
  const bytes = fs.readFileSync(remoteFile);
  bytes[bytes.length - 100] ^= 0xff;
  fs.writeFileSync(bad, bytes);
  fs.writeFileSync(`${bad}.sha256`, fs.readFileSync(`${remoteFile}.sha256`, "utf8").replace(b.file_name, "arcalo-20200101-000000.db"));
  const refused = await app.invoke("backup_restore", { path: bad });
  assert.equal(refused.ok, false);
  assert.equal(refused.failure.problem, "checksum");
  assert.ok(!fs.existsSync(path.join(dataDir, "restore-pending.db")), "nothing staged");
  // Paths outside the backup folders are not accepted.
  const outside = await app.invoke("backup_restore", { path: path.join(root, "arcalo-20200101-000000.db") });
  assert.equal(outside.failure.problem, "invalid");
  fs.rmSync(bad);
  fs.rmSync(`${bad}.sha256`);

  // The list shows local and destination backups; the destination row restores.
  await app.keys(["Control", ","]);
  await app.waitFor(".settings-nav");
  for (const el of await app.$$(".settings-nav-item")) if ((await app.textOf(el)) === "Sicherung") await el.click();
  await app.waitFor('.backup-row[data-source="local"]');
  const row = '.backup-row:not([data-source="local"])';
  await app.waitFor(row, 10000);
  await app.waitText(`${row} .backup-source-text`, new RegExp(`${host}$`));
  await app.browser.execute((s) => document.querySelector(s).scrollIntoView({ block: "center" }), row);
  await app.shot("87-backup-list");
  await app.browser.execute((s) => document.querySelector(`${s} .backup-restore`).click(), row);
  await app.waitText(".dialog", /Sicherung wiederherstellen\?/);
  await app.waitText(".dialog", /NAS Freigabe/);
  await app.shot("87-restore-confirm");
  await app.click(".dialog .btn-danger");
  // Staged and restarted: the new process applies it before opening the database.
  await until("restarted", () => (log().match(/Arcalo [\d.]+ started/g) ?? []).length >= 2);
  await until("restored", () => /database restored from .*arcalo-/.test(log()));
  assert.match(log(), /restore of arcalo-\d{8}-\d{6}\.db prepared/);
  await sleep(1500);
  await app.close().catch(() => {});
  app = null;
  killApp();
  await sleep(500);

  const kept = fs.readdirSync(dataDir).filter((f) => /^workspace\.db\.before-restore-\d{8}-\d{6}$/.test(f));
  assert.equal(kept.length, 1, `previous state kept: ${fs.readdirSync(dataDir)}`);
  assert.ok(!fs.existsSync(path.join(dataDir, "restore-pending.db")), "staged file used up");
  app = await start();
  const now = await titles();
  assert.ok(now.includes("Stand auf dem NAS"), `restored page: ${now}`);
  assert.ok(!now.includes("Nach der Sicherung"), `later page gone: ${now}`);
  await app.close();
  app = null;
});

test("the start-up recovery restores from the destination when the local backups are gone", async () => {
  killApp();
  fs.rmSync(path.join(dataDir, "backups"), { recursive: true, force: true });
  for (const f of ["workspace.db-wal", "workspace.db-shm"]) fs.rmSync(path.join(dataDir, f), { force: true });
  fs.writeFileSync(path.join(dataDir, "workspace.db"), Buffer.from("kein SQLite\n".repeat(200)));
  const child = spawn(APP, [], { env: appEnv(dataDir, { demo: false, env: { ARCALO_TEST_RECOVERY_CHOICE: "restore" } }), stdio: "ignore" });
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 40000);
    child.on("exit", (c) => {
      clearTimeout(timer);
      resolve(c);
    });
  });
  assert.equal(code, 0, "restored and restarted");
  await until("recovery logged", () => /database restored from backup arcalo-/.test(log()));
  assert.match(log(), /neueste von 1 Sicherungen \(davon 1 in weiteren Sicherungszielen\)/);
  await sleep(1500);
  killApp();
  await sleep(500);
  app = await start();
  assert.ok((await titles()).includes("Stand auf dem NAS"));
  assert.ok(fs.existsSync(remoteFile), "the destination's copy is left in place");
});
