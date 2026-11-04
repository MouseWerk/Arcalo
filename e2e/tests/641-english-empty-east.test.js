// An empty workspace (no demo) in English with British dates, weeks from Sunday, hours as clock
// time, a 15-minute rounding and workdays Sunday to Thursday, in the time zone farthest east of
// UTC (Pacific/Kiritimati, UTC+14: the local day is mostly a day ahead of UTC's). Every main view
// opens without German words, and a booking lands on the local day with the rounding applied.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { guarded } from "../lib/harness.js";
import { launchEnglish, germanLeftovers } from "../lib/english.js";
import { iso } from "../lib/calendar-fixtures.js";

process.env.TZ = "Pacific/Kiritimati";

const test = guarded(nodeTest, () => app);
let app, dataDir;
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
  ({ app, dataDir } = await launchEnglish({ demo: false }));
  await patchSettings((s) => ({
    ...s,
    workdays: [7, 1, 2, 3, 4],
    locale: { ...s.locale, date_format: "en-gb" },
    time: { ...s.time, week_start: "sunday", hours_display: "clock", rounding: { step_minutes: 15, mode: "up", min_minutes: 0 } },
  }));
  await reload();
});
after(async () => {
  await app?.close();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

const found = [];
async function check(name) {
  await app.browser.pause(500);
  await app.shot(`641-${name}`);
  for (const h of await germanLeftovers(app)) found.push(`${name}: ${h}`);
}
async function ribbon(label) {
  await app.dismissToasts();
  await app.click(`.ribbon [aria-label^="${label}"]`);
  await app.browser.pause(700);
}

test("the app runs at UTC+14 on an empty workspace", async () => {
  assert.equal(await app.browser.execute(() => new Date().getTimezoneOffset()), -840);
});

test("a booking lands on the local day, rounded to 15 minutes", async () => {
  // A network that does not exist yet: refused in English.
  const refused = await app.invoke("log_time", { line: "/time NP-1/10 7m Review" }).then(
    () => "",
    (e) => String(e?.message ?? e),
  );
  assert.ok(refused, "refused");
  assert.doesNotMatch(refused, /[äöüß]|nicht|Netzplan/, refused);
  const p = await app.invoke("project_create", { code: "PRJ-1", name: "Rollout" });
  await app.invoke("netzplan_create", { projectId: p.id, netzplanNr: "NP-1", wbsElement: "NP-1-1", description: "Rollout", plannedHours: 40 });
  const out = await app.invoke("log_time", { line: "/time NP-1 7m Review" });
  const entry = out.entry ?? out;
  assert.equal(entry.duration_minutes, 15);
  assert.equal(iso(new Date(entry.start_time)), iso(new Date()));
});

test("the main views are English", async () => {
  await check("start");
  await ribbon("Today's daily note");
  await app.waitFor(`${pane} .ProseMirror`);
  await check("daily");
  await ribbon("Calendar: meetings");
  await check("calendar");
  await ribbon("Time tracking");
  await check("timesheet");
  await ribbon("Tasks");
  await check("tasks");
  await ribbon("Projects");
  await check("projects");
  await ribbon("Daily review");
  await check("review");
  assert.deepEqual(found, []);
});
