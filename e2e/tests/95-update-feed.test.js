// Auto-update against a local feed: a debug build takes a test feed and a throwaway key
// (ANNALO_UPDATE_ENDPOINT / ANNALO_UPDATE_PUBKEY; release builds ignore both). Covers the toast
// and its release notes, the failures a user can meet (tampered file, 404, a download cut off,
// the server offline), a second click while downloading, the .deb route to the release page and
// the first start after an update. The successful install and relaunch is exercised with real
// AppImages (docs/testing/auto-update-windows.md, „Linux“), not here: it replaces the binary.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { APP, launch, guarded } from "../lib/harness.js";
import { startFeed, throwawayKey } from "../lib/update-feed.js";

const test = guarded(nodeTest, () => app);
let app;
let feed;
const key = throwawayKey();
const sha = () => crypto.createHash("sha256").update(fs.readFileSync(APP)).digest("hex");
const binary = sha();
const next = (v) => v.replace(/^(\d+)\.(\d+)\.(\d+).*$/, (_, a, b, c) => `${a}.${b}.${Number(c) + 1}`);

before(async () => {
  feed = await startFeed({ key, version: "0.0.0" });
  app = await launch({ env: { ANNALO_UPDATE_PUBKEY: key.pubkey, ANNALO_UPDATE_ENDPOINT: feed.url } });
  const status = await app.invoke("update_status");
  feed.version = next(status.current_version);
});
after(async () => {
  await app?.close();
  await feed?.close();
});

/** Settings → Über → „Jetzt nach Updates suchen“, like a user. */
async function checkNow() {
  const open = await app.browser.execute(() => !!document.querySelector(".update-state"));
  if (!open) {
    await app.keys(["Control", ","]);
    await app.waitFor(".settings-nav");
    await app.browser.execute(() => [...document.querySelectorAll(".settings-nav-item")].find((b) => b.textContent.includes("Über"))?.click());
    await app.waitFor(".update-state");
  }
  await app.dismissToasts();
  await app.browser.execute(() => [...document.querySelectorAll(".settings button")].find((b) => b.textContent.includes("Jetzt nach Updates suchen"))?.click());
}

const toastTexts = () => app.browser.execute(() => [...document.querySelectorAll(".toast")].map((t) => t.innerText));
const clickInstall = () =>
  app.browser.execute(() => [...document.querySelectorAll(".update-toast button")].find((b) => b.textContent.includes("Installieren und neu starten"))?.click());

test("a debug build with a test key checks the local feed", async () => {
  const status = await app.invoke("update_status");
  assert.equal(status.enabled, true);
  assert.equal(status.portable, false);
  assert.equal(status.package, false);
});

test("a newer version shows the toast with release notes; nothing installs by itself", async () => {
  await checkNow();
  await app.waitText(".update-toast .toast-title", new RegExp(`Version ${feed.version.replace(/\./g, "\\.")} verfügbar`));
  await app.waitText(".update-state", /ist verfügbar/);
  assert.deepEqual(feed.requests.filter((r) => r.includes("annalo-update.bin")), [], "no download without a click");
  await app.shot("95-update-toast");
  await app.browser.execute(() => [...document.querySelectorAll(".update-toast button")].find((b) => b.textContent.includes("Was ist neu"))?.click());
  await app.waitText(".dialog", /Getestet/);
  await app.shot("95-update-notes");
  await app.keys(["Escape"]);
});

test("a tampered file is rejected with a clear message and nothing is installed", async () => {
  feed.mode = "tampered";
  await clickInstall();
  await app.waitText(".toast", /Signatur des Updates ist ungültig/, 20000);
  assert.equal(sha(), binary, "the binary is unchanged");
  // Back to the offer: the user can try again.
  await app.waitText(".update-toast .toast-title", /verfügbar/);
  assert.equal(fs.existsSync(path.join(app.dataDir, ".annalo-update")), false, "no restart note left behind");
  await app.shot("95-update-signature");
});

test("a download cut off midway fails cleanly", async () => {
  feed.mode = "cut";
  await app.dismissToasts();
  await clickInstall();
  await app.waitText(".toast", /Download fehlgeschlagen/, 20000);
  assert.equal(sha(), binary);
  await app.waitText(".update-toast .toast-title", /verfügbar/);
});

test("a second click while downloading does not start a second install", async () => {
  feed.mode = "slow";
  await app.dismissToasts();
  await clickInstall();
  await app.waitText(".update-toast .toast-title", /wird geladen/);
  // The busy toast offers nothing to click; the backend refuses a second install and a new check.
  const buttons = await app.browser.execute(() => [...document.querySelectorAll(".update-toast button")].map((b) => b.textContent));
  assert.deepEqual(buttons, []);
  await assert.rejects(app.invoke("update_install"), /bereits installiert/);
  await assert.rejects(app.invoke("update_check"), /gerade installiert/);
  await app.waitText(".update-toast .toast-detail", /%/);
  await app.shot("95-update-progress");
  // The trickled file fails its signature at the end; the offer comes back.
  await app.waitText(".toast", /Signatur des Updates ist ungültig/, 20000);
  await app.waitText(".update-toast .toast-title", /verfügbar/);
});

test("a feed without latest.json and a server offline are explained", async () => {
  feed.mode = "missing";
  await checkNow();
  await app.waitText(".toast", /keine Versionsinformation/);
  await feed.close();
  await checkNow();
  await app.waitText(".toast", /Keine Verbindung zum Update-Server/, 15000);
  await app.shot("95-update-offline");
});

test("the same version is no update", async () => {
  const status = await app.invoke("update_status");
  feed = await startFeed({ key, version: status.current_version });
  // The endpoint is read per check; the new server has another port, so a fresh app is started.
  await app.close();
  app = await launch({ env: { ANNALO_UPDATE_PUBKEY: key.pubkey, ANNALO_UPDATE_ENDPOINT: feed.url } });
  assert.equal(await app.invoke("update_check"), null);
  await checkNow();
  await app.waitText(".toast", /Arcalo ist aktuell/);
});

test("a .deb install offers the release page instead of installing", async () => {
  feed.version = next(feed.version);
  await app.close();
  app = await launch({ env: { ANNALO_UPDATE_PUBKEY: key.pubkey, ANNALO_UPDATE_ENDPOINT: feed.url, ANNALO_UPDATE_BUNDLE: "deb" } });
  const status = await app.invoke("update_status");
  assert.equal(status.package, true);
  await checkNow();
  await app.waitText(".update-toast .toast-detail", /Als Paket installiert/);
  const buttons = await app.browser.execute(() => [...document.querySelectorAll(".update-toast button")].map((b) => b.textContent));
  assert.ok(buttons.includes("Release-Seite öffnen"), buttons.join(", "));
  assert.ok(!buttons.some((b) => b.includes("Installieren")));
  await assert.rejects(app.invoke("update_install"), /als Paket installiert/);
  await app.shot("95-update-deb");
});

test("the first start after an update says so, or that the installer did not finish", async () => {
  const current = (await app.invoke("update_status")).current_version;
  await app.close();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "annalo-e2e-"));
  try {
    fs.writeFileSync(path.join(dataDir, ".annalo-update"), current);
    app = await launch({ dataDir });
    await app.waitText(".toast", new RegExp(`auf Version ${current.replace(/\./g, "\\.")} aktualisiert`));
    assert.equal(fs.existsSync(path.join(dataDir, ".annalo-update")), false, "reported once");
    await app.close();
    // UAC denied or the installer cancelled: the old version starts again.
    fs.writeFileSync(path.join(dataDir, ".annalo-update"), next(current));
    app = await launch({ dataDir });
    await app.waitText(".toast", /nicht installiert/);
    await app.waitText(".toast", new RegExp(`weiter mit Version ${current.replace(/\./g, "\\.")}`));
    await app.shot("95-update-not-installed");
  } finally {
    await app.close();
    app = null;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
