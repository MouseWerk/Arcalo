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
  await app.waitFor(".pane.active .calv");
  await app.waitText(".pane.active .tab.active", /Kalender/);
  await app.click(".pane.active .tab.active .tab-close");
  await app.keys(["Control", "k"]);
  await app.waitFor(".palette");
  await app.type("Kalender öffnen");
  await app.waitText(".pal-item.sel", /Kalender öffnen/);
  await app.keys(["Enter"]);
  await app.waitFor(".pane.active .calv");
});

test("the start page widget lists today's meetings and opens the calendar on one", async () => {
  await app.keys(["Control", "t"]);
  await app.waitFor(".pane.active .dash");
  const button = (text) => app.browser.execute((t) => [...document.querySelectorAll(".pane.active .dash-bar .btn")].find((b) => b.textContent.trim() === t)?.click(), text);
  await button("Anpassen");
  await app.waitText(".pane.active .dash-bar .btn", /Widget hinzufügen/);
  await button("Widget hinzufügen");
  await app.waitText(".menu-item", /^Termine$/);
  await app.browser.execute(() => [...document.querySelectorAll(".menu-item")].find((b) => b.textContent.trim() === "Termine").click());
  await button("Fertig");
  await app.waitText('.dw[data-kind="agenda"] .dw-agenda-row', /Daily Standup/);
  assert.deepEqual((await app.invoke("settings_get")).settings.dashboard.widgets.filter((w) => w.kind === "agenda").length, 1);
  await app.browser.execute(() => document.querySelector('.dw[data-kind="agenda"]').scrollIntoView({ block: "center" }));
  await app.shot("64-dashboard-agenda");
  await app.click('.dw[data-kind="agenda"] .dw-agenda-row');
  await app.waitText(".pane.active .calv-detail-title", /Daily Standup/);
});

test("the timesheet offers this week's unbooked meetings and books one", async () => {
  await app.click(".ribbon .icon-btn[aria-label='Zeiterfassung']");
  // The first four are shown; „Alle … zeigen“ lists the rest (today's standup comes last).
  await app.waitText(".ts-meetings .card-head", /Termine dieser Woche noch nicht gebucht/);
  await app.browser.execute(() => [...document.querySelectorAll(".ts-meetings > .btn")].find((b) => /^Alle \d+ zeigen$/.test(b.textContent.trim()))?.click());
  await app.waitText(".ts-meetings .ts-meeting-title", /Daily Standup/);
  const before = await app.browser.execute(() => document.querySelectorAll(".ts-meeting").length);
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
