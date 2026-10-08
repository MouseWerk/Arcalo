// 1.11 fixes in the calendar: focus blocks show in the month view and in the list (before only
// in the time grid), a block opens its detail from there, and the free slots of „Im Kalender
// planen…“ follow the working hours of Settings → Zeiterfassung instead of a fixed 08:00–18:00.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";
import { iso } from "../lib/calendar-fixtures.js";

const test = guarded(nodeTest, () => app);
let app;
const today = new Date();
const at = (d, h, m = 0) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m);

async function patchSettings(f) {
  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", { settings: f(structuredClone(view.settings)) });
  await app.browser.pause(300);
}
async function openCalendar(view) {
  await app.browser.execute((v) => localStorage.setItem("arcalo.calendar.view", v), view);
  await app.browser.execute(() => location.reload());
  await app.browser.waitUntil(() => app.browser.execute(() => document.body.classList.contains("ready")), { timeout: 20000, timeoutMsg: "not ready after reload" });
  await app.click(".ribbon-calendar-view");
}

before(async () => {
  app = await launch({ width: 1480, demo: false });
  for (const [title, h] of [["Fokus 148 Bericht", 10], ["Fokus 148 Review", 14]]) {
    await app.invoke("block_create", { block: { title, start: at(today, h).toISOString(), end: at(today, h + 1, 30).toISOString(), link: { kind: "none" } } });
  }
});
after(async () => {
  await app?.close();
});

test("Monatsansicht zeigt Fokusblöcke mit Uhrzeit und öffnet ihr Detail", async () => {
  await openCalendar("month");
  const cell = `.calv-mcell[data-date="${iso(today)}"]`;
  await app.waitFor(`${cell} .calv-mblock`, 15000);
  const lines = await app.browser.execute((c) => [...document.querySelectorAll(`${c} .calv-mblock`)].map((b) => b.textContent), cell);
  assert.deepEqual(lines, ["10:00Fokus 148 Bericht", "14:00Fokus 148 Review"]);
  await app.click(`${cell} .calv-mblock`);
  await app.waitFor(".calv-block-detail", 5000);
  assert.ok(await app.browser.execute((c) => document.querySelector(`${c} .calv-mblock`).classList.contains("selected"), cell));
  await app.shot("148-month-blocks");
});

test("Listenansicht zeigt Fokusblöcke zwischen den Terminen", async () => {
  await openCalendar("agenda");
  await app.waitFor(".calv-agenda-block", 15000);
  const rows = await app.browser.execute(() => [...document.querySelectorAll(".calv-agenda-block")].map((r) => r.querySelector(".calv-agenda-time").textContent + " " + r.querySelector(".calv-ev-title").textContent));
  assert.deepEqual(rows.slice(0, 2), ["10:00–11:30 Fokus 148 Bericht", "14:00–15:30 Fokus 148 Review"]);
  await app.shot("148-list-blocks");
});

test("Freie Zeiten folgen der Arbeitszeit aus den Einstellungen", async () => {
  const tomorrow = iso(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1));
  const hm = (s) => new Date(s).toTimeString().slice(0, 5);
  let slots = await app.invoke("block_free_slots", { date: tomorrow, minutes: 60 });
  assert.equal(hm(slots[0]), "08:00", "default 08:00–18:00");
  await patchSettings((s) => ({ ...s, time: { ...s.time, work_start: "06:30", work_end: "09:00" } }));
  slots = await app.invoke("block_free_slots", { date: tomorrow, minutes: 60 });
  assert.deepEqual(slots.map(hm), ["06:30", "07:00", "07:30", "08:00"]);
  // A start after the end is not taken: back to the default hours.
  await patchSettings((s) => ({ ...s, time: { ...s.time, work_start: "17:00", work_end: "09:00" } }));
  slots = await app.invoke("block_free_slots", { date: tomorrow, minutes: 60 });
  assert.equal(hm(slots[0]), "08:00");
  const saved = (await app.invoke("settings_get")).settings.time;
  assert.deepEqual([saved.work_start, saved.work_end], ["17:00", "09:00"]);
});
