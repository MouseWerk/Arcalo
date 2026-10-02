// Upgrade to calendar selection: a data folder of 1.5 (settings without the list of Outlook
// calendars, only the switch and the color of the default calendar) with a booked meeting, a
// meeting note and a „nicht buchen“ mark. After the upgrade the default calendar keeps the
// source id `outlook`, its color and every mark and WBS memory, also after syncing again next
// to newly selected calendars.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launch, guarded } from "../lib/harness.js";
import { outlookCalendarsJson, outlookEnv, outlookJson } from "../lib/calendar-fixtures.js";

const test = guarded(nodeTest, () => app);
let app;
let dir;
let dataDir;
const keys = {};

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "annalo-olmig-"));
  dataDir = path.join(dir, "data");
  fs.mkdirSync(dataDir);
  fs.writeFileSync(path.join(dir, "old.json"), outlookJson());
  fs.writeFileSync(path.join(dir, "new.json"), outlookCalendarsJson());
});
after(async () => {
  await app?.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const range = () => ({ from: new Date(Date.now() - 20 * 86400e3).toISOString(), to: new Date(Date.now() + 20 * 86400e3).toISOString() });
const byTitle = async (title) => (await app.invoke("calendar_events", range())).find((e) => e.title === title);

test("1.5: the default calendar is booked, noted and marked", async () => {
  app = await launch({ dataDir, env: outlookEnv(path.join(dir, "old.json")) });
  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", { settings: { ...view.settings, calendar: { ...view.settings.calendar, outlook: true, outlook_color: "#db2777" } } });
  await app.invoke("calendar_sync_now", { source: "outlook" });
  const kunde = await byTitle("Kundentermin Müller");
  const standup = await byTitle("Daily Standup");
  assert.equal(kunde.source, "outlook");
  keys.kunde = kunde.key;
  keys.standup = standup.key;
  const logged = await app.invoke("log_time", { line: "/zeit NP-8801/1020 1h Kundentermin Müller" });
  keys.entry = logged.entry.id;
  await app.invoke("calendar_link_entry", { key: kunde.key, entryId: logged.entry.id });
  keys.note = (await app.invoke("calendar_meeting_note", { key: kunde.key })).page.id;
  await app.invoke("calendar_set_skip", { key: standup.key, skip: true });
  await app.close();
  app = null;

  // What 1.5 stored: no list of Outlook calendars and no settings version (1.10 added it).
  const db = new DatabaseSync(path.join(dataDir, "workspace.db"));
  const row = db.prepare("SELECT value FROM settings WHERE key = 'app'").get();
  const settings = JSON.parse(row.value);
  delete settings.calendar.outlook_calendars;
  delete settings.calendar.outlook_recipients;
  delete settings.version;
  db.prepare("UPDATE settings SET value = ? WHERE key = 'app'").run(JSON.stringify(settings));
  db.close();
});

test("after the upgrade the default calendar keeps its id, color, marks and WBS memory", async () => {
  app = await launch({ dataDir, env: outlookEnv(path.join(dir, "new.json")) });
  const cal = (await app.invoke("settings_get")).settings.calendar;
  assert.equal(cal.outlook_calendars.length, 1);
  const def = cal.outlook_calendars[0];
  assert.deepEqual([def.id, def.default, def.enabled, def.booking, def.color], ["outlook", true, true, true, "#db2777"]);
  assert.deepEqual((await app.invoke("calendar_status")).sources.filter((s) => s.kind === "outlook").map((s) => s.id), ["outlook"]);

  const check = async () => {
    const kunde = await byTitle("Kundentermin Müller");
    assert.equal(kunde.key, keys.kunde, "same key");
    assert.equal(kunde.entry_id, keys.entry, "booked");
    assert.equal(kunde.note_page_id, keys.note, "meeting note");
    assert.equal((await byTitle("Daily Standup")).skip, true, "nicht buchen");
    const hint = await app.invoke("calendar_wbs_hint", { key: keys.kunde });
    assert.equal(hint?.reference, "NP-8801/1020", "WBS memory");
  };
  await check();
  await app.invoke("calendar_sync_now", { source: null });
  await check();

  // Two more calendars next to it: the default calendar's marks stay, and so does its color.
  const st = await app.invoke("calendar_outlook_discover");
  const proj = st.outlook_calendars.find((r) => r.name === "Projekt X");
  const anna = st.outlook_calendars.find((r) => r.owner === "Anna Müller");
  assert.equal(st.outlook_calendars.find((r) => r.default).id, "outlook", "discovery finds the default calendar under its old id");
  await app.invoke("calendar_outlook_update", { id: proj.id, enabled: true, color: null, booking: null });
  await app.invoke("calendar_outlook_update", { id: anna.id, enabled: true, color: null, booking: null });
  await app.invoke("calendar_sync_now", { source: "outlook:*" });
  await check();
  const after = (await app.invoke("settings_get")).settings.calendar;
  assert.equal(after.outlook_color, "#db2777");
  assert.deepEqual(after.outlook_calendars.map((c) => c.id), ["outlook", proj.id, anna.id]);

  // In the Kalender view: the booked meeting in the old color, the legend with all three.
  await app.click(".ribbon-calendar-view");
  await app.waitFor(".calv-legend");
  const legend = await app.browser.execute(() => [...document.querySelectorAll(".calv-legend-item")].map((b) => b.textContent));
  assert.deepEqual(legend, ["Outlook", "Projekt X", "Anna Müller – Kalender"]);
  await app.waitText(".calv-ev .calv-ev-title", /^Kundentermin Müller$/);
  const kunde = await app.browser.execute(() => {
    const b = [...document.querySelectorAll(".calv-ev")].find((x) => x.querySelector(".calv-ev-title")?.textContent === "Kundentermin Müller");
    return { booked: b.classList.contains("booked"), color: b.style.getPropertyValue("--ev") };
  });
  assert.deepEqual(kunde, { booked: true, color: "#db2777" });
  await app.shot("85-migrated-calendar");
});
