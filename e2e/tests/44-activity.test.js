// Activity feed („Aktivität“): edits, tasks, bookings and releases appear as a timeline with a
// day summary; range, type, Vorgang, person and search filters narrow it; „Was habe ich am …
// gemacht?“ jumps to a day; a click opens the page; the assistant reads it as a tool.

import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
let page;
before(async () => (app = await launch()));
after(async () => app?.close());

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const items = () => app.browser.execute(() => [...document.querySelectorAll(".activity-item")].map((e) => ({ kind: e.dataset.kind, text: e.innerText.replace(/\s+/g, " ") })));
const chip = (label) =>
  app.browser.execute((l) => {
    const b = [...document.querySelectorAll(".activity-view .chip")].find((x) => x.textContent.trim() === l);
    b?.click();
    return !!b;
  }, label);

test("edits, tasks, bookings and releases appear in the timeline with a day summary", async () => {
  page = await app.invoke("page_create", { parentId: null, title: "Aktivität E2E", icon: null, content: "Start\n" });
  await app.invoke("search_open", { target: { kind: "page", page_id: page.id, new_tab: false } });
  await app.browser.waitUntil(async () => (await (await app.$(".page-title")).getValue()) === "Aktivität E2E");
  // Typed in the editor: saved by autosave, merged into this hour's event of the page.
  await app.caretToEnd();
  await app.keys(["Enter"]);
  await app.type("Abstimmung mit @Bernd");
  await app.keys(["Enter"]);
  await app.type("[ ] Protokoll schreiben");
  await app.browser.waitUntil(async () => /Protokoll schreiben/.test((await app.invoke("page_get", { id: page.id })).content), { timeout: 8000, timeoutMsg: "not saved" });
  // Checked off outside the editor (task view path).
  await app.invoke("task_set_done", { pageId: page.id, ordinal: 0, done: true, expectedText: "Protokoll schreiben" });
  const out = await app.invoke("log_time", { line: "/zeit NP-8801/1020 1.5h Review Aktivität", pageId: null });
  await app.invoke("set_entry_status", { ids: [out.entry.id], status: "released" });

  await app.click('.ribbon [aria-label="Aktivität"]');
  await app.waitFor(".activity-view");
  assert.ok(await chip("Heute"));
  await app.waitText(".activity-item", /Aktivität E2E/);
  const list = await items();
  const kinds = new Set(list.map((i) => i.kind));
  for (const k of ["page_created", "task_done", "entry_created", "entry_released"]) assert.ok(kinds.has(k), `${k} in ${[...kinds]}`);
  const edit = list.find((i) => /Aktivität E2E/.test(i.text) && /page_/.test(i.kind));
  assert.match(edit.text, /Änderungen · ~\d+ Zeichen/);
  assert.match(edit.text, /@bernd/);
  assert.ok(list.some((i) => i.kind === "entry_created" && /1,5 h gebucht Review Aktivität NP-8801\/1020/.test(i.text)));
  assert.ok(list.some((i) => i.kind === "task_done" && /Protokoll schreiben/.test(i.text)));
  // The header sums up the day.
  assert.match(await app.text(".activity-summary h2"), /^Heute · /);
  const stats = await app.text(".activity-stats");
  assert.match(stats, /Aufgabe(n)? erledigt/);
  assert.match(stats, /\d+(,\d+)? h\s*gebucht/);
  await app.shot("activity-feed");
  assert.equal(await app.text(".pane.active .tab.active .tab-title"), "Aktivität");
});

test("type, Vorgang, person and search filters narrow the feed", async () => {
  await chip("Buchungen");
  await app.browser.waitUntil(async () => (await items()).every((i) => i.kind.startsWith("entry_")), { timeoutMsg: "type filter" });
  assert.ok((await items()).length >= 2);
  await chip("Buchungen");
  const np = await app.browser.execute(() => [...document.querySelectorAll('.activity-view select[aria-label="Projekt, Netzplan oder Vorgang"] option')].find((o) => /NP-8801\/1020/.test(o.textContent))?.value);
  assert.ok(np, "Vorgang in the filter");
  await app.select('.activity-view select[aria-label="Projekt, Netzplan oder Vorgang"]', np);
  await app.browser.waitUntil(async () => {
    const l = await items();
    return l.length > 0 && l.every((i) => /NP-8801\/1020/.test(i.text));
  }, { timeoutMsg: "Vorgang filter" });
  await app.select('.activity-view select[aria-label="Projekt, Netzplan oder Vorgang"]', "");
  await app.select('.activity-view select[aria-label="Person"]', "bernd");
  await app.browser.waitUntil(async () => {
    const l = await items();
    return l.length > 0 && l.every((i) => /@bernd/.test(i.text));
  }, { timeoutMsg: "person filter" });
  await app.select('.activity-view select[aria-label="Person"]', "");
  const search = await app.$('.activity-view input[aria-label="Aktivität durchsuchen"]');
  const typeSearch = async (text) => {
    await search.click();
    await app.keys(["Control", "a"]);
    await app.keys(["Backspace"]);
    if (text) await app.type(text);
  };
  await typeSearch("Protokoll schreiben");
  await app.browser.waitUntil(async () => {
    const l = await items();
    return l.length > 0 && l.every((i) => /Protokoll schreiben/.test(i.text)) && l.some((i) => i.kind === "task_done");
  }, { timeoutMsg: "search" });
  await typeSearch("gibtesnicht");
  await app.waitText(".activity-view .empty-title", /Keine Aktivität/);
  await typeSearch("");
  await app.waitText(".activity-item", /Aktivität E2E/);
});

test("„Was habe ich am … gemacht?“ jumps to a day; a click opens the page", async () => {
  await app.click(".activity-jump");
  await app.waitFor(".calendar");
  const today = iso(new Date());
  await app.click(`.calendar [data-date="${today}"]`);
  await app.waitText(".activity-summary h2", /^Heute · /);
  assert.ok(await (await app.$(".activity-range .chip.on")).isExisting());
  // Yesterday: nothing happened in this fresh workspace except the demo import time.
  await app.click(".activity-jump");
  await app.waitFor(".calendar");
  const y = iso(new Date(Date.now() - 86400000));
  const hasYesterday = await (await app.$(`.calendar [data-date="${y}"]`)).isExisting();
  if (hasYesterday) {
    await app.click(`.calendar [data-date="${y}"]`);
    await app.waitText(".activity-summary h2", /^Gestern · /);
    await app.waitText(".activity-view .empty-title", /Keine Aktivität/);
  } else await app.keys(["Escape"]);
  assert.ok(await chip("Heute"));
  await app.waitText(".activity-item", /Aktivität E2E/);
  await app.browser.execute(() => [...document.querySelectorAll(".activity-item")].find((b) => b.dataset.kind === "page_created" && /Aktivität E2E/.test(b.textContent))?.click());
  await app.browser.waitUntil(async () => (await (await app.$(".page-title")).getValue()) === "Aktivität E2E", { timeoutMsg: "page not opened" });
});

test("Ctrl+K opens the feed; the assistant reads it with the activity_log tool", async () => {
  await app.keys(["Control", "k"]);
  await app.waitFor(".palette");
  await app.type("aktivität");
  await app.waitText(".pal-item", /AktivitätWas wann passiert ist/);
  await app.keys(["Escape"]);
  // „Was habe ich am … gemacht?“ from the palette: pick the day, the feed opens on it.
  await app.keys(["Control", "k"]);
  await app.waitFor(".palette");
  await app.type("was habe ich");
  await app.waitText(".pal-item.sel", /Was habe ich am/);
  await app.keys(["Enter"]);
  await app.waitFor(".calendar");
  await app.click(`.calendar [data-date="${iso(new Date())}"]`);
  await app.waitFor(".activity-view");
  await app.waitText(".activity-summary h2", /^Heute · /);
  const text = await app.invoke("ai_run_workspace_tool", { name: "activity_log", arguments: JSON.stringify({ from: iso(new Date()) }) });
  assert.match(text, /Seiten bearbeitet/);
  assert.match(text, /Aufgabe erledigt: Protokoll schreiben/);
  assert.match(text, /Zeit gebucht: NP-8801\/1020 1:30 h Review Aktivität/);
  // Dark theme and a narrow split pane.
  await app.browser.execute(() => (document.documentElement.dataset.theme = "dark"));
  await app.click('.pane.active .tabbar [aria-label="Rechts teilen"]');
  await app.browser.waitUntil(async () => (await app.$$(".pane")).length === 2);
  await app.waitFor(".pane.active .activity-view");
  await app.shot("activity-dark-split");
  const overflow = await app.browser.execute(() => [...document.querySelectorAll(".activity-view")].some((v) => v.scrollWidth > v.clientWidth + 1));
  assert.equal(overflow, false, "no horizontal overflow in a split pane");
  await app.browser.execute(() => (document.documentElement.dataset.theme = "light"));
  assert.deepEqual(await app.consoleErrors(), []);
});
