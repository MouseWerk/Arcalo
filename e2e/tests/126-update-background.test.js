// Updates 2.0 (mode „automatisch“) against a local feed: the background download with its
// status-bar progress (paused and resumed with a Range request), the calm „bereit“ hint with
// „Jetzt neu starten“ / „Später“, „Diese Version überspringen“ with „Rückgängig“ in Settings,
// „Später erinnern“, the install when Arcalo quits (a test stand-in replaces the installer:
// ARCALO_UPDATE_FAKE_INSTALL), and the next start: „aktualisiert auf 1.9.0“ with „Neu in
// Arcalo“ once, and Settings → Über → „Neu in Arcalo“ with the bundled release notes.
// ARCALO_UPDATE_CURRENT stands in for the running version (1.8.5, then 1.9.0).
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, guarded } from "../lib/harness.js";
import { startFeed, throwawayKey } from "../lib/update-feed.js";

const test = guarded(nodeTest, () => app);
let app;
let feed;
const key = throwawayKey();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "arcalo-e2e-upd2-"));
const env = (current) => ({ ARCALO_UPDATE_PUBKEY: key.pubkey, ARCALO_UPDATE_ENDPOINT: feed.url, ARCALO_UPDATE_CURRENT: current, ARCALO_UPDATE_FAKE_INSTALL: "1" });

before(async () => {
  feed = await startFeed({ key, version: "1.9.0" });
  app = await launch({ dataDir, env: env("1.8.5") });
});
after(async () => {
  await app?.close();
  await feed?.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const hintState = () => app.browser.execute(() => document.querySelector(".sb-update")?.dataset.state ?? null);
const waitHint = (state, timeout = 15000) =>
  app.browser.waitUntil(async () => (await hintState()) === state, { timeout, timeoutMsg: `status-bar hint not ${state}` });
const clickIn = (sel, text) =>
  app.browser.execute((s, x) => {
    const b = [...document.querySelectorAll(s)].find((e) => e.textContent.trim().includes(x) || e.getAttribute("aria-label") === x);
    b?.click();
    return !!b;
  }, sel, text);
const binaryRequests = () => feed.requests.filter((r) => r.includes("arcalo-update.bin")).length;

async function openAbout() {
  await app.browser.execute(() => document.querySelectorAll(".dialog [aria-label='Schließen']").forEach((b) => b.click()));
  await app.keys(["Control", ","]);
  await app.waitFor(".settings-nav");
  await clickIn(".settings-nav-item", "Über");
  await app.waitFor(".update-state");
}

test("a new version downloads in the background, can be paused and resumes where it stopped", async () => {
  feed.mode = "throttle";
  const info = await app.invoke("update_check");
  assert.equal(info.version, "1.9.0");
  await waitHint("downloading");
  await app.waitText(".sb-update", /Update 1\.9\.0/);
  await app.shot("126-update-downloading");
  // No toast and no modal: the status bar is the whole story.
  assert.equal(await app.browser.execute(() => !!document.querySelector(".update-toast, .dialog")), false);
  await app.browser.waitUntil(async () => (await app.invoke("update_status")).download.downloaded > 0, { timeout: 8000 });
  assert.ok(await clickIn(".sb-update button", "Download pausieren"));
  await waitHint("paused");
  const at = (await app.invoke("update_status")).download.downloaded;
  assert.ok(at > 0, "something was downloaded before the pause");
  assert.ok(fs.existsSync(path.join(dataDir, "updates", "1.9.0.part")), "the part file stays");
  await app.shot("126-update-paused");
  assert.ok(await clickIn(".sb-update button", "Download fortsetzen"));
  await waitHint("ready", 20000);
  assert.ok(feed.ranges.some((r) => r > 0), `resumed with a Range request (${feed.ranges.join(", ")})`);
  await app.waitText(".sb-update", /Update 1\.9\.0 bereit – wird beim Beenden von Arcalo installiert/);
  const buttons = await app.browser.execute(() => [...document.querySelectorAll(".sb-update button")].map((b) => b.textContent.trim() || b.getAttribute("aria-label")));
  assert.deepEqual(buttons, ["Jetzt neu starten", "Später", "Weitere Optionen"]);
  assert.ok(fs.existsSync(path.join(dataDir, "updates", "1.9.0.update")), "verified file kept for the quit");
  assert.equal(fs.existsSync(path.join(dataDir, ".arcalo-update")), false, "nothing installed by itself");
  await app.shot("126-update-ready");
});

test("„Später“ folds the hint; „Diese Version überspringen“ is remembered and undone in Settings", async () => {
  assert.ok(await clickIn(".sb-update button", "Später"));
  await waitHint("ready-folded");
  await app.click(".sb-update");
  await waitHint("ready");
  assert.ok(await clickIn(".sb-update button", "Weitere Optionen"));
  assert.ok(await clickIn(".menu [role^='menuitem'], .menu button", "Diese Version überspringen"));
  await app.browser.waitUntil(async () => (await hintState()) === null, { timeout: 5000, timeoutMsg: "hint still shown" });
  const skipped = await app.invoke("update_status");
  assert.equal(skipped.skipped, "1.9.0");
  assert.equal(fs.existsSync(path.join(dataDir, "updates", "1.9.0.update")), false, "the download goes");
  // A new check does not offer it again.
  assert.equal(await app.invoke("update_check"), null);
  await openAbout();
  await app.waitText(".set-row", /Version 1\.9\.0 wird nicht angeboten/);
  await app.shot("126-update-skipped-settings");
  feed.mode = "ok";
  const before = binaryRequests();
  await app.click(".update-unskip");
  // „Rückgängig“ checks again: the version downloads and is ready once more.
  await waitHint("ready", 20000);
  assert.ok(binaryRequests() > before);
  assert.equal((await app.invoke("update_status")).skipped, null);
});

test("„Später erinnern“ hides the update until then; „Jetzt anzeigen“ brings it back", async () => {
  assert.ok(await clickIn(".sb-update button", "Weitere Optionen"));
  assert.ok(await clickIn(".menu [role^='menuitem'], .menu button", "Morgen erinnern"));
  await app.waitText(".toast", /Erinnerung am/);
  await app.browser.waitUntil(async () => (await hintState()) === null, { timeout: 5000, timeoutMsg: "hint still shown" });
  const status = await app.invoke("update_status");
  const hours = (Date.parse(status.remind_after) - Date.now()) / 3600_000;
  assert.ok(hours > 23 && hours <= 24, `about a day (${hours})`);
  assert.equal(await app.invoke("update_check"), null, "an automatic check stays quiet");
  await openAbout();
  await app.waitText(".set-row", /Das Update wartet bis/);
  await app.click(".update-unremind");
  await waitHint("ready", 20000);
});

test("quitting installs the ready update after a database backup and keeps the old version", async () => {
  await app.invoke("page_create", { parentId: null, title: "Vor dem Update", icon: null, content: "Bleibt" });
  await app.browser.execute(() => {
    window.__TAURI_INTERNALS__.invoke("app_quit");
  });
  const note = path.join(dataDir, "updates", "fake-install.json");
  for (let i = 0; i < 100 && !fs.existsSync(note); i++) await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(JSON.parse(fs.readFileSync(note, "utf8")), { version: "1.9.0", from: "1.8.5", restart: false });
  assert.equal(fs.readFileSync(path.join(dataDir, ".arcalo-update"), "utf8"), "1.9.0\nfrom=1.8.5");
  assert.ok(fs.existsSync(path.join(dataDir, "backups", "arcalo-pre-update-1.8.5-1.9.0.db")), "backup tagged pre-update");
  const record = JSON.parse(fs.readFileSync(path.join(dataDir, "rollback", "rollback.json"), "utf8"));
  assert.equal(record.from, "1.8.5");
  assert.equal(record.to, "1.9.0");
  assert.equal(record.kind, "test");
  await app.close();
  app = null;
});

test("the next start says „aktualisiert auf 1.9.0“ and shows „Neu in Arcalo“ once", async () => {
  fs.rmSync(path.join(dataDir, "updates", "fake-install.json"));
  app = await launch({ dataDir, env: env("1.9.0") });
  await app.waitText(".toast", /auf Version 1\.9\.0 aktualisiert/);
  await app.waitFor(".whatsnew");
  await app.waitText(".dialog-title", /Neu in Arcalo 1\.9\.0/);
  const items = await app.browser.execute(() => [...document.querySelectorAll(".whatsnew-item")].map((i) => i.dataset.id));
  assert.deepEqual(items, ["filing", "smart-folders", "embeds", "updates"]);
  assert.equal(await app.browser.execute(() => document.querySelectorAll(".whatsnew-image").length), 3);
  await app.shot("126-whats-new");
  // The action of a highlight opens its place: Settings → Ordner & Ablage.
  assert.ok(await clickIn(".whatsnew-action", "Ordner einrichten"));
  await app.browser.waitUntil(async () => !(await app.browser.execute(() => !!document.querySelector(".whatsnew"))), { timeout: 4000 });
  await app.waitText(".settings-nav-item.active, .settings-nav-item[aria-current]", /Ordner/);
  assert.equal((await app.invoke("update_status")).whats_new_seen, "1.9.0");
  // The update was installed: no hint, nothing ready.
  assert.equal(await hintState(), null);
});

test("Settings → Über lists „Neu in Arcalo“ with the bundled release notes", async () => {
  await clickIn(".settings-nav-item", "Über");
  await app.waitFor(".whatsnew-row[data-version='1.9.0']");
  await app.browser.execute(() => document.querySelector(".whatsnew-row[data-version='1.9.0']").scrollIntoView({ block: "center" }));
  await app.shot("126-settings-whats-new");
  assert.ok(await clickIn(".whatsnew-row[data-version='1.9.0'] button", "Versionshinweise"));
  await app.waitText(".dialog-title", /Versionshinweise 1\.9\.0/);
  await app.waitText(".release-notes", /Automatic filing/);
  await app.keys(["Escape"]);
  assert.ok(await clickIn(".whatsnew-row[data-version='1.9.0'] button", "Höhepunkte"));
  await app.waitFor(".whatsnew");
  await app.keys(["Escape"]);
  // The manual way back exists while the copy of 1.8.5 is kept.
  await app.waitText(".set-row", /Zu Version 1\.8\.5 zurückkehren/);
  await app.click(".update-rollback");
  await app.waitText(".dialog", /seit dem Update geändert hast, geht in der Datenbank verloren/);
  await app.shot("126-rollback-confirm");
  await clickIn(".dialog button", "Abbrechen");
});
