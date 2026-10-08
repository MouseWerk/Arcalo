// The Microsoft Store build (src-tauri/src/store.rs; debug builds pretend with ARCALO_STORE=1):
// even with an update key, a feed with a newer version, an organization's update policy and a
// portable marker next to the executable, the app never checks, downloads, installs or rolls
// back, runs not portable, and Settings → Über → Updates points to the Microsoft Store.
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
const root = fs.mkdtempSync(path.join(os.tmpdir(), "arcalo-e2e-store-"));
const exeDir = path.join(root, "exe");

before(async () => {
  fs.mkdirSync(exeDir, { recursive: true });
  fs.writeFileSync(path.join(exeDir, "arcalo-portable"), "");
  fs.writeFileSync(path.join(exeDir, "policy.json"), JSON.stringify({ UpdateMode: "auto", CheckIntervalHours: 1 }));
  feed = await startFeed({ key, version: "9.9.0" });
  app = await launch({
    env: {
      ARCALO_STORE: "1",
      ARCALO_UPDATE_PUBKEY: key.pubkey,
      ARCALO_UPDATE_ENDPOINT: feed.url,
      ARCALO_UPDATE_CURRENT: "1.11.0",
      ARCALO_EXE_DIR: exeDir,
    },
  });
});
after(async () => {
  await app?.close();
  await feed?.close();
});

test("no update check, download, install or rollback; the policy is still read", async () => {
  const status = await app.invoke("update_status");
  assert.equal(status.store, true);
  assert.equal(status.enabled, false);
  assert.equal(status.rollback, null);
  assert.equal(status.policy.mode, "auto", "the organization's policy is read, not broken");
  await assert.rejects(app.invoke("update_check", { manual: true }), /Microsoft Store/);
  await assert.rejects(app.invoke("update_install"), /Microsoft Store/);
  await assert.rejects(app.invoke("update_rollback"), /Microsoft Store/);
  await assert.rejects(app.invoke("update_restart_now"), /nicht geladen/);
  assert.deepEqual(feed.requests, [], "the feed is never asked");
});

test("no portable mode and no autostart entry of the installer", async () => {
  assert.equal((await app.invoke("app_info")).portable, false, "the marker next to the executable is ignored");
  assert.equal((await app.invoke("data_dir_status")).portable, false);
  const desk = await app.invoke("desktop_info");
  assert.equal(desk.store, true);
  assert.equal(desk.portable, false);
  // Without a package (here) the startup task cannot be read: no switch, no Run key either.
  assert.equal(desk.autostart_available, false);
  await assert.rejects(app.invoke("autostart_set", { enabled: true }), /nicht aus dem Paket/);
});

test("Settings → Über → Updates points to the Microsoft Store", async () => {
  await app.keys(["Control", ","]);
  await app.waitFor(".settings-nav");
  await app.browser.execute(() => [...document.querySelectorAll(".settings-nav-item")].find((b) => b.textContent.includes("Über"))?.click());
  await app.waitText(".settings-head h1", /Arcalo/);
  await app.waitText(".update-state", /Updates kommen über den Microsoft Store/);
  const buttons = await app.browser.execute(() => [...document.querySelectorAll(".settings button")].map((b) => b.textContent.trim()));
  assert.ok(buttons.includes("Microsoft Store öffnen"), buttons.join(" | "));
  assert.ok(!buttons.some((b) => b.includes("Jetzt nach Updates suchen")), "no own update check");
  assert.ok(!buttons.some((b) => b.includes("Zur vorherigen Version")), "no rollback");
  assert.equal(await (await app.$('.settings [role="radiogroup"][aria-label="Updates"]')).isExisting(), false, "no update mode");
  await app.browser.execute(() => document.querySelector(".update-state")?.scrollIntoView({ block: "center" }));
  await app.shot("store-updates");
  assert.deepEqual(feed.requests, []);
  assert.deepEqual(await app.consoleErrors(), []);
});
