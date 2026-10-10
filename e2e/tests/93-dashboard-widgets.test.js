// Start page 1.6, the widgets: „Heute“ with a meeting running now (timeline, now marker, the
// meeting and its time left), ticking a task off and starting the timer; the custom query
// widget built in its settings (list, chart, number); every other widget on one board with
// real data; and the move of the widget list of 1.5 onto a board.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { launch, guarded } from "../lib/harness.js";
import { iso, writeMeetingNow } from "../lib/calendar-fixtures.js";

const test = guarded(nodeTest, () => app);
let app;
let fx;
let fx2;
before(async () => {
  fx = writeMeetingNow("Jour fixe Kunde X");
  fx2 = writeMeetingNow("Zweitkalender Termin");
  app = await launch();
  await app.invoke("calendar_source_add", { name: "Heute", url: null, path: fx.file });
  await app.invoke("calendar_source_add", { name: "Zweit", url: null, path: fx2.file });
  await app.invoke("calendar_sync_now", { source: null });
  await app.browser.waitUntil(async () => (await app.invoke("calendar_status")).sources.every((s) => !s.enabled || (s.status?.synced_at && !s.syncing)), { timeout: 20000, timeoutMsg: "not synced" });
});
after(async () => {
  await app?.close();
  for (const f of [fx, fx2]) if (f) fs.rmSync(f.dir, { recursive: true, force: true });
});

const reload = async () => {
  await app.browser.execute(() => location.reload());
  await app.browser.pause(300);
  await app.browser.waitUntil(() => app.browser.execute(() => document.body.classList.contains("ready")), { timeout: 20000, timeoutMsg: "not ready after reload" });
};
const clickText = async (sel, text) => {
  await app.browser.waitUntil(
    () =>
      app.browser.execute(
        (s, t) => {
          const el = [...document.querySelectorAll(s)].find((b) => b.textContent.trim() === t && !b.disabled);
          el?.click();
          return !!el;
        },
        sel,
        text,
      ),
    { timeoutMsg: `no ${sel} „${text}“` },
  );
  await app.browser.pause(80);
};
const saved = async () => (await app.invoke("settings_get")).settings.dashboard;
const W = (id, kind, x, y, w, h, config = {}) => ({ id, kind, x, y, w, h, config });

test("Heute shows the running meeting on the timeline with the now marker", async () => {
  await app.keys(["Control", "t"]);
  await app.waitFor('.pane.active > .pane-content:not([hidden]) .dw[data-widget="today"] .dw-today');
  await app.waitText('.pane.active > .pane-content:not([hidden]) [data-widget="today"] .dw-next.live', /Läuft[\s\S]*Jour fixe Kunde X/, 15000);
  assert.match(await app.text('.pane.active > .pane-content:not([hidden]) [data-widget="today"] .dw-next'), /noch \d+ Min\./);
  assert.ok(await (await app.$('.pane.active > .pane-content:not([hidden]) [data-widget="today"] .dw-tl-ev.live')).isExisting(), "running meeting on the timeline");
  assert.ok(await (await app.$('.pane.active > .pane-content:not([hidden]) [data-widget="today"] .dw-tl-ev.past')).isExisting(), "the earlier meeting is past");
  assert.ok(await (await app.$('.pane.active > .pane-content:not([hidden]) [data-widget="today"] .dw-tl-now')).isExisting(), "now marker");
  // The greeting, the date with the calendar week and the booked hours against the target.
  assert.match(await app.text('.pane.active > .pane-content:not([hidden]) [data-widget="today"] .dw-today-head'), /Guten (Morgen|Tag|Abend)[\s\S]*KW \d+/);
  assert.ok(await (await app.$('.pane.active > .pane-content:not([hidden]) [data-widget="today"] .dw-ring')).isExisting());
  // „Termine“ next to it lists both, the running one marked.
  await app.waitText('.pane.active > .pane-content:not([hidden]) [data-widget="agenda"] .dw-agenda-item.live', /Jour fixe Kunde X/);
  await app.shot("93-heute-meeting");
});

test("a calendar hidden in the Kalender's legend is hidden in „Heute“ and „Termine“ too", async () => {
  const titles = (sel) => app.browser.execute((s) => [...document.querySelectorAll(s)].map((e) => e.textContent.trim()), sel);
  await app.waitText('.pane.active > .pane-content:not([hidden]) [data-widget="agenda"] .dw-agenda-title', /Zweitkalender Termin/);
  const src = (await app.invoke("settings_get")).settings.calendar.sources.find((x) => x.name === "Heute");
  await app.keys(["Control", "Shift", "e"]);
  await app.waitFor(`.pane.active > .pane-content:not([hidden]) .calv-legend-item[data-source="ics:${src.id}"]`);
  await app.click(`.pane.active > .pane-content:not([hidden]) .calv-legend-item[data-source="ics:${src.id}"]`);
  await app.click(".pane.active .tab.active .tab-close");
  await app.keys(["Control", "t"]);
  await app.waitText('.pane.active > .pane-content:not([hidden]) [data-widget="agenda"] .dw-agenda-title', /Zweitkalender Termin/);
  assert.ok(!(await titles('.pane.active > .pane-content:not([hidden]) [data-widget="agenda"] .dw-agenda-title')).some((x) => /Jour fixe Kunde X/.test(x)), "hidden calendar in Termine");
  assert.ok(!(await titles('.pane.active > .pane-content:not([hidden]) [data-widget="today"] .dw-tl-ev')).some((x) => /Jour fixe Kunde X/.test(x)), "hidden calendar on the timeline");
  assert.match(await app.text('.pane.active > .pane-content:not([hidden]) [data-widget="today"] .dw-next'), /Zweitkalender Termin/);
  // Shown again in the Kalender: back on the start page at once.
  await app.keys(["Control", "Shift", "e"]);
  await app.click(`.pane.active > .pane-content:not([hidden]) .calv-legend-item[data-source="ics:${src.id}"]`);
  await app.click(".pane.active .tab.active .tab-close");
  await app.keys(["Control", "t"]);
  await app.waitText('.pane.active > .pane-content:not([hidden]) [data-widget="agenda"] .dw-agenda-title', /Jour fixe Kunde X/);
});

test("Heute: a task is ticked off inline, the timer starts and stops", async () => {
  const daily = await app.invoke("daily_note", { date: null });
  await app.invoke("page_save", { id: daily.id, content: "# Heute\n\n- [ ] Angebot schicken !!\n- [ ] Rückruf Müller" });
  // As the editor does after a save.
  await app.browser.execute((id) => window.dispatchEvent(new CustomEvent("arcalo:page-saved", { detail: { id, content: "", from: "test" } })), daily.id);
  await app.waitText('.pane.active > .pane-content:not([hidden]) [data-widget="today"] .dw-task', /Angebot schicken/, 10000);
  await app.click('.pane.active > .pane-content:not([hidden]) [data-widget="today"] [aria-label^="Erledigt: Angebot schicken"]');
  await app.browser.waitUntil(async () => /- \[x\] Angebot schicken/.test((await app.invoke("page_get", { id: daily.id })).content), { timeoutMsg: "not ticked" });
  await app.browser.waitUntil(async () => !/Angebot schicken/.test(await app.text('.pane.active > .pane-content:not([hidden]) [data-widget="today"] .dw-today-tasks')), { timeoutMsg: "still listed" });
  await app.click('.pane.active > .pane-content:not([hidden]) [data-widget="today"] .dw-start');
  await app.waitFor('.pane.active > .pane-content:not([hidden]) [data-widget="today"] .dw-timer.running');
  assert.ok(await app.invoke("timer_status"));
  await clickText('.pane.active > .pane-content:not([hidden]) [data-widget="today"] button', "Stoppen");
  await app.browser.waitUntil(async () => (await app.invoke("timer_status")) === null, { timeoutMsg: "timer still running" });
});

test("the custom query widget: built in its settings with a live preview, as list, chart and number", async () => {
  await app.invoke("page_create", { title: "Abfrage93", parentId: null, icon: null, content: "- [ ] Eins #q93 !!\n- [ ] Zwei #q93 !!\n- [ ] Drei #q93" });
  await clickText(".pane.active > .pane-content:not([hidden]) .dash-bar button", "Anpassen");
  await clickText(".pane.active > .pane-content:not([hidden]) .dash-bar button", "Widget hinzufügen");
  await app.click('.dash-gallery-card[data-kind="query"]');
  await app.waitFor('.pane.active > .pane-content:not([hidden]) .dw[data-widget="query"]');
  await app.click('.pane.active > .pane-content:not([hidden]) .dw[data-widget="query"] [aria-label="Einstellungen"]');
  await app.waitFor(".dialog .dws-query");
  await (await app.$(".dialog .dws input")).setValue("Top-Aufgaben");
  await (await app.$(".dialog .dws-query")).click();
  await app.type("#q93 prio: hoch");
  await app.waitText(".dialog .dws-chips", /#q93[\s\S]*prio\s+ist\s+hoch/);
  await app.waitText(".dialog .dws-preview-head", /2 Treffer/);
  await app.waitText(".dialog .dws-preview-body", /Eins[\s\S]*Zwei/);
  await app.shot("93-query-builder");
  await clickText(".dialog-foot button", "Übernehmen");
  await clickText(".pane.active > .pane-content:not([hidden]) .dash-bar button", "Fertig");
  await app.browser.waitUntil(async () => (await app.browser.execute(() => document.querySelector('.pane.active > .pane-content:not([hidden]) .dw[data-widget="query"] .dw-head h2')?.textContent)) === "Top-Aufgaben", { timeoutMsg: "own title not shown" });
  await app.waitText('.pane.active > .pane-content:not([hidden]) .dw[data-widget="query"] .dw-task', /Eins/);
  // Ticking one off in the list updates the widget.
  await app.click('.pane.active > .pane-content:not([hidden]) .dw[data-widget="query"] [aria-label^="Erledigt: Eins"]');
  await app.browser.waitUntil(async () => !/Eins/.test(await app.text('.pane.active > .pane-content:not([hidden]) .dw[data-widget="query"]')), { timeoutMsg: "done task still listed" });
  // As a bar chart grouped by priority, then as a number.
  const d = await saved();
  const board = d.boards.find((b) => b.id === d.active);
  const q = board.widgets.find((w) => w.id === "query");
  assert.deepEqual(q.config.query.filters, [{ field: "prio", op: "ist", value: "hoch" }]);
  assert.equal(q.config.query.tag, "q93");
  const chart = { ...q, config: { ...q.config, display: "bar", query: { ...q.config.query, filters: [], group: "prio" } } };
  await app.invoke("dashboard_save", { dashboard: { ...d, boards: d.boards.map((b) => (b.id === board.id ? { ...b, widgets: b.widgets.map((w) => (w.id === "query" ? chart : w)) } : b)) } });
  await reload();
  await app.waitFor('.pane.active > .pane-content:not([hidden]) .dw[data-widget="query"] .dw-chart svg');
  assert.match(await app.browser.execute(() => document.querySelector('.pane.active > .pane-content:not([hidden]) .dw[data-widget="query"] .dw-chart svg').getAttribute("aria-label")), /hoch: 1, keine: 1/);
  await app.browser.execute(() => {
    const el = document.querySelector('.pane.active > .pane-content:not([hidden]) .dw[data-widget="query"]');
    const home = el.closest(".home");
    home.scrollTop += el.getBoundingClientRect().top - home.getBoundingClientRect().top - 100;
  });
  await app.shot("93-query-chart");
  const d2 = await saved();
  const num = d2.boards.map((b) => ({ ...b, widgets: b.widgets.map((w) => (w.id === "query" ? { ...w, config: { ...w.config, display: "number" } } : w)) }));
  await app.invoke("dashboard_save", { dashboard: { ...d2, boards: num } });
  await reload();
  await app.waitText('.pane.active > .pane-content:not([hidden]) .dw[data-widget="query"] .dw-number', /^2\s*Aufgaben/);
});

test("every widget shows real data on one board", async () => {
  const tree = await app.invoke("wbs_tree");
  const np = tree[0].netzplaene[0];
  const page = await app.invoke("page_create", { title: "Eingebettet93", parentId: null, icon: null, content: "# Plan\n\nDer **Plan** mit [[Architektur]].\n\n- Punkt eins" });
  const boards = [
    {
      id: "alle",
      name: "Alle",
      widgets: [
        W("budget", "budget", 0, 0, 4, 7, { mode: "worst", count: 3, forecast: true }),
        W("project", "project", 4, 0, 8, 9, { netzplan: np.id }),
        W("tasks", "tasks", 0, 7, 4, 7, { due: "any", priority: 0, add: true }),
        W("week", "week", 4, 9, 5, 6, { mode: "wbs" }),
        W("proposal", "proposal", 9, 9, 3, 6),
        W("review", "review", 0, 14, 4, 7, { workday: false }),
        W("activity", "activity", 4, 15, 4, 7),
        W("embed", "embed", 8, 15, 4, 7, { page: page.id }),
        W("pinned", "pinned", 0, 21, 3, 5, { pages: [page.id] }),
        W("clock", "clock", 3, 22, 3, 4),
        W("calendar", "calendar", 6, 22, 3, 8),
        W("suggestions", "suggestions", 9, 22, 3, 6),
        W("favorites", "favorites", 0, 26, 3, 5),
        W("links", "links", 3, 26, 3, 4),
        W("focus", "focus", 9, 28, 3, 6),
      ],
    },
  ];
  await app.invoke("dashboard_save", { dashboard: { version: 2, boards, active: "alle", notes: {} } });
  await reload();
  await app.waitFor('.pane.active > .pane-content:not([hidden]) .dw[data-widget="budget"] .dw-budget');
  await app.waitText('.pane.active > .pane-content:not([hidden]) .dw[data-widget="budget"] .dw-budget-fc', /h\/Tag|Aufgebraucht|Keine Buchungen|Ohne geplante/);
  await app.waitText('.pane.active > .pane-content:not([hidden]) .dw[data-widget="project"] .dw-project-head', new RegExp(np.netzplan_nr));
  await app.waitText('.pane.active > .pane-content:not([hidden]) .dw[data-widget="tasks"]', /Rückruf Müller/);
  await app.waitFor('.pane.active > .pane-content:not([hidden]) .dw[data-widget="week"] .dw-wbs-row, .pane.active > .pane-content:not([hidden]) .dw[data-widget="week"] .dw-empty');
  await app.waitText('.pane.active > .pane-content:not([hidden]) .dw[data-widget="proposal"]', /Woche vorschlagen/);
  await app.waitText('.pane.active > .pane-content:not([hidden]) .dw[data-widget="embed"] .dw-md strong', /Plan/);
  await app.waitText('.pane.active > .pane-content:not([hidden]) .dw[data-widget="pinned"] .dw-page', /Eingebettet93/);
  await app.waitText('.pane.active > .pane-content:not([hidden]) .dw[data-widget="clock"] .dw-clock-time', /\d{2}:\d{2}/);
  await app.browser.execute(() => {
    const el = document.querySelector('.pane.active > .pane-content:not([hidden]) .dw[data-widget="focus"]');
    const home = el.closest(".home");
    home.scrollTop += el.getBoundingClientRect().top - home.getBoundingClientRect().top - 100;
  });
  await app.waitText('.pane.active > .pane-content:not([hidden]) .dw[data-widget="focus"]', /Sitzung/);
  await app.waitFor(`.pane.active > .pane-content:not([hidden]) .dw[data-widget="calendar"] .dw-cal-day[data-date="${iso(new Date())}"]`);
  await app.waitFor('.pane.active > .pane-content:not([hidden]) .dw[data-widget="suggestions"] .dw-suggest-row');
  // No widget shows an error.
  assert.equal((await app.$$(".pane.active > .pane-content:not([hidden]) .dw-error")).length, 0);
  // The embedded page follows an edit.
  await app.invoke("page_save", { id: page.id, content: "# Plan\n\nNeuer Stand 93" });
  await app.browser.execute(() => window.dispatchEvent(new CustomEvent("arcalo:page-saved", { detail: { id: 0 } })));
  await app.waitText('.pane.active > .pane-content:not([hidden]) .dw[data-widget="embed"] .dw-md', /Neuer Stand 93/, 10000);
  // Adding a task in the „Aufgaben“ widget puts it into the daily note.
  const add = await app.$('.pane.active > .pane-content:not([hidden]) .dw[data-widget="tasks"] .dw-add');
  await add.click();
  await app.type("Neu aus dem Widget");
  await app.keys(["Enter"]);
  await app.waitText('.pane.active > .pane-content:not([hidden]) .dw[data-widget="tasks"] .dw-task', /Neu aus dem Widget/, 10000);
  await app.browser.execute(() => document.querySelector(".home").scrollTo(0, 0));
  await app.shot("93-all-widgets");
  assert.deepEqual(await app.consoleErrors(), []);
});

test("the widget list of 1.5 moves onto a board with the same widgets and its note", async () => {
  const legacy = {
    widgets: [
      { id: "today", kind: "today", size: "m" },
      { id: "week", kind: "week", size: "m" },
      { id: "budgets", kind: "budgets", size: "s" },
      { id: "note", kind: "note", size: "l" },
    ],
    note: "Alter Merkzettel",
  };
  const view = await app.invoke("dashboard_save", { dashboard: legacy });
  assert.equal(view.settings.dashboard.boards.length, 0, "stored as it came");
  await reload();
  await app.waitFor('.pane.active > .pane-content:not([hidden]) .dw[data-widget="note"] textarea');
  assert.equal(await (await app.$('.pane.active > .pane-content:not([hidden]) .dw[data-widget="note"] textarea')).getValue(), "Alter Merkzettel");
  await app.browser.waitUntil(async () => (await saved()).boards.length === 1, { timeoutMsg: "not moved" });
  const d = await saved();
  assert.deepEqual(d.boards[0].widgets.map((w) => [w.id, w.kind, w.w]), [
    ["today", "today", 6],
    ["week", "week", 6],
    ["budgets", "budget", 3],
    ["note", "note", 12],
  ]);
  assert.equal(d.notes.note, "Alter Merkzettel");
  assert.equal(d.widgets, undefined, "the old list is gone after the move");
});
