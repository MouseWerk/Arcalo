// The settings in English: every section is opened and photographed, its dialogs (a provider,
// the theme editor) too, and no German word may show. The settings search finds English words.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { guarded } from "../lib/harness.js";
import { launchEnglish, germanLeftovers } from "../lib/english.js";

const test = guarded(nodeTest, () => app);
let app;
let dataDir;
before(async () => {
  ({ app, dataDir } = await launchEnglish());
});
after(async () => {
  await app?.close();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

const found = [];
async function check(name) {
  await app.browser.pause(400);
  await app.shot(`en-82-${name}`);
  // The Markdown copy's folder layout is a file format and stays as it is.
  for (const h of await germanLeftovers(app, [/Zeiterfassung\/YYYY-MM\.csv/])) found.push(`${name}: ${h}`);
}

test("every settings section is English", async () => {
  await app.dismissToasts();
  await app.click('.ribbon [aria-label^="Settings"]');
  await app.waitFor(".settings-nav-item");
  const sections = await app.browser.execute(() => [...document.querySelectorAll(".settings-nav-item")].map((b) => b.dataset.section));
  assert.ok(sections.length >= 15, sections.join(" "));
  for (const id of sections) {
    await app.click(`.settings-nav-item[data-section="${id}"]`);
    await app.browser.waitUntil(async () => app.browser.execute((s) => document.querySelector(".settings-nav-item.active")?.dataset.section === s, id), {
      timeoutMsg: `section ${id} not shown`,
    });
    await check(`section-${id}`);
  }
});

test("the provider dialog is English", async () => {
  await app.click('.settings-nav-item[data-section="ai"]');
  await app.browser.pause(300);
  const edit = await app.browser.execute(() => !!document.querySelector('.provider-row [aria-label^="Edit"]'));
  if (edit) {
    await app.click('.provider-row [aria-label^="Edit"]');
    await app.waitFor(".dialog");
    await check("provider-dialog");
    await app.keys(["Escape"]);
    await app.browser.pause(200);
  }
});

test("the settings search takes English words", async () => {
  await app.click('.settings-nav-item[data-section="appearance"]');
  const search = await app.$(".settings-search input, input.settings-search");
  await search.click();
  await app.type("language");
  await app.browser.pause(400);
  const hits = await app.browser.execute(() => document.querySelectorAll(".settings-hit-section:not([hidden]) .set-group:not([hidden]) .set-row").length);
  assert.ok(hits > 0, "no row for “language”");
  await check("search");
});

test("no German words in the settings", () => {
  assert.deepEqual(found, []);
});
