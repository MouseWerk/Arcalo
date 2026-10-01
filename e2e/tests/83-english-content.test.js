// What Annalo writes and says in English: the daily note's sections, a new page's title, the
// delete toast, core error messages, the dashboard query with English words, and a live switch
// to German and back (UI and core follow at once).
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { guarded } from "../lib/harness.js";
import { launchEnglish, germanLeftovers } from "../lib/english.js";

const test = guarded(nodeTest, () => app);
let app;
let dataDir;
before(async () => {
  ({ app, dataDir } = await launchEnglish());
});
after(async () => {
  await app?.close();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

const today = () => new Date().toISOString().slice(0, 10);
/** The error text of a failing command. */
async function failure(cmd, args) {
  try {
    await app.invoke(cmd, args);
  } catch (e) {
    return String(e?.message ?? e);
  }
  throw new Error(`${cmd} did not fail`);
}

test("the daily note is written in English", async () => {
  await app.dismissToasts();
  await app.click('.ribbon [aria-label^="Today\'s daily note"]');
  await app.waitFor(".pane.active .ProseMirror h2");
  const heads = await app.browser.execute(() => [...document.querySelectorAll(".pane.active .ProseMirror h2")].map((h) => h.textContent));
  assert.deepEqual(heads.slice(0, 2), ["Focus", "Notes"]);
  await app.shot("en-83-daily");
});

test("/time books in English, and an English due word becomes the date", async () => {
  // The slash menu offers the English command.
  await app.caretToEnd();
  await app.keys(["Enter"]);
  await app.type("/time");
  await app.waitFor(".sugg .sugg-item");
  assert.match(await app.text(".sugg"), /\/time/);
  await app.keys(["Escape"]);
  for (let i = 0; i < 5; i++) await app.keys(["Backspace"]);
  // `/time` with English words: a duration, a date word.
  await app.type("/time NP-8801/1020 1.5h english review @yesterday");
  await app.keys(["Escape"]);
  await app.keys(["Enter"]);
  await app.waitFor(".pane.active .ProseMirror .time-chip");
  await app.waitText(".toast-title", /h booked/);
  const e = (await app.invoke("time_entries", { from: null, to: null })).find((x) => x.description === "english review");
  assert.ok(e, "entry booked");
  assert.equal(e.duration_minutes, 90);
  assert.equal(new Date(e.start_time).toDateString(), new Date(Date.now() - 86400000).toDateString(), e.start_time);
  // A task with `due:tomorrow` gets tomorrow's date.
  await app.caretToEnd();
  await app.keys(["Enter"]);
  await app.type("[ ] call Bob due:tomorrow ");
  const next = new Date(Date.now() + 86400000);
  const tomorrow = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-${String(next.getDate()).padStart(2, "0")}`;
  await app.browser.waitUntil(async () => (await app.text(".pane.active .ProseMirror")).includes(`due:${tomorrow}`), { timeoutMsg: "due:tomorrow not resolved" });
  await app.shot("en-83-time-due");
});

test("a new page, its deletion and the undo are English", async () => {
  await app.dismissToasts();
  await app.click('.ribbon [aria-label^="New page"]');
  await app.browser.waitUntil(async () => (await app.browser.execute(() => document.querySelector(".pane.active .page-title")?.value)) === "Untitled", {
    timeoutMsg: "new page is not “Untitled”",
  });
  await app.click('.pane.active [aria-label="More actions"]');
  await app.waitFor(".menu");
  await app.click(".menu-item.danger");
  await app.waitText(".toast", /Page deleted/);
  assert.match(await app.text(".toast"), /“Untitled” is in the trash/);
  assert.match(await app.text(".toast"), /Undo/);
  await app.shot("en-83-deleted");
  assert.deepEqual(await germanLeftovers(app), []);
});

test("core messages are English", async () => {
  assert.match(await failure("page_get", { id: 987654 }), /not found/i);
  assert.doesNotMatch(await failure("page_get", { id: 987654 }), /nicht|gefunden|Seite/);
});

test("the dashboard query takes English words and gives the German result", async () => {
  const run = async (filters) => {
    const r = await app.invoke("dashboard_data", { request: { today: today(), parts: [{ key: "q", part: { kind: "query", query: { source: "tasks", filters } } }] } });
    return r.parts.q;
  };
  const en = await run([{ field: "status", op: "is", value: "open" }]);
  const de = await run([{ field: "status", op: "ist", value: "offen" }]);
  assert.equal(en.error, undefined, en.error);
  assert.ok(de.total > 0, "the English demo has open tasks");
  assert.equal(en.total, de.total);
  const due = await run([{ field: "due", op: "is", value: "overdue" }]);
  const faellig = await run([{ field: "fällig", op: "ist", value: "überfällig" }]);
  assert.equal(due.total, faellig.total);
});

test("switching to German and back takes effect at once, in the UI and the core", async () => {
  await app.dismissToasts();
  await app.click('.ribbon [aria-label^="Settings"]');
  await app.click('.settings-nav-item[data-section="locale"]');
  await app.click('[role="radiogroup"] [role="radio"]:first-child');
  await app.browser.waitUntil(async () => (await app.invoke("settings_get")).settings.locale.language === "de", { timeoutMsg: "German not saved" });
  await app.browser.waitUntil(async () => app.browser.execute(() => [...document.querySelectorAll(".ribbon [aria-label]")].some((b) => /^Einstellungen/.test(b.getAttribute("aria-label")))), {
    timeoutMsg: "UI not German",
  });
  assert.match(await failure("page_get", { id: 987654 }), /nicht gefunden/);
  await app.shot("en-83-german");
  await app.click('[role="radiogroup"] [role="radio"]:last-child');
  await app.browser.waitUntil(async () => (await app.invoke("settings_get")).settings.locale.language === "en", { timeoutMsg: "English not saved" });
  await app.browser.waitUntil(async () => app.browser.execute(() => [...document.querySelectorAll(".ribbon [aria-label]")].some((b) => /^Settings/.test(b.getAttribute("aria-label")))), {
    timeoutMsg: "UI not English again",
  });
  assert.match(await failure("page_get", { id: 987654 }), /not found/i);
  assert.deepEqual(await app.consoleErrors(), []);
});
