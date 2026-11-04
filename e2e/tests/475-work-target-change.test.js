// q124 round 2, work features: a change of the daily target counts from its day on; the days
// before keep the target they had, so the balance of past weeks does not change. Settings →
// Zeiterfassung names the earlier target and can apply the new one to every day.
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
const yesterday = () => {
  const d = new Date();
  return iso(new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1));
};

async function patchSettings(f) {
  const view = await app.invoke("settings_get");
  const out = await app.invoke("settings_save", { settings: f(structuredClone(view.settings)) });
  await app.browser.pause(300);
  return out.settings;
}

before(async () => {
  app = await launch({ demo: false, env: { TZ: "Europe/Berlin" } });
  await patchSettings((s) => {
    s.time.balance.state = "";
    s.time.balance.weekday_hours = [];
    s.workdays = [1, 2, 3, 4, 5];
    s.daily_target_hours = 8;
    return s;
  });
});
after(async () => app?.close());

test("a new daily target counts from today; last week keeps its 8 hours", async () => {
  const lastWeekTargets = () => app.invoke("day_targets", { from: iso(day(0)), to: iso(day(6)) });
  assert.deepEqual(await lastWeekTargets(), [480, 480, 480, 480, 480, 0, 0]);
  const saved = await patchSettings((s) => {
    s.daily_target_hours = 6;
    return s;
  });
  assert.deepEqual(saved.time.balance.target_history, [{ until: yesterday(), minutes: [480, 480, 480, 480, 480, 0, 0] }]);
  assert.deepEqual(await lastWeekTargets(), [480, 480, 480, 480, 480, 0, 0], "last week keeps its target");
  const next = monday(new Date(Date.now() + 7 * 86400000));
  const nextWeek = await app.invoke("day_targets", { from: iso(next), to: iso(new Date(next.getFullYear(), next.getMonth(), next.getDate() + 6)) });
  assert.deepEqual(nextWeek, [360, 360, 360, 360, 360, 0, 0]);
  // A settings draft that still carries the history cannot add to it; a second change today
  // keeps the target of before the first.
  const again = await patchSettings((s) => {
    s.daily_target_hours = 7;
    s.time.balance.target_history.push({ until: "2099-01-01", minutes: [0, 0, 0, 0, 0, 0, 0] });
    return s;
  });
  assert.deepEqual(again.time.balance.target_history, saved.time.balance.target_history);
});

test("Settings → Zeiterfassung names the earlier target and applies the new one to all days", async () => {
  await app.keys(["Control", ","]);
  await app.click('.settings-nav-item[data-section="time"]');
  await app.waitText(".set-row", /Früheres Soll/);
  let row = null;
  for (const r of await app.$$(".set-row")) if (/Früheres Soll/.test(await app.textOf(r))) row = r;
  assert.ok(row, "the row of the earlier target");
  assert.match(await app.textOf(row), /galten 40,00 h pro Woche/);
  await app.shot("earlier-target");
  await (await row.$("button")).click();
  await app.browser.waitUntil(async () => !(await app.invoke("settings_get")).settings.time.balance.target_history.length, {
    timeout: 8000,
    timeoutMsg: "the history was not cleared",
  });
  assert.deepEqual(await app.invoke("day_targets", { from: iso(day(0)), to: iso(day(6)) }), [420, 420, 420, 420, 420, 0, 0]);
});
