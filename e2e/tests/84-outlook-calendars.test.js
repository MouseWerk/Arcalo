// Outlook calendar selection („Kalender auswählen“, script output from a fixture): discovery
// lists the default calendar, a sub-calendar, a PST, calendars shared by colleagues (one only
// free/busy, one refusing access) and a room; two more are selected and sync with their own
// colors and status; the Kalender legend hides one in the view only; a meeting in two
// calendars shows once; a colleague's meetings are no booking proposals until asked for.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, guarded } from "../lib/harness.js";
import { iso, outlookCalendarsJson, outlookEnv, week } from "../lib/calendar-fixtures.js";

const test = guarded(nodeTest, () => app);
let app;
let dir;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "arcalo-olcal-"));
  const fixture = path.join(dir, "outlook.json");
  fs.writeFileSync(fixture, outlookCalendarsJson());
  app = await launch({ env: outlookEnv(fixture) });
});
after(async () => {
  await app?.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

const status = () => app.invoke("calendar_status");
/** The id of the row whose name (and owner) match. */
const rowId = (name, owner = null) =>
  app.browser.execute(
    (n, o) =>
      [...document.querySelectorAll(".olcal-row")].find((r) => r.querySelector(".olcal-name .ellipsis")?.textContent === n && (!o || r.querySelector(".olcal-owner")?.textContent === o))?.dataset.calendar ?? null,
    name,
    owner,
  );
const ids = {};
const row = (id) => `.olcal-row[data-calendar="${id}"]`;
const eventsOf = async (source) => {
  const range = { from: new Date(Date.now() - 20 * 86400e3).toISOString(), to: new Date(Date.now() + 20 * 86400e3).toISOString() };
  return (await app.invoke("calendar_events", range)).filter((e) => !source || e.source === source);
};

test("discovery lists every calendar of Outlook with its badges", async () => {
  await app.click(".ribbon-calendar-view");
  await app.click(".calv-empty .btn-primary");
  await app.waitFor('.settings-nav-item.active[data-section="calendar"]');
  await app.click('[role="switch"][aria-label="Outlook-Kalender lesen"]');
  // The list appears with the switch and searches by itself.
  await app.waitText(".olcal-found", /7 Kalender gefunden/, 15000);
  const names = await app.browser.execute(() => [...document.querySelectorAll(".olcal-row")].map((r) => `${r.querySelector(".olcal-name .ellipsis").textContent} | ${r.querySelector(".olcal-owner")?.textContent ?? ""} | ${[...r.querySelectorAll(".badge")].map((b) => b.textContent).join(",")}`));
  assert.deepEqual(names, [
    "Kalender | maurice@firma.de | Standard",
    "Projekt X | maurice@firma.de | ",
    "Kalender | Archiv 2025 | Datei",
    "Kalender | Anna Müller | Freigegeben",
    "Chef | Chef | Freigegeben",
    "Jörg Weiß | Jörg Weiß | Freigegeben,nur Frei/Gebucht",
    "Raum Zürich | Raum Zürich | Raum",
  ]);
  ids.proj = await rowId("Projekt X");
  ids.anna = await rowId("Kalender", "Anna Müller");
  ids.joerg = await rowId("Jörg Weiß");
  ids.chef = await rowId("Chef");
  assert.ok(ids.proj.startsWith("outlook:") && ids.anna.startsWith("outlook:") && ids.proj !== ids.anna);
  // The default calendar is selected and keeps the id `outlook`; it synced at once.
  assert.equal(await app.browser.execute(() => document.querySelector('.olcal-row[data-calendar="outlook"] input.check').checked), true);
  await app.waitText(`${row("outlook")} .olcal-status`, /Termine · synchronisiert/, 15000);
  // A calendar refusing access says so and cannot be selected; the others show their size.
  await app.waitText(`${row(ids.chef)} .olcal-status`, /Kein Zugriff.*Berechtigung/);
  assert.equal(await app.browser.execute((s) => document.querySelector(`${s} input.check`).disabled, row(ids.chef)), true);
  await app.waitText(`${row(ids.proj)} .olcal-status`, /^12 Elemente$/);
  // Booking proposals: on for own calendars, off for shared ones.
  const booking = (id) => app.browser.execute((s) => document.querySelector(`${s} [role="switch"]`).getAttribute("aria-checked"), row(id));
  assert.equal(await booking(ids.proj), "true");
  assert.equal(await booking(ids.anna), "false");
  await app.shot("84-outlook-calendar-list");
});

test("two more calendars are selected, sync with their own status and color", async () => {
  await app.click(`${row(ids.proj)} input.check`);
  await app.click(`${row(ids.anna)} input.check`);
  await app.browser.waitUntil(
    async () => {
      const s = await status();
      return [ids.proj, ids.anna].every((id) => s.sources.find((x) => x.id === id)?.status?.synced_at);
    },
    { timeout: 15000, timeoutMsg: "selected calendars not synced" },
  );
  await app.waitText(`${row(ids.proj)} .olcal-status`, /^2 Termine · synchronisiert/);
  await app.waitText(`${row(ids.anna)} .olcal-status`, /^3 Termine · synchronisiert/);
  // Every calendar keeps its own rows.
  assert.deepEqual((await eventsOf(ids.proj)).map((e) => e.title), ["Projekt-Sync alt", "Projekt-Sync"]);
  // A color of its own, changed with the swatch.
  const cal = (await app.invoke("settings_get")).settings.calendar;
  const colors = cal.outlook_calendars.filter((c) => c.enabled).map((c) => c.color);
  assert.equal(new Set(colors).size, 3, `distinct colors: ${colors}`);
  await app.click(`${row(ids.proj)} .olcal-swatch`);
  await app.click(`${row(ids.proj)} .olcal-color[aria-label="Grün"]`);
  await app.browser.waitUntil(async () => (await app.invoke("settings_get")).settings.calendar.outlook_calendars.find((c) => c.id === ids.proj)?.color === "#65a30d", { timeoutMsg: "color not saved" });
  // The Outlook status row sums the three up.
  await app.waitText(".calset-status .set-status", /^3 Kalender · \d+ Termine · synchronisiert/);
  await app.shot("84-outlook-calendars-selected");
});

test("the Kalender shows each calendar in its color; the legend hides one in the view only", async () => {
  await app.click(".ribbon-calendar-view");
  await app.waitFor(".calv-legend");
  const legend = await app.browser.execute(() => [...document.querySelectorAll(".calv-legend-item")].map((b) => `${b.textContent}|${b.style.getPropertyValue("--ev")}|${b.getAttribute("aria-pressed")}`));
  assert.deepEqual(legend, ["Outlook|#2563eb|true", "Projekt X|#65a30d|true", "Anna Müller – Kalender|" + legend[2].split("|")[1] + "|true"]);
  const color = (title) => app.browser.execute((t) => [...document.querySelectorAll(".calv-ev")].find((b) => b.querySelector(".calv-ev-title")?.textContent === t)?.style.getPropertyValue("--ev") ?? null, title);
  await app.waitText(".calv-ev .calv-ev-title", /^Projekt-Sync$/);
  assert.equal(await color("Projekt-Sync"), "#65a30d");
  assert.equal(await color("Anna: Vertriebsrunde"), legend[2].split("|")[1]);
  await app.shot("84-calendar-colors");

  // Hidden in the view: its meetings go, the selection (and sync) stays.
  await app.click(`.calv-legend-item[data-source="${ids.anna}"]`);
  await app.browser.waitUntil(async () => (await color("Anna: Vertriebsrunde")) === null, { timeoutMsg: "still shown" });
  assert.equal(await app.browser.execute((id) => document.querySelector(`.calv-legend-item[data-source="${id}"]`).getAttribute("aria-pressed"), ids.anna), "false");
  await app.waitText(".calv-legend-note", /1 ausgeblendet/);
  const cal = (await app.invoke("settings_get")).settings.calendar;
  assert.equal(cal.outlook_calendars.find((c) => c.id === ids.anna).enabled, true, "still synced");
  assert.ok((await app.invoke("week_proposal", { weekStart: iso(week().monday), restOfToday: true })) !== null);
  await app.shot("84-calendar-hidden");
  await app.click(`.calv-legend-item[data-source="${ids.anna}"]`);
  await app.browser.waitUntil(async () => (await color("Anna: Vertriebsrunde")) !== null, { timeoutMsg: "not shown again" });
});

test("the start page's „Termine“ lists the Outlook calendars by name and color", async () => {
  await app.keys(["Control", "t"]);
  await app.waitFor('.pane.active .dw[data-widget="agenda"]');
  await app.browser.execute(() => document.querySelector('.pane.active .dw[data-widget="agenda"] .dw-gear').click());
  await app.waitFor(".dialog .dws");
  const rows = await app.browser.execute(() => [...document.querySelectorAll(".dialog .dws-check")].map((l) => `${l.querySelector(".ellipsis")?.textContent}|${l.querySelector(".dws-swatch")?.style.background}`));
  const names = rows.map((r) => r.split("|")[0]);
  assert.deepEqual(names, ["Outlook", "Projekt X", "Anna Müller – Kalender"]);
  assert.match(rows[1], /\|rgb\(101, 163, 13\)$/, "Projekt X in its color");
  await app.shot("84-dashboard-calendars");
  await app.keys(["Escape"]);
  await app.click(".pane.active .tab.active .tab-close");
});

test("a meeting in two calendars shows once, from the own calendar, naming the other", async () => {
  const jf = (await eventsOf()).filter((e) => e.title === "Jour fixe Vertrieb");
  assert.equal(jf.length, 1, "deduplicated");
  assert.equal(jf[0].source, "outlook", "the own calendar wins");
  assert.deepEqual(jf[0].also_in, [ids.anna]);
  const blocks = await app.browser.execute(() => [...document.querySelectorAll(".calv-ev")].filter((b) => b.querySelector(".calv-ev-title")?.textContent === "Jour fixe Vertrieb").length);
  assert.equal(blocks, 1);
  await app.browser.execute(() => [...document.querySelectorAll(".calv-ev")].find((b) => b.querySelector(".calv-ev-title")?.textContent === "Jour fixe Vertrieb").click());
  await app.waitText(".calv-also-in", /Auch in:\s*Anna Müller – Kalender/);
  await app.shot("84-calendar-dedupe-detail");
  // A colleague's calendar says it is not used for booking proposals.
  await app.browser.execute(() => [...document.querySelectorAll(".calv-ev")].find((b) => b.querySelector(".calv-ev-title")?.textContent === "Anna: Vertriebsrunde").click());
  await app.waitText(".calv-detail-row", /nicht für Buchungsvorschläge/);
  await app.waitText(".calv-detail-source", /Anna Müller – Kalender/);
  await app.keys(["Escape"]);
});

test("shared-calendar meetings are no booking proposals until the calendar is used for them", async () => {
  const texts = async () => (await app.invoke("week_proposal", { weekStart: iso(week(-1).monday), restOfToday: false })).proposals.map((p) => p.text).join(" | ");
  // The demo bookings start hours before „now“ on each past day and could cover the meetings.
  for (const e of await app.invoke("time_entries", { from: null, to: null })) await app.invoke("delete_time_entry", { id: e.id });
  const before = await texts();
  assert.match(before, /Projekt-Sync alt/, "own sub-calendar proposed");
  assert.match(before, /Planung Rollout/, "default calendar proposed");
  assert.doesNotMatch(before, /Kundentermin Anna/, "a colleague's meeting is not");
  await app.invoke("calendar_outlook_update", { id: ids.anna, enabled: null, color: null, booking: true });
  assert.match(await texts(), /Kundentermin Anna/, "after „Für Buchungsvorschläge verwenden“");
  await app.invoke("calendar_outlook_update", { id: ids.anna, enabled: null, color: null, booking: false });
  assert.doesNotMatch(await texts(), /Kundentermin Anna/);
});

test("a free/busy-only calendar syncs its busy times without subjects", async () => {
  await app.invoke("calendar_outlook_update", { id: ids.joerg, enabled: true, color: null, booking: null });
  await app.browser.waitUntil(async () => (await status()).sources.find((x) => x.id === ids.joerg)?.status?.synced_at, { timeout: 15000, timeoutMsg: "free/busy not synced" });
  const evs = await eventsOf(ids.joerg);
  assert.deepEqual(evs.map((e) => [e.title, e.busy]), [["Beschäftigt", "busy"]]);
  // The Kalender shows it with its note.
  await app.waitText(".calv-ev .calv-ev-title", /^Beschäftigt$/, 10000);
  await app.browser.execute(() => [...document.querySelectorAll(".calv-ev")].find((b) => b.querySelector(".calv-ev-title")?.textContent === "Beschäftigt").click());
  await app.waitText(".calv-detail-row", /Nur Frei\/Gebucht freigegeben/);
  await app.keys(["Escape"]);
});

test("a calendar that fails does not fail the others", async () => {
  // Anna's calendar is no longer shared: its error, the rest syncs.
  const fixture = JSON.parse(outlookCalendarsJson());
  fixture.folders["E-ANNA"] = { ok: false, error: "denied", message: "Keine Berechtigung" };
  fs.writeFileSync(path.join(dir, "outlook.json"), JSON.stringify(fixture));
  await app.invoke("calendar_sync_now", { source: null });
  const s = await status();
  const of = (id) => s.sources.find((x) => x.id === id).status;
  assert.match(of(ids.anna).error, /Kein Zugriff.*Keine Berechtigung/);
  assert.equal(of("outlook").error, null);
  assert.equal(of(ids.proj).error, null);
  // Its stored meetings stay until it syncs again.
  assert.ok((await eventsOf(ids.anna)).length > 0);
  await app.click('.calv-actions [aria-label="Kalendereinstellungen"]');
  await app.waitFor('.settings-nav-item.active[data-section="calendar"]');
  await app.waitText(`${row(ids.anna)} .olcal-status`, /Kein Zugriff/);
  await app.waitText(".calset-status .set-status", /1 von \d Kalendern mit Fehler/);
  await app.shot("84-outlook-calendar-error");
});

for (const theme of ["dark", "light"]) {
  test(`the list and the legend at 900 px in ${theme} mode`, async () => {
    await app.browser.execute((t) => (document.documentElement.dataset.theme = t), theme);
    await app.browser.setWindowSize(900, 900);
    await app.browser.pause(300);
    await app.browser.execute(() => document.querySelector(".olcal")?.scrollIntoView({ block: "start" }));
    await app.shot(`84-outlook-list-900-${theme}`);
    const overflow = await app.browser.execute(() => [...document.querySelectorAll(".olcal-row")].some((r) => r.scrollWidth > r.clientWidth + 1));
    assert.equal(overflow, false, "rows fit");
    await app.click(".ribbon-calendar-view");
    await app.waitFor(".calv-legend");
    await app.shot(`84-calendar-legend-900-${theme}`);
    await app.browser.setWindowSize(1480, 920);
  });
}
