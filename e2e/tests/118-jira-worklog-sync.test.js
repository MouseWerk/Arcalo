// Zeiterfassung und Jira (German): an entry shows its issue key and worklog state (in Jira,
// wird gesendet, fehlgeschlagen with „Erneut an Jira senden“); editing duration or comment
// updates the posted worklog, deleting the entry deletes it (the confirmation names Jira); a site
// that does not log work, and time tracking off, leave Jira alone. Also: the Morgen-Briefing on a
// new day while the app keeps running, and the „Nächster Termin“ widget at a small size.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, guarded } from "../lib/harness.js";
import { startFakeJira } from "../lib/fake-jira.js";

const test = guarded(nodeTest, () => app);
let app, jira, calDir;

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const yesterday = iso(new Date(Date.now() - 86_400_000));
const site = (p = {}) => ({ id: "acme", name: "Acme", color: "", kind: "cloud", url: jira.url, email: "mia@firma.de", enabled: true, log_work: true, allow_writes: false, ...p });

async function patchSettings(f) {
  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", { settings: f(structuredClone(view.settings)) });
}
const emit = (event) => app.browser.executeAsync((e, done) => window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: e, payload: null }).then(done, done), event);
const states = (ids) => app.invoke("jira_entry_issues", { entryIds: ids });
const waitState = async (id, state, timeout = 15000) => app.browser.waitUntil(async () => (await states([id]))[0]?.worklog_state === state, { timeout, timeoutMsg: `entry ${id} not ${state}` });
/** Books like `/zeit` in a note; the open timesheet reloads as after a booking there. */
const book = async (line) => {
  const { entry } = await app.invoke("log_time", { line, pageId: null });
  await emit("data://entries");
  return entry;
};
const chip = (key, state) => `.entry-jira[data-key="${key}"][data-state="${state}"]`;
const rowOf = (text) =>
  app.browser.execute((t) => {
    const r = [...document.querySelectorAll(".entry")].find((e) => e.textContent.includes(t));
    r?.scrollIntoView({ block: "center" });
    return !!r;
  }, text);
async function rowMenu(text) {
  await app.dismissToasts();
  assert.ok(await rowOf(text), `no row ${text}`);
  const rows = await app.$$(".entry");
  for (const r of rows) if ((await app.textOf(r)).includes(text)) await r.$(".icon-btn").click();
  await app.waitFor(".menu");
}

/** A meeting in 20 minutes with a long title and a long place. */
function writeCalendar() {
  calDir = fs.mkdtempSync(path.join(os.tmpdir(), "arcalo-118-"));
  const ics = (d) =>
    d
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d{3}/, "");
  const start = new Date(Date.now() + 20 * 60e3);
  const file = path.join(calDir, "termine.ics");
  fs.writeFileSync(
    file,
    [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:118-next@e2e",
      `DTSTART:${ics(start)}`,
      `DTEND:${ics(new Date(start.getTime() + 45 * 60e3))}`,
      "SUMMARY:Abstimmung Rollout Portal",
      "LOCATION:Besprechungsraum Zürich-Nord, Gebäude C, dritter Stock, hinter dem Empfang",
      "END:VEVENT",
      "END:VCALENDAR",
      "",
    ].join("\r\n"),
  );
  return file;
}

before(async () => {
  jira = await startFakeJira({ flavor: "cloud" });
  // The app „started yesterday“: the next focus or tick sees a new day.
  app = await launch({ env: { ARCALO_JIRA_DELAY_SECS: "600", ARCALO_TEST_BRIEFING_DAY: yesterday } });
  await patchSettings((s) => ({ ...s, workdays: [1, 2, 3, 4, 5, 6, 7] }));
  await app.invoke("jira_site_save", { site: site({ id: "" }), token: "secret-token" });
  await app.invoke("jira_sync_now", { site: "acme" });
  await app.invoke("jira_wbs_set", { kind: "project", key: "PROJ", reference: "NP-8801/1020" });
});
after(async () => {
  await app?.close();
  await jira?.close();
  if (calDir) fs.rmSync(calDir, { recursive: true, force: true });
});

test("the Morgen-Briefing opens on a new day while the app keeps running, once", async () => {
  const tabs = () => app.browser.execute(() => [...document.querySelectorAll(".tab")].filter((t) => /Briefing/.test(t.textContent)).length);
  assert.equal(await tabs(), 0, "off at the start");
  await patchSettings((s) => ({ ...s, briefing: { ...s.briefing, mode: "start" } }));
  // The window comes to the front (or the next reminder tick sees it in front): the new day's check.
  await app.browser.executeAsync((done) => window.__TAURI_INTERNALS__.invoke("plugin:window|set_focus", { label: "main" }).then(done, done));
  await app.waitFor(".pane.active > .pane-content:not([hidden]) .bf-view", 45000);
  assert.equal(await tabs(), 1);
  assert.equal(await app.invoke("briefing_start"), "none", "used up for today");
  await app.browser.execute(() => {
    for (const t of [...document.querySelectorAll(".tab")].filter((x) => /Briefing/.test(x.textContent))) t.querySelector(".tab-close")?.click();
  });
  await app.browser.executeAsync((done) => window.__TAURI_INTERNALS__.invoke("plugin:window|set_focus", { label: "main" }).then(done, done));
  await app.browser.pause(1500);
  assert.equal(await tabs(), 0, "not a second time the same day");
  await patchSettings((s) => ({ ...s, briefing: { ...s.briefing, mode: "off" } }));
});

test("the timesheet shows the issue key and the worklog state", async () => {
  const e = await book("/zeit 1h PROJ-123 Analyse Login");
  await waitState(e.id, "posted");
  assert.equal(jira.worklogs().filter((w) => w.key === "PROJ-123").length, 1);
  await emit("nav://timesheet");
  await app.waitFor(chip("PROJ-123", "posted"), 10000);
  assert.match(await app.text(chip("PROJ-123", "posted")), /PROJ-123\s*in Jira/);
});

test("editing duration or comment updates the posted worklog", async () => {
  const [entry] = (await app.invoke("time_entries", { from: null, to: null })).filter((x) => x.description === "PROJ-123 Analyse Login");
  const [before] = jira.worklogs();
  // Through the dialog: the note says the worklog follows.
  await rowMenu("PROJ-123 Analyse Login");
  await app.click(".menu-item:first-child");
  await app.waitFor(".dialog .entry-jira-note");
  assert.match(await app.text(".dialog .entry-jira-note"), /Jira-Worklog von PROJ-123/);
  await app.click(".dialog .btn-ghost");
  await app.invoke("time_entry_update", { id: entry.id, vorgangNr: "1020", leistungsart: null, startTime: entry.start_time, durationMinutes: 90, description: "PROJ-123 Analyse und Fix" });
  await app.browser.waitUntil(() => jira.worklogs().some((w) => w.id === before.id && w.timeSpentSeconds === 5400), { timeout: 15000, timeoutMsg: "worklog not updated" });
  const after = jira.worklogs().find((w) => w.id === before.id);
  assert.equal(after.comment, "PROJ-123 Analyse und Fix");
  assert.equal(jira.worklogs().length, 1, "updated, not posted again");
  assert.ok(jira.requests.some((r) => r.method === "PUT" && r.path === `/rest/api/3/issue/PROJ-123/worklog/${before.id}`));
  await waitState(entry.id, "posted");
  // Another Vorgang only: nothing for Jira.
  const puts = jira.requests.filter((r) => r.method === "PUT").length;
  await app.invoke("time_entry_update", { id: entry.id, vorgangNr: "1010", leistungsart: null, startTime: entry.start_time, durationMinutes: 90, description: "PROJ-123 Analyse und Fix" });
  await app.browser.pause(1500);
  assert.equal(jira.requests.filter((r) => r.method === "PUT").length, puts);
});

test("a failed post shows, and „Erneut an Jira senden“ sends it", async () => {
  await jira.stop();
  const e = await book("/zeit 30m PROJ-124 Mailtext");
  await waitState(e.id, "failed");
  await app.waitFor(chip("PROJ-124", "failed"), 10000);
  assert.match(await app.text(chip("PROJ-124", "failed")), /fehlgeschlagen/);
  await app.shot("118-timesheet-jira");
  await jira.start();
  await app.click(`${chip("PROJ-124", "failed")} .entry-jira-retry`);
  await app.waitFor(chip("PROJ-124", "posted"), 15000);
  assert.equal(jira.worklogs().filter((w) => w.key === "PROJ-124").length, 1);
});

test("deleting the entry deletes its worklog; the confirmation names Jira", async () => {
  await rowMenu("PROJ-124 Mailtext");
  await app.click(".menu-item.danger");
  await app.waitFor(".dialog");
  assert.match(await app.text(".dialog"), /Worklog in Jira \(PROJ-124\) wird ebenfalls gelöscht/);
  await app.click(".dialog .btn-danger");
  await app.browser.waitUntil(() => !jira.worklogs().some((w) => w.key === "PROJ-124"), { timeout: 15000, timeoutMsg: "worklog not deleted" });
  assert.ok(jira.requests.some((r) => r.method === "DELETE" && r.path.startsWith("/rest/api/3/issue/PROJ-124/worklog/")));
});

test("a site that does not log work, and time tracking off, leave Jira alone", async () => {
  const e = await book("/zeit 45m PROJ-125 Export");
  await waitState(e.id, "posted");
  await app.invoke("jira_site_save", { site: site({ log_work: false }), token: null });
  const writes = () => jira.requests.filter((r) => r.method === "PUT" || r.method === "DELETE").length;
  const before = writes();
  assert.equal((await states([e.id]))[0].syncs, false);
  await app.invoke("time_entry_update", { id: e.id, vorgangNr: "1020", leistungsart: null, startTime: e.start_time, durationMinutes: 60, description: "PROJ-125 Export fertig" });
  await emit("data://entries");
  await rowMenu("PROJ-125 Export fertig");
  await app.click(".menu-item.danger");
  await app.waitFor(".dialog");
  assert.doesNotMatch(await app.text(".dialog"), /Jira/);
  await app.click(".dialog .btn-danger");
  await app.browser.pause(1500);
  assert.equal(writes(), before, "no update, no deletion");
  assert.equal(jira.worklogs().filter((w) => w.key === "PROJ-125").length, 1, "the worklog stays in Jira");
  // Time tracking off: nothing reaches Jira either.
  await app.invoke("jira_site_save", { site: site(), token: null });
  const kept = await book("/zeit 15m PROJ-123 Rückfrage");
  await waitState(kept.id, "posted");
  await patchSettings((s) => ({ ...s, time: { ...s.time, enabled: false } }));
  assert.equal((await states([kept.id]))[0].syncs, false);
  await patchSettings((s) => ({ ...s, time: { ...s.time, enabled: true } }));
  assert.equal((await states([kept.id]))[0].syncs, true);
  assert.deepEqual(await app.consoleErrors(), []);
});

test("the next-meeting widget keeps its title at a small size", async () => {
  await app.invoke("calendar_source_add", { name: "Arbeit", url: null, path: writeCalendar() });
  await app.invoke("calendar_sync_now", { source: null });
  await app.browser.waitUntil(async () => (await app.invoke("calendar_status")).sources.every((s) => !s.enabled || (s.status?.synced_at && !s.syncing)), { timeout: 20000, timeoutMsg: "not synced" });
  const W = (id, x, w, h) => ({ id, kind: "next_meeting", x, y: 0, w, h, config: {} });
  await app.invoke("dashboard_save", {
    dashboard: { version: 2, active: "b", notes: {}, boards: [{ id: "b", name: "Start", widgets: [W("small", 0, 3, 5), W("narrow", 3, 3, 7), W("wide", 6, 5, 7)] }] },
  });
  await app.browser.execute(() => location.reload());
  await app.browser.waitUntil(() => app.browser.execute(() => document.body.classList.contains("ready")), { timeout: 20000, timeoutMsg: "not ready" });
  await app.keys(["Control", "t"]);
  const check = async () => {
    for (const id of ["small", "narrow", "wide"]) {
      const sel = `.pane.active > .pane-content:not([hidden]) [data-widget="${id}"] .wn-title`;
      await app.waitText(sel, /Abstimmung/, 15000);
      const box = await app.browser.execute((s) => {
        const t = document.querySelector(s);
        const body = t.closest(".dw-body") ?? t.parentElement;
        const r = t.getBoundingClientRect();
        const b = body.getBoundingClientRect();
        return { h: r.height, inside: r.top >= b.top - 1 && r.top + 8 <= b.bottom, words: t.scrollWidth <= t.clientWidth + 1 };
      }, sel);
      assert.ok(box.h >= 14 && box.inside && box.words, `${id}: title hidden ${JSON.stringify(box)}`);
    }
  };
  await check();
  // A narrow window: the widgets get narrower still.
  await app.browser.setWindowSize(960, 820);
  await app.browser.pause(600);
  await check();
  await app.shot("118-next-meeting-small");
  await app.browser.setWindowSize(1480, 920);
});
