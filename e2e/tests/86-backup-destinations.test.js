// Backup destinations (1.6.0): a second folder (standing in for a network share) is added under
// Settings → Sicherung, „Jetzt testen“ writes and deletes a probe, and every backup is copied
// there in the background with its SHA-256 checksum. An unreachable destination stays pending
// without holding anything up, a hanging one is given up after the stall timeout (shortened here
// with ANNALO_BACKUP_STALL_SECS; ANNALO_TEST_SLOW_DEST makes every step to it take 20 s), and the
// retention of a destination only touches Annalo's own files of this computer.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, guarded } from "../lib/harness.js";

let app;
const test = guarded(nodeTest, () => app);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "annalo-e2e-dest-"));
// A folder name with a space and umlauts, like „\\nas\Team Büro\Annalo“.
const share = path.join(root, "Netzlaufwerk Büro", "Annalo");
const offlineParent = path.join(root, "nicht verbunden");
const offline = path.join(offlineParent, "Annalo");
const hanging = path.join(root, "haengt");
fs.mkdirSync(path.dirname(share), { recursive: true });
fs.mkdirSync(hanging, { recursive: true });

before(async () => {
  app = await launch({
    dataDir: fs.mkdtempSync(path.join(root, "data-")),
    env: { ANNALO_BACKUP_DELAY_SECS: "3600", ANNALO_BACKUP_STALL_SECS: "3", ANNALO_TEST_SLOW_DEST: "haengt=20000" },
  });
});
after(async () => {
  await app?.close();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const backupsIn = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^annalo-\d{8}-\d{6}\.db$/.test(f)).sort() : []);
const views = () => app.invoke("backup_destinations");
const view = async (p) => (await views()).find((v) => v.path === p);

async function openBackupSettings() {
  await app.keys(["Control", ","]);
  await app.waitFor(".settings-nav");
  for (const el of await app.$$(".settings-nav-item")) if ((await app.textOf(el)) === "Sicherung") await el.click();
  await app.waitText(".settings-head h1", /Sicherung/);
}

async function addDestination(p) {
  const input = await app.waitFor(".bdest-input");
  await input.click();
  await input.setValue(p);
  await app.click(".bdest-add .btn-primary");
  await app.browser.waitUntil(async () => !!(await view(p)), { timeout: 8000, timeoutMsg: `destination ${p} not saved` });
}

const card = async (p) => {
  const id = (await view(p)).id;
  return `.bdest-card[data-id="${id}"]`;
};

async function clickIn(scope, label) {
  for (const b of await app.$$(`${scope} .btn`)) {
    if ((await app.textOf(b)) === label) {
      await app.browser.execute((e) => e.scrollIntoView({ block: "center" }), b);
      return b.click();
    }
  }
  throw new Error(`no button ${label} in ${scope}`);
}

let host;

test("a destination is added in the settings and „Jetzt testen“ writes and deletes a probe", async () => {
  await openBackupSettings();
  await app.waitText(".bdest-empty", /Noch kein weiteres Ziel/);
  await addDestination(share);
  const sel = await card(share);
  await app.waitText(`${sel} .bdest-path`, /Annalo/);
  await app.waitText(`${sel} .bdest-kind`, /Ordner/);
  await app.waitText(`${sel} .bdest-state`, /Wartet auf die nächste Sicherung|Zuletzt kopiert/);
  host = (await view(share)).folder;
  assert.match(host, /^[a-z0-9_-]+$/, "a folder name for this computer");
  // Adding the same folder again (other separators) is refused.
  const input = await app.$(".bdest-input");
  await input.setValue(`${share}/`);
  await app.waitText(".bdest-dup", /schon ein Sicherungsziel/);
  assert.equal(await (await app.$(".bdest-add .btn-primary")).isEnabled(), false);
  await input.clearValue();

  await clickIn(sel, "Jetzt testen");
  await app.waitText(`${sel} .bdest-test`, /Schreiben, Lesen und Löschen: \d+ ms/, 15000);
  assert.deepEqual(fs.readdirSync(share).filter((f) => f.startsWith(".annalo-probe")), [], "probe file deleted");
  // A test of a folder whose share is missing names the reason.
  const res = await app.invoke("backup_destination_test", { path: offline });
  assert.equal(res.ok, false);
  assert.equal(res.failure.problem, "unreachable");
  assert.ok(!fs.existsSync(offlineParent), "nothing created where the share should be");
  await app.shot("86-destination-added");
});

test("a backup appears locally and in the destination with its checksum", async () => {
  await app.dismissToasts();
  // An attachment (a drawing) to be copied along.
  fs.mkdirSync(path.join(app.dataDir, "attachments"), { recursive: true });
  fs.writeFileSync(path.join(app.dataDir, "attachments", "Plan Büro.excalidraw"), '{"type":"excalidraw"}');
  for (const el of await app.$$(".set-row-control .btn")) if ((await app.textOf(el)) === "Jetzt sichern") await el.click();
  await app.waitText(".toast-title", /Sicherung erstellt/);
  await app.waitText(".toast-detail", /Sicherungsziele folgen im Hintergrund/);
  const local = await app.invoke("backup_list");
  const name = local[0].file_name;
  const dir = path.join(share, host);
  await app.browser.waitUntil(async () => backupsIn(dir).includes(name) && fs.existsSync(path.join(dir, `${name}.sha256`)), {
    timeout: 15000,
    timeoutMsg: `no copy in ${dir}: ${fs.existsSync(dir) ? fs.readdirSync(dir) : "missing"}`,
  });
  const sum = fs.readFileSync(path.join(dir, `${name}.sha256`), "utf8");
  assert.equal(sum, `${sha256(path.join(dir, name))}  ${name}\n`, "sha256sum format, matching the copy");
  assert.equal(sha256(path.join(dir, name)), sha256(local[0].path), "the copy equals the local backup");
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".partial")), [], "no partial files left");
  await app.browser.waitUntil(async () => fs.existsSync(path.join(dir, "attachments", "Plan Büro.excalidraw")), { timeout: 8000, timeoutMsg: "attachments not copied along" });
  const sel = await card(share);
  await app.waitText(`${sel} .bdest-state`, /Zuletzt kopiert/, 10000);
  // The backup list shows the copy with its source and the checksum mark.
  await app.waitFor('.backup-row[data-source]:not([data-source="local"])', 10000);
  await app.waitText('.backup-row:not([data-source="local"]) .backup-source-text', new RegExp(host));
  assert.ok(await (await app.$('.backup-row:not([data-source="local"]) .backup-sum')).isExisting(), "checksum mark");
  await app.shot("86-backup-copied");
});

test("an unreachable and a hanging destination stay pending and block nothing", async () => {
  await addDestination(offline);
  await addDestination(hanging);
  const started = Date.now();
  const b = await app.invoke("backup_now");
  assert.ok(Date.now() - started < 8000, `backup_now returned after ${Date.now() - started} ms`);
  // The app answers while the hanging copy runs.
  const t0 = Date.now();
  await app.invoke("workspace_tree");
  assert.ok(Date.now() - t0 < 2000, "the app stays responsive");
  // The reachable destination gets the backup although the others fail or hang.
  await app.browser.waitUntil(async () => backupsIn(path.join(share, host)).includes(b.file_name), { timeout: 15000, timeoutMsg: "copy to the reachable share blocked" });
  await app.browser.waitUntil(async () => (await view(offline))?.health === "pending", { timeout: 10000, timeoutMsg: "offline destination not pending" });
  const off = await view(offline);
  assert.equal(off.state.last_error.problem, "unreachable");
  assert.ok(off.state.next_try, "retried later with a pause");
  assert.ok(!fs.existsSync(offlineParent), "the missing share was not created");
  // The hanging one is given up after the stall timeout (3 s here), not after the 20 s the step takes.
  await app.browser.waitUntil(async () => (await view(hanging))?.health === "pending", { timeout: 12000, timeoutMsg: "hanging destination not given up" });
  assert.equal((await view(hanging)).state.last_error.problem, "timeout");
  assert.ok(Date.now() - started < 15000, "gave up within the stall timeout");
  assert.deepEqual(backupsIn(path.join(hanging, host)), [], "nothing half-written looks like a backup");
  // Quiet status: pending, no warning toast after one missed backup.
  await app.waitText(`${await card(offline)} .bdest-state`, /Ausstehend – nicht erreichbar/, 8000);
  await app.waitText(`${await card(hanging)} .bdest-state`, /Ausstehend – keine Antwort|Wird kopiert/, 8000);
  assert.equal((await app.$$(".toast-title")).length === 0 || !(await app.text(".toast-title")).includes("seit Längerem"), true);
  await app.shot("86-destination-pending");

  // The share comes back: „Erneut versuchen“ copies the newest backup at once.
  fs.mkdirSync(offlineParent, { recursive: true });
  await clickIn(await card(offline), "Erneut versuchen");
  await app.browser.waitUntil(async () => backupsIn(path.join(offline, host)).includes(b.file_name), { timeout: 15000, timeoutMsg: "retry did not copy" });
  await app.browser.waitUntil(async () => (await view(offline)).health === "ok", { timeout: 8000, timeoutMsg: "not ok after retry" });
  await app.waitText(`${await card(offline)} .bdest-state`, /Zuletzt kopiert/, 8000);
});

test("retention keeps the newest backups of this computer and never touches other files", async () => {
  // Remove the slow ones; the reachable share keeps 2.
  const view0 = await app.invoke("settings_get");
  const s = view0.settings;
  s.backup_targets.destinations = s.backup_targets.destinations.filter((d) => d.path === share).map((d) => ({ ...d, keep: 2 }));
  await app.invoke("settings_save", { settings: s });
  const dir = path.join(share, host);
  // Files that are not Annalo's own backups of this computer.
  fs.writeFileSync(path.join(dir, "Notizen.txt"), "fremd");
  fs.writeFileSync(path.join(dir, "annalo-20200101-000000.db"), "ohne Prüfsumme");
  const other = path.join(share, "anderer-pc");
  fs.mkdirSync(other, { recursive: true });
  for (const n of ["annalo-20200101-000000.db", "annalo-20200102-000000.db", "annalo-20200103-000000.db"]) {
    fs.writeFileSync(path.join(other, n), "x");
    fs.writeFileSync(path.join(other, `${n}.sha256`), `${"0".repeat(64)}  ${n}\n`);
  }
  let last;
  for (let i = 0; i < 3; i++) {
    await sleep(1100);
    last = await app.invoke("backup_now");
    await app.browser.waitUntil(async () => backupsIn(dir).includes(last.file_name), { timeout: 15000, timeoutMsg: "copy missing" });
  }
  await app.browser.waitUntil(async () => backupsIn(dir).filter((f) => f !== "annalo-20200101-000000.db").length === 2, { timeout: 10000, timeoutMsg: `not pruned: ${backupsIn(dir)}` });
  const own = backupsIn(dir).filter((f) => f !== "annalo-20200101-000000.db");
  assert.equal(own[1], last.file_name, "the newest is kept");
  for (const f of own) assert.ok(fs.existsSync(path.join(dir, `${f}.sha256`)));
  assert.ok(fs.existsSync(path.join(dir, "Notizen.txt")), "foreign file kept");
  assert.ok(fs.existsSync(path.join(dir, "annalo-20200101-000000.db")), "a backup without checksum is not ours");
  assert.equal(backupsIn(other).length, 3, "the other computer's backups are left alone");
});

test("the settings look right in light and dark and at 900 px", async () => {
  await openBackupSettings();
  const sel = await card(share);
  await app.browser.execute((s) => document.querySelector(s)?.scrollIntoView({ block: "start" }), sel);
  await app.shot("86-settings-light");
  const view0 = await app.invoke("settings_get");
  await app.invoke("settings_save", { settings: { ...view0.settings, theme: "dark" } });
  await app.browser.waitUntil(async () => (await app.browser.execute(() => document.documentElement.dataset.theme)) === "dark", { timeout: 5000, timeoutMsg: "no dark theme" });
  await app.browser.execute((s) => document.querySelector(s)?.scrollIntoView({ block: "start" }), sel);
  await app.shot("86-settings-dark");
  await app.browser.setWindowSize(900, 900);
  await sleep(400);
  const overflow = await app.browser.execute(() => {
    const scroller = document.querySelector(".settings-scroll");
    const cards = [...document.querySelectorAll(".bdest-card, .backup-row, .bdest-add")];
    const edge = scroller.getBoundingClientRect().right;
    return cards.filter((c) => c.getBoundingClientRect().right > edge + 1).map((c) => c.className);
  });
  assert.deepEqual(overflow, [], "nothing sticks out at 900 px");
  await app.browser.execute((s) => document.querySelector(s)?.scrollIntoView({ block: "start" }), sel);
  await app.shot("86-settings-900");
  await app.browser.setWindowSize(1480, 920);
  await app.invoke("settings_save", { settings: { ...(await app.invoke("settings_get")).settings, theme: "light" } });
});
