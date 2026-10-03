import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
before(async () => (app = await launch()));
after(async () => app?.close());

const entries = () => app.invoke("time_entries", { from: null, to: null });
const openTree = async (title) => {
  for (const r of await app.$$(".sidebar .tree-row")) if ((await app.textOf(r)) === title) return r.click();
  throw new Error(`no ${title}`);
};

test("/zeit in a note books time and leaves a chip", async () => {
  const before = (await entries()).length;
  await openTree("Jour fixe 22.09.");
  await app.caretToEnd();
  await app.keys(["Enter"]);
  await app.type("/zeit NP-8801/1040 1.5h #TEST Testdaten vorbereitet");
  await app.keys(["Escape"]);
  await app.keys(["Enter"]);
  await app.waitFor(".ProseMirror .time-chip");
  await app.waitText(".toast-title", /1,50 h gebucht/);
  const all = await entries();
  assert.equal(all.length, before + 1);
  const e = all.find((x) => x.description === "Testdaten vorbereitet");
  assert.equal(e.vorgang_nr, "1040");
  assert.equal(e.leistungsart, "TEST");
  assert.equal(e.duration_minutes, 90);
  await app.browser.pause(800);
  const doc = await app.invoke("page_get", { id: (await app.invoke("page_resolve", { title: "Jour fixe 22.09.", create: false })).id });
  assert.match(doc.content, /<time-entry id="\d+" hours="1,50" target="NP-8801\/1040">Testdaten vorbereitet<\/time-entry>/);
  await app.shot("time-chip");
});

test("an invalid /zeit shows an error and keeps the text", async () => {
  await app.type("/zeit NP-9999 1h Quatsch");
  await app.keys(["Escape"]);
  await app.keys(["Enter"]);
  await app.waitText(".toast-title", /Buchung fehlgeschlagen/);
  const html = await (await app.$(".ProseMirror")).getHTML();
  assert.match(html, /NP-9999 1h Quatsch/);
});

test("timesheet: start and stop the timer", async () => {
  await app.click(".ribbon [aria-label=\"Zeiterfassung\"]");
  await app.waitText(".view-header h1", /Zeiterfassung/);
  await app.shot("timesheet");
  const desc = await app.$('input[aria-label="Beschreibung"]');
  await desc.setValue("Timer-Test");
  await app.click(".timer-form .btn-primary");
  await app.waitFor(".timer-card.running");
  await app.waitFor(".timer-dock");
  await app.browser.pause(1300);
  assert.match(await app.text(".timer-clock"), /^00:00:0[1-9]$/);
  await app.shot("timesheet-running");
  const running = (await entries()).find((x) => x.description === "Timer-Test");
  assert.equal(running.status_flag, "running");
  await app.click(".timer-card .btn-primary");
  // Less than a minute is not booked.
  await app.waitText(".toast-title", /Nicht gebucht/);
  assert.equal((await entries()).find((x) => x.description === "Timer-Test"), undefined);
  await app.waitFor(".timer-form");
});

test("quick booking field", async () => {
  const q = await app.$('input[aria-label="Schnell buchen"]');
  await q.setValue("NP-8802/2010 45m #CONSULTING Agenda Schulung");
  await q.click();
  await app.keys(["Enter"]);
  await app.waitText(".toast-title", /0,75 h gebucht/);
  await app.waitText(".entry-desc", /Agenda Schulung/);
});

test("manual entry dialog", async () => {
  await app.click(".view-actions .btn-primary");
  await app.waitFor(".dialog");
  const dur = await app.$('.dialog input[value="1,00"]');
  await dur.setValue("2:15");
  const d = await app.$('.dialog input[placeholder="Was hast du gemacht?"]');
  await d.setValue("Nachbereitung Workshop");
  await app.shot("entry-dialog");
  await app.click(".dialog .btn-primary");
  await app.waitText(".toast-title", /2,25 h gebucht/);
  const e = (await entries()).find((x) => x.description === "Nachbereitung Workshop");
  assert.equal(e.duration_minutes, 135);
});

test("week grid sums hours per WBS line", async () => {
  await app.waitFor(".week-grid");
  const text = await app.text(".week-grid tfoot");
  assert.match(text, /Summe/);
});

test("release entries, then export as SAP CATS", async () => {
  // All days: shortly after midnight the bookings of this run fall on yesterday.
  for (const c of await app.$$(".entry-day-head .check")) await c.click();
  await app.waitFor(".bulk");
  await app.click(".bulk .btn-secondary");
  await app.waitText(".toast-title", /freigegeben/);
  const released = (await entries()).filter((e) => e.status_flag === "released");
  assert.ok(released.length >= 3);

  await app.click('.view-actions .btn-secondary');
  await app.waitFor(".export-preview");
  await app.browser.waitUntil(async () => /PERNR;WORKDATE;RPROJ;RNPLNR;VORNR;LSTAR;CATSHOURS/.test(await app.text(".export-preview")));
  const preview = await app.text(".export-preview");
  assert.match(preview, /NP-8801;1040;TEST;1,50;H;Testdaten vorbereitet/);
  await app.shot("export-dialog");
  await app.click('.dialog .segmented button:nth-child(3)');
  await app.browser.waitUntil(async () => /^id,project,netzplan/.test(await app.text(".export-preview")));
  await app.keys(["Escape"]);
});

test("budget alert appears when a Vorgang is overbooked", async () => {
  await app.invoke("log_time", { line: "/zeit NP-8801/1050 9h Doku komplett @gestern @08:00" });
  const out = await app.invoke("log_time", { line: "/zeit NP-8801/1050 30m Nachtrag" });
  assert.ok(out.alerts.some((a) => a.label === "NP-8801/1050" && a.level === "exceeded"));
});

test("editing an entry updates duration", async () => {
  const rows = await app.$$(".entry");
  let target;
  for (const r of rows) if (/Nachbereitung Workshop/.test(await app.textOf(r))) target = r;
  await app.dismissToasts();
  await target.$(".icon-btn").click();
  await app.waitFor(".menu");
  await app.click(".menu-item:first-child");
  await app.waitFor(".dialog");
  const inputs = await app.$$(".dialog .input");
  let dur;
  for (const i of inputs) if ((await i.getValue()) === "2,25") dur = i;
  await dur.setValue("3");
  await app.click(".dialog .btn-primary");
  await app.waitText(".toast-title", /Eintrag gespeichert/);
  const e = (await entries()).find((x) => x.description === "Nachbereitung Workshop");
  assert.equal(e.duration_minutes, 180);
});

test("week grid copies a CATS grid and marks it exported", async () => {
  await app.click(".ribbon [aria-label=\"Zeiterfassung\"]");
  await app.waitFor(".week-grid");
  await app.browser.execute(() => {
    // The test WebView may deny clipboard access; capture what would be copied.
    window.__copied = null;
    navigator.clipboard.writeText = async (t) => void (window.__copied = t);
  });
  await app.click("button=In CATS kopieren");
  await app.waitText(".toast-title", /Für CATS kopiert/);
  const copied = await app.browser.execute(() => window.__copied);
  assert.match(copied, /^NP-88\d\d\t\d{4}\t[A-Z]+\t/m);
  assert.match(copied, /\d,\d\d/);
  await app.click("button=Als exportiert markieren");
  await app.browser.waitUntil(async () => (await entries()).some((e) => e.status_flag === "exported"));
});

test("no console errors", async () => {
  assert.deepEqual(await app.consoleErrors(), []);
});
