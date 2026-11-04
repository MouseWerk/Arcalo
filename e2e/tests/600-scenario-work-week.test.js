// q124 round 3, scenarios: one work week of a consultant played through in the real app (German
// time, Europe/Berlin). Last week's daily notes are written on its days' notes, time is booked with
// `/zeit` in them, meetings come from an ICS file with a prep page and a meeting note, tasks are
// written in the notes, ticked off and repeated, the timer runs; on Friday the week review, the
// timesheet, the start page's numbers, the CSV, SAP CATS and the Jira worklogs must all say the
// same as what was booked.
process.env.TZ = "Europe/Berlin";

import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, guarded, EDITOR } from "../lib/harness.js";
import { startFakeJira } from "../lib/fake-jira.js";

const test = guarded(nodeTest, () => app);
let app, jira, dir, np;
const PANE = ".pane.active > .pane-content:not([hidden])";
const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const de = (d) => `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
const mondayOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
// The week played through: last week, Monday to Friday.
const monday = mondayOf(new Date(Date.now() - 7 * 86400000));
const day = (i, h = 0, m = 0) => new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i, h, m);
const icsLocal = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`;
const until = (f, msg, timeout = 10000) => app.browser.waitUntil(f, { timeout, timeoutMsg: msg });
const site = (p = {}) => ({ id: "acme", name: "Acme", color: "", kind: "cloud", url: jira.url, email: "mia@firma.de", enabled: true, log_work: true, allow_writes: false, ...p });

async function patchSettings(f) {
  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", { settings: f(structuredClone(view.settings)) });
  await app.browser.pause(300);
}
const weekEntries = () => app.invoke("time_entries", { from: day(0).toISOString(), to: day(7).toISOString() });

async function openPage(id) {
  const { title } = await app.invoke("page_get", { id });
  await app.invoke("search_open", { target: { kind: "page", page_id: id, new_tab: false } });
  await until(() => app.browser.execute((p, ed, t) => !!document.querySelector(`${p} ${ed}`) && document.querySelector(`${p} .page-title`)?.value === t, PANE, EDITOR, title), `page ${title} not open`);
  await app.waitFor(`${PANE} ${EDITOR}`);
  await app.browser.pause(300);
}

/** Types a line at the end of the open note and presses Enter (a `/zeit` line books then). */
async function typeLine(text) {
  await app.caretToEnd();
  await app.keys(["Enter"]);
  await app.type(text);
  await app.keys(["Escape"]);
  await app.keys(["Enter"]);
}

/** The ICS calendar of the week: a daily stand-up and the sprint review on Wednesday. */
function writeCalendar() {
  const jf = day(0, 9, 30);
  const review = day(2, 14);
  const text = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Arcalo e2e//DE",
    "BEGIN:VEVENT",
    "UID:standup-600@e2e",
    `DTSTART:${icsLocal(jf)}`,
    `DTEND:${icsLocal(new Date(jf.getTime() + 15 * 60e3))}`,
    "RRULE:FREQ=DAILY;COUNT=5",
    "SUMMARY:Stand-up Portal",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:review-600@e2e",
    `DTSTART:${icsLocal(review)}`,
    `DTEND:${icsLocal(new Date(review.getTime() + 60 * 60e3))}`,
    "SUMMARY:Sprint Review Portal",
    "ORGANIZER;CN=Mia Meyer:mailto:mia@firma.de",
    "ATTENDEE;CN=Anna Müller:mailto:anna@example.com",
    "ATTENDEE;CN=Jörg Weiß:mailto:joerg@example.com",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
  const file = path.join(dir, "Arbeit.ics");
  fs.writeFileSync(file, text);
  return file;
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "arcalo-600-"));
  jira = await startFakeJira({ flavor: "cloud" });
  app = await launch({ demo: false, env: { TZ: "Europe/Berlin" } });
  const p = await app.invoke("project_create", { code: "PRJ-600", name: "Portal" });
  np = await app.invoke("netzplan_create", { projectId: p.id, netzplanNr: "NP-6000", wbsElement: "P-6000-01", description: "Portal Rollout", plannedHours: 400 });
  await app.invoke("vorgang_create", { netzplanId: np.id, vorgangNr: "10", description: "Entwicklung", durationDays: 10, plannedHours: 200, predecessors: [] });
  await app.invoke("vorgang_create", { netzplanId: np.id, vorgangNr: "20", description: "Beratung", durationDays: 10, plannedHours: 100, predecessors: [] });
  await patchSettings((s) => {
    s.time.balance.state = "";
    s.time.balance.weekday_hours = [8, 8, 8, 8, 8, 0, 0];
    s.pernr = "4711";
    return s;
  });
  await app.invoke("jira_site_save", { site: site({ id: "" }), token: "secret-token" });
  await app.invoke("jira_sync_now", { site: "acme" });
});
after(async () => {
  await app?.close();
  await jira?.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

const notes = {};

test("Monday to Friday: each day's daily note gets its text, its bookings and its tasks", async () => {
  for (let i = 0; i < 5; i++) {
    const page = await app.invoke("daily_note", { date: iso(day(i)) });
    notes[i] = page.id;
    await openPage(page.id);
    await typeLine(`Tag ${i + 1}: am Portal gearbeitet`);
    // Booked on the day of the note, written later that week.
    // Thursday's work was on a Jira issue: its worklog goes to Jira.
    await typeLine(`/zeit NP-6000/10 6h ${i === 3 ? "PROJ-123 " : ""}Entwicklung Tag ${i + 1} @${de(day(i))}`);
    await app.waitFor(`${PANE} .time-chip`);
  }
  const rows = await weekEntries();
  assert.deepEqual(
    rows.map((r) => [iso(new Date(r.start_time)), r.duration_minutes, r.page_id]).sort(),
    [0, 1, 2, 3, 4].map((i) => [iso(day(i)), 360, notes[i]]).sort(),
  );
});

let review;

test("the week's meetings: the review is prepared, noted and booked from its note", async () => {
  await app.invoke("calendar_source_add", { name: "Arbeit", url: null, path: writeCalendar() });
  await app.invoke("calendar_sync_now", { source: null });
  const events = await app.invoke("calendar_events", { from: day(0).toISOString(), to: day(7).toISOString() });
  assert.deepEqual(
    events.map((e) => [iso(new Date(e.start)), e.title]).sort(),
    [...[0, 1, 2, 3, 4].map((i) => [iso(day(i)), "Stand-up Portal"]), [iso(day(2)), "Sprint Review Portal"]].sort(),
  );
  review = events.find((e) => e.title === "Sprint Review Portal");
  const prep = await app.invoke("meeting_prep", { requestId: "prep-600", key: review.key, ai: false });
  assert.ok(prep.page, JSON.stringify(prep));
  const note = await app.invoke("calendar_meeting_note", { key: review.key });
  assert.equal(note.created, true);
  notes.review = note.page.id;
  await openPage(note.page.id);
  await typeLine(`- [ ] Protokoll an Anna schicken due:${iso(day(4))}`);
  // Out of the list again.
  await app.keys(["Enter"]);
  await typeLine(`/zeit NP-6000/20 1h Sprint Review Portal @${de(day(2))} @14:00`);
  await app.waitFor(`${PANE} .time-chip`);
  const again = await app.invoke("calendar_meeting_note", { key: review.key });
  assert.equal(again.created, false);
  const wed = await app.invoke("week_review", { date: iso(day(2)) });
  const m = wed.meetings.find((x) => x.key === review.key);
  assert.equal(m.state, "booked");
  assert.equal(m.note_page_id, notes.review);
  const tasks = await app.invoke("tasks_list", { filter: { page_id: notes.review } });
  assert.deepEqual(
    tasks.filter((t) => t.text.includes("Protokoll")).map((t) => [t.done, t.due]),
    [[false, iso(day(4))]],
  );
});

test("a weekly task written on Monday is ticked off in the task view and comes back for next week", async () => {
  const id = notes[0];
  const before = await app.invoke("page_get", { id });
  await app.invoke("page_save", { id, content: `${before.content.trimEnd()}\n\n- [ ] Wochenbericht schreiben every:weekly due:${iso(day(4))}\n` });
  await app.keys(["Control", "Shift", "a"]);
  const row = `.tasks-view .task-row[data-page="${id}"]`;
  await app.waitFor(row);
  const ordinal = await app.browser.execute((sel) => [...document.querySelectorAll(sel)].find((r) => r.textContent.includes("Wochenbericht"))?.dataset.ordinal, row);
  assert.ok(ordinal != null, "the task is in the task view");
  await app.browser.execute((sel) => document.querySelector(sel).querySelector("input[type=checkbox], [role=checkbox]").click(), `${row}[data-ordinal="${ordinal}"]`);
  await until(async () => (await app.invoke("page_get", { id })).content.includes("- [x] Wochenbericht schreiben"), "the task was not ticked off");
  const content = (await app.invoke("page_get", { id })).content;
  const next = /- \[x\] Wochenbericht schreiben every:weekly due:(\S+)\n- \[ \] Wochenbericht schreiben every:weekly due:(\S+)/.exec(content);
  assert.ok(next, content);
  assert.equal(next[1], iso(day(4)));
  // The next Friday from today on (the past ones are skipped).
  const due = new Date(`${next[2]}T12:00:00`);
  assert.equal(due.getDay(), 5);
  assert.ok(next[2] >= iso(new Date()) && due.getTime() - Date.now() < 8 * 86400000, next[2]);
  const open = await app.invoke("tasks_list", { filter: { status: "open" } });
  assert.deepEqual(
    open.filter((t) => t.text.startsWith("Wochenbericht")).map((t) => t.due),
    [next[2]],
  );
  // Done this week (today), in this week's review.
  const week = await app.invoke("week_review", { date: iso(new Date()) });
  assert.ok(week.tasks.done.some((t) => t.text.startsWith("Wochenbericht") && t.page_id === id), JSON.stringify(week.tasks.done));
});

test("a /zeit without a date written up later in Tuesday's daily note books on Tuesday", async () => {
  await openPage(notes[1]);
  await typeLine("/zeit NP-6000/20 30m Nachtrag Telefonat");
  await until(async () => (await weekEntries()).some((x) => x.description === "Nachtrag Telefonat"), "not booked on Tuesday's week");
  const r = (await weekEntries()).find((x) => x.description === "Nachtrag Telefonat");
  assert.equal(iso(new Date(r.start_time)), iso(day(1)));
  assert.equal(r.page_id, notes[1]);
  BOOKED[1] += 30;
  // The chip names that day.
  const chip = `<time-entry id="${r.id}" hours="0,50" target="NP-6000/20" date="${iso(day(1))}">Nachtrag Telefonat</time-entry>`;
  await until(async () => (await app.invoke("page_get", { id: notes[1] })).content.includes(chip), "the chip is not saved with the day");
});

// What was booked: 6 h on Vorgang 10 every day, the review's hour on Vorgang 20 on Wednesday.
const BOOKED = [360, 360, 420, 360, 360];

test("Friday: the week review, the calendar, the timesheet, the CSV and SAP CATS say what was booked", async () => {
  const week = await app.invoke("week_review", { date: iso(day(4)) });
  const total = BOOKED.reduce((a, b) => a + b, 0);
  const hours = (m) => (m / 60).toFixed(2).replace(".", ",");
  assert.equal(week.time.booked_minutes, total);
  assert.equal(week.time.target_minutes, 2400);
  assert.deepEqual(
    week.days.slice(0, 5).map((d) => d.booked_minutes),
    BOOKED,
  );
  const overview = await app.invoke("daily_overview", { from: iso(day(0)), to: iso(day(6)) });
  assert.deepEqual(
    overview.map((d) => d.booked_minutes),
    [...BOOKED, 0, 0],
  );

  // The timesheet of last week.
  await app.click('.ribbon [aria-label="Zeiterfassung"]');
  await app.waitText(".view-header h1", /Zeiterfassung/);
  await app.click('.week-nav [aria-label="Vorherige Woche"]');
  await until(async () => (await app.browser.execute(() => document.querySelector(".week-grid tfoot td.strong")?.textContent)) === hours(total), "timesheet total");
  const foot = await app.browser.execute(() => [...document.querySelectorAll(".week-grid tfoot td")].map((t) => t.textContent.trim()));
  assert.deepEqual(foot.slice(0, 5), BOOKED.map(hours));
  await app.shot("600-timesheet-week");

  // CSV and SAP CATS of the week.
  const range = { from: day(0).toISOString(), to: day(7).toISOString(), onlyReleased: false, markExported: false, path: null };
  const csv = (await app.invoke("export_entries", { format: "csv", ...range })).content.trim().split("\r\n").slice(1);
  assert.equal(csv.length, 7, csv.join("\n"));
  assert.equal(csv.reduce((a, l) => a + Number(l.split(",")[8]), 0), total);
  const cats = (await app.invoke("export_entries", { format: "sap_cats", ...range })).content.trim().split("\r\n");
  const head = cats[0].split(";");
  const at = (name) => head.indexOf(name);
  const perDay = {};
  for (const l of cats.slice(1)) {
    const f = l.split(";");
    assert.equal(f[at("PERNR")], "4711");
    perDay[f[at("WORKDATE")]] = (perDay[f[at("WORKDATE")]] ?? 0) + Number(f[at("CATSHOURS")].replace(",", "."));
  }
  const ymd = (d) => iso(d).replaceAll("-", "");
  assert.deepEqual(perDay, Object.fromEntries([0, 1, 2, 3, 4].map((i) => [ymd(day(i)), BOOKED[i] / 60])));
});

test("Friday: Thursday's hours on the Jira issue are in Jira as its worklog", async () => {
  const rows = await weekEntries();
  const thursday = rows.find((r) => iso(new Date(r.start_time)) === iso(day(3)));
  await until(async () => (await app.invoke("jira_entry_issues", { entryIds: [thursday.id] }))[0]?.worklog_state === "posted", "worklog not posted", 20000);
  const logs = jira.worklogs();
  assert.deepEqual(
    logs.map((w) => [w.key, w.timeSpentSeconds, new Date(w.started).toISOString()]),
    [["PROJ-123", 21600, new Date(thursday.start_time).toISOString()]],
  );
});

test("the assistant's tools answer about last week with the booked hours", async () => {
  const tool = (name, args) => app.invoke("ai_run_workspace_tool", { name, arguments: JSON.stringify(args) });
  const summary = JSON.parse(await tool("time_summary", { from: iso(day(0)), to: iso(day(4)) }));
  assert.equal(summary.total_hours, BOOKED.reduce((a, b) => a + b, 0) / 60);
  assert.deepEqual(
    summary.days.map((d) => [d.date, d.hours]),
    BOOKED.map((m, i) => [iso(day(i)), m / 60]),
  );
  assert.deepEqual(
    summary.items.map((i) => [i.label, i.hours]),
    [
      ["NP-6000/10", 30],
      ["NP-6000/20", 1.5],
    ],
  );
  // The open tasks: the protocol from the review, the weekly report's next occurrence.
  const tasks = JSON.parse(await tool("list_tasks", { status: "open" }));
  assert.deepEqual(tasks.map((t) => t.text).sort(), ["Protokoll an Anna schicken", "Wochenbericht schreiben"]);
});

const RIGHT = ".workspace > .pane:last-child > .pane-content:not([hidden])";
const weekSum = () => app.browser.execute((s) => document.querySelector(`${s} .dw-week-sum .dw-big`)?.textContent ?? null, RIGHT);

test("today: the start page beside today's daily note follows a booking typed there", async () => {
  const thisWeek = async () => {
    const m = mondayOf(new Date());
    const rows = await app.invoke("time_entries", { from: m.toISOString(), to: new Date(m.getFullYear(), m.getMonth(), m.getDate() + 7).toISOString() });
    return rows.reduce((a, r) => a + (r.duration_minutes ?? 0), 0);
  };
  const before = await thisWeek();
  // Today's daily note on the left, the start page split off to the right.
  const today = await app.invoke("daily_note", { date: iso(new Date()) });
  await openPage(today.id);
  await app.click('.pane.active .tabbar [aria-label="Rechts teilen"]');
  await until(async () => (await app.$$(".workspace > .pane")).length === 2, "no second pane");
  await app.click(".workspace > .pane:last-child .tabbar-home");
  await app.waitFor(`${RIGHT} .dw-week-sum`, 10000);
  const fmt = (m) => (m / 60).toFixed(2).replace(".", ",");
  await until(async () => (await weekSum()) === fmt(before), `start page shows ${await weekSum()}, booked ${fmt(before)}`);
  // A booking of 45 minutes typed in the daily note.
  await typeLine("/zeit NP-6000/10 45m Abstimmung Schnittstelle");
  await until(async () => (await thisWeek()) === before + 45, "not booked");
  await until(async () => (await weekSum()) === fmt(before + 45), `start page still shows ${await weekSum()}`);
  const review = await app.invoke("week_review", { date: iso(new Date()) });
  assert.equal(review.time.booked_minutes, before + 45);
  await app.shot("600-start-page-beside-note");
});
