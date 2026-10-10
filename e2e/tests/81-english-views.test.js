// The app in English, view by view: the start page, the daily note, the calendar, time
// tracking, tasks, projects, the timeline, the daily review, a page with its menus, the command
// palette, the focus dialog, the assistant and the trash. Each view is photographed and must not
// show German words (visible text and labels alike).
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
/** Photographs the window and collects German words. */
async function check(name) {
  await app.browser.pause(500);
  await app.shot(`en-81-${name}`);
  for (const h of await germanLeftovers(app)) found.push(`${name}: ${h}`);
}
async function ribbon(label) {
  await app.dismissToasts();
  await app.click(`.ribbon [aria-label^="${label}"]`);
  await app.browser.pause(700);
}
async function escape() {
  await app.keys(["Escape"]);
  await app.browser.pause(200);
}

test("the settings say English and the shell is English", async () => {
  assert.equal((await app.invoke("settings_get")).settings.locale.language, "en");
  assert.equal(await app.browser.execute(() => document.documentElement.lang), "en");
  const labels = await app.browser.execute(() => [...document.querySelectorAll(".ribbon [aria-label]")].map((b) => b.getAttribute("aria-label")));
  assert.ok(labels.some((l) => /^Settings/.test(l)), labels.join(" | "));
  await check("start");
});

test("the main views are English", async () => {
  await ribbon("Today's daily note");
  await app.waitFor(".pane.active > .pane-content:not([hidden]) .ProseMirror");
  await check("daily");
  await ribbon("Calendar: meetings");
  await check("calendar");
  await ribbon("Time tracking");
  await check("timesheet");
  await ribbon("Tasks");
  await check("tasks");
  await ribbon("Projects");
  await check("projects");
  await ribbon("Timeline");
  await check("timeline");
  await ribbon("Daily review");
  await check("review");
});

test("a page, its menus, the palette, the focus dialog, the assistant and the trash are English", async () => {
  // A demo page from the sidebar, with its property and backlink areas.
  await app.dismissToasts();
  await app.click('.tree[role="tree"] .tree-row');
  await app.waitFor(".pane.active > .pane-content:not([hidden]) .page-title");
  await check("page");
  // The page's "More actions" menu.
  await app.click('.pane.active > .pane-content:not([hidden]) [aria-label="More actions"]');
  await app.waitFor(".menu");
  await check("page-menu");
  await escape();
  // The sidebar's context menu of a page.
  const row = await app.$('.tree[role="tree"] .tree-row');
  await row.click({ button: "right" });
  await app.waitFor(".menu");
  await check("tree-menu");
  await escape();
  // Command palette.
  await app.keys(["Control", "k"]);
  await app.waitFor(".palette input");
  await check("palette");
  await escape();
  // Focus dialog.
  await ribbon("Start focus session");
  await app.waitFor(".focus-form");
  await check("focus");
  await escape();
  // Assistant panel.
  await ribbon("Assistant");
  await check("assistant");
  await escape();
  // Trash (through the palette).
  await app.keys(["Control", "k"]);
  await app.waitFor(".palette input");
  await app.type("trash");
  await app.browser.pause(300);
  await app.keys(["Enter"]);
  await app.browser.pause(600);
  await check("trash");
});

test("no German words anywhere", () => {
  assert.deepEqual(found, []);
});
