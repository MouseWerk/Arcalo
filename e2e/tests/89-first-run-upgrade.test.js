// Upgrade to 1.6: a workspace from before the intro is not interrupted; a one-time hint offers
// the tour. Settings → Über reruns intro and setup with the current values prefilled (nothing is
// lost), and „Einrichtung zurücksetzen“ clears only the flags after a confirmation, so the next
// start plays the intro like a fresh install while notes stay.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
let dataDir;
before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "arcalo-e2e-upgrade-"));
  // Sample data stands in for a workspace used with an earlier version.
  app = await launch({ demo: true, onboarding: true, dataDir });
});
after(async () => {
  await app?.close();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

const settings = async () => (await app.invoke("settings_get")).settings;
const overlay = () => app.browser.execute(() => !!document.querySelector(".fr-overlay"));
const hintToasts = () => app.browser.execute(() => [...document.querySelectorAll(".toast")].filter((t) => /1\.6/.test(t.textContent)).length);

async function openAbout() {
  if (!(await app.browser.execute(() => !!document.querySelector(".pane.active > .pane-content:not([hidden]) .settings")))) await app.keys(["Control", ","]);
  await app.waitFor(".pane.active > .pane-content:not([hidden]) .settings");
  await app.browser.execute(() => document.querySelector('.settings-nav-item[data-section="about"]').click());
  await app.waitFor(".fr-rerun");
}

test("an existing workspace gets no forced intro, only the hint (once)", async () => {
  await app.browser.pause(800);
  assert.equal(await overlay(), false, "intro forced on an upgrade");
  await app.waitText(".toast", /Neu in 1\.6: Einführung ansehen/);
  assert.equal(await hintToasts(), 1);
  const st = await app.invoke("onboarding_status");
  assert.equal(st.existing, true);
  assert.equal(st.intro, false);
  assert.equal(st.whats_new, false, "the hint is marked as shown");
  await app.shot("firstrun-89-hint");

  await app.close();
  app = await launch({ onboarding: true, dataDir });
  await app.browser.pause(1200);
  assert.equal(await overlay(), false);
  assert.equal(await hintToasts(), 0, "hint shown twice");
});

test("Über reruns intro and setup with the current settings prefilled", async () => {
  const view = await app.invoke("settings_get");
  // New workspaces follow the system language; a chosen one (German here) is what the step shows.
  assert.equal(view.settings.locale.language, "system");
  await app.invoke("settings_save", { settings: { ...view.settings, locale: { ...view.settings.locale, language: "de" }, daily_target_hours: 7.5, workdays: [1, 2, 3, 4], theme: "dark" } });
  const pages = (await app.invoke("workspace_tree")).length;
  await openAbout();
  await app.shot("firstrun-89-about");
  await app.click(".fr-rerun");
  await app.waitFor(".fr-intro");
  await app.keys(["Escape"]);
  await app.waitFor(".fr-intake");
  // Prefilled: German stays chosen, dark mode, the work days and the target.
  assert.equal(await app.browser.execute(() => document.querySelector('[data-choice="de"]').getAttribute("aria-checked")), "true");
  assert.equal(await app.browser.execute(() => document.querySelector('[data-choice="system"]').getAttribute("aria-checked")), "false");
  await app.click('.fr-rail-item[data-step="theme"]');
  assert.equal(await app.browser.execute(() => document.querySelector('[data-choice="dark"]').getAttribute("aria-checked")), "true");
  await app.click('.fr-rail-item[data-step="work"]');
  await app.waitFor(".fr-step-work");
  const days = await app.browser.execute(() => [...document.querySelectorAll(".fr-step-work .day-toggle button")].map((b) => b.getAttribute("aria-pressed")));
  assert.deepEqual(days, ["true", "true", "true", "true", "false", "false", "false"]);
  assert.equal(await app.browser.execute(() => document.querySelector('.fr-step-work input[type="number"]').value), "7.5");
  // The workspace step knows the data is there: nothing is replaced.
  await app.click('.fr-rail-item[data-step="workspace"]');
  await app.waitText(".fr-step-title", /Wie möchtest du starten/);
  assert.equal(await app.browser.execute(() => document.querySelector('[data-choice="samples"]').disabled), true);
  // A change is saved at once; closing keeps it.
  await app.click('.fr-rail-item[data-step="work"]');
  await app.click('.fr-step-work .day-toggle button:nth-child(5)');
  await app.browser.waitUntil(async () => (await settings()).workdays.includes(5), { timeoutMsg: "Friday not saved" });
  await app.click(".fr-close");
  await app.browser.waitUntil(async () => !(await overlay()), { timeoutMsg: "setup not closed" });
  const s = await settings();
  assert.equal(s.onboarding.completed_version, "1.6.0");
  assert.equal(s.daily_target_hours, 7.5);
  assert.equal((await app.invoke("workspace_tree")).length, pages, "pages changed");
});

test("the palette command starts it too, and „Mehr in den Einstellungen“ pauses it", async () => {
  await app.keys(["Control", "k"]);
  await app.waitFor(".palette input");
  await app.type("Einführung");
  await app.waitText(".pal-title", /Einführung erneut starten/);
  await app.keys(["Enter"]);
  await app.waitFor(".fr-intro");
  await app.click(".fr-setup");
  await app.click('.fr-rail-item[data-step="ai"]');
  await app.click(".fr-more");
  await app.browser.waitUntil(async () => !(await overlay()), { timeoutMsg: "not paused" });
  await app.waitText(".settings-head h1", /KI/);
  await app.waitText(".toast", /Einrichtung pausiert/);
  await app.browser.execute(() => [...document.querySelectorAll(".toast button")].find((b) => /fortsetzen/.test(b.textContent)).click());
  await app.waitFor(".fr-step-ai");
  await app.click(".fr-close");
  await app.browser.waitUntil(async () => !(await overlay()));
});

test("„Einrichtung zurücksetzen“ asks, clears only the flags, and the next start plays the intro", async () => {
  const pages = (await app.invoke("workspace_tree")).length;
  const before = await settings();
  await openAbout();
  // Cancel first: nothing changes.
  await app.click(".fr-reset");
  await app.waitText(".dialog-title", /Einrichtung zurücksetzen/);
  await app.shot("firstrun-89-reset-confirm");
  await app.keys(["Escape"]);
  assert.equal((await settings()).onboarding.completed_version, "1.6.0");
  await app.click(".fr-reset");
  await app.waitFor(".dialog .btn-primary");
  await app.click(".dialog .btn-primary");
  await app.browser.waitUntil(async () => (await settings()).onboarding.completed_version === null, { timeoutMsg: "flags not reset" });
  const after = await settings();
  assert.equal(after.daily_target_hours, before.daily_target_hours);
  assert.deepEqual(after.workdays, before.workdays);
  assert.equal((await app.invoke("workspace_tree")).length, pages, "notes touched");
  assert.equal((await app.invoke("onboarding_status")).intro, true);

  await app.close();
  app = await launch({ onboarding: true, dataDir });
  await app.waitFor(".fr-intro", 10000);
  assert.equal((await app.invoke("workspace_tree")).length, pages);
  assert.deepEqual(await app.consoleErrors(), []);
});
