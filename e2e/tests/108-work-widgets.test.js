// Start page 1.7, work widgets (German): overtime balance and vacation with the absence dialog
// (from the widget and from the Kalender's day header), an absence day that is no gap in the
// week proposal, deadlines with countdowns, the next meeting with join and the following one,
// and team availability from two shared Outlook calendars (one free/busy only). Light and dark.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { launch, guarded } from "../lib/harness.js";
import { isoDay, enableTeamCalendars, writeWorkFixtures } from "../lib/work-fixtures.js";

const test = guarded(nodeTest, () => app);
let app;
let fx;
// Whether today is a public holiday in Bavaria (then the run goes on without a state, so
// today keeps its target and the absence flow works on any date).
let holidayToday = false;

const W = (id, x, y, w, h, config = {}) => ({ id, kind: id, x, y, w, h, config });
const today = isoDay(new Date());
const inDays = (n) => isoDay(new Date(Date.now() + n * 86_400_000));
const monday = (offsetWeeks) => {
  const d = new Date();
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + offsetWeeks * 7);
  return isoDay(d);
};

before(async () => {
  fx = writeWorkFixtures();
  app = await launch({ env: fx.env });
  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", {
    settings: {
      ...view.settings,
      // Every day a workday, so "today" has a target whatever weekday the run falls on.
      workdays: [1, 2, 3, 4, 5, 6, 7],
      time: { ...view.settings.time, balance: { weekday_hours: [8, 8, 8, 8, 8, 8, 8], start: monday(-3), opening_hours: 12.5, vacation_days: 30, carry_over: 2, state: "BY" } },
    },
  });
  await enableTeamCalendars(app);
  // A task due in two days and one overdue.
  await app.invoke("page_create", { parentId: null, title: "Release-Plan", icon: null, content: `# Release-Plan\n\n- [ ] Changelog schreiben due:${inDays(2)} !!\n- [ ] Lizenzen prüfen due:${inDays(-3)}\n` });
  await app.invoke("dashboard_save", {
    dashboard: {
      version: 2,
      active: "arbeit",
      notes: {},
      boards: [
        {
          id: "arbeit",
          name: "Arbeit",
          widgets: [W("balance", 0, 0, 4, 7), W("vacation", 4, 0, 4, 7), W("next_meeting", 8, 0, 4, 7), W("deadlines", 0, 7, 6, 8, { days: 14 }), W("team", 6, 7, 6, 8)],
        },
      ],
    },
  });
  await app.keys(["Control", "t"]);
  await app.browser.execute(() => location.reload());
  await app.browser.pause(300);
  await app.browser.waitUntil(() => app.browser.execute(() => document.body.classList.contains("ready")), { timeout: 20000, timeoutMsg: "not ready" });
  await app.waitText('.pane.active [data-widget="vacation"] .wv-holiday', /\S/, 15000);
  holidayToday = /Heute/.test(await app.text('.pane.active [data-widget="vacation"] .wv-holiday'));
  if (holidayToday) {
    const v = await app.invoke("settings_get");
    await app.invoke("settings_save", { settings: { ...v.settings, time: { ...v.settings.time, balance: { ...v.settings.time.balance, state: "" } } } });
    await app.browser.execute(() => location.reload());
    await app.browser.pause(300);
    await app.browser.waitUntil(() => app.browser.execute(() => document.body.classList.contains("ready")), { timeout: 20000, timeoutMsg: "not ready" });
  }
});
after(async () => {
  await app?.close();
  if (fx) fs.rmSync(fx.dir, { recursive: true, force: true });
});

const setTheme = async (theme) => {
  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", { settings: { ...view.settings, theme } });
  await app.browser.execute((t) => (document.documentElement.dataset.theme = t), theme);
};

test("balance and vacation: hours and days in German notation", async () => {
  await app.waitFor('.pane.active [data-widget="balance"] .wb-value', 15000);
  const value = await app.text('.pane.active [data-widget="balance"] .wb-value');
  assert.match(value, /^[+−±]\d+(\.\d{3})*,\d\d h$/, `balance „${value}“`);
  assert.match(await app.text('.pane.active [data-widget="balance"] .wb-foot'), /Seit \d\d\.\d\d\.\d{4}/);
  assert.match(await app.text('.pane.active [data-widget="balance"] .wb-today'), /Heute[\s\S]*von 8,00 h/);
  // 30 days plus 2 carried over; the next holiday in Bavaria.
  await app.waitText('.pane.active [data-widget="vacation"] .wv-dl', /Anspruch \d{4}\s*32/);
  assert.match(await app.text('.pane.active [data-widget="vacation"] .wv-holiday'), /\S+/);
  if (!holidayToday) assert.ok(!(await app.text('.pane.active [data-widget="vacation"] .wv-holiday')).includes("Bundesland"), "a state is chosen");
});

test("the absence dialog enters vacation for today; the Kalender's day header shows and removes it", async () => {
  const takenBefore = await app.browser.execute(() => document.querySelector('.pane.active [data-widget="vacation"] .wv-dl dd')?.textContent);
  await app.click('.pane.active [data-widget="balance"] .wb-absence');
  await app.waitFor(".dialog .wa-kinds");
  assert.equal(await app.browser.execute(() => document.querySelector('.wa-kind[aria-checked="true"]')?.dataset.kind), "vacation");
  await app.click('.wa-kind[data-kind="sick"]');
  await app.waitText(".wa-kind-hint", /Kein Soll/);
  await app.click('.wa-kind[data-kind="vacation"]');
  await app.browser.execute(() => document.querySelector(".wa-half .switch")?.click());
  await app.shot("108-absence-dialog");
  await app.click(".dialog .wa-save");
  await app.browser.waitUntil(async () => !(await (await app.$(".dialog .wa-kinds")).isExisting()), { timeoutMsg: "dialog stays open" });
  const abs = await app.invoke("absence_list", { from: today, to: today });
  assert.deepEqual(abs.absences.map((a) => [a.date, a.kind, a.half]), [[today, "vacation", true]]);
  // The vacation widget reloads: half a day taken.
  await app.browser.waitUntil(async () => (await app.browser.execute(() => document.querySelector('.pane.active [data-widget="vacation"] .wv-dl dd')?.textContent)) !== takenBefore, { timeout: 8000, timeoutMsg: `taken stays ${takenBefore}` });
  assert.match(await app.text('.pane.active [data-widget="vacation"] .wv-list'), /Urlaub/);

  // The Kalender: today's header carries the absence; it opens the dialog to remove it.
  await app.keys(["Control", "Shift", "e"]);
  // Today's day view: a seven-day week in a narrow pane hides the header chips.
  await app.click(`.pane.active .calv-dayhead[data-date="${today}"] .calv-dayhead-date`);
  await app.waitText(`.pane.active .calv-dayhead[data-date="${today}"] .wa-chip.set`, /Urlaub \(halb\)/, 10000);
  await app.shot("108-calendar-absence");
  await app.click(`.pane.active .calv-dayhead[data-date="${today}"] .wa-chip.set`);
  await app.waitFor(".dialog .wa-remove");
  await app.click(".dialog .wa-remove");
  await app.browser.waitUntil(async () => !(await (await app.$(`.pane.active .calv-dayhead[data-date="${today}"] .wa-chip.set`)).isExisting()), { timeout: 8000, timeoutMsg: "chip stays" });
  // A day without an absence offers entering one from the header.
  await app.click(`.pane.active .calv-dayhead[data-date="${today}"] .wa-chip`);
  await app.waitFor(".dialog .wa-kinds");
  await app.keys(["Escape"]);
  await app.click(".pane.active .tab.active .tab-close");
});

test("an absence day is no gap in the week proposal", async () => {
  const proposal = async () => {
    const r = await app.invoke("dashboard_data", { request: { today, parts: [{ key: "p", part: { kind: "proposal", week_start: monday(-1) } }] } });
    return r.parts.p.open_days.map((d) => d.date);
  };
  const open = await proposal();
  assert.ok(open.length > 0, "last week has a day below the target in the demo");
  await app.invoke("absence_save", { from: open[0], to: open[0], kind: "sick", half: false, note: "" });
  assert.ok(!(await proposal()).includes(open[0]), "the sick day is no gap");
  await app.invoke("absence_remove", { from: open[0], to: open[0] });
  assert.ok((await proposal()).includes(open[0]));
});

test("deadlines: overdue first, countdowns, a click opens the page", async () => {
  await app.waitText('.pane.active [data-widget="deadlines"] .wd-list', /Changelog schreiben/, 10000);
  const rows = await app.browser.execute(() => [...document.querySelectorAll('.pane.active [data-widget="deadlines"] .wd-row')].map((r) => `${r.querySelector(".wd-title").textContent}|${r.querySelector(".wd-count").textContent}|${r.className}`));
  const lic = rows.findIndex((r) => r.startsWith("Lizenzen prüfen"));
  const cl = rows.findIndex((r) => r.startsWith("Changelog schreiben"));
  assert.ok(lic >= 0 && cl > lic, `order: ${rows.join(" / ")}`);
  assert.match(rows[lic], /seit 3 Tagen überfällig\|.*tone-overdue/);
  assert.match(rows[cl], /in 2 Tagen\|.*tone-soon/);
  assert.match(await app.text('.pane.active [data-widget="deadlines"] .badge'), /überfällig/);
  // The horizon: 1 day leaves the task in two days out.
  const d = (await app.invoke("settings_get")).settings.dashboard;
  d.boards[0].widgets = d.boards[0].widgets.map((w) => (w.id === "deadlines" ? { ...w, config: { days: 1 } } : w));
  await app.invoke("dashboard_save", { dashboard: d });
  await app.browser.execute(() => location.reload());
  await app.browser.waitUntil(() => app.browser.execute(() => document.body.classList.contains("ready")), { timeout: 20000 });
  await app.waitText('.pane.active [data-widget="deadlines"] .wd-list', /Lizenzen prüfen/, 10000);
  assert.ok(!(await app.text('.pane.active [data-widget="deadlines"] .wd-list')).includes("Changelog"));
  d.boards[0].widgets = d.boards[0].widgets.map((w) => (w.id === "deadlines" ? { ...w, config: { days: 14 } } : w));
  await app.invoke("dashboard_save", { dashboard: d });
  await app.browser.execute(() => location.reload());
  await app.browser.waitUntil(() => app.browser.execute(() => document.body.classList.contains("ready")), { timeout: 20000 });
});

test("next meeting: countdown ticks, join, location and the meeting after it", async () => {
  await app.waitText('.pane.active [data-widget="next_meeting"] .wn-title', /Kundentermin Portal/, 15000);
  assert.match(await app.text('.pane.active [data-widget="next_meeting"] .wn-loc'), /Raum Zürich/);
  const c1 = await app.text('.pane.active [data-widget="next_meeting"] .wn-clock');
  assert.match(c1, /^\d+:\d\d$/);
  await app.browser.pause(1500);
  assert.notEqual(await app.text('.pane.active [data-widget="next_meeting"] .wn-clock'), c1, "the countdown runs");
  assert.match(await app.text('.pane.active [data-widget="next_meeting"] .wn-actions'), /Beitreten[\s\S]*Besprechungsnotiz/);
  assert.match(await app.text('.pane.active [data-widget="next_meeting"] .wn-then'), /Danach[\s\S]*Abstimmung Rollout/);
});

test("team: Anna busy in a meeting, Jörg out of office (free/busy only, no subject)", async () => {
  await app.waitFor('.pane.active [data-widget="team"] .wt-row', 15000);
  const rows = await app.browser.execute(() => [...document.querySelectorAll('.pane.active [data-widget="team"] .wt-row')].map((r) => `${r.querySelector(".wt-name").textContent}|${r.querySelector(".wt-main .faint").textContent}|${r.querySelector(".wt-until").textContent}`));
  assert.equal(rows.length, 2, rows.join(" / "));
  assert.match(rows[0], /^Jörg Weiß\|Abwesend\|bis /);
  assert.match(rows[1], /^Anna Müller\|Beschäftigt · Vertriebsrunde\|bis \d\d:\d\d$/);
  // The widget's settings pick one person.
  const d = (await app.invoke("settings_get")).settings.dashboard;
  const anna = (await app.invoke("settings_get")).settings.calendar.outlook_calendars.find((c) => c.owner === "Anna Müller").id;
  d.boards[0].widgets = d.boards[0].widgets.map((w) => (w.id === "team" ? { ...w, config: { sources: [anna] } } : w));
  await app.invoke("dashboard_save", { dashboard: d });
  await app.browser.execute(() => location.reload());
  await app.browser.waitUntil(() => app.browser.execute(() => document.body.classList.contains("ready")), { timeout: 20000 });
  await app.waitText('.pane.active [data-widget="team"] .wt-list', /Anna Müller/, 15000);
  assert.ok(!(await app.text('.pane.active [data-widget="team"] .wt-list')).includes("Jörg"));
});

test("screenshots light and dark", async () => {
  for (const theme of ["light", "dark"]) {
    await setTheme(theme);
    await app.browser.pause(400);
    await app.shot(`108-work-${theme}`);
  }
});

test("time tracking off hides balance and vacation and leaves no hole", async () => {
  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", { settings: { ...view.settings, time: { ...view.settings.time, enabled: false } } });
  await app.browser.waitUntil(async () => !(await (await app.$('.pane.active [data-widget="balance"]')).isExisting()), { timeout: 8000, timeoutMsg: "balance still shown" });
  assert.ok(!(await (await app.$('.pane.active [data-widget="vacation"]')).isExisting()));
  assert.ok(await (await app.$('.pane.active [data-widget="next_meeting"]')).isExisting());
  const v2 = await app.invoke("settings_get");
  await app.invoke("settings_save", { settings: { ...v2.settings, time: { ...v2.settings.time, enabled: true } } });
  await app.waitFor('.pane.active [data-widget="balance"] .wb-value', 10000);
});
