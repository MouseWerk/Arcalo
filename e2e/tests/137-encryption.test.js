// Encryption at rest (1.10): Settings → Sicherheit encrypts a workspace with sample data (the
// recovery key is shown and confirmed, the app restarts and switches before opening the
// database), every row is still there after the restart and the file holds no plain text. Without
// the key in the credential store the recovery screen opens it with the recovery key (English).
// Backups are encrypted and restore from the settings and from the start-up recovery. Decrypting
// gives a plain SQLite file again.
import { test as nodeTest, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { APP, appEnv, launch, guarded } from "../lib/harness.js";
import { germanLeftovers } from "../lib/english.js";

let app;
const test = guarded(nodeTest, () => app);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "annalo-e2e-crypt-"));
const dataDir = path.join(root, "daten");
fs.mkdirSync(dataDir, { recursive: true });
const db = path.join(dataDir, "workspace.db");
const secretsFile = path.join(dataDir, "secrets.json");
// Linux in CI has no Secret Service: the key lands in secrets.json (the file fallback), which the
// test can take away like a new computer would not have it.
const ENV = { ANNALO_BACKUP_DELAY_SECS: "3600", ANNALO_SECRET_STORE: "file" };

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
    return fs.readFileSync(path.join(dataDir, "logs", "annalo.log"), "utf8");
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
  throw new Error(`timed out: ${what}\n${log().slice(-2500)}`);
}
const header = (f) => fs.readFileSync(f).subarray(0, 16).toString("latin1");
const isPlain = (f) => header(f) === "SQLite format 3\0";
const count = (re) => (log().match(re) ?? []).length;
const titles = async () => (await app.invoke("workspace_tree")).map((p) => p.title);
const start = (env = {}) => launch({ demo: false, dataDir, env: { ...ENV, ...env } });
/** The app restarted itself (it is not under WebDriver any more): ends it and the session. */
async function afterRestart(what, re, before) {
  await until(what, () => count(re) > before);
  await until("restarted", () => count(/Arcalo [\d.]+ started/g) >= 2);
  await sleep(2500);
  await app?.close().catch(() => {});
  app = null;
  killApp();
  await sleep(600);
}
/** Clicks a button that restarts the app (the click's answer would never come back). */
async function pressRestarting(sel) {
  await app.browser.execute((s) => setTimeout(() => document.querySelector(s).click(), 50), sel);
}
async function openSecurity() {
  await app.keys(["Control", ","]);
  await app.waitFor(".settings-nav");
  for (const el of await app.$$(".settings-nav-item")) if (/^(Sicherheit|Security)$/.test(await app.textOf(el))) await el.click();
  await app.waitFor(".sec-state");
}

let code;
let backupFile;
let pageCount;

after(async () => {
  await app?.close();
  killApp();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

test("encrypting a workspace with sample data keeps every row and leaves no plain text", async () => {
  killApp();
  await sleep(800);
  app = await launch({ demo: true, dataDir, env: ENV });
  const page = await app.invoke("page_create", { parentId: null, title: "Geheime Notiz", icon: null, content: "Kontonummer 4711-0815" });
  assert.ok(page.id);
  pageCount = (await titles()).length;
  assert.ok(pageCount > 5, `sample data: ${pageCount} pages`);
  assert.ok(isPlain(db), "plain before");

  await openSecurity();
  assert.match(await app.text(".sec-state"), /Nicht verschlüsselt/);
  // The mirror stays plaintext: said next to the switch, with its own switch.
  await app.waitText(".set-row", /Markdown-Spiegel[\s\S]*Bleibt unverschlüsselt/);
  await app.shot("137-security-off");
  await app.click(".sec-encrypt");
  await app.waitText(".dialog", /Datenbank verschlüsseln/);
  await app.waitText(".dialog", /Markdown-Spiegel/);
  await app.click(".dialog .sec-next");
  await app.browser.waitUntil(async () => /^[A-Z2-7]{4}(-[A-Z2-7]{4}){13}$/.test(await app.browser.execute(() => document.querySelector(".sec-code")?.dataset.code ?? "")), { timeoutMsg: "no recovery key" });
  code = await app.browser.execute(() => document.querySelector(".sec-code").dataset.code);
  // Not without the confirmation.
  assert.equal(await app.browser.execute(() => document.querySelector(".dialog .sec-go").disabled), true);
  await app.shot("137-recovery-key");
  await app.click(".dialog .sec-confirm input");
  const before = count(/database encrypted/g);
  await pressRestarting(".dialog .sec-go");
  await afterRestart("encrypted", /database encrypted/g, before);

  assert.ok(!isPlain(db), "encrypted on disk");
  const raw = fs.readFileSync(db);
  assert.ok(!raw.includes("Kontonummer"), "no plain text in the database");
  assert.ok(fs.existsSync(path.join(dataDir, "workspace.db.cipher-old")), "the plain original is kept until the next start");
  assert.match(fs.readFileSync(secretsFile, "utf8"), /"db_key"/);

  app = await start();
  assert.equal((await titles()).length, pageCount, "same pages");
  const doc = await app.invoke("page_get", { id: page.id });
  assert.match(doc.content, /Kontonummer 4711-0815/);
  // The second start after the switch deletes the plain original.
  await until("original deleted", () => !fs.existsSync(path.join(dataDir, "workspace.db.cipher-old")));
  // Backups of an encrypted database are encrypted (same key).
  const info = await app.invoke("backup_now");
  backupFile = info.path;
  assert.ok(!isPlain(backupFile), "encrypted backup");
  assert.ok(!fs.readFileSync(backupFile).includes("Kontonummer"));
  await openSecurity();
  assert.match(await app.text(".sec-state"), /Verschlüsselt/);
  await app.shot("137-security-on");
  assert.deepEqual(await app.consoleErrors(), []);
});

test("without the key the recovery screen opens the workspace with the recovery key (English)", async () => {
  await app.close();
  app = null;
  killApp();
  await sleep(500);
  // A new computer: the credential is gone.
  const secrets = JSON.parse(fs.readFileSync(secretsFile, "utf8"));
  delete secrets.db_key;
  fs.writeFileSync(secretsFile, JSON.stringify(secrets), { mode: 0o600 });
  const started = count(/Arcalo [\d.]+ started/g);
  app = await launch({ demo: false, dataDir, env: { ...ENV, ANNALO_LOCALE: "en-US" } });
  await app.waitFor(".keygate-card");
  assert.match(await app.text(".keygate-card h1"), /Key missing/);
  assert.deepEqual(await germanLeftovers(app), []);
  await app.shot("137-keygate-en");
  // A typo is caught by the checksum.
  const typo = code.slice(0, 5) + (code[5] === "A" ? "B" : "A") + code.slice(6);
  await app.click(".keygate-code");
  await app.type(typo.toLowerCase());
  await app.click(".keygate-card button[type=submit]");
  await app.waitText(".keygate-msg", /typo/);
  await app.browser.execute(() => {
    const el = document.querySelector(".keygate-code");
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, "");
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  // Typed in lower case with spaces: read like the printed key.
  await app.click(".keygate-code");
  await app.type(code.toLowerCase().replace(/-/g, " "));
  await app.click(".keygate-card button[type=submit]");
  await until("key entered", () => /database key entered \(recovery, remembered: true\)/.test(log()));
  await until("restarted", () => count(/Arcalo [\d.]+ started/g) >= started + 2);
  await sleep(2500);
  await app.close().catch(() => {});
  app = null;
  killApp();
  await sleep(500);
  assert.match(fs.readFileSync(secretsFile, "utf8"), /"db_key"/, "stored again");
  app = await start();
  assert.ok((await titles()).includes("Geheime Notiz"));
});

test("an encrypted backup restores from the settings and from the start-up recovery", async () => {
  await app.invoke("page_create", { parentId: null, title: "Nach der Sicherung", icon: null, content: "später" });
  const before = count(/database restored from/g);
  const staged = await app.invoke("backup_restore", { path: backupFile });
  assert.equal(staged.ok, true, JSON.stringify(staged));
  await app.invoke("app_restart").catch(() => {});
  await until("restored", () => count(/database restored from/g) > before);
  await sleep(2500);
  await app.close().catch(() => {});
  app = null;
  killApp();
  await sleep(500);
  app = await start();
  let now = await titles();
  assert.ok(now.includes("Geheime Notiz") && !now.includes("Nach der Sicherung"), `restored: ${now}`);
  await app.close();
  app = null;
  killApp();

  // A broken database: the recovery restores the newest (encrypted) backup, which opens with the key.
  for (const f of ["workspace.db-wal", "workspace.db-shm"]) fs.rmSync(path.join(dataDir, f), { force: true });
  fs.writeFileSync(db, Buffer.from("kein SQLite\n".repeat(300)));
  const child = spawn(APP, [], { env: appEnv(dataDir, { demo: false, env: { ...ENV, ANNALO_TEST_RECOVERY_CHOICE: "restore" } }), stdio: "ignore" });
  const exit = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 40000);
    child.on("exit", (c) => (clearTimeout(timer), resolve(c)));
  });
  assert.equal(exit, 0, "restored and restarted");
  await sleep(2500);
  killApp();
  await sleep(500);
  assert.ok(!isPlain(db), "the restored database is encrypted");
  app = await start();
  now = await titles();
  assert.ok(now.includes("Geheime Notiz"), `recovered: ${now}`);
});

test("decrypting gives a plain SQLite file with the same data", async () => {
  await openSecurity();
  await app.click(".sec-decrypt");
  await app.waitText(".dialog", /Verschlüsselung entfernen/);
  const before = count(/database decrypted/g);
  await pressRestarting(".dialog .sec-go");
  await until("decrypted", () => count(/database decrypted/g) > before);
  await sleep(2500);
  await app.close().catch(() => {});
  app = null;
  killApp();
  await sleep(500);
  assert.ok(isPlain(db), "plain again");
  app = await start();
  assert.ok((await titles()).includes("Geheime Notiz"));
  assert.match((await app.invoke("cipher_status")).state, /plain/);
});
