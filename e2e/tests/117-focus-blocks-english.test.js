// Time blocking in English and dark (1.8): „Plan in calendar…“ on a task (the keyboard way, no
// dragging) offers free slots today and tomorrow and creates the block; the Kalender shows it with
// its detail in English, planned next to booked hours in the day header; with time tracking off
// blocks stay but the booked side goes. A task of the dashboard's task widget can be dragged into
// the week as well; a deleted block comes back with „Undo“.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { guarded } from "../lib/harness.js";
import { germanLeftovers, launchEnglish } from "../lib/english.js";
import { iso, week } from "../lib/calendar-fixtures.js";

const test = guarded(nodeTest, () => app);
let app;
let dataDir;
let pageId;
const HOUR = 48;
const today = new Date();
const todayIso = iso(today);
const tomorrowIso = iso(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1));
const { monday } = week();
const range = { from: monday.toISOString(), to: new Date(monday.getTime() + 14 * 86400e3).toISOString() };

before(async () => {
  ({ app, dataDir } = await launchEnglish({ width: 1600 }));
  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", { settings: { ...view.settings, theme: "dark" } });
  await app.browser.execute(() => (document.documentElement.dataset.theme = "dark"));
  const page = await app.invoke("page_create", { parentId: null, title: "Focus tasks", icon: null, content: `- [ ] Write the report due:${todayIso}\n- [ ] Review the slides\n` });
  pageId = page.id;
  await app.browser.execute(() => localStorage.setItem("arcalo.calendar.view", "week"));
});
after(async () => {
  await app?.close();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

const blocks = () => app.invoke("blocks_list", range);
const hm = (s) => {
  const d = new Date(s);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
const clickText = async (sel, pattern) => {
  await app.browser.waitUntil(
    () => app.browser.execute((s, src) => {
      const el = [...document.querySelectorAll(s)].find((b) => new RegExp(src).test(b.textContent.trim()) && !b.disabled);
      el?.click();
      return !!el;
    }, sel, pattern.source),
    { timeoutMsg: `no ${sel} ${pattern}` },
  );
  await app.browser.pause(150);
};

test("„Plan in calendar…“ offers free slots and plans the task without dragging", async () => {
  await app.keys(["Control", "Shift", "a"]);
  const row = `.tasks-view .task-row[data-page="${pageId}"][data-ordinal="1"]`;
  await app.waitFor(row);
  // Shown on hover and focus: reached with the keyboard.
  await app.browser.execute((s) => document.querySelector(`${s} .task-plan`).focus(), row);
  assert.equal(await app.browser.execute(() => document.activeElement.getAttribute("aria-label")), "Plan in calendar…");
  await app.keys(["Enter"]);
  await app.waitText(".dialog .dialog-title", /^Plan in calendar$/);
  assert.match(await app.text(".dialog .dialog-desc"), /Review the slides/);
  await clickText('.dialog .segmented [role="radio"]', /^Tomorrow$/);
  await app.browser.waitUntil(() => app.browser.execute(() => document.querySelectorAll(".plan-slot").length > 0), { timeoutMsg: "no free slots" });
  const slots = await app.browser.execute(() => [...document.querySelectorAll(".plan-slot")].map((b) => b.textContent.trim()));
  assert.equal(slots[0], "08:00–09:00", "tomorrow from the start of the working day");
  assert.ok(slots.every((x) => /^\d\d:\d\d–\d\d:\d\d$/.test(x)));
  await app.shot("117-picker-dark");
  await clickText(".plan-slot", /^09:00–10:00$/);
  await app.waitText(".toast", /Planned: .*09:00–10:00/);
  const b = (await blocks()).find((x) => x.title === "Review the slides");
  assert.ok(b);
  assert.deepEqual([iso(new Date(b.start)), hm(b.start), hm(b.end)], [tomorrowIso, "09:00", "10:00"]);

  // „Show in calendar“: the Kalender on that day with the block open.
  await clickText(".toast .btn", /^Show in calendar$/);
  await app.waitFor(`.calv-block[data-block="${b.id}"].selected`, 10000);
  await app.waitFor(".calv-block-detail");
  assert.match(await app.text(".calv-block-detail"), /Focus block[\s\S]*TASK[\s\S]*Review the slides[\s\S]*Start focus session[\s\S]*Mark task done[\s\S]*Delete/);
  assert.match(await app.browser.execute((id) => document.querySelector(`.calv-block[data-block="${id}"]`).getAttribute("aria-description"), b.id), /Arrow keys move/);
  // The picker avoids the new block next time.
  const next = await app.invoke("block_free_slots", { date: tomorrowIso, minutes: 60 });
  assert.ok(!next.some((s) => hm(s) === "09:00" || hm(s) === "08:30"), "taken slot not offered again");
  const left = await germanLeftovers(app);
  assert.deepEqual(left, [], "German left in the English Kalender");
  await app.shot("117-calendar-dark");
});

test("planned next to booked in the day header; time tracking off keeps the plan only", async () => {
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 6);
  await app.invoke("block_create", { block: { title: "Deep work", start: start.toISOString(), end: new Date(start.getTime() + 90 * 60e3).toISOString() } });
  await app.invoke("log_time", { line: "/time NP-8801/1020 2h 'Booked in the test'", pageId: null });
  await app.browser.execute(() => location.reload());
  await app.browser.pause(300);
  await app.browser.waitUntil(() => app.browser.execute(() => document.body.classList.contains("ready")), { timeout: 20000, timeoutMsg: "not ready" });
  await app.click(".ribbon-calendar-view");
  const head = `.calv-dayhead[data-date="${todayIso}"]`;
  await app.browser.waitUntil(() => app.browser.execute((h) => !!document.querySelector(`${h} .calv-planned-sum`) && !!document.querySelector(`${h} .calv-booked-sum`), head), { timeout: 10000, timeoutMsg: "no planned/booked in the header" });
  assert.match(await app.browser.execute((h) => document.querySelector(`${h} .calv-planned-sum`).getAttribute("aria-label"), head), /^1\.50 h planned$/);
  assert.match(await app.browser.execute((h) => document.querySelector(`${h} .calv-plan-vs`).getAttribute("data-tooltip"), head), /1\.50 h planned, [\d.:]+ h booked/);

  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", { settings: { ...view.settings, time: { ...view.settings.time, enabled: false } } });
  await app.browser.waitUntil(() => app.browser.execute((h) => !document.querySelector(`${h} .calv-booked-sum`), head), { timeout: 10000, timeoutMsg: "booked side still shown" });
  assert.ok(await app.browser.execute((h) => !!document.querySelector(`${h} .calv-planned-sum`), head), "the plan stays");
  assert.ok(await app.browser.execute(() => !document.querySelector(".calv-lane")), "no booked lane");
  const deep = (await blocks()).find((x) => x.title === "Deep work");
  await app.browser.execute((id) => document.querySelector(`.calv-block[data-block="${id}"]`).focus(), deep.id);
  await app.keys(["Enter"]);
  await app.waitFor(".calv-block-detail");
  assert.doesNotMatch(await app.text(".calv-block-detail"), /Activity/, "no WBS without time tracking");
  await app.invoke("settings_save", { settings: { ...(await app.invoke("settings_get")).settings, time: { ...view.settings.time, enabled: true } } });
});

test("a task of the dashboard is dragged into the week; a deleted block comes back with Undo", async () => {
  await app.invoke("dashboard_save", {
    dashboard: { version: 2, active: "plan", notes: {}, boards: [{ id: "plan", name: "Plan", widgets: [{ id: "tasks", kind: "tasks", x: 0, y: 0, w: 6, h: 8, config: {} }] }] },
  });
  await app.keys(["Control", "t"]);
  const task = ".pane.active > .pane-content:not([hidden]) .dw-task";
  await app.browser.waitUntil(() => app.browser.execute((s) => [...document.querySelectorAll(s)].some((li) => /Write the report/.test(li.textContent)), task), { timeout: 15000, timeoutMsg: "task widget" });
  const payload = await app.browser.execute((s) => {
    const li = [...document.querySelectorAll(s)].find((x) => /Write the report/.test(x.textContent));
    const dt = new DataTransfer();
    li.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
    window.__planDrag = dt;
    return li.draggable && dt.getData("application/x-arcalo-plan");
  }, task);
  assert.equal(JSON.parse(payload).text, "Write the report");
  await app.click(".ribbon-calendar-view");
  const col = `.calv-col[data-date="${todayIso}"]`;
  await app.waitFor(col);
  await app.browser.execute((s, hour) => {
    const c = document.querySelector(s);
    const r = c.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, dataTransfer: window.__planDrag, clientX: r.x + 10, clientY: r.top + 16 * hour + 24 };
    c.dispatchEvent(new DragEvent("dragover", opts));
    c.dispatchEvent(new DragEvent("drop", opts));
  }, col, HOUR);
  await app.browser.waitUntil(async () => (await blocks()).some((x) => x.title === "Write the report"), { timeoutMsg: "not dropped" });
  const b = (await blocks()).find((x) => x.title === "Write the report");
  assert.deepEqual([hm(b.start), hm(b.end)], ["16:30", "17:30"], "on the nearest quarter hour, default length");

  await app.waitFor(".calv-block-detail");
  await clickText(".calv-block-detail .btn", /^Delete$/);
  await app.browser.waitUntil(async () => !(await blocks()).some((x) => x.title === "Write the report"), { timeoutMsg: "not deleted" });
  await app.waitText(".toast", /Focus block deleted/);
  await clickText(".toast .btn", /^Undo$/);
  await app.browser.waitUntil(async () => (await blocks()).some((x) => x.title === "Write the report" && hm(x.start) === "16:30"), { timeoutMsg: "not back" });
  await app.waitFor(".calv-block");
});
