// The window left open over midnight (q124 round 5): the next morning the views show the new
// day without a restart, a click or a change of data. The sidebar's „Heute“ hours start at zero,
// the task due yesterday is overdue in the task list, a query of the tasks due today in an open
// note asks for the new day, and the Zeiterfassung marks the new day. The window's clock is
// moved forward (`shiftWindowClock`); the views notice the new day by themselves.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";
import { shiftWindowClock, windowDay } from "../lib/clock.js";

const test = guarded(nodeTest, () => app);
let app;
let page;
const DAY = 24 * 3600 * 1000;
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const today = iso(new Date());
const fence = (body) => "```query\n" + body + "\n```";

before(async () => {
  app = await launch();
  page = await app.invoke("page_create", {
    parentId: null,
    title: "Mitternacht",
    icon: null,
    content: `- [ ] Angebot schicken due:${today}\n\n${fence("from: tasks\nshow: table\nfällig: heute")}\n`,
  });
  await app.invoke("log_time", { line: "/zeit NP-8801/1020 2h 'Vor Mitternacht'", pageId: null });
  await app.reload();
});
after(async () => app?.close());

const badge = () => app.browser.execute(() => document.querySelector(".side-foot-btn .nav-badge")?.textContent ?? "");
const LEFT = ".pane:first-child > .pane-content:not([hidden])";
const RIGHT = ".pane:last-child > .pane-content:not([hidden])";
const queryText = () => app.browser.execute((s) => document.querySelector(`${s} .qb`)?.textContent ?? "", LEFT);
const marked = () => app.browser.execute((s) => [...document.querySelectorAll(`${s} .week-grid th.today`)].map((th) => th.getAttribute("aria-label")), RIGHT);
const dayIn = (d) => `, ${Number(d.slice(8))}. `;

test("the views open in the evening show the new day the next morning", { timeout: 120000 }, async () => {
  // The note with the query on the left, the task list on the right; both stay in view.
  await app.invoke("search_open", { target: { kind: "page", page_id: page.id, new_tab: false } });
  await app.browser.waitUntil(async () => (await queryText()).includes("Angebot schicken"), { timeoutMsg: "the query does not list the task due today" });
  await app.click('.pane.active .tabbar [aria-label="Rechts teilen"]');
  await app.browser.waitUntil(async () => (await app.$$(".pane")).length === 2);
  await app.keys(["Control", "Shift", "a"]);
  await app.waitFor(`${RIGHT} .tasks-view .task-group-today .task-row[data-page="${page.id}"]`);
  await app.browser.waitUntil(async () => /\d\s*h/.test(await badge()), { timeoutMsg: "the sidebar does not show today's hours" });

  // The next morning, nothing touched.
  await shiftWindowClock(app, DAY);
  assert.notEqual(await windowDay(app), today);
  await app.browser.waitUntil(async () => (await badge()) === "", { timeout: 45000, timeoutMsg: "„Heute“ in the sidebar still shows yesterday's hours" });
  await app.waitFor(`${RIGHT} .tasks-view .task-group-overdue .task-row[data-page="${page.id}"]`, 15000);
  await app.browser.waitUntil(async () => !(await queryText()).includes("Angebot schicken"), { timeout: 15000, timeoutMsg: "the query still lists yesterday's tasks as due today" });
});

test("the Zeiterfassung left open marks the new day", { timeout: 120000 }, async () => {
  await app.click(".side-foot-btn");
  await app.waitFor(`${RIGHT} .week-grid th.today`);
  const before = await windowDay(app);
  assert.ok((await marked()).some((l) => l.includes(dayIn(before))), "today is marked");
  await shiftWindowClock(app, 2 * DAY);
  const now = await windowDay(app);
  // The day before is no longer marked (the new one is, when it is in the week shown).
  await app.browser.waitUntil(async () => !(await marked()).some((l) => l.includes(dayIn(before))), { timeout: 45000, timeoutMsg: "the Zeiterfassung still marks yesterday" });
  assert.ok((await marked()).every((l) => l.includes(dayIn(now))));
});
