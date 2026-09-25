// „Woche vorschlagen“: last week's meetings (the Team subscription's Jour fixe series and a
// project calendar file), a focus session without booking and editing sessions on a page are
// proposed around an existing booking; one WBS is changed, the rest taken over with Enter; the
// drafts appear in the grid, the sources are linked and the next proposal has learned the WBS.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launch, guarded } from "../lib/harness.js";
import { iso, serveTeam, week } from "../lib/calendar-fixtures.js";

const test = guarded(nodeTest, () => app);
let app;
let team;
let dir;
let portal;
let wbs;

const pad = (n) => String(n).padStart(2, "0");
/** Floating ICS time (local). */
const ics = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`;
/** RFC 3339 in UTC without milliseconds, as the app stores instants. */
const utc = (d) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
/** Last week (fully in the past on any day the suite runs) and the week before. */
const last = week(-1);
const before2 = week(-2);

function projectCalendar() {
  const ev = (uid, start, minutes, summary) => [
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTART:${ics(start)}`,
    `DTEND:${ics(new Date(start.getTime() + minutes * 60e3))}`,
    `SUMMARY:${summary}`,
    "END:VEVENT",
  ];
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Annalo e2e//DE",
    ...ev("review@wp", last.at(1, 14), 60, "Schnittstellen-Review"),
    ...ev("runde@wp", last.at(2, 10), 60, "Architektur-Runde"),
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}

/** Rows written straight into the database: page edits of past hours and a focus session. */
function seedPast(dataDir, pageId, np) {
  const db = new DatabaseSync(path.join(dataDir, "workspace.db"));
  db.exec("PRAGMA busy_timeout = 5000");
  const edit = db.prepare("INSERT INTO activity (at, kind, page_id, title, amount, count) VALUES (?, 'page_edited', ?, 'Konzept Portal', 800, 30)");
  // 30 saves ending 11:50: a session 11:00–11:50 (the booking 11:30–12:00 takes the rest).
  edit.run(utc(last.at(0, 11, 50)), pageId);
  edit.run(utc(before2.at(0, 11, 50)), pageId);
  db.prepare(
    `INSERT INTO focus_sessions (netzplan_id, vorgang_nr, reference, goal, started_at, planned_minutes, ended_at, status, worked_minutes)
     VALUES (?, '1020', 'NP-8801/1020', 'Mapping Materialstamm', ?, 50, ?, 'done', 50)`,
  ).run(np, utc(last.at(3, 13)), utc(last.at(3, 13, 50)));
  db.close();
}

before(async () => {
  team = await serveTeam();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "annalo-wp-"));
  fs.writeFileSync(path.join(dir, "Projekt.ics"), projectCalendar());
  app = await launch();
  // Quarter hours, as CATS is usually booked.
  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", { settings: { ...view.settings, time: { ...view.settings.time, rounding: { step_minutes: 15, mode: "up", min_minutes: 0 } } } });
  // The demo bookings of the last days would fill the week: only this test's data counts.
  for (const e of await app.invoke("time_entries", { from: null, to: null })) await app.invoke("delete_time_entry", { id: e.id });
  wbs = await app.invoke("wbs_tree");
  const np = (nr) => wbs.flatMap((p) => p.netzplaene).find((n) => n.netzplan_nr === nr).id;
  wbs = { np8801: np("NP-8801"), np8802: np("NP-8802") };
  portal = await app.invoke("page_create", { parentId: null, title: "Konzept Portal", icon: null, content: "---\nvorgang: NP-8801/1050\n---\nEntwurf der Portalseiten.\n" });
  seedPast(app.dataDir, portal.id, wbs.np8801);
  // The existing booking on Monday 11:30–12:00.
  await app.invoke("time_entry_create", { netzplanId: wbs.np8801, vorgangNr: "1010", leistungsart: "PM", startTime: last.at(0, 11, 30).toISOString(), durationMinutes: 30, description: "Abstimmung Anforderungen" });
  await app.invoke("calendar_source_add", { name: "Team", url: team.url, path: null });
  await app.invoke("calendar_source_add", { name: "Projekt", url: null, path: path.join(dir, "Projekt.ics") });
  await app.invoke("calendar_sync_now", { source: null });
  await app.browser.waitUntil(async () => (await app.invoke("calendar_status")).sources.every((s) => s.status?.synced_at && !s.syncing), { timeout: 20000, timeoutMsg: "not synced" });
});
after(async () => {
  await app?.close();
  team?.server.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

/** Text, time, confidence badge and the WBS shown per row. */
const rows = () =>
  app.browser.execute(() =>
    [...document.querySelectorAll(".wp-row")].map((r) => ({
      text: r.querySelector(".wp-text .input").value,
      time: r.querySelector(".wp-time").textContent.trim(),
      dur: r.querySelector(".wp-dur").value,
      conf: r.querySelector(".wp-conf").textContent.trim(),
      np: r.querySelector('.wp-wbs [aria-label="Netzplan"]').dataset.value,
      vorgang: r.querySelector('.wp-wbs [aria-label="Vorgang"]').dataset.value,
      checked: r.querySelector(".wp-row-check").checked,
      reason: r.querySelector(".wp-reason").textContent.trim(),
    })),
  );
/** Marks the row with this text for selectors. */
const mark = (text, name) => app.browser.execute((t, n) => ([...document.querySelectorAll(".wp-row")].find((r) => r.querySelector(".wp-text .input").value === t).dataset.e2e = n), text, name);

test("the proposal lists last week's meetings, focus and page work around the booking", async () => {
  await app.click(".ribbon .icon-btn[aria-label='Zeiterfassung']");
  await app.waitFor(".pane.active .view-header");
  await app.click(".pane.active .week-nav .icon-btn[aria-label='Vorherige Woche']");
  await app.waitText(".pane.active .entry-desc", /Abstimmung Anforderungen/);
  await app.click(".pane.active .wp-open");
  await app.waitFor(".dialog .wp-days");
  const list = await rows();
  const by = Object.fromEntries(list.map((r) => [r.text, r]));
  assert.deepEqual(Object.keys(by).sort(), ["Architektur-Runde", "Jour fixe Änderungen", "Konzept Portal", "Mapping Materialstamm", "Schnittstellen-Review"]);
  // Around the booking 11:30–12:00: the page session is cut to 11:00–11:30.
  assert.equal(by["Konzept Portal"].time, "11:00–11:30");
  assert.equal(by["Konzept Portal"].vorgang, "1050");
  assert.equal(by["Konzept Portal"].np, String(wbs.np8801));
  assert.equal(by["Konzept Portal"].conf, "Sicher");
  assert.match(by["Konzept Portal"].reason, /Seite „Konzept Portal“ gehört zu NP-8801\/1050/);
  assert.equal(by["Jour fixe Änderungen"].time, "10:00–11:00");
  assert.equal(by["Jour fixe Änderungen"].conf, "Kein Vorgang");
  assert.equal(by["Jour fixe Änderungen"].checked, false, "nothing to book on without a WBS");
  // Similar to the Vorgang „Schnittstellen-Design“, but unsure.
  assert.equal(by["Schnittstellen-Review"].vorgang, "1030");
  assert.equal(by["Schnittstellen-Review"].conf, "Unsicher");
  assert.equal(by["Mapping Materialstamm"].conf, "Sicher");
  assert.equal(by["Mapping Materialstamm"].dur, "1,00", "50 minutes in quarter hours");
  assert.match(by["Mapping Materialstamm"].reason, /Fokus-Sitzung auf NP-8801\/1020/);
  // Monday: 0,5 h booked, 0,5 h selected (the Jour fixe has no WBS yet) of 8 h.
  await app.waitText(".dialog .wp-day-head", /Montag.*7,00 h ohne Vorschlag/s);
  await app.shot("65-week-proposal");
});

test("a changed WBS is taken over with the rest by Enter; drafts appear in the grid", async () => {
  await mark("Konzept Portal", "portal");
  await mark("Jour fixe Änderungen", "jf");
  await app.select('.wp-row[data-e2e="portal"] .wp-wbs [aria-label="Netzplan"]', String(wbs.np8802));
  await app.select('.wp-row[data-e2e="portal"] .wp-wbs [aria-label="Vorgang"]', "2010");
  await app.select('.wp-row[data-e2e="jf"] .wp-wbs [aria-label="Netzplan"]', String(wbs.np8802));
  await app.select('.wp-row[data-e2e="jf"] .wp-wbs [aria-label="Vorgang"]', "2010");
  // Given a WBS, the meeting is checked; space on the focused row toggles it.
  assert.equal((await rows()).find((r) => r.text === "Jour fixe Änderungen").checked, true);
  await app.browser.execute(() => document.querySelector('.wp-row[data-e2e="jf"]').focus());
  await app.keys([" "]);
  assert.equal((await rows()).find((r) => r.text === "Jour fixe Änderungen").checked, false);
  await app.keys([" "]);
  assert.equal((await rows()).find((r) => r.text === "Jour fixe Änderungen").checked, true);
  await app.waitText(".dialog .wp-foot-info", /4 von 5 ausgewählt/);
  await app.waitText(".dialog .wp-day-head", /Montag.*6,00 h ohne Vorschlag/s);
  await app.shot("65-week-proposal-edited");
  await app.keys(["Enter"]);
  await app.browser.waitUntil(async () => !(await app.browser.execute(() => !!document.querySelector(".dialog .wp"))), { timeoutMsg: "dialog still open" });
  await app.waitText(".toast", /4 Einträge als Entwurf angelegt/);

  const entries = await app.invoke("time_entries", { from: last.monday.toISOString(), to: week(0).monday.toISOString() });
  const got = Object.fromEntries(entries.map((e) => [e.description, e]));
  assert.equal(got["Konzept Portal"].vorgang_nr, "2010");
  assert.equal(got["Konzept Portal"].netzplan_nr, "NP-8802");
  assert.equal(got["Konzept Portal"].page_id, portal.id);
  assert.equal(got["Jour fixe Änderungen"].netzplan_nr, "NP-8802");
  assert.equal(got["Schnittstellen-Review"].vorgang_nr, "1030");
  assert.equal(got["Mapping Materialstamm"].duration_minutes, 60);
  for (const d of ["Konzept Portal", "Jour fixe Änderungen", "Schnittstellen-Review", "Mapping Materialstamm"]) {
    assert.equal(got[d].status_flag, "draft", d);
    assert.equal(got[d].source, "auto", d);
  }
  assert.equal(got["Abstimmung Anforderungen"].source, "manual");
  // The appointment and the focus session are linked to their bookings.
  const events = await app.invoke("calendar_events", { from: last.monday.toISOString(), to: week(0).monday.toISOString() });
  assert.equal(events.find((e) => e.title === "Jour fixe Änderungen").entry_id, got["Jour fixe Änderungen"].id);
  assert.ok((await app.invoke("focus_entry_ids")).includes(got["Mapping Materialstamm"].id));
  // The week grid shows the drafts.
  await app.waitText(".pane.active .week-grid tbody td.mono", /NP-8802\/2010/);
  await app.waitText(".pane.active .entry-desc", /Konzept Portal/);
  await app.browser.execute(() => document.querySelector(".pane.active .week-grid").scrollIntoView({ block: "center" }));
  await app.shot("65-week-proposal-applied");
});

test("the next proposal is empty for the week and has learned the WBS", async () => {
  await app.click(".pane.active .wp-open");
  await app.waitFor(".dialog .wp-days");
  const list = await rows();
  assert.deepEqual(list.map((r) => r.text), ["Architektur-Runde"], "only the meeting without WBS is left");
  await app.keys(["Escape"]);
  await app.browser.waitUntil(async () => !(await app.browser.execute(() => !!document.querySelector(".dialog .wp"))));

  // The week before: the series and the page come with the chosen WBS.
  const p = await app.invoke("week_proposal", { weekStart: iso(before2.monday), restOfToday: false });
  const monday = p.proposals.filter((x) => x.date === iso(before2.monday));
  assert.equal(monday.length, 1, JSON.stringify(monday));
  assert.equal(monday[0].text, "Jour fixe Änderungen; Konzept Portal", "same WBS, adjacent: one block");
  assert.equal(monday[0].wbs.reference, "NP-8802/2010");
  assert.equal(monday[0].wbs.basis, "learned");
  assert.equal(monday[0].minutes, 120, "10:00–12:00: no booking that week");
  assert.deepEqual(monday[0].sources.map((s) => s.kind), ["calendar", "page"]);
  await app.click(".pane.active .week-nav .icon-btn[aria-label='Vorherige Woche']");
  await app.click(".pane.active .wp-open");
  await app.waitText(".dialog .wp-reason", /wie letzte Woche|wie am/);
  await app.shot("65-week-proposal-learned");
  await app.keys(["Escape"]);
});
