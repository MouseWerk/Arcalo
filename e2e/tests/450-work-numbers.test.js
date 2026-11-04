// q124 hunt H3, work features: a /zeit time span over a clock change books the real length, the
// month calendar compares each day with its own target (no red vacation day, a short Friday met),
// and a monthly task from the 31st ticked off in the editor keeps its day (German time; the app
// and this file run in Europe/Berlin).
process.env.TZ = "Europe/Berlin";

import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
let np;
const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const monday = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
const lastWeek = monday(new Date(Date.now() - 7 * 86400000));
const day = (i) => new Date(lastWeek.getFullYear(), lastWeek.getMonth(), lastWeek.getDate() + i);
const until = (f, msg) => app.browser.waitUntil(f, { timeout: 8000, timeoutMsg: msg });

async function patchSettings(f) {
  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", { settings: f(structuredClone(view.settings)) });
  await app.browser.pause(300);
}

const book = (d, hour, minutes) =>
  app.invoke("time_entry_create", { netzplanId: np.id, vorgangNr: "10", leistungsart: null, startTime: new Date(d.getTime() + hour * 3600000).toISOString(), durationMinutes: minutes, description: "Arbeit" });

before(async () => {
  app = await launch({ demo: false, env: { TZ: "Europe/Berlin" } });
  const p = await app.invoke("project_create", { code: "PRJ-450", name: "Zahlen" });
  np = await app.invoke("netzplan_create", { projectId: p.id, netzplanNr: "NP-4500", wbsElement: "NP-4500-1", description: "Betrieb", plannedHours: 200 });
  await app.invoke("vorgang_create", { netzplanId: np.id, vorgangNr: "10", description: "Wartung", durationDays: 1, plannedHours: 100, predecessors: [] });
  // Own targets (Friday 5 h), no public holidays; Monday of last week is a vacation day.
  await patchSettings((s) => {
    s.time.balance.state = "";
    s.time.balance.weekday_hours = [8, 8, 8, 8, 5, 0, 0];
    return s;
  });
  await app.invoke("absence_save", { from: iso(day(0)), to: iso(day(0)), kind: "vacation", half: false, note: "" });
  // Tuesday 2 h (below 8 h), Wednesday 8 h, Friday 5 h (its own target).
  await book(day(1), 9, 120);
  await book(day(2), 8, 480);
  await book(day(4), 8, 300);
});
after(async () => app?.close());

test("a /zeit time span over a clock change books the hours the clock really ran", async () => {
  // 25 October 2026: 03:00 summer time becomes 02:00 winter time; 01:00–04:00 is four hours.
  let out = await app.invoke("log_time", { line: "/zeit NP-4500/10 01:00-04:00 Migration @2026-10-25", pageId: null });
  assert.equal(out.entry.duration_minutes, 240);
  assert.equal(new Date(out.entry.start_time).toISOString(), "2026-10-24T23:00:00.000Z");
  assert.equal(new Date(out.entry.end_time).toISOString(), "2026-10-25T03:00:00.000Z");
  // 29 March 2026: 02:00 becomes 03:00; 01:00–04:00 is two hours.
  out = await app.invoke("log_time", { line: "/zeit NP-4500/10 01:00-04:00 Wartung @2026-03-29", pageId: null });
  assert.equal(out.entry.duration_minutes, 120);
  // The same span on an ordinary day.
  out = await app.invoke("log_time", { line: "/zeit NP-4500/10 01:00-04:00 Wartung @2026-03-22", pageId: null });
  assert.equal(out.entry.duration_minutes, 180);
});

test("the month calendar compares each day with its own target", async () => {
  const days = await app.invoke("daily_overview", { from: iso(day(0)), to: iso(day(6)) });
  assert.deepEqual(
    days.map((d) => [d.booked_minutes, d.target_minutes]),
    [
      [0, 0],
      [120, 480],
      [480, 480],
      [0, 480],
      [300, 300],
      [0, 0],
      [0, 0],
    ],
  );
  await app.keys(["Control", "k"]);
  await app.waitFor(".palette");
  await app.type("Tagesnotiz eines Tages");
  await app.waitText(".pal-item.sel", /Tagesnotiz eines Tages öffnen/);
  await app.keys(["Enter"]);
  await app.waitFor(".calendar");
  // Last week can lie before the month shown.
  if (!(await (await app.$(`.cal-day[data-date="${iso(day(0))}"]`)).isExisting())) await app.click('.calendar [aria-label^="Vorheriger Monat"]');
  await app.waitFor(`.cal-day[data-date="${iso(day(0))}"]`);
  const tones = await app.browser.execute(
    (dates) => dates.map((d) => [...document.querySelector(`.cal-day[data-date="${d}"]`).classList].filter((c) => c.startsWith("tone-")).join(" ")),
    [0, 1, 2, 3, 4].map((i) => iso(day(i))),
  );
  // Vacation: nothing missing; Tuesday 2 of 8 h; Wednesday met; Thursday nothing booked; Friday 5 of 5 h.
  assert.deepEqual(tones, ["", "tone-below", "tone-met", "tone-below", "tone-met"]);
  await app.shot("450-calendar-targets");
  await app.keys(["Escape"]);
});

test("a monthly task from the 31st ticked off in the editor keeps its day", async () => {
  const page = await app.invoke("page_create", { parentId: null, title: "Monatlich", icon: null, content: "- [ ] Miete zahlen every:monthly due:2026-01-31\n" });
  const content = async () => (await app.invoke("page_get", { id: page.id })).content;
  // The first month's end (or 31st) after today.
  const today = iso(new Date());
  let next = "";
  for (let m = 1; !next || next <= today; m++) next = iso(new Date(2026, m, Math.min(31, new Date(2026, m + 1, 0).getDate())));
  await app.keys(["Control", "Shift", "a"]);
  const row = `.tasks-view .task-row[data-page="${page.id}"][data-ordinal="0"]`;
  await app.waitFor(row);
  await app.click(`${row} .task-page`);
  await app.waitText(".pane.active .tab.active .tab-title", /Monatlich/);
  await app.waitFor(".pane.active > .pane-content:not([hidden]) .ProseMirror li[data-checked]");
  await app.browser.execute(() => document.querySelector(".pane.active > .pane-content:not([hidden]) .ProseMirror li[data-checked] input[type=checkbox]").click());
  await until(async () => (await content()).includes("- [x] Miete zahlen every:monthly due:2026-01-31\n- [ ] Miete zahlen"), "editor did not add the next occurrence");
  assert.equal(await content(), `- [x] Miete zahlen every:monthly due:2026-01-31\n- [ ] Miete zahlen every:monthly,31 due:${next}\n`);
});
