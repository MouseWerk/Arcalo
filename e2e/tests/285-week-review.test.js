// Wochenrückblick (1.15): a seeded week (bookings, tasks, meetings from the calendar fixtures,
// a focus block, pages) shows up per day and per section; ←/→/T and the buttons move between
// weeks; the Kalender header, the Tagesrückblick, the palette and the start page widget open it;
// „Als Wochenbericht speichern“ writes a filed page with tables and lists and updates it in
// place; without AI the button explains the setup; without time tracking the time part is gone;
// the English UI. Screenshots in light and dark at 1440 px.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { launch, guarded, SHOTS } from "../lib/harness.js";
import { germanLeftovers, launchEnglish } from "../lib/english.js";
import { iso, week } from "../lib/calendar-fixtures.js";

const test = guarded(nodeTest, () => app);
let app, dir, enDir;
const { monday, at } = week();
const mondayIso = iso(monday);
const sunday = iso(at(6, 0));
const lastWeek = iso(week(-1).at(2, 0));
const pad = (n) => String(n).padStart(2, "0");
const icsTime = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`;
/** ISO week and its year (the Thursday's). */
function isoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const y = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return { week: Math.ceil(((t - y) / 86400000 + 1) / 7), year: t.getUTCFullYear(), month: t.getUTCMonth() + 1 };
}
const kw = isoWeek(monday);
const MONTHS = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];

/** Copies a screenshot of this run next to the others the report names. */
const OUT = process.env.WEEK_SHOTS;
async function shot(name) {
  await app.shot(name);
  if (OUT) {
    fs.mkdirSync(OUT, { recursive: true });
    fs.copyFileSync(path.join(SHOTS, `${name}.png`), path.join(OUT, `${name}.png`));
  }
}

async function reload() {
  await app.browser.execute(() => location.reload());
  await app.browser.pause(300);
  await app.browser.waitUntil(() => app.browser.execute(() => document.body.classList.contains("ready")), { timeout: 20000, timeoutMsg: "not ready after reload" });
}
async function patchSettings(f) {
  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", { settings: f(structuredClone(view.settings)) });
  await app.browser.pause(400);
}
async function setTheme(theme) {
  await patchSettings((s) => ({ ...s, theme }));
  await app.browser.waitUntil(async () => (await app.browser.execute(() => document.documentElement.dataset.theme)) === theme, { timeout: 5000, timeoutMsg: `not ${theme}` });
}
const rows = (sel) => app.browser.execute((s) => [...document.querySelectorAll(s)].map((e) => e.innerText.replace(/\s+/g, " ").trim()), sel);
async function openWeek() {
  await app.keys(["Control", "k"]);
  await app.waitFor(".palette input");
  await app.type("Wochenrückblick");
  await app.waitText(".pal-item.sel", /^Wochenrückblick/);
  await app.keys(["Enter"]);
  await app.waitFor(".pane.active .wr-view .rv-stats", 15000);
}
async function report(id) {
  return (await app.invoke("page_get", { id })).content;
}
/** Titles from the top level down to the page's folder. */
async function folders(id) {
  const out = [];
  let parent = (await app.invoke("page_get", { id })).parent_id;
  while (parent != null) {
    const p = await app.invoke("page_get", { id: parent });
    out.unshift(p.title);
    parent = p.parent_id;
  }
  return out;
}

before(async () => {
  dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "arcalo-e2e-week-"));
  const file = path.join(dir, "Woche.ics");
  const ev = (uid, a, b, title) => ["BEGIN:VEVENT", `UID:${uid}`, `DTSTART:${icsTime(a)}`, `DTEND:${icsTime(b)}`, `SUMMARY:${title}`, "END:VEVENT"];
  fs.writeFileSync(
    file,
    ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Arcalo e2e//DE", ...ev("start@e2e", at(0, 10), at(0, 10, 30), "Wochenstart Rückblick"), ...ev("kunde@e2e", at(2, 14), at(2, 15), "Kundentermin Woche"), ...ev("retro@e2e", at(4, 11), at(4, 12), "Retro Woche"), "END:VCALENDAR", ""].join("\r\n"),
  );
  app = await launch();
  await app.invoke("calendar_source_add", { name: "Woche", url: null, path: file });
  await app.invoke("calendar_sync_now", { source: null });
  await app.browser.waitUntil(async () => (await app.invoke("calendar_status")).sources.every((s) => !s.enabled || (s.status?.synced_at && !s.syncing)), { timeout: 20000, timeoutMsg: "not synced" });

  // Pages and tasks of the week: one done, one due on Sunday, one overdue from last week.
  const page = await app.invoke("page_create", { parentId: null, title: "Wochen Konzept", icon: null, content: "Erste Gedanken\n" });
  await app.invoke("page_save", { id: page.id, content: `Erste Gedanken zur Woche\n\n- [ ] Angebot Woche\n- [ ] Bericht Woche due:${sunday}\n- [ ] Alte Sache due:${lastWeek}\n` });
  await app.invoke("task_set_done", { pageId: page.id, ordinal: 0, done: true, expectedText: "Angebot Woche" });
  // Bookings on Monday (never in the future, whatever today is): the meeting by its subject and a block.
  const np = (await app.invoke("wbs_tree")).flatMap((p) => p.netzplaene).find((n) => n.netzplan_nr === "NP-8801");
  const book = (start, minutes, description, vorgangNr = "1020") =>
    app.invoke("time_entry_create", { netzplanId: np.id, vorgangNr, leistungsart: null, startTime: start.toISOString(), durationMinutes: minutes, description });
  await book(at(0, 10), 30, "Wochenstart Rückblick");
  await book(at(0, 7), 120, "Konzept Woche");
  await book(at(0, 13), 90, "Abstimmung Woche", null);
  // A focus block on Thursday.
  await app.invoke("block_create", { block: { title: "Fokus Wochenbericht", start: at(3, 9).toISOString(), end: at(3, 10, 30).toISOString() } });
  // The start page with the widget.
  await app.invoke("dashboard_save", {
    dashboard: { version: 2, active: "w", notes: {}, boards: [{ id: "w", name: "Woche", widgets: [{ id: "week_review", kind: "week_review", x: 0, y: 0, w: 4, h: 7, config: {} }] }] },
  });
  await reload();
});
after(async () => {
  await app?.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  if (enDir) fs.rmSync(enDir, { recursive: true, force: true });
});

test("the week's days and sections show what was done", async () => {
  const r = await app.invoke("week_review", { date: mondayIso });
  assert.equal(r.monday, mondayIso);
  assert.equal(r.days.length, 7);
  assert.equal(r.week, kw.week);
  assert.ok(r.days[0].booked_minutes >= 240, `Monday booked ${r.days[0].booked_minutes}`);
  assert.ok(r.time.items.some((w) => w.label === "NP-8801/1020"));
  assert.ok(r.tasks.done.some((t) => t.text === "Angebot Woche"));
  assert.ok(r.tasks.open.some((t) => t.text === "Bericht Woche"));
  assert.ok(r.tasks.overdue.some((t) => t.text === "Alte Sache"));
  assert.ok(r.meetings.some((m) => m.title === "Wochenstart Rückblick" && m.state === "booked"));
  assert.ok(r.focus.blocks.some((b) => b.title === "Fokus Wochenbericht"));
  assert.ok(r.pages.some((p) => p.title === "Wochen Konzept" && p.created));

  await app.browser.setWindowSize(1440, 960);
  // The side panel closed: the view gets the window's width.
  await app.browser.execute(() => document.querySelector('button[aria-label^="Seitenpanel"].active, button[aria-label^="Seitenpanel"][aria-pressed="true"]')?.click());
  await openWeek();
  await app.waitText(".pane.active .tab.active", /Wochenrückblick/);
  assert.match(await app.text(".pane.active .wr-date"), new RegExp(`^Diese Woche · KW ${kw.week} · `));
  assert.equal((await app.$$(".pane.active .wr-day")).length, 7);
  assert.match(await app.text(".pane.active .wr-day:first-child"), /^Mo/);
  assert.match(await app.text(".pane.active .rv-stat.tone-time"), /\/ 40 h/);
  await app.waitText(".pane.active .rv-time .rv-wbs", /NP-8801\/1020/);
  // Meetings by day with their booking state.
  // Day heads are small caps (upper case by CSS).
  const heads = await rows(".pane.active .rv-meetings .rv-group-head");
  assert.match(heads[0], /^mo /i, heads.join(" | "));
  const meetings = await rows(".pane.active .rv-meetings .rv-meeting");
  assert.ok(meetings.some((m) => /Wochenstart Rückblick/.test(m) && /gebucht/.test(m) && !/nicht gebucht/.test(m)), meetings.join("\n"));
  assert.ok(meetings.some((m) => /Kundentermin Woche/.test(m)));
  const done = await rows(".pane.active .rv-tasks .rv-group-done .rv-task");
  assert.ok(done.some((t) => /Angebot Woche/.test(t) && /Wochen Konzept/.test(t)), done.join("\n"));
  assert.ok((await rows(".pane.active .rv-tasks .rv-group-open .rv-task")).some((t) => /Bericht Woche/.test(t)));
  assert.ok((await rows(".pane.active .rv-tasks .rv-group-overdue .rv-task")).some((t) => /Alte Sache/.test(t)));
  assert.ok((await rows(".pane.active .rv-pages .rv-page")).some((p) => /Wochen Konzept/.test(p) && /neu/.test(p)));
  assert.match(await app.text(".pane.active .rv-focus"), /Fokus Wochenbericht/);
  // No horizontal scroll at 1440 px.
  const overflow = await app.browser.execute(() => {
    const v = document.querySelector(".pane.active .view-scroll");
    return v ? v.scrollWidth - v.clientWidth : -1;
  });
  assert.ok(overflow <= 1, `no horizontal overflow (${overflow})`);
  await shot("285-week-review-light");
  assert.deepEqual(await app.consoleErrors(), []);
});

test("←, →, T and the buttons move between weeks; a day opens its Tagesrückblick", async () => {
  await openWeek();
  assert.equal(await app.browser.execute(() => document.querySelector(".pane.active .wr-this-week")?.disabled), true);
  await app.browser.execute(() => document.activeElement?.blur());
  await app.keys(["ArrowLeft"]);
  await app.waitText(".pane.active .wr-date", /^Letzte Woche · KW /);
  await app.keys(["ArrowLeft"]);
  await app.browser.waitUntil(async () => /^KW \d+ · /.test(await app.text(".pane.active .wr-date")), { timeoutMsg: "two weeks back" });
  await app.keys(["t"]);
  await app.waitText(".pane.active .wr-date", /^Diese Woche · /);
  await app.click(".pane.active .rv-nav button[aria-label^='Nächste Woche']");
  await app.browser.waitUntil(async () => /^KW \d+ · /.test(await app.text(".pane.active .wr-date")), { timeoutMsg: "next week" });
  await app.click(".pane.active .wr-this-week");
  await app.waitText(".pane.active .wr-date", /^Diese Woche · /);
  // Monday's card opens the Tagesrückblick of that day.
  await app.click(".pane.active .wr-day:first-child");
  await app.waitFor(".pane.active .rv-view:not(.wr-view) .rv-stats");
  assert.match(await app.text(".pane.active .rv-date"), /Montag/);
});

test("the Kalender header, the Tagesrückblick and the start page open it", async () => {
  // From the day review: „Woche ansehen“.
  await app.click(".ribbon .ribbon-review");
  await app.waitFor(".pane.active .rv-view .rv-week");
  await app.click(".pane.active .rv-week");
  await app.waitFor(".pane.active .wr-view .rv-stats");
  // From the Kalender's week header.
  await app.keys(["Control", "Shift", "e"]);
  await app.waitFor(".pane.active .calv");
  await app.click(".pane.active .calv-week-review");
  await app.waitText(".pane.active .wr-date", new RegExp(`KW ${kw.week} · `));
  // The start page widget: hours against the target, the days, the way in.
  await app.keys(["Control", "t"]);
  await app.waitFor('.pane.active [data-widget="week_review"] .dw-wr', 15000);
  assert.equal((await app.$$('.pane.active [data-widget="week_review"] .dw-wr-day')).length, 7);
  assert.match(await app.text('.pane.active [data-widget="week_review"] .dw-wr-time'), /\/ 40 h/);
  assert.match(await app.text('.pane.active [data-widget="week_review"] .dw-wr-counts'), /Termine/);
  await shot("285-week-widget");
  await app.click('.pane.active [data-widget="week_review"] .dw-wr-links .dw-link');
  await app.waitFor(".pane.active .wr-view .rv-stats");
});

test("„Zusammenfassen“ without AI explains how to set it up", async () => {
  await openWeek();
  await app.click(".pane.active .wr-summarize");
  await app.waitText(".pane.active .wr-setup .ai-setup-note", /KI einrichten/);
  assert.match(await app.text(".pane.active .wr-setup .ai-setup-note"), /Zusammenfassung der Woche/);
  await assert.rejects(app.invoke("week_review_summary", { requestId: "wr-none", date: mondayIso }), /Keine KI verbunden/);
});

test("„Als Wochenbericht speichern“ writes a filed page and updates it in place", async () => {
  await openWeek();
  await app.click(".pane.active .wr-save");
  await app.waitText(".toast-title", /Wochenbericht gespeichert/);
  const r = await app.invoke("week_review", { date: mondayIso });
  assert.ok(r.report_page_id, "the review knows its report");
  const id = r.report_page_id;
  const title = `Wochenbericht KW ${pad(kw.week)} ${kw.year}`;
  assert.equal((await app.invoke("page_get", { id })).title, title);
  // Filed like a journal page: year and month folder of the week.
  const path_ = await folders(id);
  assert.deepEqual(path_.slice(-2), [String(kw.year), `${pad(kw.month)} – ${MONTHS[kw.month - 1]}`], path_.join(" / "));
  const first = await report(id);
  assert.match(first, new RegExp(`^KW ${kw.week} · `));
  assert.equal(first.split("<!-- arcalo:auto -->").length, 2);
  assert.match(first, /## Zeit\n\n\| Tag \| Gebucht \| Soll \| Differenz \|/);
  assert.match(first, /\| \*\*Woche\*\* \| \*\*[\d,]+ h\*\* \| \*\*40 h\*\* \|/);
  assert.match(first, /\| NP-8801\/1020 \| [^|]+ \| [\d,]+ h \|/);
  assert.match(first, /## Aufgaben[\s\S]*\*\*Erledigt \(\d+\)\*\*[\s\S]*- Angebot Woche \((Mo|Di|Mi|Do|Fr|Sa|So) \d\d\.\d\d\.\) – \[\[Wochen Konzept\]\]/);
  assert.match(first, /\*\*Überfällig \(\d+\)\*\*\n\n[\s\S]*- Alte Sache/);
  assert.match(first, /## Termine\n\n\*\*Mo [^*]+\*\*\n\n[\s\S]*Wochenstart Rückblick \(gebucht\)/);
  assert.match(first, /## Fokus[\s\S]*Fokus Wochenbericht/);
  assert.match(first, /## Seiten\n\n[\s\S]*- \[\[Wochen Konzept\]\] \(neu/);
  // Folders the filing made, templates and the report itself are no work on the week.
  assert.doesNotMatch(first.split("## Seiten")[1], /\[\[(Journal|Vorlagen|\d{4}|Wochenbericht KW[^\]]*)\]\]/);
  assert.doesNotMatch(first, /- \[[ x]\]/, "the report adds no tasks");
  assert.match(first, /## Notizen/);

  // A note of the user, then something changes and the week is saved again: asked, then updated in place.
  await app.invoke("page_save", { id, content: first.replace("## Notizen\n\n", "## Notizen\n\nMeine Notiz zur Woche\n") });
  const np = (await app.invoke("wbs_tree")).flatMap((p) => p.netzplaene).find((n) => n.netzplan_nr === "NP-8801");
  await app.invoke("time_entry_create", { netzplanId: np.id, vorgangNr: "1020", leistungsart: null, startTime: at(0, 16).toISOString(), durationMinutes: 45, description: "Nachtrag Woche" });
  await app.dismissToasts();
  await app.click(".pane.active .wr-save");
  await app.waitText(".dialog .dialog-title", /Wochenbericht aktualisieren\?/);
  await app.click(".dialog .btn-primary");
  await app.waitText(".toast-title", /Wochenbericht aktualisiert/);
  const second = await report(id);
  assert.equal(second.split("<!-- arcalo:auto -->").length, 2, "one generated part");
  assert.match(second, /Meine Notiz zur Woche/);
  assert.notEqual(second, first);
  const titles = (await app.invoke("week_review", { date: mondayIso })).report_page_id;
  assert.equal(titles, id, "no second report");

  // The report page in light and dark.
  await app.dismissToasts();
  await app.click(".pane.active .wr-open-report");
  await app.waitText(".pane.active .ProseMirror h2", /Zeit/);
  await shot("285-week-report-light");
  await setTheme("dark");
  await shot("285-week-report-dark");
  await openWeek();
  await shot("285-week-review-dark");
  await setTheme("light");
  assert.deepEqual(await app.consoleErrors(), []);
});

test("the template „Wochenbericht“ opens from the view", async () => {
  await openWeek();
  await app.click(".pane.active .wr-template");
  await app.browser.waitUntil(async () => (await (await app.$(".pane.active .page-title")).getValue().catch(() => "")) === "Wochenbericht", { timeoutMsg: "template not opened" });
  await app.waitText(".pane.active .ProseMirror", /\{\{rückblick\}\}/);
});

test("narrow panes: the days wrap, nothing scrolls sideways", async () => {
  await openWeek();
  await app.browser.setWindowSize(960, 900);
  await app.browser.pause(400);
  const overflow = await app.browser.execute(() => {
    const v = document.querySelector(".pane.active .view-scroll");
    return v ? v.scrollWidth - v.clientWidth : -1;
  });
  assert.ok(overflow <= 1, `no horizontal overflow (${overflow})`);
  await shot("285-week-review-narrow");
  await app.browser.setWindowSize(1440, 960);
});

test("without time tracking the time part is gone", async () => {
  await patchSettings((s) => ({ ...s, time: { ...s.time, enabled: false } }));
  const r = await app.invoke("week_review", { date: mondayIso });
  assert.equal(r.without_time, true);
  assert.equal(r.time.booked_minutes, 0);
  assert.ok(r.meetings.every((m) => !["booked", "open", "skipped"].includes(m.state)));
  await openWeek();
  await app.browser.waitUntil(async () => !(await app.browser.execute(() => !!document.querySelector(".pane.active .wr-view .rv-stat.tone-time"))), { timeoutMsg: "time stat still shown" });
  assert.equal(await app.browser.execute(() => document.querySelectorAll(".pane.active .wr-days, .pane.active .wr-view .rv-time").length), 0);
  assert.match(await app.text(".pane.active .rv-tasks"), /Angebot Woche/);
  await shot("285-week-review-no-time");
  await app.click(".pane.active .wr-save");
  await app.waitText(".dialog .dialog-title", /Wochenbericht aktualisieren\?/);
  await app.click(".dialog .btn-primary");
  await app.waitText(".toast-title", /Wochenbericht aktualisiert/);
  const content = await report(r.report_page_id);
  assert.doesNotMatch(content.split("<!-- /arcalo:auto -->")[0], /## Zeit|Soll|gebucht\)/);
  assert.match(content, /## Termine/);
  await patchSettings((s) => ({ ...s, time: { ...s.time, enabled: true } }));
});

test("in English", async () => {
  await app.close();
  app = null;
  ({ app, dataDir: enDir } = await launchEnglish());
  await app.invoke("page_create", { parentId: null, title: "Week plan", icon: null, content: "Notes for the week\n" });
  await app.browser.setWindowSize(1440, 960);
  await app.keys(["Control", "k"]);
  await app.waitFor(".palette input");
  await app.type("Weekly review");
  await app.waitText(".pal-item.sel", /^Weekly review/);
  await app.keys(["Enter"]);
  await app.waitFor(".pane.active .wr-view .rv-stats", 15000);
  assert.match(await app.text(".pane.active .wr-view h1"), /^Weekly review$/);
  assert.match(await app.text(".pane.active .wr-date"), new RegExp(`^This week · Week ${kw.week} · `));
  assert.match(await app.text(".pane.active .wr-save"), /Save as weekly report/);
  assert.deepEqual(await germanLeftovers(app, [/Rückblick|Kundentermin|Abstimmung|Müller|Weiß|Zürich/]), []);
  await shot("285-week-review-english");
  await app.click(".pane.active .wr-save");
  await app.waitText(".toast-title", /Weekly report saved/);
  const r = await app.invoke("week_review", { date: mondayIso });
  const page = await app.invoke("page_get", { id: r.report_page_id });
  assert.equal(page.title, `Weekly report week ${pad(kw.week)} ${kw.year}`);
  assert.match(page.content, /## Tasks/);
  assert.match(page.content, /## Pages\n\n[\s\S]*\[\[Week plan\]\]/);
  assert.deepEqual(await app.consoleErrors(), []);
});
