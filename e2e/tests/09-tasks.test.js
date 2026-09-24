// Tasks across all notes: grouped view, filters, toggling rewrites the page, slash "Fälligkeitsdatum".
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
let page;
before(async () => (app = await launch()));
after(async () => app?.close());

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const today = iso(new Date());
const yesterday = iso(new Date(Date.now() - 86400000));
const content = async () => (await app.invoke("page_get", { id: page.id })).content;
const row = (ordinal) => `.tasks-view .task-row[data-page="${page.id}"][data-ordinal="${ordinal}"]`;

test("Ctrl+Shift+A lists tasks from all notes grouped by due date", async () => {
  page = await app.invoke("page_create", {
    parentId: null,
    title: "Aufgaben-Test",
    icon: null,
    content: `# Plan\n\n\`\`\`\n- [ ] im Code\n\`\`\`\n\n- [ ] Angebot an [[Architektur]] senden due:${yesterday} !!\n- [ ] Aufräumen #e2e\n- [x] Schon erledigt\n`,
  });
  await app.keys(["Control", "Shift", "a"]);
  await app.waitFor(".tasks-view");
  await app.waitFor(row(0));
  assert.equal(await app.text(".pane.active .tab.active .tab-title"), "Aufgaben");

  const overdue = await app.$(".task-group-overdue");
  assert.match(await app.textOf(overdue), /Überfällig/);
  assert.match(await app.textOf(await overdue.$(`.task-row[data-page="${page.id}"]`)), /Angebot an Architektur senden/);
  assert.ok(await (await overdue.$(`.task-row[data-page="${page.id}"] .badge-danger`)).isExisting(), "overdue badge is red");
  assert.ok(await (await overdue.$(`.task-row[data-page="${page.id}"] .task-prio.high`)).isExisting(), "priority marker");
  assert.match(await app.textOf(await app.$(".task-group-none")), /Aufräumen/);
  assert.ok(!(await (await app.$(row(2))).isExisting()), "done task hidden under Offen");
  await app.shot("tasks-view");
});

test("filters by status and tag", async () => {
  await app.click('.tasks-view .segmented [role="radio"]:nth-child(2)');
  await app.waitText(".tasks-view .task-row", /Schon erledigt/);
  assert.ok(!(await (await app.$(row(0))).isExisting()));
  await app.click('.tasks-view .segmented [role="radio"]:nth-child(1)');
  await app.waitFor(row(0));
  await app.select(".tasks-view select", "e2e");
  await app.browser.waitUntil(async () => !(await (await app.$(row(0))).isExisting()), { timeoutMsg: "tag filter not applied" });
  assert.ok(await (await app.$(row(1))).isExisting());
  await app.select(".tasks-view select", "");
  await app.waitFor(row(0));
});

test("toggling a task rewrites its checkbox and reloads the open editor", async () => {
  // Page in the left pane, task view in the right one.
  await app.click(`${row(0)} .task-page`);
  await app.waitText(".pane.active .tab.active .tab-title", /Aufgaben-Test/);
  await app.waitFor(".ProseMirror li[data-checked]");
  await app.click('.pane.active .tabbar [aria-label="Rechts teilen"]');
  await app.browser.waitUntil(async () => (await app.$$(".pane")).length === 2);
  await app.keys(["Control", "Shift", "a"]);
  await app.waitFor(row(0));

  await app.click(`${row(0)} .task-check`);
  await app.browser.waitUntil(async () => (await content()).includes(`- [x] Angebot an [[Architektur]] senden due:${yesterday} !!`), {
    timeoutMsg: "page content not rewritten",
  });
  const md = await content();
  assert.match(md, /^- \[ \] Aufräumen #e2e$/m, "other tasks untouched");
  assert.match(md, /^- \[ \] im Code$/m, "code block untouched");
  await app.browser.waitUntil(async () => !(await (await app.$(row(0))).isExisting()), { timeoutMsg: "done task still listed" });
  await app.browser.waitUntil(
    () => app.browser.execute(() => document.querySelector(".pane:first-child .ProseMirror li[data-checked]")?.getAttribute("data-checked") === "true"),
    { timeoutMsg: "editor did not reload" },
  );
});

test("slash menu inserts a due date and the palette opens Aufgaben", async () => {
  // Caret to the end of the last task without clicking (a click could hit the [[link]]).
  await app.browser.execute(() => {
    const el = document.querySelector(".pane:first-child .ProseMirror");
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el.lastElementChild ?? el);
    range.collapse(false);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
  });
  await app.browser.pause(60);
  await app.keys(["End"]);
  await app.keys(["Enter"]);
  // "[ ] " turns the new paragraph into a task item.
  await app.type("[ ] Neue Aufgabe /faellig");
  await app.waitText(".sugg-item.sel", /Fälligkeitsdatum/);
  await app.keys(["Enter"]);
  await app.browser.waitUntil(async () => (await content()).includes(`- [ ] Neue Aufgabe due:${today}`), { timeoutMsg: "due date not saved" });
  await app.waitText(`.tasks-view .task-group-today .task-row[data-page="${page.id}"]`, /Neue Aufgabe/);

  await app.click(".pane:first-child .tab");
  await app.keys(["Control", "k"]);
  await app.waitFor(".palette");
  await app.type("Aufgaben");
  await app.waitText(".pal-item", /Offene Aufgaben aus allen Notizen/);
  for (const it of await app.$$(".pal-item")) if (/Offene Aufgaben aus allen Notizen/.test(await app.textOf(it))) {
      await it.click();
      break;
    }
  await app.browser.waitUntil(async () => (await app.$$(".pane.active .tasks-view")).length === 1);
});
