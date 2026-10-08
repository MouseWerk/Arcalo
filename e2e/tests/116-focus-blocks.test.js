// Time blocking (1.8): a task dragged from the Aufgaben list into the week becomes a focus block
// (default length, on the quarter hour), is moved and resized with the mouse and the keyboard,
// opens a detail that starts a focus session on it and ticks the task off. With „Fokusblöcke in
// Outlook eintragen“ every change is written to Outlook (a fixture log stands in for the script),
// the appointment that comes back with the next sync shows as the block only, a closed Outlook
// makes the write wait until „Erneut versuchen“. „Woche vorschlagen“ proposes a past block.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, guarded } from "../lib/harness.js";
import { iso, outlookEnv, week } from "../lib/calendar-fixtures.js";

const test = guarded(nodeTest, () => app);
let app;
let dir;
let readFixture;
let log;
let pageId;
let blockId;
const HOUR = 48;
const today = new Date();
const todayIso = iso(today);
const { monday } = week();
const range = { from: monday.toISOString(), to: new Date(monday.getTime() + 7 * 86400e3).toISOString() };
const at = (d, h, m = 0) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m);
const utc = (d) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
const local = (d) => `${iso(d)}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:00`;

/** The script's output: one meeting today and the appointments given. */
const outlookItems = (extra = []) => {
  const item = (id, subject, a, b) => ({
    entryId: id, globalId: `G-${id}`, subject, start: utc(a), end: utc(b), startLocal: local(a), endLocal: local(b),
    allDay: false, recurring: false, busy: 2, sensitivity: 0, responseStatus: 3, meetingStatus: 1, location: "", organizer: "", attendees: [], categories: "", body: null, urls: [],
  });
  return JSON.stringify({ ok: true, items: [item("M1", "Abstimmung Team", at(today, 14), at(today, 15)), ...extra.map((x) => item(...x))] });
};

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "arcalo-blocks-"));
  readFixture = path.join(dir, "outlook.json");
  log = path.join(dir, "writes.log");
  fs.writeFileSync(readFixture, outlookItems());
  app = await launch({ width: 1600, env: { ...outlookEnv(readFixture), ARCALO_OUTLOOK_WRITE_LOG: log } });
  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", { settings: { ...view.settings, calendar: { ...view.settings.calendar, outlook: true, blocks_outlook: true, block_minutes: 60 } } });
  await app.invoke("calendar_sync_now", { source: "outlook" });
  const page = await app.invoke("page_create", { parentId: null, title: "Fokus-Aufgaben", icon: null, content: "---\nvorgang: NP-8801/1020\n---\n- [ ] Bericht schreiben\n- [ ] Folien bauen\n" });
  pageId = page.id;
  await app.browser.execute(() => localStorage.setItem("arcalo.calendar.view", "week"));
});
after(async () => {
  await app?.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

const blocks = () => app.invoke("blocks_list", range);
const block = async () => (await blocks()).find((b) => b.id === blockId);
const hm = (s) => {
  const d = new Date(s);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
const writes = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const blockSel = () => `.calv-block[data-block="${blockId}"]`;
const rect = (sel) => app.browser.execute((s) => {
  const r = document.querySelector(s).getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
}, sel);
const drag = async (x, y, dy) => {
  await app.browser.action("pointer").move({ x, y }).down().move({ x, y: y + 6, duration: 80 }).move({ x, y: y + dy, duration: 200 }).up().perform();
  await app.browser.pause(150);
};
const clickText = async (sel, pattern) => {
  await app.browser.waitUntil(
    () => app.browser.execute((s, src) => {
      const el = [...document.querySelectorAll(s)].find((b) => new RegExp(src).test(b.textContent.trim()) && !b.disabled);
      el?.click();
      return !!el;
    }, sel, pattern.source),
    { timeoutMsg: `no ${sel} ${pattern}` },
  );
  await app.browser.pause(150);
};

test("a task dragged from the Aufgaben list lands in the week as a focus block", async () => {
  await app.keys(["Control", "Shift", "a"]);
  const row = `.tasks-view .task-row[data-page="${pageId}"][data-ordinal="0"]`;
  await app.waitFor(row);
  assert.equal(await app.browser.execute((s) => document.querySelector(s).draggable, row), true, "open tasks can be dragged");
  // WebKitGTK does not run native drags under WebDriver: the same events with a DataTransfer.
  const payload = await app.browser.execute((s) => {
    const dt = new DataTransfer();
    document.querySelector(s).dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
    window.__planDrag = dt;
    return dt.getData("application/x-arcalo-plan");
  }, row);
  assert.deepEqual(JSON.parse(payload), { kind: "task", page_id: pageId, ordinal: 0, text: "Bericht schreiben", page_title: "Fokus-Aufgaben" });

  await app.click(".ribbon-calendar-view");
  const col = `.calv-col[data-date="${todayIso}"]`;
  await app.waitFor(col);
  const ghost = await app.browser.execute((s, hour) => {
    const c = document.querySelector(s);
    const r = c.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, dataTransfer: window.__planDrag, clientX: r.x + r.width / 3, clientY: r.top + 10 * hour + 4 };
    c.dispatchEvent(new DragEvent("dragenter", opts));
    c.dispatchEvent(new DragEvent("dragover", opts));
    return new Promise((res) => setTimeout(() => {
      const g = document.querySelector(".calv-block-ghost")?.textContent ?? "";
      c.dispatchEvent(new DragEvent("drop", opts));
      res(g);
    }, 150));
  }, col, HOUR);
  assert.equal(ghost, "Hier planen · 10:00", "the landing place on the quarter hour");
  await app.browser.waitUntil(async () => (await blocks()).length === 1, { timeoutMsg: "no block" });
  const b = (await blocks())[0];
  blockId = b.id;
  assert.deepEqual([b.title, hm(b.start), hm(b.end), b.link.kind], ["Bericht schreiben", "10:00", "11:00", "task"]);
  assert.equal(b.suggested_reference, "NP-8801/1020", "the page's Vorgang");

  // It looks like a plan, not a meeting, and opens right away.
  await app.waitFor(`${blockSel()}.selected`);
  assert.match(await app.text(blockSel()), /Bericht schreiben\s*10:00–11:00/);
  assert.equal(await app.browser.execute(() => document.querySelector(".calv-block-name").value), "Bericht schreiben");
  assert.match(await app.text(".calv-block-detail"), /NP-8801\/1020 \(aus der Verknüpfung\)/);
  // Selected: lifted with a stronger fill and a bolder title; the dashed plan border stays, no ring.
  const look = await app.browser.execute((s) => {
    const el = document.querySelector(s);
    const cs = getComputedStyle(el);
    return { border: cs.borderTopStyle, outline: cs.outlineStyle, lifted: cs.boxShadow !== "none", weight: Number(getComputedStyle(el.querySelector(".calv-block-title")).fontWeight) };
  }, blockSel());
  assert.deepEqual(look, { border: "dashed", outline: "none", lifted: true, weight: 650 }, "selected: lifted, not framed");
  assert.match(await app.browser.execute((s) => document.querySelector(s).getAttribute("aria-label"), `.calv-dayhead[data-date="${todayIso}"] .calv-planned-sum`), /h geplant/);

  // Written to Outlook: busy, „Fokus: …“, no reminder, the category.
  await app.browser.waitUntil(async () => (await block()).outlook === "written", { timeout: 10000, timeoutMsg: "not written to Outlook" });
  const w = writes();
  assert.equal(w.length, 1);
  assert.deepEqual([w[0].op, w[0].subject, w[0].start, w[0].busy, w[0].reminder, w[0].category], ["upsert", "Fokus: Bericht schreiben", `${todayIso}T10:00:00`, 2, false, "Arcalo"]);
  assert.equal((await block()).outlook_entry_id, w[0].entryId);
  await app.shot("116-block-dropped");
});

test("moved and resized with the mouse and the keyboard, Outlook follows", async () => {
  await app.click(`.calv-detail-head [aria-label="Schließen"]`);
  let r = await rect(blockSel());
  // One hour down: 11:00–12:00.
  await drag(r.x + r.w / 2, r.y + 12, HOUR);
  await app.browser.waitUntil(async () => hm((await block()).start) === "11:00", { timeoutMsg: `not moved: ${hm((await block()).start)}` });
  assert.equal(hm((await block()).end), "12:00", "length kept");
  // The handle at its foot: half an hour longer.
  r = await rect(blockSel());
  await drag(r.x + r.w / 2, r.y + r.h - 3, HOUR / 2);
  await app.browser.waitUntil(async () => hm((await block()).end) === "12:30", { timeoutMsg: `not resized: ${hm((await block()).end)}` });
  assert.equal(hm((await block()).start), "11:00");

  // Keyboard: arrow down moves a quarter hour, Shift+arrow changes the length.
  await app.browser.execute((s) => document.querySelector(s).focus(), blockSel());
  await app.keys(["ArrowDown"]);
  await app.browser.waitUntil(async () => hm((await block()).start) === "11:15", { timeoutMsg: "arrow did not move" });
  assert.equal(hm((await block()).end), "12:45", "moved, not resized");
  await app.keys(["Shift", "ArrowDown"]);
  await app.browser.waitUntil(async () => hm((await block()).end) === "13:00", { timeoutMsg: "shift+arrow did not resize" });
  assert.equal(hm((await block()).start), "11:15");
  assert.match(await app.browser.execute((s) => document.querySelector(s).getAttribute("aria-description"), blockSel()), /Pfeiltasten verschieben/);

  // The same appointment is updated in Outlook.
  await app.browser.waitUntil(() => writes().at(-1)?.end === `${todayIso}T13:00:00`, { timeout: 10000, timeoutMsg: "Outlook not updated" });
  const w = writes();
  assert.ok(w.slice(1).every((x) => x.op === "upsert" && x.entryId === w[0].entryId), "updates of the same appointment");
  await app.shot("116-block-moved");
});

test("the detail starts a focus session on the block and ticks the task off", async () => {
  await app.browser.execute((s) => document.querySelector(s).focus(), blockSel());
  await app.keys(["Enter"]);
  await app.waitFor(".calv-block-detail");
  await clickText(".calv-block-detail .btn", /^Fokussitzung starten$/);
  await app.waitFor(".dialog .focus-form");
  assert.equal(await app.browser.execute(() => document.querySelector(".dialog .focus-form input[aria-label='Ziel']")?.value ?? document.querySelector(".dialog .focus-form .input").value), "Bericht schreiben");
  await clickText(".dialog .btn-primary", /Starten|Start/);
  await app.browser.waitUntil(async () => !!(await app.invoke("focus_state"))?.session, { timeoutMsg: "no session" });
  const st = await app.invoke("focus_state");
  assert.equal(st.session.block_id, blockId, "the session knows its block");
  assert.equal(st.session.planned_minutes, 105, "the block's length (11:15–13:00)");
  await app.invoke("focus_abort", { book: false });

  await clickText(".calv-block-detail .btn", /^Aufgabe erledigen$/);
  await app.browser.waitUntil(async () => /- \[x\] Bericht schreiben/.test((await app.invoke("page_get", { id: pageId })).content), { timeoutMsg: "task not done" });
  await app.browser.waitUntil(async () => (await block()).task_done === true, { timeoutMsg: "block does not show it" });
  await app.browser.waitUntil(() => app.browser.execute(() => !!document.querySelector(".calv-block-task.done")), { timeoutMsg: "detail not updated" });
});

test("Outlook: no duplicate after the sync, a closed Outlook makes the write wait", async () => {
  const b = await block();
  // The next sync brings our appointment back.
  fs.writeFileSync(readFixture, outlookItems([[b.outlook_entry_id, `Fokus: ${b.title}`, new Date(b.start), new Date(b.end)]]));
  await app.invoke("calendar_sync_now", { source: "outlook" });
  const events = await app.invoke("calendar_events", range);
  assert.deepEqual(events.map((e) => e.title), ["Abstimmung Team"], "shown as the block only");
  await app.browser.waitUntil(() => app.browser.execute(() => [...document.querySelectorAll(".calv-ev .calv-ev-title")].some((e) => e.textContent === "Abstimmung Team")), { timeoutMsg: "meeting not shown" });
  assert.equal(await app.browser.execute(() => [...document.querySelectorAll(".calv-ev .calv-ev-title")].filter((e) => /^Fokus:/.test(e.textContent)).length), 0);
  assert.equal(await app.browser.execute(() => document.querySelectorAll(".calv-block").length), 1);

  // Outlook closed: the move waits, the detail says why; „Erneut versuchen“ writes it.
  fs.writeFileSync(`${log}.offline`, "");
  const before = writes().length;
  await app.browser.execute((s) => document.querySelector(s).focus(), blockSel());
  await app.keys(["ArrowUp"]);
  await app.browser.waitUntil(async () => (await block()).outlook === "pending" && !!(await block()).outlook_error, { timeout: 10000, timeoutMsg: "not waiting" });
  await app.browser.execute((s) => document.querySelector(s).focus(), blockSel());
  await app.keys(["Enter"]);
  await app.waitText('.calv-block-state[data-outlook="pending"]', /Wartet auf Outlook.*nicht geöffnet/s);
  assert.equal(writes().length, before, "nothing written while closed");
  await app.shot("116-outlook-waiting");
  fs.rmSync(`${log}.offline`);
  await clickText('.calv-block-state[data-outlook="pending"] .btn', /Erneut versuchen/);
  await app.waitText('.calv-block-state[data-outlook="written"]', /In Outlook eingetragen/);
  assert.equal(writes().at(-1).start, `${todayIso}T11:00:00`);

  // Deleted: the appointment goes too.
  const entry = (await block()).outlook_entry_id;
  await clickText(".calv-block-detail .btn", /^Löschen$/);
  await app.browser.waitUntil(async () => (await blocks()).length === 0, { timeoutMsg: "not deleted" });
  await app.browser.waitUntil(() => writes().at(-1)?.op === "delete", { timeout: 10000, timeoutMsg: "not deleted in Outlook" });
  assert.equal(writes().at(-1).entryId, entry);
});

test("„Woche vorschlagen“ proposes a past block with the Vorgang of its task's page", async () => {
  // A Sunday three weeks back: no daily target, and older than the demo bookings (up to nine
  // days back, so last week's Sunday holds one when today is a Friday).
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() - 15);
  const start = at(sunday, 10);
  await app.invoke("block_create", { block: { title: "", start: start.toISOString(), end: new Date(start.getTime() + 90 * 60e3).toISOString(), link: { kind: "task", page_id: pageId, ordinal: 1, text: "Folien bauen" } } });
  const earlierMonday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() - 21);
  const w = await app.invoke("week_proposal", { weekStart: iso(earlierMonday), restOfToday: false });
  const p = w.proposals.find((x) => x.kind === "block");
  assert.ok(p, JSON.stringify(w.proposals.map((x) => [x.kind, x.text])));
  assert.deepEqual([p.text, p.minutes, p.confidence, p.wbs?.reference], ["Folien bauen", 90, "high", "NP-8801/1020"]);
  assert.equal(p.sources[0].kind, "block");
});
