// Update failures of 1.18.1 against a local feed (a throwaway key, ARCALO_UPDATE_FAKE_INSTALL stands
// in for the installer): a newer version found while another downloads follows it, a downloaded
// file that no longer matches its signature or is gone at „Jetzt neu starten“ is downloaded again
// instead of failing at every quit, „Abbrechen“ stops the download of „Installieren“ without an
// error and the next click continues it, and a copy that cannot replace its program files
// (ARCALO_UPDATE_BLOCKED, e.g. an AppImage in a folder without write permission) offers the
// release page and downloads nothing.
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "arcalo-e2e-updfail-"));
const env = (extra = {}) => ({ ARCALO_UPDATE_PUBKEY: key.pubkey, ARCALO_UPDATE_ENDPOINT: feed.url, ARCALO_UPDATE_CURRENT: "1.18.0", ARCALO_UPDATE_FAKE_INSTALL: "1", ...extra });

before(async () => {
  feed = await startFeed({ key, version: "1.18.1" });
  // The automatic check shortly after the start finds nothing (the next one is hours later), so
  // every download below is started by the test itself.
  feed.mode = "missing";
  app = await launch({ dataDir, env: env() });
  for (let i = 0; i < 300 && !feed.requests.some((r) => r.startsWith("/latest.json")); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(feed.requests.some((r) => r.startsWith("/latest.json")), "the automatic check ran");
});
after(async () => {
  await app?.close();
  await feed?.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const hintState = () => app.browser.execute(() => document.querySelector(".sb-update")?.dataset.state ?? null);
const waitHint = (state, timeout = 20000) =>
  app.browser.waitUntil(async () => (await hintState()) === state, { timeout, timeoutMsg: `status-bar hint not ${state}` });
const clickIn = (sel, text) =>
  app.browser.execute((s, x) => {
    const b = [...document.querySelectorAll(s)].find((e) => e.textContent.trim().includes(x) || e.getAttribute("aria-label") === x);
    b?.click();
    return !!b;
  }, sel, text);
const updates = (...p) => path.join(dataDir, "updates", ...p);
const toastTexts = () => app.browser.execute(() => [...document.querySelectorAll(".toast")].map((t) => t.innerText).join("\n"));

test("a newer version found while another downloads is downloaded next", async () => {
  feed.mode = "throttle";
  assert.equal((await app.invoke("update_check")).version, "1.18.1");
  await waitHint("downloading");
  // 1.18.2 is published meanwhile; the next check finds it while 1.18.1 still downloads.
  feed.version = "1.18.2";
  assert.equal((await app.invoke("update_check")).version, "1.18.2");
  await app.browser.waitUntil(async () => (await app.invoke("update_status")).ready === "1.18.2", { timeout: 30000, timeoutMsg: "1.18.2 not downloaded" });
  await waitHint("ready");
  await app.waitText(".sb-update", /Update 1\.18\.2 bereit/);
  assert.ok(fs.existsSync(updates("1.18.2.update")));
  assert.equal(fs.existsSync(updates("1.18.1.update")), false, "the older download went");
  assert.equal(JSON.parse(fs.readFileSync(updates("staged.json"), "utf8")).version, "1.18.2");
});

test("a downloaded file that no longer matches its signature is discarded and downloaded again", async () => {
  feed.mode = "ok";
  const file = updates("1.18.2.update");
  const bytes = fs.readFileSync(file);
  bytes[bytes.length >> 1] ^= 0xff;
  fs.writeFileSync(file, bytes);
  await app.dismissToasts();
  assert.ok(await clickIn(".sb-update button", "Jetzt neu starten"));
  await app.waitText(".toast", /Signatur des Updates ist ungültig/, 15000);
  await waitHint("failed");
  assert.equal(fs.existsSync(file), false, "the broken file goes");
  assert.equal(fs.existsSync(updates("staged.json")), false);
  assert.equal(fs.existsSync(path.join(dataDir, ".arcalo-update")), false, "nothing was installed");
  assert.equal(fs.existsSync(updates("fake-install.json")), false);
  const status = await app.invoke("update_status");
  assert.equal(status.ready, null);
  assert.match(status.download.error, /Signatur/);
  await app.shot("375-update-signature-at-restart");
  // „Erneut versuchen“ downloads it again.
  assert.ok(await clickIn(".sb-update button", "Download fortsetzen"));
  await waitHint("ready");
  assert.ok(fs.existsSync(file));
});

test("a downloaded file that is gone at „Jetzt neu starten“ is downloaded again", async () => {
  fs.rmSync(updates("1.18.2.update"));
  await app.dismissToasts();
  assert.ok(await clickIn(".sb-update button", "Jetzt neu starten"));
  await app.waitText(".toast", /noch nicht geladen/, 15000);
  await waitHint("ready");
  assert.ok(fs.existsSync(updates("1.18.2.update")));
  assert.equal(fs.existsSync(updates("fake-install.json")), false, "nothing was installed");
  // Now it installs (the test stand-in notes it and the app ends).
  await app.dismissToasts();
  assert.ok(await clickIn(".sb-update button", "Jetzt neu starten"));
  const note = updates("fake-install.json");
  for (let i = 0; i < 100 && !fs.existsSync(note); i++) await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(JSON.parse(fs.readFileSync(note, "utf8")), { version: "1.18.2", from: "1.18.0", restart: true });
  await app.close().catch(() => {});
  app = null;
});

test("„Abbrechen“ stops the download of „Installieren“ without an error; the next click continues it", async () => {
  const notify = fs.mkdtempSync(path.join(os.tmpdir(), "arcalo-e2e-updcancel-"));
  try {
    feed.version = "1.18.1";
    app = await launch({ dataDir: notify, env: env() });
    const view = await app.invoke("settings_get");
    await app.invoke("settings_save", { settings: { ...view.settings, updates: { ...view.settings.updates, mode: "notify" } } });
    feed.mode = "throttle";
    await app.invoke("update_check");
    await app.waitText(".update-toast .toast-title", /Version 1\.18\.1 verfügbar/);
    const install = () => clickIn(".update-toast button", "Installieren und neu starten");
    assert.ok(await install());
    await app.waitText(".update-toast .toast-detail", /%/);
    await app.shot("375-update-cancel");
    assert.ok(await clickIn(".update-toast button", "Abbrechen"));
    await app.waitText(".update-toast .toast-title", /Version 1\.18\.1 verfügbar/, 15000);
    assert.doesNotMatch(await toastTexts(), /fehlgeschlagen/, "cancelling is no failure");
    const part = path.join(notify, "updates", "1.18.1.part");
    assert.ok(fs.existsSync(part) && fs.statSync(part).size > 0, "the part stays");
    assert.equal((await app.invoke("update_status")).download.phase, "paused");
    // The next click continues where it stopped.
    const before = feed.ranges.length;
    assert.ok(await install());
    await app.waitText(".update-toast .toast-detail", /%/);
    assert.ok(feed.ranges.slice(before).some((r) => r > 0), `resumed with a Range request (${feed.ranges.join(", ")})`);
    assert.ok(await clickIn(".update-toast button", "Abbrechen"));
    await app.waitText(".update-toast .toast-title", /verfügbar/, 15000);
  } finally {
    await app?.close();
    app = null;
    fs.rmSync(notify, { recursive: true, force: true });
  }
});

test("a copy that cannot replace its program files offers the release page and downloads nothing", async () => {
  feed.mode = "ok";
  feed.version = "1.18.1";
  const seen = feed.requests.length;
  app = await launch({ env: env({ ARCALO_UPDATE_BLOCKED: "not_writable" }) });
  const status = await app.invoke("update_status");
  assert.equal(status.blocked, "not_writable");
  assert.equal((await app.invoke("update_check")).version, "1.18.1");
  await app.waitText(".update-toast .toast-detail", /Kein Schreibrecht für den Ordner der AppImage-Datei/);
  const buttons = await app.browser.execute(() => [...document.querySelectorAll(".update-toast button")].map((b) => b.textContent));
  assert.ok(buttons.includes("Release-Seite öffnen"), buttons.join(", "));
  assert.ok(!buttons.some((b) => b.includes("Installieren")), buttons.join(", "));
  await assert.rejects(app.invoke("update_install"), /Keine Schreibrechte für den Ordner der AppImage-Datei/);
  await assert.rejects(app.invoke("update_download"), /Keine Schreibrechte/);
  await new Promise((r) => setTimeout(r, 1500));
  assert.deepEqual(feed.requests.slice(seen).filter((r) => r.includes("arcalo-update.bin")), [], "nothing downloaded");
  assert.equal(await hintState(), null, "no background download in the status bar");
  // Settings → Über says the same.
  await app.keys(["Control", ","]);
  await app.waitFor(".settings-nav");
  await clickIn(".settings-nav-item", "Über");
  await app.waitText(".settings", /Kein Schreibrecht für den Ordner der AppImage-Datei/);
  await app.shot("375-update-blocked");
});
