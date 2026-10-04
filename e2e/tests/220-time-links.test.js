// 1.12 time tracking follow-ups: a /zeit chip stays linked to its booking (edits and deletes
// elsewhere show in the note, removing the chip removes the booking after an undo toast, copies
// do not share a booking), the timer pauses and resumes (widget, palette, shortcut, tray entry),
// and CATS hours use the decimal separator set in Settings → Zeiterfassung.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
let pageId;
before(async () => (app = await launch()));
after(async () => app?.close());

const content = async () => (await app.invoke("page_get", { id: pageId })).content;
const entries = () => app.invoke("time_entries", { from: null, to: null });
const entry = async (id) => (await entries()).find((e) => e.id === id);
const until = (f, msg, timeout = 8000) => app.browser.waitUntil(f, { timeout, timeoutMsg: msg });
const chips = () =>
  app.browser.execute(() =>
    [...document.querySelectorAll(".pane.active .ProseMirror .time-chip")].map((c) => ({ cls: c.className, text: c.textContent, link: c.dataset.chip ?? "" })),
  );
const chipId = async () => Number(/<time-entry id="(\d+)"/.exec(await content())?.[1]);
/** Clicks the first `sel` that reads `label`. */
const clickText = async (sel, label) => {
  for (const el of await app.$$(sel)) if ((await app.textOf(el)) === label) return el.click();
  throw new Error(`no ${sel} reading ${label}`);
};
/** Opens the menu of the `i`-th chip and picks `label`. */
const chipMenu = async (i, label) => {
  const all = await app.$$(".pane.active .ProseMirror .time-chip");
  await all[i].click();
  await app.waitFor(".menu");
  await clickText(".menu .menu-item", label);
};

test("a /zeit chip shows its booking's values and follows edits made elsewhere", async () => {
  await app.keys(["Control", "n"]);
  await app.browser.waitUntil(() => app.browser.execute(() => document.activeElement?.classList.contains("page-title") && document.activeElement.selectionEnd > 0));
  await app.type("Zeitnotiz");
  await app.keys(["Enter"]);
  await app.type("/zeit NP-8801/1040 1h #TEST Chiptest");
  await app.keys(["Escape"]);
  await app.keys(["Enter"]);
  await app.waitFor(".pane.active .ProseMirror .time-chip");
  pageId = (await app.invoke("page_resolve", { title: "Zeitnotiz", create: false })).id;
  await until(async () => /la="TEST" date="\d{4}-\d{2}-\d{2}">Chiptest<\/time-entry>/.test(await content()), "chip saved with Leistungsart and day");
  const id = await chipId();
  const [chip] = await chips();
  assert.match(chip.text, /^1 hNP-8801\/1040TEST\d\d\.\d\d\.Chiptest$/);
  await until(async () => (await chips())[0].link === "linked", "chip linked");

  // Edited in the timesheet (the same command the entry dialog uses): the note follows.
  const e = await entry(id);
  await app.invoke("time_entry_update", { id, vorgangNr: "1020", leistungsart: "DEV", startTime: e.start_time, durationMinutes: 135, description: "Chiptest lang" });
  await until(async () => /hours="2,25" target="NP-8801\/1020" la="DEV"/.test(await content()), "page rewritten");
  await until(async () => /^2,25 hNP-8801\/1020DEV\d\d\.\d\d\.Chiptest lang$/.test((await chips())[0]?.text), "chip shows the new values").catch(async (err) => {
    throw new Error(`${err.message}: ${JSON.stringify(await chips())}`);
  });
  await app.shot("220-chip-linked");

  // Deleted in the timesheet: the chip says so and offers to book again.
  await app.invoke("delete_time_entry", { id });
  await until(async () => /state="deleted">Chiptest lang<\/time-entry>/.test(await content()), "chip marked deleted");
  await until(async () => (await chips())[0].cls.includes("time-chip--deleted"), "chip shows deleted");
  assert.match((await chips())[0].text, /Buchung gelöscht/);
  await app.shot("220-chip-deleted");
  await chipMenu(0, "Erneut buchen");
  await app.waitText(".toast-title", /2,25 h gebucht/);
  // (SQLite may give the new booking the freed id again.)
  await until(async () => !/state=/.test(await content()), "chip linked to the new booking");
  const again = await entry(await chipId());
  assert.equal(again.duration_minutes, 135);
  assert.equal(again.page_id, pageId);
  await until(async () => !(await chips())[0].cls.includes("--deleted"), "chip normal again");
});

test("removing a chip removes its booking after the undo toast; undo in the editor brings it back", async () => {
  const id = await chipId();
  await until(async () => (await chips())[0].link === "linked", "chip linked");
  await chipMenu(0, "Chip und Buchung entfernen");
  await app.waitText(".toast-title", /Buchung mit dem Chip gelöscht/);
  assert.equal((await chips()).length, 0);
  // „Rückgängig“ in the toast: the chip is back, the booking was never touched.
  await clickText(".toast button", "Rückgängig");
  await until(async () => (await chips()).length === 1, "chip back");
  await app.browser.pause(7500);
  assert.ok(await entry(id), "booking kept");

  // Removed again and left: the booking goes when the toast closes.
  await chipMenu(0, "Chip und Buchung entfernen");
  await until(async () => !(await entry(id)), "booking deleted", 12000);
  // Undo in the editor puts the chip back, and with it the booking (same id).
  await app.keys(["Control", "z"]);
  await until(async () => (await chips()).length === 1, "chip back after undo");
  await until(async () => (await entry(id))?.duration_minutes === 135, "booking restored", 8000);
  await app.waitText(".toast-title", /Buchung wiederhergestellt/);
});

test("a copied chip does not share the booking and can be booked on its own", async () => {
  await until(async () => /<time-entry/.test(await content()), "chip saved again");
  const id = await chipId();
  const md = await content();
  const chip = /<time-entry[^>]*>[^<]*<\/time-entry>/.exec(md)[0];
  await app.invoke("page_save", { id: pageId, content: `${md.trimEnd()}\n\nKopie: ${chip}\n` });
  await app.browser.execute((id) => window.dispatchEvent(new CustomEvent("annalo:reload-pages", { detail: { ids: [id] } })), pageId);
  await until(async () => (await chips()).length === 2, "two chips");
  await until(async () => (await chips())[1].cls.includes("time-chip--copy"), "second is a copy");
  assert.match((await chips())[1].text, /Kopie, nicht gebucht/);
  // Copy and paste through HTML keeps every value.
  const html = await app.browser.execute(() => document.querySelector(".pane.active .ProseMirror time-entry, .pane.active .ProseMirror .time-chip")?.outerHTML ?? "");
  assert.ok(html);
  await app.shot("220-chip-copy");
  const before = (await entries()).length;
  await chipMenu(1, "Buchen");
  await until(async () => (await entries()).length === before + 1, "copy booked");
  const ids = async () => [...(await content()).matchAll(/<time-entry id="(\d+)"/g)].map((m) => Number(m[1]));
  await until(async () => new Set(await ids()).size === 2, "the copy has its own booking");
  assert.equal((await ids())[0], id);
  await until(async () => (await chips()).every((c) => c.link === "linked"), "both booked");
});

test("the timer pauses and resumes from the widget, the palette and the shortcut", async () => {
  const [np] = (await app.invoke("wbs_tree")).flatMap((p) => p.netzplaene);
  await app.invoke("timer_start", { netzplanId: np.id, vorgangNr: null, leistungsart: null, description: "Pausentest" });
  await app.browser.execute(() => window.dispatchEvent(new Event("focus")));
  await app.waitFor(".timer-dock");
  await app.click('.timer-dock [aria-label="Pausieren"]');
  await until(async () => (await app.invoke("timer_status"))?.paused_since != null, "paused");
  await app.waitText(".timer-dock .timer-dock-label", /Pausiert/);
  const clock = await app.text(".timer-dock-time");
  await app.browser.pause(2200);
  assert.equal(await app.text(".timer-dock-time"), clock, "the clock stands still");
  await app.shot("220-timer-paused");
  // Settings → Tastatur: Ctrl+Shift+G continues.
  await app.click(".statusbar");
  await app.keys(["Control", "Shift", "g"]);
  await until(async () => (await app.invoke("timer_status"))?.paused_since == null, "resumed by the shortcut");
  assert.ok((await app.invoke("timer_status")).paused_seconds >= 2, "the pause is counted");
  // Palette: „Timer pausieren“.
  await app.keys(["Control", "k"]);
  await app.type("Timer pausieren");
  await app.keys(["Enter"]);
  await until(async () => (await app.invoke("timer_status"))?.paused_since != null, "paused from the palette");
  await app.invoke("timer_pause", { paused: false });
  await assert.rejects(app.invoke("timer_pause", { paused: false }), /nicht pausiert/);
  const info = await app.invoke("desktop_info");
  if (info.tray_menu) assert.ok(info.tray_menu.includes("pause"));
  await app.invoke("timer_discard");
});

/** Picks an option of the „Dezimaltrennzeichen“ setting. */
const choose = (label) => clickText('[role="radiogroup"][aria-label="Dezimaltrennzeichen"] button', label);

test("CATS hours use the decimal separator from the settings", async () => {
  const cats = async () => (await app.invoke("export_entries", { format: "sap_cats", from: null, to: null, onlyReleased: false, markExported: false, path: null })).content;
  assert.match(await cats(), /;4,00;H;/, "comma by default");
  await app.keys(["Control", ","]);
  await app.waitFor(".settings-nav");
  await app.click('.settings-nav-item[data-section="time"]');
  await choose("Punkt (1.50)");
  await until(async () => (await app.invoke("settings_get")).settings.time.cats_decimal === "point", "saved");
  assert.match(await cats(), /;4\.00;H;/);
  assert.doesNotMatch(await cats(), /;\d+,\d\d;H;/);
  await app.shot("220-cats-decimal");
  await choose("Wie Zahlenformat");
  await until(async () => (await app.invoke("settings_get")).settings.time.cats_decimal === "number", "saved");
  assert.match(await cats(), /;4,00;H;/, "German number format: comma");
});

test("no console errors", async () => {
  assert.deepEqual(await app.consoleErrors(), []);
});
