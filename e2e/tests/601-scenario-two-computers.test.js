// q124 round 3, scenarios: the office computer and the laptop share their notes through a Git
// repository (a local bare one). The office computer writes today's daily note with a booking and
// a task, a meeting note from the ICS calendar and a concept page; the laptop takes them over and
// goes on there (the same daily note, the same meeting note, a renamed page, a ticked task); the
// office computer starts again (as after an update) and takes the laptop's work over without
// losing its own bookings, links or time sheets.
process.env.TZ = "Europe/Berlin";

import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app, base, bare, office, laptop, ics;
const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = iso(new Date());
const git = (...args) => execFileSync("git", ["-C", bare, ...args], { encoding: "utf8" });
const flat = (nodes) => nodes.flatMap((n) => [n, ...flat(n.children ?? [])]);
const pages = async () => flat(await app.invoke("workspace_tree"));
const named = async (title) => (await pages()).filter((p) => p.title === title);
const content = async (id) => (await app.invoke("page_get", { id })).content;

async function start(dataDir) {
  // A test that failed before its end leaves its computer running.
  await stop();
  app = await launch({ demo: false, dataDir, env: { TZ: "Europe/Berlin" } });
}
async function stop() {
  await app?.close();
  app = null;
}
async function enableSync(name) {
  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", {
    settings: { ...view.settings, git_sync: { ...view.settings.git_sync, enabled: true, remote_url: bare, author_name: name, author_email: `${name.toLowerCase()}@example.com` } },
  });
}
async function wbs() {
  const p = await app.invoke("project_create", { code: "PRJ-601", name: "Portal" });
  const np = await app.invoke("netzplan_create", { projectId: p.id, netzplanNr: "NP-6010", wbsElement: "P-6010-01", description: "Portal", plannedHours: 100 });
  await app.invoke("vorgang_create", { netzplanId: np.id, vorgangNr: "10", description: "Entwicklung", durationDays: 5, plannedHours: 50, predecessors: [] });
  return np;
}
/** An appointment an hour ago (today) in the ICS file both computers subscribe to. */
function writeCalendar() {
  const s = new Date(Date.now() - 2 * 3600e3);
  const stamp = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  fs.writeFileSync(
    ics,
    ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Arcalo e2e//DE", "BEGIN:VEVENT", "UID:abstimmung-601@e2e", `DTSTART:${stamp(s)}`, `DTEND:${stamp(new Date(s.getTime() + 3600e3))}`, "SUMMARY:Abstimmung Schnittstelle", "END:VEVENT", "END:VCALENDAR", ""].join("\r\n"),
  );
}
async function meetingKey() {
  await app.invoke("calendar_source_add", { name: "Arbeit", url: null, path: ics });
  await app.invoke("calendar_sync_now", { source: null });
  const from = new Date(Date.now() - 6 * 3600e3).toISOString();
  const to = new Date(Date.now() + 3600e3).toISOString();
  const ev = (await app.invoke("calendar_events", { from, to })).find((e) => e.title === "Abstimmung Schnittstelle");
  assert.ok(ev, "the appointment is in the calendar");
  return ev.key;
}

before(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "arcalo-e2e-601-"));
  bare = path.join(base, "notizen.git");
  office = path.join(base, "office");
  laptop = path.join(base, "laptop");
  ics = path.join(base, "arbeit.ics");
  fs.mkdirSync(office);
  fs.mkdirSync(laptop);
  execFileSync("git", ["init", "-q", "--bare", bare]);
  writeCalendar();
});
after(async () => {
  await app?.close();
  if (base) fs.rmSync(base, { recursive: true, force: true });
});

const state = {};

test("the office computer writes the day and syncs it", async () => {
  await start(office);
  await wbs();
  const daily = await app.invoke("daily_note", { date: today });
  state.daily = daily.title;
  const booked = await app.invoke("log_time", { line: "/zeit NP-6010/10 30m Schnittstelle skizziert", pageId: daily.id });
  state.entry = booked.entry.id;
  const chip = `<time-entry id="${booked.entry.id}" hours="0,50" target="NP-6010/10" date="${today}">Schnittstelle skizziert</time-entry>`;
  await app.invoke("page_save", { id: daily.id, content: `## Notizen\n\nIm Büro begonnen, siehe [[Konzept Schnittstelle]].\n\n${chip}\n\n- [ ] Feldliste an Anna schicken\n` });
  await app.invoke("page_create", { parentId: null, title: "Konzept Schnittstelle", icon: null, content: "Felder: Kunde, Auftrag" });
  const key = await meetingKey();
  const note = await app.invoke("calendar_meeting_note", { key });
  assert.equal(note.created, true);
  state.meeting = note.page.title;
  await app.invoke("page_save", { id: note.page.id, content: `${note.page.content ?? (await content(note.page.id))}\nBeschlossen: REST statt SOAP.\n` });
  await enableSync("Office");
  await app.invoke("backup_now");
  const files = git("ls-tree", "-r", "--name-only", "main").split("\n");
  assert.ok(files.some((f) => f.startsWith("Zeiterfassung/")), files.join("\n"));
  state.csv = files.find((f) => f.startsWith("Zeiterfassung/"));
  await stop();
});

test("the laptop goes on with the same daily note and the same meeting note", async () => {
  await start(laptop);
  await wbs();
  await enableSync("Laptop");
  const out = await app.invoke("git_sync_now");
  assert.ok(!out.error, JSON.stringify(out));
  assert.equal((await named("Konzept Schnittstelle")).length, 1);
  // Today's daily note is the one the office computer wrote, not a second one beside it.
  const daily = await app.invoke("daily_note", { date: today });
  assert.match(await content(daily.id), /Im Büro begonnen/);
  assert.equal((await named(state.daily)).length, 1, (await pages()).map((p) => p.title).join(", "));
  // The meeting note of the appointment is the one written in the office.
  const key = await meetingKey();
  const note = await app.invoke("calendar_meeting_note", { key });
  assert.equal(note.page.title, state.meeting);
  assert.match(await content(note.page.id), /REST statt SOAP/);
  // The laptop goes on: a line in the daily note, the concept renamed, the task done.
  await app.invoke("page_save", { id: daily.id, content: (await content(daily.id)).replace("Im Büro begonnen", "Im Büro begonnen, unterwegs weiter") });
  const konzept = (await named("Konzept Schnittstelle"))[0];
  await app.invoke("page_rename", { id: konzept.id, title: "Konzept REST-Schnittstelle", updateLinks: true });
  assert.match(await content(daily.id), /\[\[Konzept REST-Schnittstelle\]\]/);
  const [task] = await app.invoke("tasks_list", { filter: { page_id: daily.id } });
  await app.invoke("task_set_done", { pageId: daily.id, ordinal: task.ordinal, done: true, expectedText: task.text });
  await app.invoke("git_sync_now");
  // The office computer's time sheet stays on the server: the laptop booked nothing.
  const files = git("ls-tree", "-r", "--name-only", "main").split("\n");
  assert.ok(files.includes(state.csv), `${state.csv} gone from the server: ${files.join(", ")}`);
  await stop();
});

test("the office computer starts again and takes the laptop's work over", async () => {
  await start(office);
  const out = await app.invoke("git_sync_now");
  assert.ok(!out.error, JSON.stringify(out));
  const daily = await app.invoke("daily_note", { date: today });
  const text = await content(daily.id);
  assert.match(text, /unterwegs weiter/);
  assert.match(text, /\[\[Konzept REST-Schnittstelle\]\]/);
  assert.match(text, /- \[x\] Feldliste an Anna schicken/);
  assert.equal((await named("Konzept Schnittstelle")).length, 0);
  assert.equal((await named("Konzept REST-Schnittstelle")).length, 1);
  assert.equal((await named(state.daily)).length, 1);
  // The booking stays the office computer's, linked to its chip.
  const rows = await app.invoke("time_entries", { from: null, to: null });
  assert.deepEqual(rows.map((r) => [r.id, r.duration_minutes, r.page_id]), [[state.entry, 30, daily.id]]);
  const [chip] = await app.invoke("time_chip_states", { pageId: daily.id, chips: [{ id: state.entry, target: "NP-6010/10" }] });
  assert.equal(chip.link, "linked");
  const tasks = await app.invoke("tasks_list", { filter: { status: "open" } });
  assert.deepEqual(tasks.map((t) => t.text), []);
});
