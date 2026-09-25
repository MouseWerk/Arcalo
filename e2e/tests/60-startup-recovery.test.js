// Start-up recovery (1.4.1): the real app on a damaged database with a backup restores the
// backup and starts with its pages (the broken file is kept as workspace.db.broken-…); a database
// of a newer Annalo explains that in German and quits without touching the file. The native
// dialog cannot be clicked through WebDriver: debug builds take the answer from
// ANNALO_TEST_RECOVERY_CHOICE, everything else (dialog text, restore, restart, exit code) is real.
import { test as nodeTest, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { APP, appEnv, launch, guarded } from "../lib/harness.js";

let app;
const test = guarded(nodeTest, () => app);
const dirs = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = (name) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `annalo-e2e-${name}-`));
  dirs.push(d);
  return d;
};
const log = (dir) => {
  try {
    return fs.readFileSync(path.join(dir, "logs", "annalo.log"), "utf8");
  } catch {
    return "";
  }
};
const killApp = () => {
  try {
    execSync(`pkill -f "${APP}"`, { stdio: "ignore" });
  } catch {
    /* none running */
  }
};

after(async () => {
  await app?.close();
  killApp();
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

/** Starts the app without WebDriver; resolves to its exit code (null: still running after `timeout`). */
function run(dir, choice, timeout = 30000) {
  const child = spawn(APP, [], { env: appEnv(dir, { demo: false, env: { ANNALO_TEST_RECOVERY_CHOICE: choice } }), stdio: "ignore" });
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeout);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function until(what, fn, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (fn()) return;
    await sleep(200);
  }
  throw new Error(`timed out: ${what}`);
}

const titles = async () => (await app.invoke("workspace_tree")).map((p) => p.title);

let backupFile;

test("a damaged database is restored from the last backup; the app starts with the backup's pages", async () => {
  const dir = tmp("recover");
  // A workspace with a backup, and a page written after it.
  app = await launch({ demo: false, dataDir: dir });
  await app.invoke("page_create", { parentId: null, title: "Aus der Sicherung", icon: null, content: "Stand der Sicherung" });
  const backup = await app.invoke("backup_now");
  backupFile = backup.path;
  await app.invoke("page_create", { parentId: null, title: "Nach der Sicherung", icon: null, content: "fehlt nach dem Wiederherstellen" });
  await app.close();
  app = null;
  killApp();

  // The database is damaged: text where SQLite expects its header.
  const db = path.join(dir, "workspace.db");
  const garbage = Buffer.from("Kein SQLite mehr – ein beschädigter Datenträger hat diese Datei überschrieben.\n".repeat(80));
  for (const f of ["workspace.db-wal", "workspace.db-shm"]) fs.rmSync(path.join(dir, f), { force: true });
  fs.writeFileSync(db, garbage);

  // The dialog offers the restore; the answer „Letzte Sicherung wiederherstellen“ restores and restarts.
  const code = await run(dir, "restore");
  assert.equal(code, 0, "the first process ends after starting the restored app");
  await until("restore logged", () => /database restored from backup annalo-/.test(log(dir)));
  const text = log(dir);
  assert.match(text, /recovery dialog „Datenbank beschädigt“: Die Datenbank im Datenordner lässt sich nicht öffnen/);
  assert.match(text, /verwendet die neueste von 1 Sicherungen/);
  assert.match(text, /answered by the test: Letzte Sicherung wiederherstellen/);
  const broken = fs.readdirSync(dir).filter((f) => /^workspace\.db\.broken-\d{8}-\d{6}$/.test(f));
  assert.equal(broken.length, 1, `broken file kept: ${fs.readdirSync(dir)}`);
  assert.deepEqual(fs.readFileSync(path.join(dir, broken[0])), garbage, "the broken file is kept unchanged");
  assert.equal(fs.readFileSync(db).subarray(0, 15).toString("latin1"), "SQLite format 3");
  // The restarted app opens the restored database.
  await until("restarted app started", () => (log(dir).match(/Annalo [\d.]+ started/g) ?? []).length >= 2);
  await sleep(1500);
  killApp();
  await sleep(500);

  app = await launch({ demo: false, dataDir: dir });
  const now = await titles();
  assert.ok(now.includes("Aus der Sicherung"), `backup's page is there: ${now}`);
  assert.ok(!now.includes("Nach der Sicherung"), `later page is not: ${now}`);
  await app.waitText(".sidebar .tree-row", /Aus der Sicherung/);
  await app.shot("60-restored");
  await app.close();
  app = null;
});

test("a database of a newer Annalo is explained in German; quitting leaves it untouched", async () => {
  assert.ok(backupFile, "needs the backup of the first test");
  const dir = tmp("newer");
  const db = path.join(dir, "workspace.db");
  const bytes = fs.readFileSync(backupFile);
  // PRAGMA user_version lives at byte 60 of the header (big-endian).
  bytes.writeUInt32BE(999, 60);
  fs.writeFileSync(db, bytes);

  const code = await run(dir, "quit");
  assert.equal(code, 1, `quits with exit code 1: ${log(dir)}`);
  const text = log(dir);
  assert.match(text, /recovery dialog „Neuere Datenbank“: Die Datenbank stammt von einer neueren Annalo-Version \(Schema v999, diese kennt v\d+\)\. Bitte Annalo aktualisieren\./);
  assert.match(text, /answered by the test: Beenden/);
  assert.deepEqual(fs.readFileSync(db), bytes, "the newer database is not changed");
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes("broken")), [], "nothing set aside");
});
