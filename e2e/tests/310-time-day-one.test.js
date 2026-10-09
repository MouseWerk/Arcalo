// 1.16: a new workspace does not count the days before its setup as missing time, in every view
// alike (one rule in the core, `worktime::DayTargets`): the timesheet, the start page's week, the
// week review and the week proposal. The previous week (before the setup) has no gaps; the same
// week counts in a workspace from before the setup existed. German time.
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

before(async () => {
  app = await launch({ demo: false, env: { TZ: "Europe/Berlin" } });
  // No state: no public holiday changes the targets.
  const view = await app.invoke("settings_get");
  const s = structuredClone(view.settings);
  s.time.balance.state = "";
  await app.invoke("settings_save", { settings: s });
});
after(async () => app?.close());

const targets = () => app.invoke("day_targets", { from: iso(day(0)), to: iso(day(6)) });

test("before the setup is finished every past workday has its target", async () => {
  assert.deepEqual(await targets(), [480, 480, 480, 480, 480, 0, 0]);
  const w = await app.invoke("week_review", { date: iso(day(2)) });
  assert.equal(w.time.missing_minutes, 5 * 480);
});

test("after the setup of a new workspace, the week before is no gap anywhere", async () => {
  await app.invoke("onboarding_complete");
  assert.deepEqual(await targets(), [0, 0, 0, 0, 0, 0, 0]);
  // Week review and week proposal: nothing missing.
  const w = await app.invoke("week_review", { date: iso(day(2)) });
  assert.equal(w.time.missing_minutes, 0);
  assert.ok(w.days.every((d) => d.missing_minutes === 0), JSON.stringify(w.days.map((d) => d.missing_minutes)));
  // The workdays before the setup are no days off: „vor der Einrichtung“, not „kein Arbeitstag“.
  assert.deepEqual(w.days.map((d) => !!d.before_setup), [true, true, true, true, true, false, false]);
  const data = await app.invoke("dashboard_data", { request: { today: iso(new Date()), parts: [{ key: "p", part: { kind: "proposal", week_start: iso(day(0)) } }, { key: "w", part: { kind: "week", week_start: iso(day(0)) } }] } });
  assert.deepEqual(data.parts.p.open_days, []);
  const week = data.parts.w;
  assert.deepEqual(week.days.map((d) => d.target_minutes), [0, 0, 0, 0, 0, 0, 0]);

  // The timesheet of last week: no „Unter Soll“ row.
  await app.click('.ribbon [aria-label^="Zeiterfassung"]');
  await app.waitText(".view-header h1", /Zeiterfassung/);
  await app.click('[aria-label="Vorherige Woche"]');
  await app.waitText(".stat-note", /^Soll 0,00 h$/);
  assert.equal(await app.browser.execute(() => !!document.querySelector(".week-gaps")), false);
  await app.shot("310-timesheet-day-one");
});
