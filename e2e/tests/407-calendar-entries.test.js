// Appointments in the Kalender (1.21): created by dragging over a free stretch, a double click or
// N (writing to Outlook is offered on first use), renamed, moved and resized, deleted with
// „Rückgängig“, written to Outlook (a fixture log stands in for the script and comes back with the
// next sync, once). A closed Outlook makes a change wait, a change made in Outlook too asks which
// one applies, a received meeting stays read-only with „In Outlook öffnen“, an organized meeting
// asks before the update goes to its attendees. Switched off, nothing can be changed. The panels
// are checked in light, dark and high-contrast themes.
import { test as nodeTest, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, guarded } from "../lib/harness.js";
import { iso, outlookEnv, week } from "../lib/calendar-fixtures.js";
import { auditLayout } from "../lib/layout-audit.js";

const test = guarded(nodeTest, () => app);
let app;
let dir;
let log;
const HOUR = 48;
const today = new Date();
const todayIso = iso(today);
const { monday } = week();
const range = { from: monday.toISOString(), to: new Date(monday.getTime() + 7 * 86400e3).toISOString() };
const at = (h, m = 0) => new Date(today.getFullYear(), today.getMonth(), today.getDate(), h, m);
const utc = (d) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
const pad = (n) => String(n).padStart(2, "0");
const local = (d) => `${iso(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The script's output: own appointments, a received, an organized meeting and a series. */
function outlookItems() {
  const item = (id, subject, a, b, extra = {}) => ({
    entryId: id, globalId: `G-${id}`, subject, start: utc(a), end: utc(b), startLocal: local(a), endLocal: local(b),
    allDay: false, recurring: false, busy: 2, sensitivity: 0, responseStatus: 0, meetingStatus: 0, location: "", organizer: "", attendees: [], categories: "", body: null, urls: [],
    modified: "2026-01-01T08:00:00Z", recipients: 0, ...extra,
  });
  return JSON.stringify({
    ok: true,
    items: [
      item("O1", "Angebot prüfen", at(10), at(11)),
      item("O2", "Rückruf Kunde", at(15, 15), at(15, 45)),
      item("R1", "Abstimmung Vertrieb", at(13), at(14), { meetingStatus: 3, responseStatus: 3, organizer: "Müller, Anna", attendees: ["Müller, Anna", "Ich"], recipients: 2 }),
      item("W1", "Workshop Planung", at(16), at(17), { meetingStatus: 1, organizer: "Ich", attendees: ["Ich", "Anna Müller", "Jörg Weiß"], recipients: 2 }),
      item("S1", "Daily", at(8, 30), at(8, 45), { recurring: true }),
    ],
  });
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "arcalo-entries-"));
  const readFixture = path.join(dir, "outlook.json");
  log = path.join(dir, "writes.log");
  fs.writeFileSync(readFixture, outlookItems());
  app = await launch({ width: 1600, height: 1000, env: { ...outlookEnv(readFixture), ARCALO_OUTLOOK_WRITE_LOG: log } });
  const view = await app.invoke("settings_get");
  assert.equal(view.settings.calendar.entries_outlook, false, "off for a new installation too");
  await app.invoke("settings_save", { settings: { ...view.settings, calendar: { ...view.settings.calendar, outlook: true, entry_minutes: 30 } } });
  await app.invoke("calendar_sync_now", { source: "outlook" });
  await app.browser.execute(() => localStorage.setItem("arcalo.calendar.view", "week"));
  // The Kalender with its side panel, the assistant's panel closed.
  if (await app.browser.execute(() => document.querySelector(".app")?.classList.contains("with-panel"))) await app.keys(["Control", "Shift", "\\"]);
  await app.click(".ribbon-calendar-view");
  await app.waitFor(`.calv-col[data-date="${todayIso}"]`);
  await app.waitText(".calv-ev .calv-ev-title", /^Angebot prüfen$/);
});
// Each test starts with no panel open and no message over the grid.
beforeEach(async () => {
  if (!app) return;
  await app.browser.execute(() => document.activeElement?.blur());
  await app.keys(["Escape"]);
  await app.dismissToasts();
});
after(async () => {
  await app?.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

const writes = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const entryWrites = () => writes().filter((w) => w.kind === "entry");
const events = () => app.invoke("calendar_events", range);
const byTitle = async (title) => (await events()).filter((e) => e.title === title);
const one = async (title) => {
  const list = await byTitle(title);
  assert.equal(list.length, 1, `${title}: ${list.length}`);
  return list[0];
};
const hm = (s) => {
  const d = new Date(s);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const col = `.calv-col[data-date="${todayIso}"]`;
const sel = (key) => `[data-key="${key}"]`;
/** Scrolls the grid so `hour` is near the top. */
const scrollTo = (hour) => app.browser.execute((y) => (document.querySelector(".calv-scroll").scrollTop = y), (hour - 1) * HOUR);
const rect = (s) => app.browser.execute((q) => {
  const r = document.querySelector(q).getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
}, s);
const drag = async (x, y, dy, dx = 0) => {
  await app.browser.action("pointer").move({ x, y }).down().move({ x, y: y + 6, duration: 80 }).move({ x: x + dx, y: y + dy, duration: 200 }).up().perform();
  await app.browser.pause(200);
};
const clickText = async (s, pattern) => {
  await app.browser.waitUntil(
    () => app.browser.execute((q, src) => {
      const el = [...document.querySelectorAll(q)].find((b) => new RegExp(src).test(b.textContent.trim()) && !b.disabled);
      el?.click();
      return !!el;
    }, s, pattern.source),
    { timeoutMsg: `no ${s} ${pattern}` },
  );
  await app.browser.pause(150);
};
const waitWrite = (pred, msg) => app.browser.waitUntil(async () => entryWrites().some(pred), { timeout: 10000, timeoutMsg: msg });
/** Types into the panel's input and leaves it (saved on blur). */
const setInput = async (s, value) => {
  await app.browser.execute((q, v) => {
    const el = document.querySelector(q);
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    el.focus();
    set.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, s, value);
  await app.browser.pause(50);
  await app.browser.execute((q) => document.querySelector(q).blur(), s);
  await app.browser.pause(150);
};

test("switched off, the first new appointment offers writing to Outlook; a double click makes one", async () => {
  // Read-only kinds say why, from the start.
  assert.equal(await app.browser.execute(() => document.querySelectorAll(".calv-appt").length), 0, "nothing can be moved while writing is off");
  await scrollTo(18);
  await app.browser.execute((c, hour) => {
    const el = document.querySelector(c);
    const target = el.querySelector(".calv-meetings");
    const r = el.getBoundingClientRect();
    target.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, clientX: r.x + 20, clientY: r.top + 18 * hour + 5 }));
  }, col, HOUR);
  await app.waitText(".dialog", /Termine in Outlook eintragen\?/);
  await app.shot("407-offer");
  await clickText(".dialog .btn", /^Einschalten$/);
  await app.waitFor(".calv-entry-editor");
  assert.equal((await app.invoke("settings_get")).settings.calendar.entries_outlook, true);
  const times = await app.browser.execute(() => [...document.querySelectorAll(".calv-entry-editor .time-input")].map((i) => i.value));
  assert.deepEqual(times, ["18:00", "18:30"], "the setting's 30 minutes from the slot");
  await app.waitFor(".calv-entry-ghost");
  assert.equal(await app.browser.execute(() => document.activeElement?.getAttribute("aria-label")), "Titel");
  await app.type("Telefonat Lieferant");
  await app.keys(["Enter"]);
  await waitWrite((w) => w.op === "create" && w.fields.subject === "Telefonat Lieferant", "not written to Outlook");
  const w = entryWrites().find((x) => x.op === "create");
  assert.deepEqual([w.fields.start, w.fields.end, w.folder], [`${todayIso}T18:00:00`, `${todayIso}T18:30:00`, ""]);
  assert.match(w.marker, /^arcalo-entry-[0-9a-f]{32}$/, "the hidden marker, no category");
  assert.equal(w.category, undefined);
  await app.browser.waitUntil(async () => (await byTitle("Telefonat Lieferant"))[0]?.write == null, { timeoutMsg: "still waiting" });
  // The next sync brings it back from Outlook: shown once.
  await app.invoke("calendar_sync_now", { source: "outlook" });
  const e = await one("Telefonat Lieferant");
  assert.equal(e.key, `outlook|G-${w.entryId}|`);
  assert.equal(e.editable, "yes");
});

test("dragging over a free stretch and N make new appointments", async () => {
  await scrollTo(12);
  const c = await rect(col);
  const top = c.y + 12 * HOUR + 4;
  await drag(c.x + 30, top, (3 * HOUR) / 4);
  await app.waitFor(".calv-entry-editor");
  const times = await app.browser.execute(() => [...document.querySelectorAll(".calv-entry-editor .time-input")].map((i) => i.value));
  assert.deepEqual(times, ["12:00", "13:00"], "the stretch dragged over, on the quarter hour");
  await app.type("Workshop vorbereiten");
  await setInput(".calv-entry-editor input[aria-label='Ort']", "Raum 4");
  await app.shot("407-new-entry");
  await clickText(".calv-entry-editor .btn", /^Anlegen$/);
  await waitWrite((w) => w.op === "create" && w.fields.subject === "Workshop vorbereiten", "drag: not written");
  assert.equal(entryWrites().find((w) => w.fields?.subject === "Workshop vorbereiten").fields.location, "Raum 4");
  await app.waitFor(`.calv-detail .calv-entry-name`);
  assert.equal(await app.browser.execute(() => document.querySelector(".calv-detail .calv-entry-name").value), "Workshop vorbereiten", "opens right away");

  // N: a new one at the next half hour of today; Escape closes it without a write.
  await app.click(".calv-head h1");
  await app.keys(["Escape"]);
  await app.keys(["n"]);
  await app.waitFor(".calv-entry-editor");
  const n = await app.browser.execute(() => document.querySelector(".calv-entry-editor .time-input").value);
  assert.match(n, /^\d\d:(00|30)$/);
  const count = entryWrites().length;
  await app.keys(["Escape"]);
  await app.browser.waitUntil(() => app.browser.execute(() => !document.querySelector(".calv-entry-editor")), { timeoutMsg: "editor still open" });
  await sleep(400);
  assert.equal(entryWrites().length, count);
});

test("renamed, moved and resized: Outlook gets only what changed", async () => {
  const key = "outlook|G-O1|";
  await scrollTo(10);
  await app.click(sel(key));
  await app.waitFor(".calv-detail .calv-entry-name");
  await setInput(".calv-detail .calv-entry-name", "Angebot prüfen und senden");
  await waitWrite((w) => w.op === "update" && w.entryId === "O1", "rename not written");
  let w = entryWrites().filter((x) => x.entryId === "O1").at(-1);
  assert.deepEqual(w.fields, { subject: "Angebot prüfen und senden" }, "a patch of the title only");

  // One hour down with the mouse: 11:00–12:00.
  await app.keys(["Escape"]);
  let r = await rect(sel(key));
  await drag(r.x + r.w / 2, r.y + 10, HOUR);
  await app.browser.waitUntil(async () => hm((await one("Angebot prüfen und senden")).start) === "11:00", { timeoutMsg: "not moved" });
  await waitWrite((x) => x.entryId === "O1" && x.fields.start === `${todayIso}T11:00:00`, "move not written");
  w = entryWrites().filter((x) => x.entryId === "O1").at(-1);
  assert.deepEqual(Object.keys(w.fields).sort(), ["end", "start"]);
  // The handle at its foot: half an hour longer.
  r = await rect(sel(key));
  await drag(r.x + r.w / 2, r.y + r.h - 3, HOUR / 2);
  await waitWrite((x) => x.entryId === "O1" && x.fields.end === `${todayIso}T12:30:00` && !x.fields.start, "resize not written");
  // Keyboard: Shift+arrow down another quarter hour.
  await app.browser.execute((s) => document.querySelector(s).focus(), sel(key));
  await app.keys(["Shift", "ArrowDown"]);
  await waitWrite((x) => x.entryId === "O1" && x.fields.end === `${todayIso}T12:45:00`, "key resize not written");
  assert.equal(await app.browser.execute((s) => document.querySelector(s).getAttribute("aria-description"), sel(key)), "Pfeiltasten verschieben, Umschalt und Pfeiltasten ändern die Länge, Entf löscht, Eingabe öffnet");
});

test("deleted to Outlook's Deleted Items and brought back with Rückgängig", async () => {
  const e = await one("Telefonat Lieferant");
  await scrollTo(18);
  await app.click(sel(e.key));
  await clickText(".calv-detail .calv-entry-delete", /^Löschen$/);
  await waitWrite((w) => w.op === "delete" && w.entryId === e.outlook_id, "delete not written");
  assert.equal((await byTitle("Telefonat Lieferant")).length, 0);
  await app.waitText(".toast", /Termin gelöscht/);
  await clickText(".toast .btn", /^Rückgängig$/);
  await waitWrite((w) => w.op === "restore", "undo not written");
  await app.browser.waitUntil(async () => (await byTitle("Telefonat Lieferant")).length === 1, { timeoutMsg: "not back" });
  await app.invoke("calendar_sync_now", { source: "outlook" });
  assert.equal((await one("Telefonat Lieferant")).write ?? null, null);
});

test("with Outlook closed the change waits, then goes in", async () => {
  fs.writeFileSync(`${log}.offline`, "");
  const key = "outlook|G-O1|";
  await scrollTo(11);
  await app.click(sel(key));
  await app.waitFor(".calv-detail .calv-entry-name");
  await setInput(".calv-detail .calv-entry-name", "Angebot an Kunde X");
  await app.waitFor('.calv-detail [data-write="pending"]');
  assert.match(await app.text('.calv-detail [data-write="pending"]'), /Wartet auf Outlook\s*Outlook ist nicht geöffnet/);
  assert.ok(await app.browser.execute((s) => !!document.querySelector(`${s}.write-pending .calv-mark`), sel(key)), "a clock on the appointment");
  assert.equal((await one("Angebot an Kunde X")).write.state, "pending", "shown as changed meanwhile");
  await app.shot("407-pending");
  fs.rmSync(`${log}.offline`);
  await clickText('.calv-detail [data-write="pending"] .btn', /^Erneut versuchen$/);
  await waitWrite((w) => w.entryId === "O1" && w.fields.subject === "Angebot an Kunde X", "not written after Outlook opened");
  await app.browser.waitUntil(() => app.browser.execute(() => !document.querySelector('.calv-detail [data-write="pending"]')), { timeoutMsg: "still pending" });
});

test("a change made in Outlook too asks which one applies", async () => {
  const key = "outlook|G-O2|";
  // Outlook renames it while Arcalo does too.
  fs.appendFileSync(log, `${JSON.stringify({ kind: "entry", op: "outlook", entryId: "O2", fields: { subject: "Rückruf Kunde (verschoben)" }, modified: "2026-01-02T08:00:00Z" })}\n`);
  await scrollTo(15);
  await app.click(sel(key));
  await app.waitFor(".calv-detail .calv-entry-name");
  await setInput(".calv-detail .calv-entry-name", "Rückruf Kunde Müller");
  await app.waitFor('.calv-detail [data-write="conflict"]');
  const text = await app.text('.calv-detail [data-write="conflict"]');
  assert.match(text, /Auch in Outlook geändert/);
  assert.match(text, /In Outlook Rückruf Kunde \(verschoben\)/);
  assert.match(text, /Deine Änderung Rückruf Kunde Müller/);
  assert.ok(await app.browser.execute((s) => !!document.querySelector(`${s}.write-conflict`), sel(key)));
  const look = await app.browser.execute(() => {
    const cs = getComputedStyle(document.querySelector('.calv-detail [data-write="conflict"]'));
    return { left: cs.borderLeftWidth, outline: cs.outlineStyle };
  });
  assert.deepEqual(look, { left: "0px", outline: "none" }, "a tint, no bar or frame");
  for (const [mode, light, dark, name] of [["light", "arcalo-light", "arcalo-dark", "light"], ["dark", "arcalo-light", "arcalo-dark", "dark"], ["light", "contrast-light", "arcalo-dark", "contrast"]]) {
    const v = await app.invoke("settings_get");
    await app.invoke("settings_save", { settings: { ...v.settings, theme: mode, appearance: { ...v.settings.appearance, theme_light: light, theme_dark: dark } } });
    await app.browser.waitUntil(async () => (await app.browser.execute(() => document.documentElement.dataset.themeId)) === (mode === "dark" ? dark : light), { timeoutMsg: `theme ${name}` });
    await sleep(300);
    const problems = await app.browser.execute(auditLayout, ".calv-detail");
    assert.deepEqual(problems, [], `${name}: ${problems.join("\n")}`);
    await app.shot(`407-conflict-${name}`);
  }
  const v = await app.invoke("settings_get");
  await app.invoke("settings_save", { settings: { ...v.settings, theme: "light", appearance: { ...v.settings.appearance, theme_light: "arcalo-light", theme_dark: "arcalo-dark" } } });
  const before = entryWrites().length;
  await clickText('.calv-detail [data-write="conflict"] .btn', /^Meine Änderung behalten$/);
  await waitWrite((w) => w.entryId === "O2" && w.op === "update" && w.fields.subject === "Rückruf Kunde Müller", "mine not written");
  assert.equal(entryWrites().length, before + 1);
  await app.browser.waitUntil(async () => (await one("Rückruf Kunde Müller")).write == null, { timeoutMsg: "conflict stays" });
});

test("a received meeting stays read-only and opens in Outlook", async () => {
  const key = "outlook|G-R1|";
  await scrollTo(13);
  const kind = await app.browser.execute((s) => document.querySelector(s).className, sel(key));
  assert.doesNotMatch(kind, /calv-appt/, "not movable");
  await app.click(sel(key));
  await app.waitFor('.calv-detail [data-readonly="received"]');
  assert.match(await app.text('.calv-detail [data-readonly="received"]'), /Eingeladen: Änderungen nur in Outlook/);
  assert.equal(await app.browser.execute(() => !!document.querySelector(".calv-detail .calv-entry-name, .calv-detail .calv-entry-delete")), false);
  await clickText(".calv-detail .btn", /^In Outlook öffnen$/);
  await app.browser.waitUntil(async () => writes().some((w) => w.kind === "show" && w.entryId === "R1"), { timeoutMsg: "not shown in Outlook" });
  await app.shot("407-read-only");
  // A series too.
  const series = (await events()).find((e) => e.title === "Daily");
  assert.equal(series.editable, "series");
  await assert.rejects(app.invoke("calendar_entry_update", { key, patch: { title: "x" }, send: true }), /nur in Outlook/);
});

test("an organized meeting changes only after the update to its attendees is confirmed", async () => {
  const key = "outlook|G-W1|";
  await scrollTo(16);
  await app.dismissToasts();
  const count = entryWrites().length;
  await app.browser.execute((s) => document.querySelector(s).focus(), sel(key));
  await app.keys(["ArrowDown"]);
  await app.waitText(".dialog", /Aktualisierung an 2 Teilnehmende senden\?/);
  await app.shot("407-send-confirm");
  await clickText(".dialog .btn", /^Abbrechen$/);
  await sleep(500);
  assert.equal(entryWrites().length, count, "nothing saved without the confirmation");
  assert.equal(hm((await one("Workshop Planung")).start), "16:00");
  await app.browser.execute((s) => document.querySelector(s).focus(), sel(key));
  await app.keys(["ArrowDown"]);
  await clickText(".dialog .btn", /^Senden und speichern$/);
  await waitWrite((w) => w.entryId === "W1" && w.op === "update", "update not written");
  const w = entryWrites().filter((x) => x.entryId === "W1").at(-1);
  assert.deepEqual([w.fields.start, w.fields.end, w.sent], [`${todayIso}T16:15:00`, `${todayIso}T17:15:00`, true], "Outlook sent the update");
  // Cancelling goes through Outlook: no delete here.
  await app.click(sel(key));
  await app.waitFor(".calv-detail .calv-entry-name");
  assert.equal(await app.browser.execute(() => !!document.querySelector(".calv-detail .calv-entry-delete")), false);
  assert.match(await app.text(".calv-detail .calv-entry-state"), /Änderungen gehen als Aktualisierung an die Teilnehmenden[\s\S]*In Outlook absagen/);
});

test("switched off in the settings: nothing can be changed and N offers it again", async () => {
  await app.invoke("calendar_entries_enable", { on: false });
  await app.browser.waitUntil(async () => (await app.browser.execute(() => document.querySelectorAll(".calv-appt").length)) === 0, { timeoutMsg: "still movable" });
  await app.click(sel("outlook|G-O1|"));
  await app.waitText(".calv-detail .calv-entry-state", /„Termine in Outlook eintragen“ einschalten/);
  await assert.rejects(app.invoke("calendar_entry_update", { key: "outlook|G-O1|", patch: { title: "x" }, send: false }), /ausgeschaltet/);
  await app.keys(["Escape"]);
  await app.click(".calv-head h1");
  await app.keys(["n"]);
  await app.waitText(".dialog", /Termine in Outlook eintragen\?/);
  await clickText(".dialog .btn", /^Abbrechen$/);
  assert.equal(await app.browser.execute(() => !!document.querySelector(".calv-entry-editor")), false);
  // The settings group says what it does; nothing waits.
  const st = await app.invoke("calendar_status");
  assert.equal(st.entries_available, true);
  assert.deepEqual(st.entries_waiting, {});
  await app.click('.calv-actions [aria-label="Kalendereinstellungen"]');
  await app.waitFor('.settings-nav-item.active[data-section="calendar"]');
  await app.waitText(".set-group-head h2", /^Termine anlegen$/);
  const sw = '[role="switch"][aria-label="Termine in Outlook eintragen"]';
  await app.browser.execute((s) => document.querySelector(s).scrollIntoView({ block: "center" }), sw);
  assert.equal(await app.browser.execute((s) => document.querySelector(s).getAttribute("aria-checked"), sw), "false");
  await app.shot("407-settings");
});
