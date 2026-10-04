// Changing the database key (1.12): Settings → Sicherheit → „Schlüssel wechseln“ shows a new
// recovery key (to print or save, confirmed), restarts and re-encrypts the database with it
// without an unencrypted copy. Afterwards the new recovery key opens the workspace, the old one
// does not, and backups use the new key.
import { test as nodeTest, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { APP, launch, guarded } from "../lib/harness.js";

let app;
const test = guarded(nodeTest, () => app);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "annalo-e2e-rekey-"));
const dataDir = path.join(root, "daten");
fs.mkdirSync(dataDir, { recursive: true });
const db = path.join(dataDir, "workspace.db");
const secretsFile = path.join(dataDir, "secrets.json");
// No Secret Service on the test machine: the key is in secrets.json (the file fallback).
const ENV = { ANNALO_BACKUP_DELAY_SECS: "3600", ANNALO_SECRET_STORE: "file" };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = () => {
  try {
    return fs.readFileSync(path.join(dataDir, "logs", "annalo.log"), "utf8");
  } catch {
    return "";
  }
};
const count = (re) => (log().match(re) ?? []).length;
async function until(what, fn, timeout = 40000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await fn()) return;
    await sleep(200);
  }
  throw new Error(`timed out: ${what}\n${log().slice(-2500)}`);
}
/** Ends the app of this test's data folder that restarted itself (found by its environment). */
function endRestarted() {
  for (const pid of fs.readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
    try {
      if (fs.readlinkSync(`/proc/${pid}/exe`) !== APP) continue;
      if (!fs.readFileSync(`/proc/${pid}/environ`, "latin1").split("\0").includes(`ANNALO_DATA_DIR=${dataDir}`)) continue;
      process.kill(Number(pid), "SIGTERM");
    } catch {
      /* gone or not ours */
    }
  }
}
async function afterRestart(what, re, before) {
  await until(what, () => count(re) > before);
  await until("restarted", () => count(/Arcalo [\d.]+ started/g) >= starts + 1);
  await sleep(2500);
  await app?.close().catch(() => {});
  app = null;
  endRestarted();
  await sleep(800);
}
let starts = 0;
async function start(env = {}) {
  starts = count(/Arcalo [\d.]+ started/g) + 1;
  app = await launch({ demo: true, dataDir, env: { ...ENV, ...env } });
}
const secrets = () => JSON.parse(fs.readFileSync(secretsFile, "utf8"));
const isPlain = (f) => fs.readFileSync(f).subarray(0, 16).toString("latin1") === "SQLite format 3\0";
async function openSecurity() {
  await app.keys(["Control", ","]);
  await app.waitFor(".settings-nav");
  for (const el of await app.$$(".settings-nav-item")) if (/^(Sicherheit|Security)$/.test(await app.textOf(el))) await el.click();
  await app.waitFor(".sec-state");
}
const shownCode = () => app.browser.execute(() => document.querySelector(".sec-code")?.dataset.code ?? "");

after(async () => {
  await app?.close();
  endRestarted();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

let oldCode;
let page;

test("the key changes without decrypting: a new recovery key, the old one no longer opens it", async () => {
  await start();
  page = await app.invoke("page_create", { parentId: null, title: "Vertraulich", icon: null, content: "Kennwort der Testanlage 4711" });
  oldCode = await app.invoke("cipher_recovery_key", { create: true });
  let before = count(/database encrypted/g);
  await app.browser.execute(() => setTimeout(() => window.__TAURI_INTERNALS__.invoke("cipher_switch", { encrypt: true }), 50));
  await afterRestart("encrypted", /database encrypted/g, before);
  const oldKey = secrets().db_key;
  assert.ok(oldKey && !isPlain(db));

  await start();
  await openSecurity();
  await app.click(".sec-rekey");
  await app.waitText(".dialog", /Schlüssel wechseln/);
  await app.waitText(".dialog", /Ältere Sicherungen bleiben mit dem alten verschlüsselt/);
  await app.shot("231-rekey-intro");
  await app.click(".dialog .sec-next");
  await app.browser.waitUntil(async () => /^[A-Z2-7]{4}(-[A-Z2-7]{4}){13}$/.test(await shownCode()), { timeoutMsg: "no new recovery key" });
  const newCode = await shownCode();
  assert.notEqual(newCode, oldCode);
  // Not without the confirmation; until the restart the old key stays the key.
  assert.equal(await app.browser.execute(() => document.querySelector(".dialog .sec-go").disabled), true);
  assert.equal(secrets().db_key, oldKey);
  assert.ok(secrets().db_key_next, "the new key waits next to the old one");
  await app.shot("231-rekey-key");
  await app.click(".dialog .sec-confirm input");
  before = count(/database key changed/g);
  await app.browser.execute(() => setTimeout(() => document.querySelector(".dialog .sec-go").click(), 50));
  await afterRestart("key changed", /database key changed/g, before);

  const s = secrets();
  assert.ok(s.db_key && s.db_key !== oldKey, "the new key is the key");
  assert.equal(s.db_key_next, undefined, "no second key left");
  assert.ok(!isPlain(db) && !fs.readFileSync(db).includes("Kennwort der Testanlage"), "never written unencrypted");
  assert.ok(!fs.readdirSync(dataDir).some((f) => f.endsWith(".cipher-new")));

  // The app opens with the new key and says what changed; backups use it.
  await start();
  assert.match((await app.invoke("page_get", { id: page.id })).content, /Kennwort der Testanlage 4711/);
  const backup = await app.invoke("backup_now");
  assert.ok(!isPlain(backup.path));
  await app.close();
  app = null;

  // A computer without the key: the old recovery key is refused, the new one opens it.
  const without = secrets();
  delete without.db_key;
  fs.writeFileSync(secretsFile, JSON.stringify(without), { mode: 0o600 });
  await start();
  await app.waitFor(".keygate-card");
  await app.click(".keygate-code");
  await app.type(oldCode);
  await app.click(".keygate-card button[type=submit]");
  await app.waitText(".keygate-msg", /passt nicht zu dieser Datenbank/);
  await app.shot("231-old-key-refused");
  await app.browser.execute(() => {
    const el = document.querySelector(".keygate-code");
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, "");
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await app.click(".keygate-code");
  await app.type(newCode);
  before = count(/database key entered/g);
  await app.click(".keygate-card button[type=submit]");
  await afterRestart("opened with the new recovery key", /database key entered/g, before);
  await start();
  assert.match((await app.invoke("page_get", { id: page.id })).content, /Kennwort der Testanlage 4711/);
});
