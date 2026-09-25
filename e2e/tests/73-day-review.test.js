// Tagesrückblick: a seeded day (pages edited, bookings, a task checked off, meetings from the
// calendar fixtures, a focus session) shows up in its sections; rows lead to the page, the
// Kalender and the Zeiterfassung; ←/→/T move between days; „In Tagesnotiz übernehmen“ writes
// one block into the daily note and replaces it on the next write.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { launch, guarded } from "../lib/harness.js";
import { iso, outlookEnv, writeFixtures } from "../lib/calendar-fixtures.js";

const test = guarded(nodeTest, () => app);
let app, fx, page;
const today = iso(new Date());
const at = (h, m = 0) => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m);
};
const pad = (n) => String(n).padStart(2, "0");
const icsTime = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`;

before(async () => {
  fx = writeFixtures();
  // Today's meetings besides the Outlook fixture's early standup.
  const file = path.join(fx.dir, "Heute.ics");
  const ev = (uid, a, b, title) => ["BEGIN:VEVENT", `UID:${uid}`, `DTSTART:${icsTime(a)}`, `DTEND:${icsTime(b)}`, `SUMMARY:${title}`, "END:VEVENT"];
  fs.writeFileSync(file, ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Annalo e2e//DE", ...ev("kunde@e2e", at(11), at(11, 30), "Kundentermin Rückblick"), ...ev("retro@e2e", at(16), at(17), "Retro Rückblick"), "END:VCALENDAR", ""].join("\r\n"));
  app = await launch({ env: outlookEnv(fx.outlook) });
  await app.invoke("calendar_source_add", { name: "Heute", url: null, path: file });
  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", { settings: { ...view.settings, calendar: { ...view.settings.calendar, outlook: true } } });
  await app.invoke("calendar_sync_now", { source: null });
  await app.browser.waitUntil(async () => (await app.invoke("calendar_status")).sources.every((s) => !s.enabled || (s.status?.synced_at && !s.syncing)), { timeout: 20000, timeoutMsg: "not synced" });

  // A page created and edited today, with a task checked off.
  page = await app.invoke("page_create", { parentId: null, title: "Rückblick Konzept", icon: null, content: "Erste Gedanken\n" });
  await app.invoke("page_save", { id: page.id, content: "Erste Gedanken zum Portal\n\n- [ ] Angebot schreiben\n- [ ] Review vorbereiten\n" });
  await app.invoke("task_set_done", { pageId: page.id, ordinal: 0, done: true, expectedText: "Angebot schreiben" });
  // Bookings: the standup (matches the meeting), a morning block and one after lunch.
  const np = (await app.invoke("wbs_tree")).flatMap((p) => p.netzplaene).find((n) => n.netzplan_nr === "NP-8801");
  const book = (start, minutes, description) =>
    app.invoke("time_entry_create", { netzplanId: np.id, vorgangNr: "1020", leistungsart: null, startTime: start.toISOString(), durationMinutes: minutes, description });
  await book(at(0, 5), 15, "Daily Standup");
  await book(at(6, 0), 90, "Konzept Rückblick");
  await book(at(9, 30), 30, "Abstimmung Rückblick");
  // A short focus session, completed.
  await app.invoke("focus_start", { start: { reference: "NP-8801/1020", minutes: 0.05, break_minutes: 0, goal: "Rückblick Fokus" } });
  // The UI's countdown completes it.
  await app.browser.waitUntil(async () => (await app.invoke("focus_report", { from: today, to: today })).sessions > 0, { timeout: 15000, timeoutMsg: "focus session not completed" });
});
after(async () => {
  await app?.close();
  if (fx) fs.rmSync(fx.dir, { recursive: true, force: true });
});

const rows = (sel) => app.browser.execute((s) => [...document.querySelectorAll(s)].map((e) => e.innerText.replace(/\s+/g, " ").trim()), sel);
const clickRow = (sel, re) =>
  app.browser.execute(
    (s, src) => {
      const el = [...document.querySelectorAll(s)].find((e) => new RegExp(src).test(e.innerText));
      el?.click();
      return !!el;
    },
    sel,
    re.source,
  );
const openReview = async () => {
  await app.click(".ribbon .ribbon-review");
  await app.waitFor(".pane.active .rv-view .rv-stats");
};

test("the day's sections show what was done", async () => {
  const r = await app.invoke("day_review", { date: today });
  assert.ok(r.pages.some((p) => p.title === "Rückblick Konzept" && p.created));
  assert.ok(r.tasks.done.some((t) => t.text === "Angebot schreiben"));
  assert.ok(r.focus.sessions.some((s) => s.goal === "Rückblick Fokus"));
  assert.ok(r.time.gaps.some((g) => g.minutes >= 60), "gap between the bookings");

  await openReview();
  await app.waitText(".pane.active .tab.active", /Tagesrückblick/);
  assert.match(await app.text(".rv-date"), /^Heute · /);
  // Time per WBS, the gap, the target.
  await app.waitText(".rv-time .rv-wbs", /NP-8801\/1020/);
  assert.match(await app.text(".rv-time .rv-gaps"), /Ohne Buchung:\s+00:20–06:00[\s\S]*07:30–\d\d:\d\d/);
  assert.match(await app.text(".rv-stat.tone-time"), /\/ 8 h/);
  // Meetings with their booking state.
  const meetings = await rows(".rv-meetings .rv-meeting");
  assert.ok(meetings.some((m) => /Daily Standup/.test(m) && /gebucht/.test(m) && !/nicht gebucht/.test(m)), meetings.join("\n"));
  assert.ok(meetings.some((m) => /Kundentermin Rückblick/.test(m) && /(nicht gebucht|steht an)/.test(m)), meetings.join("\n"));
  assert.ok(meetings.some((m) => /Retro Rückblick/.test(m)));
  // Pages, tasks, focus.
  const pages = await rows(".rv-pages .rv-page");
  assert.ok(pages.some((p) => /Rückblick Konzept/.test(p) && /neu/.test(p) && /Wörter/.test(p)), pages.join("\n"));
  const done = await rows(".rv-tasks .rv-group-done .rv-task");
  assert.ok(done.some((t) => /Angebot schreiben/.test(t)));
  const fresh = await rows(".rv-tasks .rv-group-added .rv-task");
  assert.ok(fresh.some((t) => /Review vorbereiten/.test(t)));
  assert.match(await app.text(".rv-focus"), /Rückblick Fokus/);
  await app.shot("73-day-review");
  assert.deepEqual(await app.consoleErrors(), []);
});

test("rows open the page, the Kalender at the meeting and the Zeiterfassung", async () => {
  assert.ok(await clickRow(".rv-pages .rv-page", /Rückblick Konzept/));
  await app.browser.waitUntil(async () => (await (await app.$(".pane.active .page-title")).getValue().catch(() => "")) === "Rückblick Konzept", { timeoutMsg: "page not opened" });
  await openReview();
  assert.ok(await clickRow(".rv-meetings .rv-meeting", /Kundentermin Rückblick/));
  await app.waitText(".pane.active .calv-detail-title", /Kundentermin Rückblick/);
  await openReview();
  assert.ok(await clickRow(".rv-time .rv-wbs", /NP-8801\/1020/));
  await app.waitFor(".pane.active .week-grid");
  await app.waitText(".pane.active .tab.active", /Zeiterfassung/);
  await openReview();
  assert.ok(await clickRow(".rv-tasks .rv-task", /Review vorbereiten/));
  await app.browser.waitUntil(async () => (await (await app.$(".pane.active .page-title")).getValue().catch(() => "")) === "Rückblick Konzept", { timeoutMsg: "task page not opened" });
});

test("←, → and T move between days", async () => {
  await openReview();
  await app.browser.execute(() => document.activeElement?.blur());
  await app.keys(["ArrowLeft"]);
  await app.waitText(".rv-date", /^Gestern · /);
  await app.keys(["ArrowLeft"]);
  await app.browser.waitUntil(async () => !/^(Heute|Gestern)/.test(await app.text(".rv-date")));
  await app.keys(["ArrowRight"]);
  await app.waitText(".rv-date", /^Gestern · /);
  await app.keys(["t"]);
  await app.waitText(".rv-date", /^Heute · /);
  // The palette entry opens it too.
  await app.keys(["Control", "k"]);
  await app.waitFor(".palette");
  await app.type("Tagesrückblick");
  await app.waitText(".pal-item.sel", /Tagesrückblick/);
  await app.keys(["Escape"]);
});

test("„In Tagesnotiz übernehmen“ writes one block and replaces it on repeat", async () => {
  await openReview();
  const note = () => app.invoke("day_review", { date: today }).then((r) => r.daily_note_id);
  await app.click(".rv-insert");
  await app.waitText(".toast-title", /Rückblick in die Tagesnotiz übernommen/);
  const id = await note();
  assert.ok(id, "daily note created");
  const first = (await app.invoke("page_get", { id })).content;
  assert.equal(first.split("<!-- rückblick -->").length, 2);
  assert.match(first, /## Rückblick/);
  assert.match(first, /\*\*Seiten:\*\* .*\[\[Rückblick Konzept\]\] \(neu\)/);
  assert.match(first, /\*\*Termine:\*\* .*Daily Standup \d\d:\d\d \(gebucht\)/);
  assert.doesNotMatch(first.split("<!-- rückblick -->")[1], /- \[[ x]\]/, "no tasks in the block");
  // Something changes, then the block is written again: replaced, not duplicated.
  const np = (await app.invoke("wbs_tree")).flatMap((p) => p.netzplaene).find((n) => n.netzplan_nr === "NP-8801");
  await app.invoke("time_entry_create", { netzplanId: np.id, vorgangNr: null, leistungsart: null, startTime: at(14).toISOString(), durationMinutes: 45, description: "Nachtrag" });
  await app.dismissToasts();
  await app.waitText(".rv-time .rv-wbs", /^NP-8801(?!\/)/);
  await app.click(".rv-insert");
  await app.waitText(".toast-title", /Rückblick in der Tagesnotiz aktualisiert/);
  const second = (await app.invoke("page_get", { id })).content;
  assert.equal(second.split("<!-- rückblick -->").length, 2, "one block");
  assert.equal(second.split("<!-- /rückblick -->").length, 2);
  assert.match(second, /- NP-8801 [^\n]*: 0,75 h/);
  assert.equal(second.split("<!-- rückblick -->")[0], first.split("<!-- rückblick -->")[0], "text before the block kept");
  // The note shows the block and links back to the review.
  await app.click(".toast .btn");
  await app.waitFor(".pane.active .page-review-link");
  await app.waitText(".pane.active .ProseMirror h2", /Rückblick/);
  await app.shot("73-daily-note-block");
  await app.click(".pane.active .page-review-link");
  await app.waitText(".pane.active .rv-date", /^Heute · /);
});

test("the Kalender day header and narrow panes", async () => {
  await app.keys(["Control", "Shift", "e"]);
  await app.waitFor(".pane.active .calv");
  // The meeting opened earlier is still selected: close its detail panel.
  if (await (await app.$(".pane.active .calv-detail")).isExisting()) {
    await app.browser.execute(() => document.activeElement?.blur());
    await app.keys(["Escape"]);
    await app.browser.waitUntil(async () => !(await (await app.$(".pane.active .calv-detail")).isExisting()), { timeoutMsg: "detail still open" });
  }
  await app.click(`.pane.active .calv-dayhead[data-date="${today}"] .calv-review-btn`);
  await app.waitText(".pane.active .rv-date", /^Heute · /);
  // A narrow window: one column, no horizontal scroll.
  await app.browser.setWindowSize(1000, 900);
  await app.browser.pause(400);
  const overflow = await app.browser.execute(() => {
    const v = document.querySelector(".pane.active .view-scroll");
    return v ? v.scrollWidth - v.clientWidth : -1;
  });
  assert.ok(overflow <= 1, `no horizontal overflow (${overflow})`);
  await app.shot("73-day-review-narrow");
  // Dark theme (the default look is light here).
  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", { settings: { ...view.settings, theme: "dark" } });
  await app.browser.waitUntil(async () => (await app.browser.execute(() => document.documentElement.dataset.theme)) === "dark", { timeout: 5000, timeoutMsg: "not dark" });
  await app.browser.setWindowSize(1480, 920);
  await app.shot("73-day-review-dark");
  assert.deepEqual(await app.consoleErrors(), []);
});
