// The window left open over midnight (q124 round 5): the next morning the views show the new
// day without a restart or a change of data. The sidebar's „Heute“ hours start at zero, the
// task due yesterday is overdue, a query of the tasks due today in an open note asks for the new
// day, and the Zeiterfassung marks the new day. The window's clock is moved forward
// (`shiftWindowClock`); the views notice the new day by themselves, while the window is shown.
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
const SHOWN = ".pane.active > .pane-content:not([hidden])";
const fence = (body) => "```query\n" + body + "\n```";

before(async () => {
  app = await launch({ demo: false });
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
const queryText = () => app.browser.execute((s) => document.querySelector(`${s} .qb`)?.textContent ?? "", SHOWN);

test("the views open in the evening show the new day the next morning", { timeout: 120000 }, async () => {
  // The note with the query, then the task list and the Zeiterfassung in tabs of their own.
  await app.invoke("search_open", { target: { kind: "page", page_id: page.id, new_tab: false } });
  await app.browser.waitUntil(async () => (await queryText()).includes("Angebot schicken"), { timeoutMsg: "the query does not list the task due today" });
  await app.keys(["Control", "Shift", "a"]);
  await app.waitFor(`${SHOWN} .tasks-view .task-group-today .task-row[data-page="${page.id}"]`);
  await app.click(".side-foot-btn");
  await app.waitFor(`${SHOWN} .week-grid th.today`);
  await app.browser.waitUntil(async () => /2\s*h/.test(await badge()), { timeoutMsg: "the sidebar does not show today's 2 h" });

  // The next morning.
  await shiftWindowClock(app, DAY);
  const tomorrow = await windowDay(app);
  assert.notEqual(tomorrow, today);
  await app.browser.waitUntil(async () => (await badge()) === "", { timeout: 45000, timeoutMsg: "„Heute“ in the sidebar still shows yesterday's hours" });
  // The Zeiterfassung (shown) no longer marks yesterday as today (the new day is marked when it
  // is in the week shown, not on the first day of a week).
  const marked = () => app.browser.execute((s) => [...document.querySelectorAll(`${s} .week-grid th.today`)].map((th) => th.getAttribute("aria-label")), SHOWN);
  const dayIn = (d) => `, ${Number(d.slice(8))}. `;
  await app.browser.waitUntil(async () => !(await marked()).some((l) => l.includes(dayIn(today))), { timeout: 15000, timeoutMsg: "the Zeiterfassung still marks yesterday" });
  // The task list (in its tab): the task due yesterday is overdue now.
  await app.keys(["Control", "Shift", "a"]);
  await app.waitFor(`${SHOWN} .tasks-view .task-group-overdue .task-row[data-page="${page.id}"]`, 15000);
  // The note: the tasks due today are those of the new day (none).
  await app.invoke("search_open", { target: { kind: "page", page_id: page.id, new_tab: false } });
  await app.browser.waitUntil(async () => !(await queryText()).includes("Angebot schicken"), { timeout: 15000, timeoutMsg: "the query still lists yesterday's tasks as due today" });
});
