// The app with regional settings other than the defaults: English, US dates (month first),
// weeks starting on Sunday, in a time zone west of UTC (America/Los_Angeles). Dates of days
// (due dates) show the day they name, `/time` takes dates written as the date format writes them,
// and the start page's week and month follow the week start of the settings.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { guarded } from "../lib/harness.js";
import { launchEnglish } from "../lib/english.js";
import { iso } from "../lib/calendar-fixtures.js";

// A real zone eight hours (seven in summer) behind UTC: a day's date read as UTC midnight is
// the day before here. Set before any local date is computed; the app inherits it.
process.env.TZ = "America/Los_Angeles";

const test = guarded(nodeTest, () => app);
let app, dataDir;
const pad = (n) => String(n).padStart(2, "0");
const daysAgo = (n) => {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return d;
};
const us = (d) => `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()}`;
const gb = (d) => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
const pane = ".pane.active > .pane-content:not([hidden])";

async function patchSettings(f) {
  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", { settings: f(structuredClone(view.settings)) });
  await app.browser.pause(400);
}
async function reload() {
  await app.reload();
  await app.browser.pause(300);
  await app.browser.waitUntil(() => app.browser.execute(() => document.body.classList.contains("ready")), { timeout: 20000, timeoutMsg: "not ready after reload" });
}

before(async () => {
  ({ app, dataDir } = await launchEnglish());
  await patchSettings((s) => ({
    ...s,
    workdays: [1, 2, 3, 4, 5, 6, 7],
    locale: { ...s.locale, date_format: "en-us" },
    time: { ...s.time, week_start: "sunday" },
  }));
  await app.invoke("page_create", { parentId: null, title: "Offers", icon: null, content: `# Offers\n\n- [ ] Send the offer due:${iso(daysAgo(3))}\n` });
  await reload();
});
after(async () => {
  await app?.close();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

test("the app runs west of UTC with US dates", async () => {
  const offset = await app.browser.execute(() => new Date().getTimezoneOffset());
  assert.ok(offset >= 420, `offset ${offset}`);
});

test("an overdue task shows its own due date, not the day before", async () => {
  await app.keys(["Control", "k"]);
  await app.waitFor(".palette input");
  await app.type("Morning briefing");
  await app.browser.pause(250);
  await app.keys(["Enter"]);
  await app.waitFor(`${pane} .bf-view .bf-grid`, 15000);
  const tasks = await app.text(`${pane} .bf-card[data-section="tasks"]`);
  assert.match(tasks, /Send the offer/);
  assert.ok(tasks.includes(us(daysAgo(3))), `${us(daysAgo(3))} in: ${tasks}`);
  assert.ok(!tasks.includes(us(daysAgo(4))), tasks);
});

test("/time takes a date in the US order", async () => {
  const day = daysAgo(2);
  const out = await app.invoke("log_time", { line: `/time NP-8801/1020 1h Review @${us(day)}` });
  const entry = out.entry ?? out;
  const start = new Date(entry.start_time);
  assert.equal(iso(start), iso(day), JSON.stringify(out));
});

test("/time takes a date in the British order", async () => {
  await patchSettings((s) => ({ ...s, locale: { ...s.locale, date_format: "en-gb" } }));
  const day = daysAgo(5);
  const out = await app.invoke("log_time", { line: `/time NP-8801/1020 1h Review @${gb(day)}` });
  const entry = out.entry ?? out;
  assert.equal(iso(new Date(entry.start_time)), iso(day), JSON.stringify(out));
  await patchSettings((s) => ({ ...s, locale: { ...s.locale, date_format: "en-us" } }));
});

test("the start page's week and month start on Sunday", async () => {
  await app.invoke("dashboard_save", {
    dashboard: {
      version: 2,
      active: "b",
      notes: {},
      boards: [{ id: "b", name: "Start", widgets: [{ id: "week", kind: "week", x: 0, y: 0, w: 6, h: 7, config: {} }, { id: "cal", kind: "calendar", x: 6, y: 0, w: 4, h: 8, config: {} }] }],
    },
  });
  await reload();
  await app.keys(["Control", "t"]);
  const week = `${pane} [data-widget="week"]`;
  await app.waitFor(`${week} .dw-bar-item button`, 15000);
  const bars = await app.browser.execute((sel) => [...document.querySelectorAll(`${sel} .dw-bar-item button`)].map((b) => b.getAttribute("aria-label")), week);
  assert.equal(bars.length, 7);
  assert.match(bars[0], /^Sun/, bars.join(" | "));
  // Today's bar is the one of its weekday counted from Sunday.
  const todayAt = await app.browser.execute((sel) => [...document.querySelectorAll(`${sel} .dw-bar-col`)].findIndex((b) => b.classList.contains("today")), week);
  assert.equal(todayAt, new Date().getDay());
  const cal = `${pane} [data-widget="cal"]`;
  await app.waitFor(`${cal} .dw-cal-wd`);
  const heads = await app.browser.execute((sel) => [...document.querySelectorAll(`${sel} .dw-cal-wd`)].map((e) => e.textContent), cal);
  assert.equal(heads[0], "Su", heads.join(","));
  const firstDay = await app.browser.execute((sel) => document.querySelector(`${sel} .dw-cal-day`).dataset.date, cal);
  assert.equal(new Date(`${firstDay}T12:00:00`).getDay(), 0, firstDay);
  await app.shot("640-sunday-start");
});
