// A backup written by a newer Arcalo (after a return to an earlier version the backup folder holds
// the newer version's daily backups) is never put in place: „Wiederherstellen…“ refuses it before
// anything is staged, and the start-up recovery of a broken database takes the newest backup this
// version can open. Before, the next start stopped at „Neuere Datenbank“ (no way out but quitting)
// with the workspace set aside.
import { test as nodeTest, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { APP, appEnv, launch, guarded, stopStarted, startProcess } from "../lib/harness.js";

let app;
const test = guarded(nodeTest, () => app);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "arcalo-e2e-newer-backup-"));
const dataDir = path.join(root, "daten");
const backups = path.join(dataDir, "backups");
fs.mkdirSync(dataDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

/** A copy of the backup `from` as the newer version's backup `name`: its schema one ahead (the
 * SQLite header keeps `user_version` big-endian at byte 60). */
function newerCopy(from, name) {
  const bytes = fs.readFileSync(from);
  bytes.writeUInt32BE(bytes.readUInt32BE(60) + 1, 60);
  const to = path.join(backups, name);
  fs.writeFileSync(to, bytes);
  return to;
}

after(async () => {
  await app?.close();
  stopStarted();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

let own;

test("a backup of a newer version is refused in the settings and nothing is staged", async () => {
  stopStarted();
  await sleep(1000);
  app = await start();
  await app.invoke("page_create", { parentId: null, title: "Mein Stand", icon: null, content: "bleibt" });
  own = await app.invoke("backup_now");
  const newer = newerCopy(own.path, "arcalo-29990101-000000.db");
  const res = await app.invoke("backup_restore", { path: newer });
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.match(res.failure.message, /neueren Arcalo-Version/);
  assert.ok(!fs.existsSync(path.join(dataDir, "restore-pending.db")), "nothing staged");
  // The workspace's own backup still restores.
  assert.equal((await app.invoke("backup_restore", { path: own.path })).ok, true);
  fs.rmSync(path.join(dataDir, "restore-pending.db"));
  fs.rmSync(path.join(dataDir, "restore-pending.db.from"), { force: true });
  await app.close();
  app = null;
});

test("the start-up recovery skips the newer backup and opens the newest one it can read", async () => {
  stopStarted();
  await sleep(500);
  for (const f of ["workspace.db-wal", "workspace.db-shm"]) fs.rmSync(path.join(dataDir, f), { force: true });
  fs.writeFileSync(path.join(dataDir, "workspace.db"), Buffer.from("kein SQLite\n".repeat(200)));
  const child = startProcess(APP, [], { env: appEnv(dataDir, { demo: false, env: { ARCALO_TEST_RECOVERY_CHOICE: "restore" } }), stdio: "ignore" });
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 40000);
    child.on("exit", (c) => {
      clearTimeout(timer);
      resolve(c);
    });
  });
  assert.equal(code, 0, "restored and restarted");
  await until("recovery logged", () => /database restored from backup arcalo-/.test(log()));
  assert.match(log(), new RegExp(`database restored from backup ${own.file_name}`));
  await sleep(1500);
  stopStarted();
  await sleep(500);
  app = await start();
  assert.ok((await titles()).includes("Mein Stand"), "the workspace opens with its own backup");
});
