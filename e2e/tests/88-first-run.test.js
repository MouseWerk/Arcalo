// First start of a fresh install: the intro plays (it advances by itself, arrow keys and Space
// work, Esc skips), then the setup is completed with the keyboard only: English, dark, no SAP
// time tracking, an empty workspace, no AI, the Outlook fixture calendar, Git sync off and a
// backup folder. Every answer is in the settings, the app follows them, and the next start does
// not show the intro again.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, guarded } from "../lib/harness.js";
import { outlookEnv, writeFixtures } from "../lib/calendar-fixtures.js";

const test = guarded(nodeTest, () => app);
let app;
let fx;
let dataDir;
let backupDir;
before(async () => {
  fx = writeFixtures();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "annalo-e2e-firstrun-"));
  backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "annalo-e2e-backups-"));
  app = await launch({ demo: false, onboarding: true, dataDir, env: outlookEnv(fx.outlook) });
});
after(async () => {
  await app?.close();
  for (const d of [dataDir, backupDir, fx?.dir]) if (d) fs.rmSync(d, { recursive: true, force: true });
});

const settings = async () => (await app.invoke("settings_get")).settings;
const scene = () => app.browser.execute(() => document.querySelector(".fr-intro")?.dataset.scene ?? null);
const stepTitle = () => app.browser.execute(() => document.querySelector(".fr-step-title")?.textContent ?? "");
const active = () => app.browser.execute(() => document.activeElement?.outerHTML.slice(0, 120) ?? "");

/** Presses Tab until the focused element matches `sel` (keyboard only, like a user). */
async function tabTo(sel, max = 60) {
  for (let i = 0; i < max; i++) {
    if (await app.browser.execute((s) => !!document.activeElement?.matches(s), sel)) return;
    await app.keys(["Tab"]);
  }
  throw new Error(`Tab never reached ${sel} (at ${await active()})`);
}
/** Focuses `sel` with Tab and presses Enter. */
async function press(sel, key = "Enter") {
  await tabTo(sel);
  await app.keys([key]);
}
async function next(title) {
  await press(".fr-next");
  await app.browser.waitUntil(async () => title.test(await stepTitle()), { timeout: 6000, timeoutMsg: `step ${title} not shown (${await stepTitle()})` });
}

test("a fresh install plays the intro: it advances, arrows and Space steer it, Esc skips", async () => {
  await app.waitFor(".fr-intro", 10000);
  assert.equal(await scene(), "welcome");
  // The app behind it stays out of reach: no palette, no ready-made shortcut.
  assert.equal(await app.browser.execute(() => document.activeElement?.classList.contains("fr-intro")), true);
  await app.shot("firstrun-88-intro");
  // It plays by itself.
  await app.browser.waitUntil(async () => (await scene()) === "notes", { timeout: 9000, timeoutMsg: "intro did not advance" });
  await app.keys(["ArrowRight"]);
  await app.browser.waitUntil(async () => (await scene()) === "time", { timeoutMsg: "ArrowRight" });
  await app.keys(["ArrowLeft"]);
  await app.browser.waitUntil(async () => (await scene()) === "notes", { timeoutMsg: "ArrowLeft" });
  // Space pauses: the scene stays.
  await app.keys([" "]);
  assert.equal(await app.browser.execute(() => document.querySelector(".fr-intro").classList.contains("fr-paused")), true);
  await app.browser.pause(5600);
  assert.equal(await scene(), "notes", "paused intro moved on");
  await app.keys([" "]);
  // Every scene has a headline and a sentence; the progress has one segment per scene.
  assert.equal(await app.browser.execute(() => document.querySelectorAll(".fr-seg").length), 7);
  assert.ok((await app.text(".fr-title")).length > 5);
  await app.keys(["Escape"]);
  await app.waitFor(".fr-intake");
  assert.equal(await app.browser.execute(() => !!document.querySelector(".fr-intro")), false);
});

test("the setup is completed with the keyboard and writes every answer", async () => {
  // Language (the OS guess is preselected; English is chosen explicitly), applied live.
  await press('[data-choice="en"]');
  await app.browser.waitUntil(async () => (await settings()).locale.language === "en", { timeoutMsg: "English not saved" });
  await app.browser.waitUntil(async () => /Which language/.test(await stepTitle()), { timeoutMsg: "UI not in English" });
  await app.shot("firstrun-88-language");
  await next(/How should Annalo look/);

  await press('[data-choice="dark"]');
  await app.browser.waitUntil(async () => (await settings()).theme === "dark", { timeoutMsg: "dark not saved" });
  assert.equal(await app.browser.execute(() => document.documentElement.dataset.theme), "dark");
  await next(/How do you work/);

  // No SAP: the time tracking is switched off.
  await press('[data-choice="nosap"]');
  await app.browser.waitUntil(async () => (await settings()).time.enabled === false, { timeoutMsg: "time tracking still on" });
  await next(/How would you like to start/);

  await press('[data-choice="empty"]');
  await app.browser.waitUntil(async () => (await app.invoke("onboarding_needed")) === false, { timeoutMsg: "welcome choice not answered" });
  await next(/AI assistant/);

  await press('[data-choice="none"]');
  await app.browser.waitUntil(async () => (await settings()).providers.every((p) => !p.enabled), { timeoutMsg: "AI not off" });
  assert.match(await app.text(".fr-step-ai"), /#privat/);
  await next(/Which meetings/);

  // The Outlook fixture stands in for Outlook Classic.
  await press('.fr-step-calendar [role="switch"]', " ");
  await app.browser.waitUntil(async () => (await settings()).calendar.outlook === true, { timeoutMsg: "Outlook not on" });
  await next(/Git/);

  // Git sync stays off (the default).
  assert.equal(await app.browser.execute(() => document.querySelector('[data-choice="nosync"]').getAttribute("aria-checked")), "true");
  await next(/backups go/);

  await tabTo('.fr-step-backup input[aria-label="Folder"]');
  await app.type(backupDir);
  await app.keys(["Enter"]);
  await app.browser.waitUntil(async () => (await settings()).backup_dir === backupDir, { timeoutMsg: "backup folder not saved" });
  await next(/desktop/);
  assert.ok(await app.browser.execute(() => [...document.querySelectorAll(".fr-step-desktop button")].some((b) => /Try it now/.test(b.textContent))));
  await next(/all set/);

  const summary = await app.browser.execute(() => Object.fromEntries([...document.querySelectorAll(".fr-sum-row")].map((r) => [r.dataset.sum, r.querySelector("dd").textContent])));
  assert.equal(summary.language, "English");
  assert.equal(summary.theme, "Dark");
  assert.equal(summary.work, "No time tracking");
  assert.equal(summary.workspace, "Start empty");
  assert.equal(summary.ai, "No AI");
  assert.match(summary.calendar, /Outlook/);
  assert.equal(summary.sync, "Off");
  assert.match(summary.backup, new RegExp(path.basename(backupDir)));
  // No time tracking chosen: the tips leave out /zeit (/time), the others stay.
  const tips = await app.text(".fr-tips");
  assert.doesNotMatch(tips, /\/(zeit|time)/);
  assert.match(tips, /Command palette/);
  await app.shot("firstrun-88-done");

  await press(".fr-next");
  await app.browser.waitUntil(async () => !(await app.browser.execute(() => !!document.querySelector(".fr-overlay"))), { timeoutMsg: "setup did not close" });
  const s = await settings();
  assert.equal(s.onboarding.completed_version, "1.6.0");
  assert.ok(!Number.isNaN(Date.parse(s.onboarding.completed_at)));
  assert.equal((await app.invoke("onboarding_status")).intro, false);
});

test("the app follows the answers: English, no timesheet, Outlook syncs", async () => {
  // Ribbon without timesheet and projects; English labels.
  const labels = await app.browser.execute(() => [...document.querySelectorAll(".ribbon [aria-label]")].map((b) => b.getAttribute("aria-label")));
  assert.ok(labels.some((l) => /Settings/.test(l)), labels.join(" | "));
  assert.ok(!labels.some((l) => /^Time tracking$|^Projects$/.test(l)), labels.join(" | "));
  // Palette without the timesheet commands, with the intro command.
  const titles = async (q) => {
    await app.keys(["Control", "k"]);
    await app.waitFor(".palette input");
    await app.type(q);
    await app.browser.pause(250);
    const out = await app.browser.execute(() => [...document.querySelectorAll(".palette .pal-title")].map((x) => x.firstChild?.textContent ?? x.textContent));
    await app.keys(["Escape"]);
    await app.browser.pause(150);
    return out;
  };
  const open = await titles("open");
  assert.ok(!open.includes("Open time tracking") && !open.includes("Open projects"), open.join(" | "));
  assert.ok(!(await titles("timer")).includes("Start timer"));
  assert.ok((await titles("introduction")).includes("Replay the introduction"));
  // The Outlook fixture calendar syncs once it is switched on.
  await app.browser.waitUntil(async () => (await app.invoke("calendar_status")).sources.find((x) => x.id === "outlook")?.status?.events > 0, {
    timeout: 20000,
    timeoutMsg: "Outlook fixture not synced",
  });
  await app.shot("firstrun-88-after");
  assert.deepEqual(await app.consoleErrors(), []);
});

test("the next start does not show the intro again", async () => {
  await app.close();
  app = await launch({ onboarding: true, dataDir, env: outlookEnv(fx.outlook) });
  await app.browser.pause(1200);
  assert.equal(await app.browser.execute(() => !!document.querySelector(".fr-overlay")), false);
  assert.equal(await app.browser.execute(() => document.querySelectorAll(".toast").length), 0, "no hint toast for a completed setup");
  assert.equal((await settings()).locale.language, "en");
});
