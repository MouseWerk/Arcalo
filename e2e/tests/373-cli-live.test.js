// The command line (docs/cli.md) on the workspace of the running app, as an AI agent uses it: the
// app's own program started with a command (`arcalo --json pages create …`). The open app shows
// what it writes without a restart (a page in the tree, text and tasks in the open note, the task
// view), and typing in the open editor that is not saved yet is not lost when the command line
// changes the same page.

import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { launch, guarded, APP } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
let page;
before(async () => (app = await launch()));
after(async () => app?.close());

/** Runs the app's program as the command line on the app's workspace; the JSON it prints. */
const cli = (...args) =>
  JSON.parse(
    execFileSync(APP, ["--json", ...args], {
      env: { ...process.env, ARCALO_DATA_DIR: app.dataDir, ARCALO_LOCALE: "de-DE" },
      encoding: "utf8",
      timeout: 30000,
    }),
  );
const SHOWN = ".pane > .pane-content:not([hidden])";
const openTree = async (title) => {
  await app.waitText(".sidebar .tree-row", new RegExp(`^${title}$`), 8000);
  for (const r of await app.$$(".sidebar .tree-row")) if ((await app.textOf(r)) === title) return r.click();
  throw new Error(`no ${title} in the tree`);
};
const stored = async () => (await app.invoke("page_get", { id: page.id })).content;
const count = (text, word) => text.split(word).length - 1;

test("the command line works on the app's workspace", () => {
  const info = cli("info");
  assert.equal(info.data_dir, app.dataDir);
  assert.ok(info.counts.pages > 0, "the demo pages are there");
});

test("a page the command line creates appears in the tree, and appended text in the open note", async () => {
  page = cli("pages", "create", "Aus dem Terminal", "--body", "Erste Zeile vom Agenten\n");
  assert.equal(page.path, "Aus dem Terminal");
  await openTree("Aus dem Terminal");
  await app.waitText(`${SHOWN} .ProseMirror`, /Erste Zeile vom Agenten/);
  cli("pages", "append", `id:${page.id}`, "Zweiter Absatz per Kommandozeile");
  await app.waitText(`${SHOWN} .ProseMirror`, /Zweiter Absatz per Kommandozeile/, 8000);
  await app.shot("cli-live-append");
});

test("tasks the command line adds show in the open note and in Aufgaben", async () => {
  const t = cli("tasks", "add", "Rückruf beim Kunden", "--page", `id:${page.id}`, "--due", "2030-01-15");
  assert.equal(t.due, "2030-01-15");
  await app.waitText(`${SHOWN} .ProseMirror li[data-checked]`, /Rückruf beim Kunden/, 8000);
  await app.keys(["Control", "Shift", "a"]);
  await app.waitFor(`${SHOWN} .tasks-view`);
  await app.waitText(`${SHOWN} .tasks-view .task-row[data-page="${page.id}"]`, /Rückruf beim Kunden/, 8000);
  // The open task view follows a task added while it shows.
  cli("tasks", "add", "Angebot nachfassen", "--page", `id:${page.id}`);
  await app.waitText(`${SHOWN} .tasks-view .task-row[data-page="${page.id}"]`, /Angebot nachfassen/, 8000);
  // Ticked off on the command line: the view shows it done (it leaves the open list).
  cli("tasks", "done", `id:${page.id}`, "0");
  await app.browser.waitUntil(
    async () => !(await app.browser.execute((s) => [...document.querySelectorAll(s)].some((r) => /Rückruf beim Kunden/.test(r.innerText)), `${SHOWN} .tasks-view .task-row[data-page="${page.id}"]`)),
    { timeout: 8000, timeoutMsg: "the done task is still listed as open" },
  );
});

test("typing not saved yet stays when the command line changes the same page", async () => {
  // A long autosave delay, set on the command line (the app takes the settings over): the
  // command line writes while the typed text is not saved yet.
  cli("settings", "set", "editor.autosave_ms", "3000");
  await app.browser.waitUntil(async () => (await app.invoke("settings_get")).settings.editor.autosave_ms === 3000, {
    timeout: 8000,
    timeoutMsg: "the app did not take over the settings of the command line",
  });
  await openTree("Aus dem Terminal");
  await app.waitText(`${SHOWN} .ProseMirror`, /Angebot nachfassen/);
  await app.caretToEnd();
  await app.keys(["Enter"]);
  await app.type("Getippt und noch nicht gespeichert");
  cli("pages", "append", `id:${page.id}`, "Parallel vom Agenten");
  // The open note shows both: the agent's text came in, the typing stayed.
  await app.browser.waitUntil(
    async () => {
      const t = await app.text(`${SHOWN} .ProseMirror`);
      return /Parallel vom Agenten/.test(t) && /Getippt und noch nicht gespeichert/.test(t);
    },
    { timeout: 10000, timeoutMsg: "the note does not show the typed text and the agent's text" },
  );
  // Stored with both, each once, after the autosave.
  await app.browser.waitUntil(async () => {
    const c = await stored();
    return /Parallel vom Agenten/.test(c) && /Getippt und noch nicht gespeichert/.test(c);
  }, { timeout: 10000, timeoutMsg: "not both texts stored" });
  const c = await stored();
  assert.equal(count(c, "Getippt und noch nicht gespeichert"), 1, c);
  assert.equal(count(c, "Parallel vom Agenten"), 1, c);
  assert.equal(count(c, "Zweiter Absatz per Kommandozeile"), 1, c);
  // The text before the command line's change is kept as a version (undo in the app).
  const versions = await app.invoke("page_versions", { pageId: page.id });
  assert.ok(versions.length >= 1, "no version kept");
  assert.deepEqual(await app.consoleErrors(), []);
  await app.shot("cli-live-merged");
});

test("a page the command line trashes leaves the tree", async () => {
  const other = cli("pages", "create", "Kurzlebig");
  await app.waitText(".sidebar .tree-row", /^Kurzlebig$/, 8000);
  assert.equal(cli("pages", "delete", `id:${other.id}`).trashed, 1);
  await app.browser.waitUntil(
    async () => !(await app.browser.execute(() => [...document.querySelectorAll(".sidebar .tree-row")].some((r) => r.innerText.trim() === "Kurzlebig"))),
    { timeout: 8000, timeoutMsg: "the trashed page is still in the tree" },
  );
});
