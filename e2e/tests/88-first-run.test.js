// First start of a fresh install: the intro plays (five scenes; it advances by itself, arrow keys
// and Space work, Esc skips), then the short setup is completed with the keyboard only: English,
// dark, „Ohne KI“, no time tracking, the Outlook fixture calendar and an empty start. Every answer
// is in the settings, „Fertig“ links to what is left for the settings, the first screen is the
// start page with „Erste Schritte“, the app follows the answers, and the next start does not show
// the intro again.
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
before(async () => {
  fx = writeFixtures();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "arcalo-e2e-firstrun-"));
  app = await launch({ demo: false, onboarding: true, dataDir, env: outlookEnv(fx.outlook) });
});
after(async () => {
  await app?.close();
  for (const d of [dataDir, fx?.dir]) if (d) fs.rmSync(d, { recursive: true, force: true });
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
/**
 * Focuses `sel` with Tab and presses Enter. A choice card is one of a radio group: Tab reaches the
 * group (its chosen card), the arrows move to the card (and choose it), as with native radios.
 */
async function press(sel, key = "Enter") {
  if (sel.startsWith("[data-choice=")) {
    await tabTo(`.fr-choices:has(${sel}) [role="radio"][tabindex="0"]`);
    for (let i = 0; i < 8 && !(await app.browser.execute((s) => !!document.activeElement?.matches(s), sel)); i++) await app.keys(["ArrowDown"]);
  }
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
  await app.browser.waitUntil(async () => (await scene()) === "meetings", { timeoutMsg: "ArrowRight" });
  await app.keys(["ArrowLeft"]);
  await app.browser.waitUntil(async () => (await scene()) === "notes", { timeoutMsg: "ArrowLeft" });
  // Space pauses: the scene stays.
  await app.keys([" "]);
  assert.equal(await app.browser.execute(() => document.querySelector(".fr-intro").classList.contains("fr-paused")), true);
  await app.browser.pause(5600);
  assert.equal(await scene(), "notes", "paused intro moved on");
  await app.keys([" "]);
  // Every scene has a headline and a sentence; the progress has one segment per scene.
  assert.equal(await app.browser.execute(() => document.querySelectorAll(".fr-seg").length), 5);
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
  await next(/How should Arcalo look/);

  await press('[data-choice="dark"]');
  await app.browser.waitUntil(async () => (await settings()).theme === "dark", { timeoutMsg: "dark not saved" });
  assert.equal(await app.browser.execute(() => document.documentElement.dataset.theme), "dark");
  await next(/work with AI/);

  // „Ohne KI“: only the switch goes off; the provider list stays as it was.
  const providers = (await settings()).providers;
  assert.equal(await app.browser.execute(() => document.querySelector('[data-choice="with"]').getAttribute("aria-checked")), "true", "a new install starts with AI on");
  await press('[data-choice="without"]');
  await app.browser.waitUntil(async () => (await settings()).ai.enabled === false, { timeoutMsg: "AI not off" });
  assert.deepEqual((await settings()).providers, providers);
  // Without AI there is no model to pick.
  assert.equal(await app.browser.execute(() => !!document.querySelector('[data-choice="local"]')), false);
  await next(/track your time/);

  // No time booking: the time tracking is switched off.
  await press('[data-choice="nosap"]');
  await app.browser.waitUntil(async () => (await settings()).time.enabled === false, { timeoutMsg: "time tracking still on" });
  await next(/Which meetings/);

  // The Outlook fixture stands in for Outlook Classic.
  await press('.fr-step-calendar [role="switch"]', " ");
  await app.browser.waitUntil(async () => (await settings()).calendar.outlook === true, { timeoutMsg: "Outlook not on" });
  await next(/How would you like to start/);

  await press('[data-choice="empty"]');
  await app.browser.waitUntil(async () => (await app.invoke("onboarding_needed")) === false, { timeoutMsg: "welcome choice not answered" });
  await next(/all set/);

  const summary = await app.browser.execute(() => Object.fromEntries([...document.querySelectorAll(".fr-sum-row")].map((r) => [r.dataset.sum, r.querySelector("dd").textContent])));
  assert.equal(summary.language, "English");
  assert.equal(summary.theme, "Dark");
  assert.equal(summary.work, "No time tracking");
  assert.equal(summary.workspace, "Start empty");
  assert.equal(summary.ai, "Without AI");
  assert.match(summary.calendar, /Outlook/);
  // Seven steps: backups, Git, security and the desktop are left to the settings, linked here.
  assert.deepEqual(await app.browser.execute(() => [...document.querySelectorAll(".fr-sum-row")].map((r) => r.dataset.sum)), ["language", "theme", "ai", "work", "calendar", "workspace"]);
  assert.deepEqual(await app.browser.execute(() => [...document.querySelectorAll(".fr-later-item")].map((b) => b.dataset.later)), ["backup", "sync", "security", "desktop"]);
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
  // The first screen: the start page with „Erste Schritte“ (the calendar is connected, so three
  // steps), no side panel next to it.
  await app.waitFor(".first-steps");
  assert.deepEqual(await app.browser.execute(() => [...document.querySelectorAll(".first-step")].map((b) => b.dataset.step)), ["note", "today", "task"]);
  assert.equal(await app.browser.execute(() => !!document.querySelector(".panel")), false);
  await app.shot("firstrun-88-first-screen");
});

test("the app follows the answers: English, no timesheet, no AI, Outlook syncs", async () => {
  // Ribbon without timesheet, projects, assistant and chat; English labels.
  const labels = await app.browser.execute(() => [...document.querySelectorAll(".ribbon [aria-label]")].map((b) => b.getAttribute("aria-label")));
  assert.ok(labels.some((l) => /Settings/.test(l)), labels.join(" | "));
  assert.ok(!labels.some((l) => /^Time tracking$|^Projects$|^Assistant|^Chat/.test(l)), labels.join(" | "));
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
  // A step of „Erste Schritte“ opens what it names and ticks itself off.
  await app.click('.first-step[data-step="today"]');
  await app.waitFor(".pane.active > .pane-content:not([hidden]) .ProseMirror");
  await app.click(".pane.active .tabbar-home");
  await app.waitFor('.first-step.done[data-step="today"]');
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
