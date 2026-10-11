// Kalender around the app: Ctrl+Shift+E and the palette open it, the start page widget
// „Termine“ lists today's meetings, the timesheet offers unbooked meetings of the week
// („Termine übernehmen“) and books one.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { launch, guarded } from "../lib/harness.js";
import { outlookEnv, serveTeam, writeFixtures } from "../lib/calendar-fixtures.js";

const test = guarded(nodeTest, () => app);
let app;
let fx;
let team;
before(async () => {
  fx = writeFixtures();
  team = await serveTeam();
  app = await launch({ env: outlookEnv(fx.outlook) });
  await app.invoke("calendar_source_add", { name: "Team", url: team.url, path: null });
  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", { settings: { ...view.settings, calendar: { ...view.settings.calendar, outlook: true } } });
  await app.invoke("calendar_sync_now", { source: null });
  await app.browser.waitUntil(async () => (await app.invoke("calendar_status")).sources.every((s) => s.status?.synced_at && !s.syncing), { timeout: 20000, timeoutMsg: "not synced" });
});
after(async () => {
  await app?.close();
  team?.server.close();
  if (fx) fs.rmSync(fx.dir, { recursive: true, force: true });
});

test("Ctrl+Shift+E and the palette open the Kalender", async () => {
  await app.keys(["Control", "Shift", "e"]);
  await app.waitFor(".pane.active > .pane-content:not([hidden]) .calv");
  await app.waitText(".pane.active .tab.active", /Kalender/);
  await app.click(".pane.active .tab.active .tab-close");
  await app.keys(["Control", "k"]);
  await app.waitFor(".palette");
  await app.type("Kalender");
  await app.waitText(".pal-item.sel", /Termine aus Outlook und ICS/);
  await app.keys(["Enter"]);
  await app.waitFor(".pane.active > .pane-content:not([hidden]) .calv");
});

test("the start page widget lists today's meetings and opens the calendar on one", async () => {
  await app.keys(["Control", "t"]);
  await app.waitFor(".pane.active > .pane-content:not([hidden]) .dash");
  const button = (text) => app.browser.execute((t) => [...document.querySelectorAll(".pane.active > .pane-content:not([hidden]) .dash-bar .btn")].find((b) => b.textContent.trim() === t)?.click(), text);
  await button("Anpassen");
  await app.waitText(".pane.active > .pane-content:not([hidden]) .dash-bar .btn", /Widget hinzufügen/);
  await button("Widget hinzufügen");
  // The widget gallery (1.6); „Termine“ is on the default board already, this adds a second one.
  await app.click('.dash-gallery-card[data-kind="agenda"]');
  await button("Fertig");
  await app.waitText('.dw[data-kind="agenda"] .dw-agenda-row', /Daily Standup/);
  const boards = (await app.invoke("settings_get")).settings.dashboard.boards;
  assert.equal(boards[0].widgets.filter((w) => w.kind === "agenda").length, 2);
  await app.browser.execute(() => document.querySelector('.dw[data-kind="agenda"]').scrollIntoView({ block: "center" }));
  await app.shot("64-dashboard-agenda");
  await app.click('.dw[data-kind="agenda"] .dw-agenda-row');
  await app.waitText(".pane.active > .pane-content:not([hidden]) .calv-detail-title", /Daily Standup/);
});

test("the timesheet offers this week's unbooked meetings and books one", async () => {
  await app.click(".ribbon .icon-btn[aria-label='Zeiterfassung']");
  // The first four are shown; „Alle … zeigen“ lists the rest (today's standup comes last). On a
  // Monday morning the standup may be the only meeting of the week that is over: „1 Termin“.
  await app.waitText(".ts-meetings .card-head", /\d+ Termine? dieser Woche noch nicht gebucht/);
  await app.browser.execute(() => [...document.querySelectorAll(".ts-meetings > .btn")].find((b) => /^Alle \d+ zeigen$/.test(b.textContent.trim()))?.click());
  await app.waitText(".ts-meetings .ts-meeting-title", /Daily Standup/);
  const before = await app.browser.execute(() => document.querySelectorAll(".ts-meeting").length);
  assert.match(await app.text(".ts-meetings .card-head"), new RegExp(`(^|\\D)${before} ${before === 1 ? "Termin" : "Termine"} dieser Woche noch nicht gebucht`), "the count of the listed meetings");
  await app.browser.execute(() => document.querySelector(".ts-meetings").scrollIntoView({ block: "center" }));
  await app.shot("64-timesheet-meetings");
  await app.browser.execute(() => [...document.querySelectorAll(".ts-meeting")].find((li) => /Daily Standup/.test(li.textContent)).querySelector(".btn").click());
  await app.waitText(".dialog .calv-book-note", /Aus dem Termin „Daily Standup“/);
  await app.click(".dialog .btn-primary");
  await app.browser.waitUntil(async () => !(await app.browser.execute(() => [...document.querySelectorAll(".ts-meeting-title")].some((t) => t.textContent === "Daily Standup"))), { timeoutMsg: "still offered after booking" });
  const today = new Date();
  const from = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const entries = await app.invoke("time_entries", { from: from.toISOString(), to: new Date(from.getTime() + 86400e3).toISOString() });
  const e = entries.find((x) => x.description === "Daily Standup");
  assert.ok(e, "booked");
  assert.equal(e.duration_minutes, 15);
  assert.equal(new Date(e.start_time).getHours(), 0);
  assert.equal(new Date(e.start_time).getMinutes(), 5);
  // „Nicht buchen“ from the list.
  const left = await app.browser.execute(() => document.querySelectorAll(".ts-meeting").length);
  assert.equal(left, before - 1);
  if (left > 0) {
    await app.browser.execute(() => document.querySelector(".ts-meeting [aria-label$='nicht buchen']").click());
    await app.browser.waitUntil(async () => (await app.browser.execute(() => document.querySelectorAll(".ts-meeting").length)) === left - 1, { timeoutMsg: "not dismissed" });
  }
});
