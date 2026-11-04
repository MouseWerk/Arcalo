// q124 round 3, scenarios: today's daily note stays open in the left pane all day while work goes
// on elsewhere: the customer page it links to is renamed in the right pane, the booking typed in
// it is corrected in the timesheet, its task is ticked off in the task view. The open note shows
// each change and typing on in it never writes the old text back. Then the app restarts (as after
// an update) with the timer running, and a backup of the morning is restored.
process.env.TZ = "Europe/Berlin";

import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app, dataDir, np, daily, kunde;
const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const LEFT = ".workspace > .pane:first-child > .pane-content:not([hidden])";
const RIGHT = ".workspace > .pane:last-child > .pane-content:not([hidden])";
const until = (f, msg, timeout = 10000) => app.browser.waitUntil(f, { timeout, timeoutMsg: msg });
const content = async (id) => (await app.invoke("page_get", { id })).content;
const leftText = () => app.browser.execute((s) => document.querySelector(`${s} .ProseMirror`)?.innerText ?? "", LEFT);
const start = () => launch({ demo: false, dataDir, env: { TZ: "Europe/Berlin", ARCALO_BACKUP_DELAY_SECS: "3600" } });

/** Types at the end of the note in the left pane. */
async function typeLeft(text) {
  await app.browser.execute((s) => {
    const ed = document.querySelector(`${s} .ProseMirror`).editor;
    ed.commands.focus("end");
  }, LEFT);
  await app.keys(["Enter"]);
  await app.type(text);
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "arcalo-e2e-602-"));
  app = await start();
  const p = await app.invoke("project_create", { code: "PRJ-602", name: "Müller" });
  np = await app.invoke("netzplan_create", { projectId: p.id, netzplanNr: "NP-6020", wbsElement: "P-6020-01", description: "Müller Einführung", plannedHours: 80 });
  await app.invoke("vorgang_create", { netzplanId: np.id, vorgangNr: "10", description: "Beratung", durationDays: 5, plannedHours: 40, predecessors: [] });
  kunde = await app.invoke("page_create", { parentId: null, title: "Kunde Müller", icon: null, content: "Ansprechpartnerin: Frau Weiß" });
  daily = await app.invoke("daily_note", { date: iso(new Date()) });
});
after(async () => {
  await app?.close();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

test("the open daily note gets a link, a booking and a task", async () => {
  await app.invoke("search_open", { target: { kind: "page", page_id: daily.id, new_tab: false } });
  await until(() => app.browser.execute(() => document.querySelector(".pane.active .page-title")?.value?.length > 0), "daily note not open");
  await app.click('.pane.active .tabbar [aria-label="Rechts teilen"]');
  await until(async () => (await app.$$(".workspace > .pane")).length === 2, "no second pane");
  await app.browser.execute((s) => document.querySelector(`${s} .ProseMirror`)?.click(), LEFT);
  await typeLeft("Telefonat mit [[Kunde Müller");
  await app.keys(["Escape"]);
  await app.type("]] wegen Schulung");
  await typeLeft("/zeit NP-6020/10 1h Telefonat Müller");
  await app.keys(["Escape"]);
  await app.keys(["Enter"]);
  await app.waitFor(`${LEFT} .time-chip`);
  await typeLeft("[ ] Schulungsunterlagen an Frau Weiß");
  await until(async () => /\[\[Kunde Müller\]\]/.test(await content(daily.id)) && /- \[ \] Schulungsunterlagen/.test(await content(daily.id)), `not saved: ${await content(daily.id)}`);
});

test("renamed in the other pane, the link in the open note follows and stays", async () => {
  // The customer page in the right pane, renamed there like a user does.
  await (await app.$(".workspace > .pane:last-child .tabbar .tab")).click();
  await until(() => app.browser.execute(() => !!document.querySelector(".workspace > .pane:last-child.active")), "right pane not active");
  await app.invoke("search_open", { target: { kind: "page", page_id: kunde.id, new_tab: false } });
  await until(() => app.browser.execute((s) => document.querySelector(`${s} .page-title`)?.value === "Kunde Müller", RIGHT), "customer page not open on the right");
  const title = await app.$(`${RIGHT} .page-title`);
  await title.click();
  await app.keys(["Control", "a"]);
  await app.type("Kunde Müller GmbH");
  await app.keys(["Enter"]);
  await app.waitText(".toast-title", /Umbenannt/);
  await until(async () => /\[\[Kunde Müller GmbH\]\]/.test(await content(daily.id)), "link not rewritten");
  await until(async () => /Kunde Müller GmbH/.test(await leftText()), "the open note still shows the old link");
  await typeLeft("Rückruf vereinbart");
  await until(async () => /Rückruf vereinbart/.test(await content(daily.id)), "not saved");
  const text = await content(daily.id);
  assert.match(text, /\[\[Kunde Müller GmbH\]\]/);
  assert.match(text, /Rückruf vereinbart/);
});

test("corrected in the timesheet, the chip in the open note follows and stays", async () => {
  const [entry] = await app.invoke("time_entries", { from: null, to: null });
  await app.invoke("time_entry_update", { id: entry.id, vorgangNr: "10", leistungsart: null, startTime: entry.start_time, durationMinutes: 90, description: entry.description });
  await until(async () => /hours="1,50"/.test(await content(daily.id)), `chip not rewritten: ${await content(daily.id)}`);
  await until(async () => /1,5 h/.test(await leftText()), "the open note still shows the old hours");
  await typeLeft("Angebot geschickt");
  await until(async () => /Angebot geschickt/.test(await content(daily.id)), "not saved");
  const text = await content(daily.id);
  assert.match(text, /hours="1,50"/);
  assert.equal((await app.invoke("time_entries", { from: null, to: null }))[0].duration_minutes, 90);
});

test("ticked off in the task view, the task in the open note stays done", async () => {
  const [task] = await app.invoke("tasks_list", { filter: { page_id: daily.id, status: "open" } });
  await app.invoke("task_set_done", { pageId: daily.id, ordinal: task.ordinal, done: true, expectedText: task.text });
  await until(async () => /- \[x\] Schulungsunterlagen/.test(await content(daily.id)), "not done");
  await until(() => app.browser.execute((s) => [...document.querySelectorAll(`${s} .ProseMirror li[data-checked="true"]`)].some((li) => li.textContent.includes("Schulungsunterlagen")), LEFT), "the open note still shows the task open");
  await typeLeft("Feierabend");
  await until(async () => /Feierabend/.test(await content(daily.id)), "not saved");
  const text = await content(daily.id);
  assert.match(text, /- \[x\] Schulungsunterlagen/);
});

let backup;

test("a restart with the timer running (as after an update) keeps the timer, the note and its chip", async () => {
  backup = await app.invoke("backup_now");
  const timer = await app.invoke("timer_start", { netzplanId: np.id, vorgangNr: "10", leistungsart: null, description: "Schulung vorbereiten" });
  const before = await content(daily.id);
  await app.close();
  app = await start();
  const status = await app.invoke("timer_status");
  assert.equal(status?.entry.id, timer.id);
  assert.equal(status.entry.description, "Schulung vorbereiten");
  assert.equal(await content(daily.id), before);
  const [chip] = await app.invoke("time_chip_states", { pageId: daily.id, chips: [{ id: 1, target: "NP-6020/10" }] });
  assert.equal(chip.link, "linked");
  assert.equal(chip.row.duration_minutes, 90);
  // The timer shows in the status bar after the start.
  await app.waitFor(".timer-dock");
  const tree = await app.invoke("workspace_tree");
  const flat = (nodes) => nodes.flatMap((n) => [n, ...flat(n.children ?? [])]);
  assert.ok(flat(tree).some((p) => p.title === "Kunde Müller GmbH"));
});

test("the morning's backup restored: notes, bookings and tasks are the morning's, the timer is gone", async () => {
  await app.invoke("timer_discard");
  await app.invoke("log_time", { line: "/zeit NP-6020/10 30m Nach der Sicherung", pageId: null });
  const staged = await app.invoke("backup_restore", { path: backup.path });
  assert.ok(staged.ok, JSON.stringify(staged));
  await app.close();
  app = await start();
  const rows = await app.invoke("time_entries", { from: null, to: null });
  assert.deepEqual(
    rows.map((r) => [r.description, r.duration_minutes, r.status_flag]),
    [["Telefonat Müller", 90, "draft"]],
  );
  assert.equal(await app.invoke("timer_status"), null);
  const text = await content(daily.id);
  assert.match(text, /\[\[Kunde Müller GmbH\]\]/);
  assert.match(text, /hours="1,50"/);
  assert.match(text, /- \[x\] Schulungsunterlagen/);
  const week = await app.invoke("week_review", { date: iso(new Date()) });
  assert.equal(week.time.booked_minutes, 90);
});
