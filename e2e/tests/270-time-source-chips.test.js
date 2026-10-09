// 1.13 time tracking: removing a /zeit chip in the Markdown source view removes its booking
// like the rich editor (undo toast, undo in the text box, exported bookings kept, cut and paste
// into another note keeps it), and a booking that comes back after the toast closed (undo,
// „Erneut buchen“) keeps its Jira worklog: the queued deletion is cancelled, or the worklog is
// posted once more and its new id stored (never two worklogs, never an orphan).
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";
import { startFakeJira } from "../lib/fake-jira.js";

const test = guarded(nodeTest, () => app);
let app, jira;

before(async () => {
  jira = await startFakeJira({ flavor: "cloud" });
  app = await launch({ env: { ARCALO_JIRA_DELAY_SECS: "600" } });
  const site = { id: "", name: "Acme", color: "", kind: "cloud", url: jira.url, email: "mia@firma.de", enabled: true, log_work: true, allow_writes: false };
  await app.invoke("jira_site_save", { site, token: "secret-token" });
  await app.invoke("jira_sync_now", { site: "acme" });
  await app.invoke("jira_wbs_set", { kind: "project", key: "PROJ", reference: "NP-8801/1020" });
});
after(async () => {
  await app?.close();
  await jira?.close();
});

const until = (f, msg, timeout = 8000) => app.browser.waitUntil(f, { timeout, timeoutMsg: msg });
const pageOf = async (title) => (await app.invoke("page_resolve", { title, create: false })).id;
const content = async (title) => (await app.invoke("page_get", { id: await pageOf(title) })).content;
const entry = async (id) => (await app.invoke("time_entries", { from: null, to: null })).find((e) => e.id === id);
const chipRe = /<time-entry id="(\d+)"[^>]*>[^<]*<\/time-entry>/;
const emit = (event) => app.browser.executeAsync((e, done) => window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: e, payload: null }).then(done, done), event);
const link = async (id) => (await app.invoke("jira_entry_issues", { entryIds: [id] }))[0];
const chips = () => app.browser.execute(() => [...document.querySelectorAll(".pane.active > .pane-content:not([hidden]) .ProseMirror .time-chip")].map((c) => c.dataset.chip ?? ""));
const clickText = async (sel, label) => {
  for (const el of await app.$$(sel)) if ((await app.textOf(el)) === label) return el.click();
  throw new Error(`no ${sel} reading ${label}`);
};
const chipMenu = async (label) => {
  await (await app.$(".pane.active > .pane-content:not([hidden]) .ProseMirror .time-chip")).click();
  await app.waitFor(".menu");
  await clickText(".menu .menu-item", label);
};

/** A new note `title` with a booked chip of `line`; returns the booking id. */
async function noteWithChip(title, line) {
  await app.keys(["Control", "n"]);
  await until(() => app.browser.execute(() => document.activeElement?.classList.contains("page-title") && document.activeElement.selectionEnd > 0), "new note");
  await app.type(title);
  await app.keys(["Enter"]);
  await app.type(line);
  await app.keys(["Escape"]);
  await app.keys(["Enter"]);
  await app.waitFor(".pane.active > .pane-content:not([hidden]) .ProseMirror .time-chip");
  await until(async () => chipRe.test(await content(title)), "chip saved");
  await until(async () => (await chips())[0] === "linked", "chip linked");
  return Number(chipRe.exec(await content(title))[1]);
}

const source = () => app.waitFor(".pane.active > .pane-content:not([hidden]) .source-text");
const sourceValue = () => app.browser.execute(() => document.querySelector(".pane.active > .pane-content:not([hidden]) .source-text").value);
/** Selects the first chip in the source text box (focused). */
const selectChip = () =>
  app.browser.execute(() => {
    const t = document.querySelector(".pane.active > .pane-content:not([hidden]) .source-text");
    const m = /<time-entry[^>]*>[^<]*<\/time-entry>/.exec(t.value);
    t.focus();
    t.setSelectionRange(m.index, m.index + m[0].length);
  });
/** Sets the source text to `f(text)` as typed text (an input event, as a paste does). */
const setSource = async (f) => {
  const next = f(await sourceValue());
  await app.browser.execute((v) => {
    const t = document.querySelector(".pane.active > .pane-content:not([hidden]) .source-text");
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    setter.call(t, v);
    t.dispatchEvent(new Event("input", { bubbles: true }));
  }, next);
};

let chipText = "";

test("removing a chip in the source view removes its booking after the undo toast", async () => {
  const id = await noteWithChip("Quellnotiz", "/zeit NP-8801/1040 1h #TEST Quelltest");
  chipText = chipRe.exec(await content("Quellnotiz"))[0];
  await app.keys(["Control", "Shift", "m"]);
  await source();
  // Give the view its link check (a chip removed before it is known is never deleted).
  await app.browser.pause(800);

  // Removed and „Rückgängig“: the text is back where it was, the booking never touched.
  await selectChip();
  await app.keys(["Backspace"]);
  await app.waitText(".toast-title", /Buchung mit dem Chip gelöscht/);
  await until(async () => !chipRe.test(await content("Quellnotiz")), "saved without the chip");
  await app.shot("270-source-chip-removed");
  // „Rückgängig“ of the chip's toast (the new note's rename toast offers one too).
  const undone = await app.browser.execute(() => {
    const toast = [...document.querySelectorAll(".toast")].find((x) => /Buchung mit dem Chip gelöscht/.test(x.querySelector(".toast-title")?.textContent ?? ""));
    const button = [...(toast?.querySelectorAll("button") ?? [])].find((b) => b.textContent.trim() === "Rückgängig");
    button?.click();
    return !!button;
  });
  assert.ok(undone, "undo in the chip's toast");
  await until(async () => (await sourceValue()).includes(chipText), "chip text back");
  await until(async () => (await content("Quellnotiz")).includes(chipText), "saved with the chip");
  await app.browser.pause(7500);
  assert.ok(await entry(id), "booking kept");

  // Removed and left: the booking goes when the toast closes; undo in the text box restores it.
  await selectChip();
  await app.keys(["Backspace"]);
  await until(async () => !(await entry(id)), "booking deleted", 14000);
  // The text box's own undo (what Ctrl+Z does there; WebDriver keys do not reach WebKitGTK's
  // editing commands).
  await app.browser.execute(() => document.execCommand("undo"));
  await until(async () => (await sourceValue()).includes(chipText), "chip text back after undo");
  await until(async () => (await entry(id))?.duration_minutes === 60, "booking restored", 8000);
  await app.waitText(".toast-title", /Buchung wiederhergestellt/);
  assert.equal((await entry(id)).description, "Quelltest");
});

test("a chip cut in the source view and pasted into another note keeps its booking", async () => {
  const id = Number(chipRe.exec(chipText)[1]);
  const from = await pageOf("Quellnotiz");
  await app.dismissToasts();
  await setSource((v) => v.replace(chipText, ""));
  await until(async () => !chipRe.test(await content("Quellnotiz")), "cut saved");
  await app.waitText(".toast-title", /Buchung mit dem Chip gelöscht/);
  // Another note, also in the source view: the chip pasted there.
  await app.keys(["Control", "n"]);
  await until(() => app.browser.execute(() => document.activeElement?.classList.contains("page-title") && document.activeElement.selectionEnd > 0), "new note");
  await app.type("Zielnotiz");
  await app.keys(["Enter"]);
  await until(async () => (await app.invoke("page_resolve", { title: "Zielnotiz", create: false }).catch(() => null)) != null, "target saved");
  await app.keys(["Control", "Shift", "m"]);
  await source();
  await setSource((v) => `${v.trimEnd()}\n\nÜbernommen: ${chipText}\n`);
  await app.waitText(".toast-title", /Buchung bleibt/);
  await app.browser.pause(8000);
  const e = await entry(id);
  assert.ok(e, "booking kept");
  assert.notEqual(e.page_id, from, "the booking moved along");
  assert.equal(e.page_id, await pageOf("Zielnotiz"));
});

test("an exported booking stays when its chip is removed in the source view", async () => {
  const id = Number(chipRe.exec(chipText)[1]);
  await app.invoke("set_entry_status", { ids: [id], status: "exported" });
  await emit("data://entries");
  await app.dismissToasts();
  await app.browser.pause(600);
  await setSource((v) => v.replace(chipText, ""));
  await app.waitText(".toast-title", /exportierte Buchung bleibt/);
  await app.browser.pause(8000);
  assert.ok(await entry(id), "exported booking kept");
});

test("a booking back before its worklog deletion was sent keeps its worklog", async () => {
  // In the rich editor of a new note: a chip booked on a Jira issue.
  await app.keys(["Control", "Shift", "m"]);
  await app.waitFor(".pane.active > .pane-content:not([hidden]) .ProseMirror");
  const id = await noteWithChip("Jiranotiz", "/zeit 1h PROJ-123 Jira Chip");
  await until(async () => (await link(id))?.worklog_state === "posted", "worklog posted", 15000);
  const w = (await link(id)).worklog_id;
  assert.deepEqual(jira.worklogs().map((x) => x.id), [w]);

  // Removed while Jira cannot be reached: the deletion of the worklog stays queued.
  await jira.stop();
  await chipMenu("Chip und Buchung entfernen");
  await until(async () => !(await entry(id)), "booking deleted", 14000);
  await app.browser.pause(1500);
  await jira.start();
  // Undo in the editor: the booking and its link come back, the deletion is cancelled.
  await app.keys(["Control", "z"]);
  await until(async () => (await entry(id))?.duration_minutes === 60, "booking restored");
  await until(async () => (await link(id))?.worklog_state === "posted", "worklog linked again", 15000);
  assert.equal((await link(id)).worklog_id, w, "the same worklog");
  await app.browser.pause(2000);
  assert.deepEqual(jira.worklogs().map((x) => x.id), [w], "no second worklog, not deleted");
  assert.equal(jira.requests.filter((r) => r.method === "POST" && r.path.endsWith("/worklog")).length, 1);
  assert.ok(!jira.requests.some((r) => r.method === "DELETE"), "the deletion never went out");
});

test("a booking back after Jira deleted its worklog posts it once more", async () => {
  const id = Number(chipRe.exec(await content("Jiranotiz"))[1]);
  const w = (await link(id)).worklog_id;
  await app.dismissToasts();
  await chipMenu("Chip und Buchung entfernen");
  await until(async () => !(await entry(id)), "booking deleted", 14000);
  await until(() => jira.worklogs().length === 0, "worklog deleted in Jira", 10000);
  await app.keys(["Control", "z"]);
  await until(async () => (await link(id))?.worklog_state === "posted" && (await link(id)).worklog_id !== w, "posted anew", 15000);
  const w2 = (await link(id)).worklog_id;
  await app.browser.pause(1500);
  assert.deepEqual(jira.worklogs().map((x) => x.id), [w2], "exactly one worklog, the new one");
});

test("„Erneut buchen“ on a chip whose booking was deleted takes the worklog back", async () => {
  const id = Number(chipRe.exec(await content("Jiranotiz"))[1]);
  const w = (await link(id)).worklog_id;
  await app.dismissToasts();
  // Deleted in the timesheet while Jira cannot be reached: the worklog deletion waits.
  await jira.stop();
  const deletes = jira.requests.filter((r) => r.method === "DELETE").length;
  await app.invoke("delete_time_entry", { id });
  await until(async () => /state="deleted"/.test(await content("Jiranotiz")), "chip marked deleted");
  await until(async () => (await chips())[0] === "deleted", "chip shows deleted");
  await app.browser.pause(1500);
  await jira.start();
  await chipMenu("Erneut buchen");
  await app.waitText(".toast-title", /gebucht/);
  await until(async () => !/state=/.test(await content("Jiranotiz")), "chip linked to the new booking");
  const again = Number(chipRe.exec(await content("Jiranotiz"))[1]);
  await until(async () => (await link(again))?.worklog_state === "posted", "linked to the issue", 15000);
  assert.equal((await link(again)).worklog_id, w, "the same worklog");
  assert.equal((await link(again)).issue_key, "PROJ-123");
  await app.browser.pause(2000);
  assert.deepEqual(jira.worklogs().map((x) => x.id), [w]);
  assert.equal(jira.requests.filter((r) => r.method === "DELETE").length, deletes, "the deletion was cancelled");
  await app.shot("270-rebooked-jira");
});

test("no console errors", async () => {
  assert.deepEqual(await app.consoleErrors(), []);
});
