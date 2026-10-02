// App-Sperre (1.10): a PIN set in Settings → Sicherheit locks Arcalo at the next start; the app
// behind the lock screen is not loaded and its commands are refused; wrong PINs make the next
// attempt wait. After the idle time (a fake idle through the test seam) it locks again, quick
// capture then shows the lock screen instead of opening. The lock screen in English.
import { test as nodeTest, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { APP, launch, guarded } from "../lib/harness.js";
import { captureVisible } from "../lib/capture.js";
import { germanLeftovers, launchEnglish } from "../lib/english.js";

let app;
const test = guarded(nodeTest, () => app);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "annalo-e2e-lock-"));
const ENV = { ANNALO_BACKUP_DELAY_SECS: "3600", ANNALO_SECRET_STORE: "file" };
const PIN = "2468";
let enDir;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const killApp = () => {
  try {
    execSync(`pkill -f "${APP}"`, { stdio: "ignore" });
  } catch {
    /* none running */
  }
};
const locked = () => app.browser.execute(() => !!document.querySelector(".lock-screen"));
const appShown = () => app.browser.execute(() => !!document.querySelector(".sidebar, .side-tabs"));
async function typePin(pin) {
  await app.browser.execute(() => {
    const el = document.querySelector(".lock-pin");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, "");
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await app.click(".lock-pin");
  await app.type(pin);
  await app.keys(["Enter"]);
}

after(async () => {
  await app?.close();
  killApp();
  for (const d of [dataDir, enDir]) if (d) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

test("a PIN set in the settings locks the next start; wrong PINs make it wait", async () => {
  killApp();
  await sleep(800);
  app = await launch({ demo: true, dataDir, env: ENV });
  await app.keys(["Control", ","]);
  await app.waitFor(".settings-nav");
  for (const el of await app.$$(".settings-nav-item")) if ((await app.textOf(el)) === "Sicherheit") await el.click();
  await app.waitFor(".sec-lock-mode");
  // „Beim Start“ needs a PIN first: the choice opens the PIN dialog (and shows once saved).
  await app.click(".sec-lock-mode");
  const list = await app.browser.waitUntil(() => app.browser.execute(() => document.querySelector(".sec-lock-mode")?.getAttribute("aria-controls")), { timeoutMsg: "mode list not open" });
  await app.click(`#${list} [role="option"][data-value="start"]`);
  await app.waitFor(".dialog .sec-pin-1");
  await app.click(".dialog .sec-pin-1");
  await app.type(PIN);
  await app.click(".dialog .sec-pin-2");
  await app.type(PIN);
  await app.click(".dialog .sec-pin-save");
  await app.browser.waitUntil(async () => (await app.invoke("applock_status")).has_pin, { timeoutMsg: "PIN not saved" });
  const status = await app.invoke("applock_status");
  assert.equal(status.config.mode, "start");
  // Only the Argon2id hash, never the PIN.
  const secrets = fs.readFileSync(path.join(dataDir, "secrets.json"), "utf8");
  assert.match(secrets, /\$argon2id\$/);
  assert.ok(!secrets.includes(`"${PIN}"`));
  await app.shot("138-lock-settings");
  await app.close();
  killApp();
  await sleep(500);

  app = await launch({ demo: false, dataDir, env: ENV });
  await app.waitFor(".lock-screen");
  assert.equal(await appShown(), false, "the app is not loaded behind the lock");
  assert.match(await app.text(".lock-title"), /Arcalo ist gesperrt/);
  await assert.rejects(app.invoke("workspace_tree"), /app-locked/);
  // Accessible: a labelled modal dialog, the PIN field focused, messages announced.
  const a11y = await app.browser.execute(() => ({
    role: document.querySelector(".lock-screen").getAttribute("role"),
    labelled: !!document.getElementById(document.querySelector(".lock-screen").getAttribute("aria-labelledby")),
    focus: document.activeElement?.classList.contains("lock-pin"),
    live: document.querySelector(".lock-msg").getAttribute("aria-live"),
  }));
  assert.deepEqual(a11y, { role: "dialog", labelled: true, focus: true, live: "polite" });
  await app.shot("138-lock-start");

  for (let i = 1; i <= 3; i++) {
    await typePin("1111");
    await app.waitText(".lock-msg", i < 3 ? /Falsche PIN/ : /Nächster Versuch in 0:0\d/);
  }
  assert.equal(await app.browser.execute(() => document.querySelector(".lock-pin").disabled), true, "waits after three wrong PINs");
  await app.shot("138-lock-wait");
  await app.browser.waitUntil(async () => app.browser.execute(() => !document.querySelector(".lock-pin").disabled), { timeout: 9000, timeoutMsg: "wait did not end" });
  await typePin(PIN);
  await app.browser.waitUntil(async () => (await appShown()) && !(await locked()), { timeout: 10000, timeoutMsg: "not unlocked" });
  assert.ok((await app.invoke("workspace_tree")).length > 0);
});

test("idle time locks again and quick capture shows the lock screen instead", async () => {
  const s = await app.invoke("applock_status");
  await app.invoke("applock_configure", { config: { ...s.config, mode: "idle", idle_minutes: 5 }, pin: null });
  // 4 minutes without input: nothing happens yet.
  await app.invoke("applock_test_idle", { seconds: 240 });
  await sleep(500);
  assert.equal(await locked(), false);
  await app.invoke("applock_test_idle", { seconds: 400 });
  await app.waitFor(".lock-screen", 6000);
  assert.equal(await appShown(), false);
  // The shortcut's stand-in: the capture window stays hidden, the main window shows the lock.
  await app.invoke("capture_show");
  await sleep(1200);
  assert.equal(await captureVisible(app), false, "quick capture blocked while locked");
  await assert.rejects(app.invoke("capture_submit", { text: "heimlich" }), /app-locked/);
  await typePin(PIN);
  await app.browser.waitUntil(appShown, { timeout: 10000, timeoutMsg: "not unlocked" });
  assert.deepEqual(await app.consoleErrors(), []);
});

test("the lock screen in English", async () => {
  await app.close();
  app = null;
  killApp();
  await sleep(500);
  ({ app, dataDir: enDir } = await launchEnglish({ env: ENV }));
  const s = await app.invoke("applock_status");
  await app.invoke("applock_configure", { config: { ...s.config, mode: "start" }, pin: "9753" });
  await app.invoke("applock_lock_now");
  await app.waitFor(".lock-screen", 6000);
  assert.match(await app.text(".lock-title"), /Arcalo is locked/);
  await app.click(".lock-link");
  await app.waitFor(".lock-forgot");
  assert.deepEqual(await germanLeftovers(app), []);
  await app.shot("138-lock-en");
  await typePin("9753");
  await app.browser.waitUntil(appShown, { timeout: 10000, timeoutMsg: "not unlocked" });
  // Settings → Security in English.
  await app.keys(["Control", ","]);
  await app.waitFor(".settings-nav");
  for (const el of await app.$$(".settings-nav-item")) if ((await app.textOf(el)) === "Security") await el.click();
  await app.waitFor(".sec-state");
  assert.match(await app.text(".sec-state"), /Not encrypted/);
  await app.shot("138-security-en");
});
