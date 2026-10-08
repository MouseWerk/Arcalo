// 1.12 quality pass, time tracking: the timesheet's week targets follow own weekday hours and
// absences, /zeit understands time spans and says when the reference is missing, a new entry
// starts with the Netzplan's default Leistungsart, and the Kalender draws the day of a clock
// change by wall clock (German time; the app and this file run in Europe/Berlin).
process.env.TZ = "Europe/Berlin";

import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const monday = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
const lastWeek = monday(new Date(Date.now() - 7 * 86400000));
const day = (i) => new Date(lastWeek.getFullYear(), lastWeek.getMonth(), lastWeek.getDate() + i);

async function patchSettings(f) {
  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", { settings: f(structuredClone(view.settings)) });
  await app.browser.pause(300);
}

before(async () => {
  app = await launch({ demo: false, env: { TZ: "Europe/Berlin" } });
  const p = await app.invoke("project_create", { code: "PRJ-152", name: "Qualität" });
  const np = await app.invoke("netzplan_create", { projectId: p.id, netzplanNr: "NP-1510", wbsElement: "NP-1510-1", description: "Prüfung", plannedHours: 40 });
  await app.invoke("vorgang_create", { netzplanId: np.id, vorgangNr: "10", description: "Test", durationDays: 1, plannedHours: 10, predecessors: [] });
  await app.invoke("leistungsart_save", { code: "PM", description: "Projektmanagement" });
  // Two hours on Tuesday of last week.
  await app.invoke("time_entry_create", { netzplanId: np.id, vorgangNr: "10", leistungsart: "PM", startTime: new Date(day(1).getTime() + 9 * 3600000).toISOString(), durationMinutes: 120, description: "Review" });
  // Own targets (Friday 5 h), no state (no public holidays), and Monday of last week off.
  await patchSettings((s) => {
    s.time.balance.state = "";
    s.time.balance.weekday_hours = [8, 8, 8, 8, 5, 0, 0];
    s.time.default_leistungsart = { "NP-1510": "PM" };
    return s;
  });
  await app.invoke("absence_save", { from: iso(day(0)), to: iso(day(0)), kind: "vacation", half: false, note: "" });
});
after(async () => app?.close());

test("the week overview takes own weekday targets and absences as the target", async () => {
  await app.click('.ribbon [aria-label^="Zeiterfassung"]');
  await app.waitText(".view-header h1", /Zeiterfassung/);
  await app.click('[aria-label="Vorherige Woche"]');
  // The previous week is shown once its target is (3 × 8 h + 5 h); the chips of this week are gone then.
  await app.waitText(".stat-note", /^Soll 29,00 h$/);
  await app.waitFor(".week-gaps .gap-chip");
  const chips = await app.browser.execute(() => [...document.querySelectorAll(".week-gaps .gap-chip")].map((c) => c.textContent.trim()));
  // No gap on the vacation Monday; Friday misses its own 5 h, not 8 h.
  assert.equal(chips.length, 4, chips.join(" | "));
  assert.ok(!chips.some((c) => c.startsWith("Mo")), chips.join(" | "));
  assert.match(chips[3], /^Fr \d+\. −5,00 h$/);
  assert.match(chips[0], /^Di \d+\. −6,00 h$/);
  // 3 × 8 h + 5 h.
  assert.equal(await app.text(".stat-note"), "Soll 29,00 h");
  // The day off is marked in the grid's head.
  const monday = await app.browser.execute(() => {
    const th = document.querySelectorAll(".week-grid thead th")[2];
    return [th.classList.contains("weekend"), th.dataset.tooltip];
  });
  assert.deepEqual(monday, [true, "Urlaub"]);
  await app.shot("152-week-targets");
});

test("/zeit books a time span and names the missing reference", async () => {
  const yesterday = new Date(Date.now() - 86400000);
  const out = await app.invoke("log_time", { line: `/zeit NP-1510/10 9:00-10:30 Abstimmung @${iso(yesterday)}`, pageId: null });
  const start = new Date(out.entry.start_time);
  assert.deepEqual([start.getHours(), start.getMinutes(), out.entry.duration_minutes], [9, 0, 90]);
  // The Netzplan's default Leistungsart applies.
  assert.equal(out.entry.leistungsart, "PM");
  await assert.rejects(app.invoke("log_time", { line: "/zeit 1h30m Abstimmung", pageId: null }), /Netzplan fehlt/);
});

test("a new entry starts with the Netzplan's default Leistungsart", async () => {
  await app.click(".view-header .btn-primary");
  await app.waitFor(".dialog");
  const la = await app.browser.execute(() => document.querySelector('.dialog [role="combobox"][aria-label="Leistungsart"]')?.dataset.value);
  assert.equal(la, "PM");
  // „1h 30m“ is a duration as well.
  const dur = await app.$("//label[contains(@class, 'field')][span[text()='Dauer']]//input");
  await dur.setValue("1h 30m");
  await app.waitText(".dialog .field-hint", /1,50 h/);
  await app.keys(["Escape"]);
});

test("the Kalender draws the day of a clock change by wall clock", async () => {
  // The next last Sunday of March or October (a clock change in Germany).
  const lastSunday = (y, m) => {
    const d = new Date(y, m + 1, 0);
    return new Date(y, m, d.getDate() - d.getDay());
  };
  const now = new Date();
  const change = [lastSunday(now.getFullYear(), 2), lastSunday(now.getFullYear(), 9), lastSunday(now.getFullYear() + 1, 2)].find((d) => d >= new Date(now.getFullYear(), now.getMonth(), now.getDate()));
  const at = (h) => new Date(change.getFullYear(), change.getMonth(), change.getDate(), h);
  await app.invoke("block_create", { block: { title: "Fokus 152", start: at(10).toISOString(), end: at(11).toISOString(), link: { kind: "none" } } });
  // One in this week too: without calendars the Kalender shows its grid once something is planned.
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12);
  await app.invoke("block_create", { block: { title: "Heute 152", start: today.toISOString(), end: new Date(today.getTime() + 3600000).toISOString(), link: { kind: "none" } } });
  await app.browser.execute(() => localStorage.setItem("arcalo.calendar.view", "week"));
  await app.click(".ribbon-calendar-view");
  await app.waitFor(".calv-grid");
  const weeks = Math.round((monday(change) - monday(now)) / (7 * 86400000));
  for (let i = 0; i < weeks; i++) await app.click('[aria-label="Weiter (→)"]');
  await app.browser.waitUntil(() => app.browser.execute(() => !![...document.querySelectorAll(".calv-block")].find((b) => b.textContent.includes("Fokus 152"))), { timeoutMsg: "block not shown" });
  // 48 px per hour: 10:00 is at 480 px, as the hour label says.
  const top = await app.browser.execute(() => [...document.querySelectorAll(".calv-block")].find((b) => b.textContent.includes("Fokus 152")).style.top);
  assert.equal(top, "480px");
  await app.shot("152-calendar-clock-change");
});
