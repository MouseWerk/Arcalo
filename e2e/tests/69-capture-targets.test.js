// Quick capture targets: `>` opens the page picker (fuzzy, recent pages first), „Neue Seite:
// Titel“ and Ctrl+Enter create a page, Tab cycles daily note / meeting now / last page / inbox,
// the meeting running now („Jetzt: …“) gets the text in its meeting note, and `[[` and `#`
// complete pages and tags in the field.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { launch, guarded } from "../lib/harness.js";
import { writeMeetingNow } from "../lib/calendar-fixtures.js";
import { captureVisible, dailyContent, findPage, openCapture, pageContent } from "../lib/capture.js";

const test = guarded(nodeTest, () => app);
let app;
let fx;
before(async () => {
  fx = writeMeetingNow("Jour fixe Kunde X");
  app = await launch();
  const p = await app.invoke("page_create", { parentId: null, title: "Kunde Müller", icon: "users", content: "# Kunde Müller\n\nAbsatz über den Kunden. #vertrieb\n" });
  assert.ok(p.id);
  await app.browser.pause(1800);
});
after(async () => {
  await app?.close();
  if (fx) fs.rmSync(fx.dir, { recursive: true, force: true });
});

const value = () => app.browser.execute(() => document.querySelector(".capture-input")?.value ?? null);
const chip = () => app.text(".capture-chip.target");
const hidden = () => app.browser.waitUntil(async () => (await captureVisible(app)) === false, { timeout: 5000, timeoutMsg: "window not hidden" });

test("> opens the page picker; the chosen page gets the text", async () => {
  await openCapture(app);
  await app.type(">");
  await app.waitFor(".capture-pick-input");
  assert.equal(await app.browser.execute(() => document.activeElement?.classList.contains("capture-pick-input")), true);
  // Without a query: the quick targets and the recently edited pages.
  await app.waitText(".capture-picker .sugg-section", /Zuletzt bearbeitet/i);
  await app.type("kd mul");
  await app.waitText(".capture-picker .sugg-item.sel", /Kunde Müller/);
  await app.shot("69-capture-picker");
  await app.keys(["Enter"]);
  await app.browser.waitUntil(async () => /Kunde Müller/.test(await chip()), { timeoutMsg: "target not set" });
  assert.equal(await app.browser.execute(() => document.activeElement?.getAttribute("aria-label")), "Schnellerfassung");
  await app.type("Rückruf vereinbart");
  await app.waitText(".capture-hint", /Enter speichert die Notiz in „Kunde Müller“/);
  await app.keys(["Enter"]);
  await app.waitText(".capture-foot.done .capture-link", /Kunde Müller/);
  assert.equal(await pageContent(app, "Kunde Müller"), "# Kunde Müller\n\nAbsatz über den Kunden. #vertrieb\n\n- Rückruf vereinbart\n");
  await hidden();

  // Next time the default target (daily note) is back; Tab reaches the page chosen last.
  await openCapture(app);
  assert.match(await chip(), /Tagesnotiz/);
  await app.keys(["Tab"]);
  await app.browser.waitUntil(async () => /Kunde Müller/.test(await chip()), { timeoutMsg: "Tab does not offer the last page" });
  await app.keys(["Tab"]);
  await app.browser.waitUntil(async () => /Posteingang/.test(await chip()));
  await app.keys(["Shift", "Tab"]);
  await app.browser.waitUntil(async () => /Kunde Müller/.test(await chip()), { timeoutMsg: "Shift+Tab does not go back" });
  // „> “ at the start is a quote, not the picker.
  await app.keys(["Escape"]);
  await hidden();
});

test("new pages: „Neue Seite: Titel“ and Ctrl+Enter on a query without match", async () => {
  await openCapture(app);
  await app.type(">Neue Seite: Ideen Q4");
  await app.waitText(".capture-picker .sugg-item.sel", /Neue Seite „Ideen Q4“ anlegen/);
  await app.keys(["Enter"]);
  await app.waitFor(".capture-chip.target .capture-new");
  assert.match(await chip(), /Ideen Q4/);
  // Nothing is created before the text is saved.
  assert.equal(await findPage(app, "Ideen Q4"), null);
  await app.type("Erste Idee");
  await app.keys(["Enter"]);
  await app.waitText(".capture-foot.done .capture-link", /Ideen Q4/);
  assert.equal(await pageContent(app, "Ideen Q4"), "- Erste Idee\n");
  // From now on it is a page: the second capture goes to the same one, no duplicate.
  await app.browser.waitUntil(async () => !(await app.browser.execute(() => !!document.querySelector(".capture-chip.target .capture-new"))));
  await app.type("Zweite Idee");
  await app.keys(["Enter"]);
  await app.browser.waitUntil(async () => (await pageContent(app, "Ideen Q4")) === "- Erste Idee\n- Zweite Idee\n", { timeoutMsg: "second capture not in the same page" });
  await hidden();

  await openCapture(app);
  await app.type(">Zukunftsplan");
  await app.waitText(".capture-picker .sugg-item", /Neue Seite „Zukunftsplan“ anlegen/);
  await app.keys(["Control", "Enter"]);
  await app.browser.waitUntil(async () => /Zukunftsplan/.test(await chip()), { timeoutMsg: "Ctrl+Enter did not choose a new page" });
  await app.type("Schritt eins");
  await app.keys(["Enter"]);
  await app.waitText(".capture-foot.done .capture-link", /Zukunftsplan/);
  assert.equal(await pageContent(app, "Zukunftsplan"), "- Schritt eins\n");

  // „> “ stays a quote; Esc in the picker goes back to the text.
  await app.type(">");
  await app.waitFor(".capture-pick-input");
  await app.keys(["Escape"]);
  await app.browser.waitUntil(async () => !(await app.browser.execute(() => !!document.querySelector(".capture-pick-input"))));
  await app.type("> ");
  await app.browser.waitUntil(async () => (await value()) === "> ", { timeoutMsg: "no quote" });
  await app.browser.execute(() => {
    const el = document.querySelector(".capture-input");
    el.select();
  });
  await app.keys(["Backspace"]);

  // The main window shows the new pages in its tree.
  await app.keys(["Escape"]);
  await app.browser.switchToWindow(app.mainHandle);
  await app.waitText(".tree-label", /^Zukunftsplan$/);
});

test("the meeting running now is offered; the text goes into its meeting note", async () => {
  await app.invoke("calendar_source_add", { name: "Heute", url: null, path: fx.file });
  await app.browser.waitUntil(async () => (await app.invoke("calendar_status")).sources.find((s) => s.id === "ics:s1")?.status?.events === 2, { timeout: 15000, timeoutMsg: "calendar not synced" });
  await openCapture(app);
  await app.waitText(".capture-chip.meeting", /Jetzt: Jour fixe Kunde X/);
  await app.shot("69-capture-meeting");
  await app.click(".capture-chip.meeting");
  await app.browser.waitUntil(async () => /Jetzt: Jour fixe Kunde X/.test(await chip()), { timeoutMsg: "meeting not chosen" });
  await app.browser.execute(() => document.querySelector(".capture-input")?.focus());
  await app.type("Budget freigegeben");
  await app.keys(["Shift", "Enter"]);
  await app.type("todo Protokoll an Anna bis morgen");
  await app.waitText(".capture-hint", /Besprechungsnotiz/);
  await app.keys(["Enter"]);
  await app.waitText(".capture-foot.done .capture-link", /Jour fixe Kunde X/);
  const title = await app.text(".capture-foot.done .capture-link");
  const md = await pageContent(app, title);
  // The demo template „Besprechung“ has no „Notizen“ section: the text goes to the end (below
  // „Notizen“ otherwise, see the core tests).
  assert.match(md, /\n\n- Budget freigegeben\n- \[ \] Protokoll an Anna due:\d{4}-\d{2}-\d{2}\n$/);
  assert.match(md, /Anna Müller/, "created from the appointment");
  const note = await findPage(app, title);
  const now = Date.now();
  const events = await app.invoke("calendar_events", { from: new Date(now - 3600e3).toISOString(), to: new Date(now + 3600e3).toISOString() });
  assert.equal(events.find((e) => e.title === "Jour fixe Kunde X")?.note_page_id, note.id, "linked as the meeting's note");
  await hidden();

  // Tab reaches it too; the second capture goes into the same note.
  await openCapture(app);
  await app.keys(["Tab"]);
  await app.browser.waitUntil(async () => /Jetzt: Jour fixe Kunde X/.test(await chip()), { timeoutMsg: "Tab does not offer the meeting" });
  await app.type("Nächster Termin in zwei Wochen");
  await app.keys(["Enter"]);
  await app.browser.waitUntil(async () => /due:\S+\n- Nächster Termin in zwei Wochen\n$/.test(await pageContent(app, title)), { timeoutMsg: "second capture not in the note" });
});

test("[[ completes pages and # completes tags in the field", async () => {
  await hidden();
  await openCapture(app);
  await app.type("Siehe [[kunde");
  await app.waitText(".capture-sugg .sugg-item.sel", /Kunde Müller/);
  await app.shot("69-capture-wikilink");
  await app.keys(["Enter"]);
  await app.browser.waitUntil(async () => (await value()) === "Siehe [[Kunde Müller]] ", { timeoutMsg: "link not inserted" });
  await app.type("#vert");
  await app.waitText(".capture-sugg .sugg-item.sel", /#vertrieb/);
  await app.keys(["Tab"]);
  await app.browser.waitUntil(async () => (await value()) === "Siehe [[Kunde Müller]] #vertrieb ", { timeoutMsg: "tag not inserted" });
  // Tab picked the tag (not the next target).
  assert.match(await chip(), /Tagesnotiz/);
  await app.keys(["Enter"]);
  await app.browser.waitUntil(async () => (await dailyContent(app)).includes("- Siehe [[Kunde Müller]] #vertrieb\n"), { timeoutMsg: "not stored" });
  const back = await app.invoke("page_get", { id: (await findPage(app, "Kunde Müller")).id });
  assert.ok(back.backlinks.some((b) => b.context.includes("Siehe")), "the link is a backlink");
  assert.deepEqual(await app.consoleErrors(), []);
});
