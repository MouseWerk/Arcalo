// „Zeiterfassung verwenden“ off (1.6): one switch in Settings → Zeiterfassung hides everything
// about booking time, live in every part of the app: ribbon, palette and shortcut, status bar,
// slash menu, time-entry chips, Kalender detail, start page (gallery and „Heute“), the
// Tagesrückblick and the tray menu; booking commands refuse. Switched on again, everything is
// back and the booked entries are untouched.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { launch, guarded } from "../lib/harness.js";
import { settingsSettled } from "../lib/settings.js";
import { writeMeetingNow } from "../lib/calendar-fixtures.js";

const test = guarded(nodeTest, () => app);
let app;
let fx;
let pageId;
let entriesBefore;
before(async () => {
  fx = writeMeetingNow("Jour fixe Kunde X");
  app = await launch();
  await app.invoke("calendar_source_add", { name: "Heute", url: null, path: fx.file });
  await app.invoke("calendar_sync_now", { source: null });
  await app.browser.waitUntil(async () => (await app.invoke("calendar_status")).sources.every((s) => !s.enabled || (s.status?.synced_at && !s.syncing)), { timeout: 20000, timeoutMsg: "not synced" });
  // A note with a booked time entry chip (booked while time tracking is on).
  const out = await app.invoke("log_time", { line: "/zeit NP-8801/1020 1h 'Chip aus dem Test'", pageId: null });
  const page = await app.invoke("page_create", { title: "Zeitnotiz", parentId: null });
  pageId = page.id;
  await app.invoke("page_save", { id: pageId, content: `Besprechung vorbereitet\n\n<time-entry id="${out.entry.id}" hours="1" target="NP-8801/1020">Chip aus dem Test</time-entry>\n` });
  // The main window picks up the new page.
  await app.browser.execute(() => location.reload());
  await app.browser.pause(300);
  await app.browser.waitUntil(() => app.browser.execute(() => document.body.classList.contains("ready")), { timeout: 20000, timeoutMsg: "not ready after reload" });
  entriesBefore = (await app.invoke("time_entries", { from: null, to: null })).length;
  assert.ok(entriesBefore > 1, "demo bookings");
});
after(async () => {
  await app?.close();
  if (fx) fs.rmSync(fx.dir, { recursive: true, force: true });
});

const has = (sel) => app.browser.execute((s) => !!document.querySelector(s), sel);
const texts = (sel) => app.browser.execute((s) => [...document.querySelectorAll(s)].map((e) => e.textContent.trim()), sel);
const clickText = async (sel, pattern) => {
  await app.browser.waitUntil(
    () =>
      app.browser.execute(
        (s, src) => {
          const re = new RegExp(src);
          const el = [...document.querySelectorAll(s)].find((b) => re.test(b.textContent.trim()) && !b.disabled);
          el?.click();
          return !!el;
        },
        sel,
        pattern.source,
      ),
    { timeoutMsg: `no ${sel} ${pattern}` },
  );
  await app.browser.pause(120);
};
const timeOn = async () => (await app.invoke("settings_get")).settings.time.enabled;

/** Settings → Zeiterfassung, the switch „Zeiterfassung verwenden“ (applies at once). */
async function setTimeTracking(on) {
  await app.keys(["Control", ","]);
  await app.waitFor(".settings-nav");
  await app.click('.settings-nav-item[data-section="time"]');
  const sw = await app.waitFor('button[role="switch"][aria-label="Zeiterfassung verwenden"]');
  if ((await sw.getAttribute("aria-checked")) !== String(on)) await sw.click();
  await settingsSettled(app);
  await app.browser.waitUntil(async () => (await timeOn()) === on, { timeoutMsg: "switch not saved" });
  await app.browser.waitUntil(() => app.browser.execute((v) => document.documentElement.hasAttribute("data-time-off") === !v, on), { timeoutMsg: "UI did not follow" });
}

async function openPalette(query) {
  await app.keys(["Escape"]);
  await app.keys(["Control", "k"]);
  await app.waitFor(".palette input");
  await app.browser.execute(() => {
    const i = document.querySelector(".palette input");
    i.select();
  });
  await app.type(query);
  await app.browser.pause(250);
  // The titles (without subtitle or snippet): notes about „Zeiterfassung“ may still be found.
  const items = await app.browser.execute(() => [...document.querySelectorAll(".pal-title")].map((e) => e.firstChild?.textContent?.trim() ?? ""));
  await app.keys(["Escape"]);
  return items;
}

test("with time tracking on, the booking parts are there", async () => {
  assert.equal(await timeOn(), true);
  assert.ok(await has('.ribbon [aria-label^="Zeiterfassung"]'), "ribbon timesheet");
  assert.ok((await openPalette("Zeiterfassung")).includes("Zeiterfassung öffnen"));
  assert.ok(await has(".statusbar .sb-item"), "status bar timer");
});

test("switching it off in Settings collapses the section to the switch", async () => {
  await setTimeTracking(false);
  const groups = await app.browser.execute(() => [...document.querySelectorAll(".settings .set-group")].filter((g) => !g.hidden && g.offsetParent).map((g) => g.dataset.group));
  assert.deepEqual(groups, ["Zeiterfassung"], `only the switch: ${groups}`);
  assert.match(await app.text(".settings-head p"), /ohne Buchungen/);
  await app.shot("time-off-settings");
  // Notifications: nothing about bookings.
  await app.click('.settings-nav-item[data-section="notifications"]');
  await app.browser.pause(200);
  const labels = await texts(".settings .set-row");
  assert.ok(!labels.some((t) => /Feierabend|Timer läuft|Woche vorschlagen|Budget/.test(t)), labels.join(" | "));
});

test("ribbon, palette, status bar and the timer shortcut show nothing about time", async () => {
  assert.ok(!(await has('.ribbon [aria-label^="Zeiterfassung"]')), "no timesheet in the ribbon");
  assert.ok(!(await has('.ribbon [aria-label^="Projekte"]')), "no projects in the ribbon");
  assert.ok(await has('.ribbon [aria-label^="Tagesrückblick"]'), "the rest stays");
  for (const q of ["Zeiterfassung", "Timer", "Woche vorschlagen", "Projekte"]) {
    const items = await openPalette(q);
    assert.ok(!items.some((t) => ["Zeiterfassung öffnen", "Timer starten", "Timer stoppen", "Woche vorschlagen", "Projekte öffnen", "Wochenbericht erstellen"].includes(t)), `${q}: ${items}`);
  }
  const zeit = await openPalette("/zeit NP-8801 1h");
  assert.ok(!zeit.some((t) => /^Buchen/.test(t)), `palette /zeit: ${zeit}`);
  assert.ok(!(await app.browser.execute(() => [...document.querySelectorAll(".statusbar .sb-item")].some((b) => /Timer/.test(b.textContent)))), "no timer in the status bar");
  assert.ok(!(await has(".sidebar-foot .side-foot-btn")), "no hours in the sidebar footer");
  // The assistant's empty state offers no booking.
  const empty = await app.browser.execute(() => document.querySelector(".assistant-empty")?.textContent ?? "");
  assert.ok(!/Zeit buchen|Zeitbuchungen|Budget/.test(empty), empty);
  const tabs = await app.browser.execute(() => document.querySelectorAll(".tab").length);
  await app.keys(["Control", "Shift", "t"]);
  await app.browser.pause(300);
  assert.equal(await app.browser.execute(() => document.querySelectorAll(".tab").length), tabs, "Ctrl+Shift+T opens nothing");
  assert.ok(!(await has(".tab.active [data-kind='timesheet']")));
});

test("booking commands refuse", async () => {
  await assert.rejects(app.invoke("log_time", { line: "/zeit NP-8801/1020 1h", pageId: null }), /Zeiterfassung ist ausgeschaltet/);
  await assert.rejects(app.invoke("timer_resume_last"), /Zeiterfassung ist ausgeschaltet/);
  // Quick capture keeps a /zeit line as text and books nothing.
  const out = await app.invoke("capture_submit", { text: "/zeit NP-8801/1020 2h aus der Schnellerfassung" });
  assert.equal(out.bookings.length, 0);
  assert.equal((await app.invoke("time_entries", { from: null, to: null })).length, entriesBefore);
});

test("the slash menu has no /zeit and chips are plain", async () => {
  await app.keys(["Control", "o"]);
  await app.type("Zeitnotiz");
  await app.browser.pause(300);
  await app.keys(["Enter"]);
  await app.waitFor(".ProseMirror .time-chip");
  assert.equal(await app.browser.execute(() => document.querySelector(".ProseMirror .time-chip").title), "Zeiteintrag");
  await app.caretToEnd();
  await app.keys(["Enter"]);
  await app.type("/zei");
  await app.browser.pause(400);
  const items = await texts(".sugg .sugg-item");
  assert.ok(!items.some((t) => /Zeit buchen/.test(t)), `slash: ${items}`);
  await app.shot("time-off-note");
  await app.keys(["Escape"]);
  // Enter on a /zeit line is just a new line.
  for (let i = 0; i < 4; i++) await app.keys(["Backspace"]);
  await app.type("/zeit NP-8801/1020 1h");
  await app.keys(["Enter"]);
  await app.browser.pause(500);
  assert.equal((await app.invoke("time_entries", { from: null, to: null })).length, entriesBefore);
  assert.ok(!(await has(".work-card")), "no work card");
});

test("Kalender: no „Zeit buchen“, no booking state, no booked hours", async () => {
  await app.keys(["Control", "Shift", "e"]);
  await app.waitText(".calv-ev .calv-ev-title", /Jour fixe Kunde X/, 15000);
  await app.browser.execute(() => [...document.querySelectorAll(".calv-ev")].find((b) => /Jour fixe Kunde X/.test(b.textContent))?.click());
  await app.waitFor(".calv-detail");
  const buttons = await texts(".calv-detail button");
  assert.ok(!buttons.some((t) => /Zeit buchen|Nicht buchen|Noch einmal buchen/.test(t)), buttons.join(" | "));
  assert.ok(buttons.some((t) => /Besprechungsnotiz/.test(t)));
  assert.ok(!(await has(".calv-detail .calv-book-state")));
  assert.ok(!(await has(".calv-booked-sum")), "no booked hours in day headers");
  assert.ok(!(await has(".calv-lane, .calv-entry")), "no booked-time lane");
  await app.shot("time-off-calendar");
  await app.keys(["Escape"]);
});

test("start page: no time widgets, no hours in „Heute“, a gallery without them", async () => {
  await app.keys(["Control", "t"]);
  await app.waitFor('.pane.active > .pane-content:not([hidden]) .dw[data-kind="today"] .dw-today', 15000);
  await app.browser.pause(500);
  const kinds = await app.browser.execute(() => [...document.querySelectorAll(".pane.active > .pane-content:not([hidden]) .dw[data-kind]")].map((w) => w.dataset.kind));
  for (const k of ["week", "budget", "timer", "proposal"]) assert.ok(!kinds.includes(k), `${k} hidden: ${kinds}`);
  assert.ok(!(await has(".pane.active > .pane-content:not([hidden]) .dw-today-hours")), "no hours ring");
  assert.ok(!(await app.browser.execute(() => [...document.querySelectorAll(".pane.active > .pane-content:not([hidden]) .dw-actions button")].some((b) => /Woche/.test(b.textContent)))));
  // The stored board still has them (they come back when switched on).
  const board = (await app.invoke("settings_get")).settings.dashboard;
  if (board?.boards?.length) assert.ok(board.boards.some((b) => b.widgets.some((w) => ["week", "budget"].includes(w.kind))), "kept in the layout");
  await app.shot("time-off-dashboard");
  await clickText(".pane.active > .pane-content:not([hidden]) .dash-bar button", /^Anpassen$/);
  await clickText(".pane.active > .pane-content:not([hidden]) button", /Widget hinzufügen/);
  await app.waitFor(".dash-gallery");
  const gallery = await app.browser.execute(() => [...document.querySelectorAll(".dash-gallery-card")].map((c) => c.dataset.kind));
  for (const k of ["week", "budget", "timer", "proposal", "project"]) assert.ok(!gallery.includes(k), `${k} not offered`);
  assert.ok(gallery.includes("tasks"));
  await app.shot("time-off-gallery");
  await app.keys(["Escape"]);
  await clickText(".pane.active > .pane-content:not([hidden]) .dash-bar button", /^Abbrechen$/);
});

test("Tagesrückblick without the Zeit section and booking states", async () => {
  await app.click(".ribbon-review");
  await app.waitFor(".rv-stats", 15000);
  await app.browser.pause(400);
  assert.ok(await has(".rv-stats.no-time"));
  assert.ok(!(await has(".rv-time")), "no Zeit card");
  assert.ok(!(await has(".rv-gaps")), "no gaps");
  const badges = await texts(".rv-meeting .badge");
  assert.ok(!badges.some((t) => /gebucht|buchen/.test(t)), badges.join(" | "));
  const r = await app.invoke("day_review", { date: null });
  assert.equal(r.without_time, true);
  await app.shot("time-off-review");
});

test("the tray menu has no timer entries", async () => {
  const info = await app.invoke("desktop_info");
  if (info.tray_menu) assert.deepEqual(info.tray_menu, ["open", "search", "briefing", "-", "capture", "-", "quit"]);
});

test("switched on again, everything is back and the entries are intact", async () => {
  await setTimeTracking(true);
  assert.ok(await has('.ribbon [aria-label^="Zeiterfassung"]'));
  assert.ok(await has('.ribbon [aria-label^="Projekte"]'));
  const groups = await app.browser.execute(() => [...document.querySelectorAll(".settings .set-group")].filter((g) => !g.hidden && g.offsetParent).length);
  assert.ok(groups > 3, "all time settings back");
  assert.ok((await openPalette("Zeiterfassung")).includes("Zeiterfassung öffnen"));
  const entries = await app.invoke("time_entries", { from: null, to: null });
  assert.equal(entries.length, entriesBefore);
  assert.ok(entries.some((e) => e.description === "Chip aus dem Test"));
  const info = await app.invoke("desktop_info");
  if (info.tray_menu) assert.ok(info.tray_menu.includes("stop") && info.tray_menu.includes("resume"));
  await app.keys(["Control", "t"]);
  await app.waitFor('.pane.active > .pane-content:not([hidden]) .dw[data-kind="today"] .dw-today', 15000);
  await app.waitFor(".pane.active > .pane-content:not([hidden]) .dw-today-hours");
  await app.click('.ribbon [aria-label^="Zeiterfassung"]');
  await app.waitFor(".pane.active > .pane-content:not([hidden]) .ts-grid, .pane.active > .pane-content:not([hidden]) .timesheet", 15000).catch(() => {});
  assert.ok(!(await has(".pane.active > .pane-content:not([hidden]) .empty-state")) || !(await app.text(".pane.active > .pane-content:not([hidden]) .view-body")).includes("ausgeschaltet"));
  // Booking works again.
  const out = await app.invoke("log_time", { line: "/zeit NP-8801/1020 0.5h 'Wieder an'", pageId: null });
  assert.ok(out.entry.id > 0);
});
