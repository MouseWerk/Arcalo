// Updates 2.0 for organizations and the way back: a policy.json next to the executable
// (ANNALO_EXE_DIR stands in for its folder) locks the update settings („Von Ihrer Organisation
// verwaltet“) and makes a network folder the only source (GitHub, here the local feed, is never
// asked); the update from the share is checked against the built-in key, downloaded and
// installed on quit (test stand-in). Then the new version fails to start twice (test hook
// ANNALO_TEST_FAIL_START) and the third start offers the return (ANNALO_TEST_ROLLBACK_ANSWER
// answers the native dialog): the database of before the update comes back and the version is
// skipped from then on.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { APP, appEnv, launch, guarded } from "../lib/harness.js";
import { startFeed, throwawayKey, writeShare } from "../lib/update-feed.js";

const test = guarded(nodeTest, () => app);
let app;
let feed;
const key = throwawayKey();
const root = fs.mkdtempSync(path.join(os.tmpdir(), "annalo-e2e-policy-"));
const dataDir = path.join(root, "data");
const exeDir = path.join(root, "exe");
const share = path.join(root, "share", "arcalo");
const pad = (n) => String(n).padStart(2, "0");
// An install window around now (the local time of this machine, as the app sees it).
const now = new Date();
const window = `${pad((now.getHours() + 23) % 24)}:00-${pad((now.getHours() + 2) % 24)}:00`;

const env = (current, extra = {}) => ({
  ANNALO_UPDATE_PUBKEY: key.pubkey,
  ANNALO_UPDATE_ENDPOINT: feed.url,
  ANNALO_UPDATE_CURRENT: current,
  ANNALO_UPDATE_FAKE_INSTALL: "1",
  ANNALO_EXE_DIR: exeDir,
  ...extra,
});

before(async () => {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(exeDir, { recursive: true });
  writeShare(share, { key, version: "1.9.0" });
  fs.writeFileSync(
    path.join(exeDir, "policy.json"),
    JSON.stringify({ UpdateMode: "auto", UpdateUrl: share, AllowGitHubFallback: false, PinnedVersion: "1.9.5", InstallWindow: window, CheckIntervalHours: 12 }),
  );
  // The "GitHub" feed offers something newer: it must not be asked.
  feed = await startFeed({ key, version: "1.9.9" });
  app = await launch({ dataDir, env: env("1.8.5") });
});
after(async () => {
  await app?.close();
  await feed?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const clickIn = (sel, text) =>
  app.browser.execute((s, x) => {
    const b = [...document.querySelectorAll(s)].find((e) => e.textContent.trim().includes(x));
    b?.click();
    return !!b;
  }, sel, text);

test("the policy locks the update settings and names its origin", async () => {
  const status = await app.invoke("update_status");
  assert.deepEqual(status.policy.managed, ["mode", "source", "github", "pinned", "window", "interval"]);
  assert.equal(status.policy.source_url, share);
  assert.equal(status.policy.allow_github_fallback, false);
  assert.equal(status.policy.check_interval_hours, 12);
  assert.equal(status.install_now, true);
  await app.keys(["Control", ","]);
  await app.waitFor(".settings-nav");
  await clickIn(".settings-nav-item", "Über");
  await app.waitText(".update-managed", /Von Ihrer Organisation verwaltet/);
  await app.waitText(".update-managed", /policy\.json/);
  const locked = await app.browser.execute(() => ({
    mode: document.querySelector(".update-mode-select")?.disabled ?? document.querySelector(".update-mode-select [aria-disabled='true'], .update-mode-select:disabled") != null,
    source: document.querySelector(".update-source-input")?.disabled,
    sourceValue: document.querySelector(".update-source-input")?.value,
    badges: document.querySelectorAll(".managed-badge").length,
  }));
  assert.equal(locked.source, true);
  assert.equal(locked.sourceValue, share);
  assert.ok(locked.badges >= 5, `managed badges: ${locked.badges}`);
  await app.waitText(".set-row", /Ihre Organisation erlaubt Versionen bis 1\.9\.5/);
  await app.browser.execute(() => document.querySelector(".update-managed").scrollIntoView({ block: "start" }));
  await app.shot("127-policy-managed");
});

test("the share is the only source; its file is verified, downloaded and installed on quit", async () => {
  const info = await app.invoke("update_check", { manual: true });
  assert.equal(info.version, "1.9.0");
  assert.ok(info.source.includes("share"), info.source);
  assert.deepEqual(feed.requests, [], "GitHub is not asked when the policy forbids it");
  await app.browser.waitUntil(async () => (await app.invoke("update_status")).ready === "1.9.0", { timeout: 15000, timeoutMsg: "not ready" });
  await app.waitText(".sb-update", /bereit/);
  // A tampered share file would be refused: the key is built in, whatever the source.
  await app.invoke("page_create", { parentId: null, title: "Vor dem Update", icon: null, content: "Bleibt" });
  await app.browser.execute(() => {
    window.__TAURI_INTERNALS__.invoke("app_quit");
  });
  const note = path.join(dataDir, "updates", "fake-install.json");
  for (let i = 0; i < 100 && !fs.existsSync(note); i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(JSON.parse(fs.readFileSync(note, "utf8")).version, "1.9.0");
  await app.close();
  app = null;
});

/** Starts the app without WebDriver and waits for it to end; returns the exit code. */
function startPlain(extra) {
  return new Promise((resolve, reject) => {
    const child = spawn(APP, [], { env: appEnv(dataDir, { env: env("1.9.0", extra) }), stdio: "ignore" });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("the start did not end"));
    }, 30000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

test("two failed starts of the new version lead to the rollback, which restores the database and skips it", async () => {
  // The new version starts once fine and gets a page the rollback will take away.
  app = await launch({ dataDir, env: env("1.9.0") });
  await app.waitText(".toast", /auf Version 1\.9\.0 aktualisiert/);
  await app.invoke("page_create", { parentId: null, title: "Nach dem Update", icon: null, content: "Geht verloren" });
  await app.close();
  app = null;
  // Then it crashes early, twice in a row.
  assert.equal(await startPlain({ ANNALO_TEST_FAIL_START: "1" }), 3);
  assert.equal(await startPlain({ ANNALO_TEST_FAIL_START: "1" }), 3);
  const health = JSON.parse(fs.readFileSync(path.join(dataDir, ".annalo-health"), "utf8"));
  assert.deepEqual(health, { version: "1.9.0", healthy: false, failures: 1 });
  // The third start asks (answered „Ja“ by the test hook) before the database is opened.
  app = await launch({ dataDir, env: env("1.9.0", { ANNALO_TEST_ROLLBACK_ANSWER: "yes" }) });
  await app.waitText(".toast", /Zurück auf Version 1\.8\.5/);
  await app.waitText(".toast", /Version 1\.9\.0 startete nicht/);
  await app.shot("127-rolled-back");
  const titles = JSON.stringify(await app.invoke("workspace_tree"));
  assert.ok(titles.includes("Vor dem Update"), "the state before the update is back");
  assert.ok(!titles.includes("Nach dem Update"), "changes since the update are gone");
  const state = JSON.parse(fs.readFileSync(path.join(dataDir, "updates", "state.json"), "utf8"));
  assert.deepEqual(state.bad_versions, ["1.9.0"]);
  assert.equal(fs.existsSync(path.join(dataDir, "rollback")), false, "the record is used up");
  assert.ok(fs.readdirSync(dataDir).some((f) => f.startsWith("workspace.db.before-rollback-")), "the database of the failed version is kept aside");
  await app.close();
  app = null;
});

test("the rolled-back version is never offered again", async () => {
  // Back on 1.8.5 (the previous version started), the share still offers 1.9.0.
  app = await launch({ dataDir, env: env("1.8.5") });
  assert.equal(await app.invoke("update_check", { manual: true }), null);
  const status = await app.invoke("update_status");
  assert.deepEqual(status.bad_versions, ["1.9.0"]);
  await app.keys(["Control", ","]);
  await app.waitFor(".settings-nav");
  await clickIn(".settings-nav-item", "Über");
  await app.waitText(".set-row", /nie wieder angeboten: 1\.9\.0/);
});
