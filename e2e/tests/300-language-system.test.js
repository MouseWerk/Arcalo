// „Wie das System“ (Settings → Sprache & Format): the default of new installs. The language of
// the operating system decides at every start (LANG and friends here, in gettext's order), the
// first run greets in it from the first frame, and the shell's texts agree with the UI. A
// chosen language stays whatever the system says; switching back follows the system again.
import { test as nodeTest, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, guarded } from "../lib/harness.js";
import { germanLeftovers } from "../lib/english.js";

const test = guarded(nodeTest, () => app);
let app;
const dirs = [];
after(async () => {
  await app?.close();
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

/** A system set to `lang` through the locale variables (no ARCALO_LOCALE stand-in). */
const sys = (vars) => ({ ARCALO_LOCALE: "", LC_ALL: "", LC_MESSAGES: "", LANGUAGE: "", LANG: "", ...vars });
const fresh = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "arcalo-e2e-lang-"));
  dirs.push(d);
  return d;
};
async function start(dataDir, vars, opts = {}) {
  await app?.close();
  app = await launch({ demo: false, dataDir, env: sys(vars), ...opts });
  return app;
}
const view = () => app.invoke("settings_get");
const htmlLang = () => app.browser.execute(() => document.documentElement.lang);
/** A message of the shell (Rust `tr!`): in the language the UI shows. */
const shellText = async () => (await app.invoke("page_get", { id: 987654 }).catch((e) => e)).toString();
const intakeTitle = () => app.browser.execute(() => document.querySelector(".fr-step-title")?.textContent ?? "");
const checked = (sel) => app.browser.execute((s) => [...document.querySelectorAll(s)].filter((b) => b.getAttribute("aria-checked") === "true").map((b) => b.dataset.choice ?? b.textContent), sel);

let german;

test("a first run on an English system greets in English from the first frame", async () => {
  await start(fresh(), { LANG: "en_US.UTF-8" }, { onboarding: true });
  await app.waitFor(".fr-intro", 10000);
  assert.equal(await app.browser.execute(() => window.__ARCALO_LANG__), "en", "the shell's boot language");
  assert.equal(await htmlLang(), "en");
  assert.equal(await app.browser.execute(() => document.querySelector(".fr-intro").getAttribute("aria-label")), "Introduction to Arcalo");
  assert.deepEqual(await germanLeftovers(app), []);
  const v = await view();
  assert.equal(v.settings.locale.language, "system");
  assert.equal(v.system_language, "en");
  await app.shot("300-firstrun-en-system");
  // The language step: „Same as system“ is chosen and names the language it stands for.
  await app.keys(["Escape"]);
  await app.browser.waitUntil(async () => /Which language/.test(await intakeTitle()), { timeoutMsg: `not English: ${await intakeTitle()}` });
  assert.deepEqual(await checked(".fr-choice"), ["system"]);
  assert.match(await app.text('[data-choice="system"]'), /Same as system[\s\S]*Now: English/);
  await app.shot("300-firstrun-en-language");
  assert.match(await shellText(), /not found/);
  assert.equal(v.settings.capture.inbox_title, "Inbox", "generated names in English too");
  assert.deepEqual(await app.consoleErrors(), []);
});

test("a first run on a German system greets in German", async () => {
  german = fresh();
  await start(german, { LANG: "de_DE.UTF-8" }, { onboarding: true });
  await app.waitFor(".fr-intro", 10000);
  assert.equal(await htmlLang(), "de");
  assert.equal(await app.browser.execute(() => document.querySelector(".fr-intro").getAttribute("aria-label")), "Einführung in Arcalo");
  assert.equal((await view()).system_language, "de");
  await app.shot("300-firstrun-de-system");
  await app.keys(["Escape"]);
  await app.browser.waitUntil(async () => /Welche Sprache/.test(await intakeTitle()), { timeoutMsg: `not German: ${await intakeTitle()}` });
  assert.deepEqual(await checked(".fr-choice"), ["system"]);
  assert.match(await app.text('[data-choice="system"]'), /Wie das System[\s\S]*Jetzt: Deutsch/);
  await app.shot("300-firstrun-de-language");
  assert.match(await shellText(), /nicht gefunden/);
});

test("the next start follows a changed system language, in gettext's order", async () => {
  const cases = [
    [{ LANG: "en_US.UTF-8" }, "en"],
    [{ LANG: "en_US.UTF-8", LC_MESSAGES: "de_DE.UTF-8" }, "de"],
    [{ LANG: "de_DE.UTF-8", LC_ALL: "en_GB.UTF-8" }, "en"],
    [{ LANG: "de_DE.UTF-8", LANGUAGE: "en_GB:de" }, "en"],
    [{ LANG: "en_US.UTF-8", LANGUAGE: "fr:de" }, "de"],
    [{ LC_ALL: "C.UTF-8", LANGUAGE: "de" }, "en"],
  ];
  for (const [vars, want] of cases) {
    await start(german, vars);
    const v = await view();
    assert.equal(v.settings.locale.language, "system", "the setting stays");
    assert.equal(v.system_language, want, JSON.stringify(vars));
    assert.equal(await htmlLang(), want, JSON.stringify(vars));
    assert.match(await shellText(), want === "en" ? /not found/ : /nicht gefunden/, JSON.stringify(vars));
    assert.equal(v.settings.capture.inbox_title, want === "en" ? "Inbox" : "Posteingang", JSON.stringify(vars));
  }
});

async function openLocale() {
  await app.keys(["Control", ","]);
  await app.waitFor(".settings-nav");
  await app.click('.settings-nav-item[data-section="locale"]');
  await app.waitFor(".segmented[role=radiogroup] button");
}
const languageOptions = () =>
  app.browser.execute(() => {
    const g = [...document.querySelectorAll(".segmented[role=radiogroup]")].find((x) => /language|Sprache der Oberfläche/i.test(x.getAttribute("aria-label") ?? ""));
    return [...(g?.querySelectorAll("button") ?? [])].map((b) => `${b.textContent}${b.getAttribute("aria-checked") === "true" ? " *" : ""}`);
  });
const clickOption = (label) =>
  app.browser.execute((l) => [...document.querySelectorAll(".segmented[role=radiogroup] button")].find((b) => b.textContent === l)?.click(), label);

test("Settings: three choices; a chosen language stays on any system, „Wie das System“ follows it again", async () => {
  await start(german, { LANG: "en_US.UTF-8" });
  await openLocale();
  assert.deepEqual(await languageOptions(), ["Same as system *", "Deutsch", "English"]);
  await app.waitText(".set-row", /System language: English/);
  await app.browser.setWindowSize(1280, 800);
  await app.shot("300-settings-locale-en-system");
  // German chosen: applies at once in the UI and the shell, and is stored.
  await clickOption("Deutsch");
  await app.waitText(".settings-head h1", /Sprache & Format/);
  await app.browser.waitUntil(async () => (await view()).settings.locale.language === "de", { timeoutMsg: "German not saved" });
  assert.match(await shellText(), /nicht gefunden/);
  assert.deepEqual(await languageOptions(), ["Wie das System", "Deutsch *", "English"]);
  await app.shot("300-settings-locale-de-chosen");
  // On the English system again: the choice stays.
  await start(german, { LANG: "en_US.UTF-8" });
  assert.equal(await htmlLang(), "de");
  assert.match(await shellText(), /nicht gefunden/);
  await openLocale();
  await clickOption("Wie das System");
  await app.waitText(".settings-head h1", /Language & format/);
  await app.browser.waitUntil(async () => (await view()).settings.locale.language === "system", { timeoutMsg: "system not saved" });
  assert.match(await shellText(), /not found/);
  // A narrow window keeps the three choices on one line.
  await app.browser.setWindowSize(900, 700);
  await app.browser.pause(300);
  const lines = await app.browser.execute(() => {
    const g = document.querySelector(".segmented[role=radiogroup]");
    return new Set([...g.querySelectorAll("button")].map((b) => Math.round(b.getBoundingClientRect().top))).size;
  });
  assert.equal(lines, 1);
  await app.shot("300-settings-locale-900");
  assert.deepEqual(await app.consoleErrors(), []);
});
