// Start-page dashboard (widgets, edit mode, persistence) and the quick-search window (#search).
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
before(async () => (app = await launch()));
after(async () => app?.close());

const order = () => app.browser.execute(() => [...document.querySelectorAll(".dash-grid .dw")].map((e) => e.dataset.widget));
const reload = async (hash = "") => {
  await app.browser.execute((h) => {
    location.hash = h;
    location.reload();
  }, hash);
  await app.browser.pause(300);
  await app.browser.waitUntil(() => app.browser.execute(() => document.body.classList.contains("ready")), { timeout: 20000, timeoutMsg: "not ready after reload" });
};
/** Clicks the first `sel` element whose text is `text` (waits until there is one). */
const clickText = async (sel, text) => {
  await app.browser.waitUntil(
    () => app.browser.execute((s, t) => {
      const el = [...document.querySelectorAll(s)].find((b) => b.textContent.trim() === t && !b.disabled);
      el?.click();
      return !!el;
    }, sel, text),
    { timeoutMsg: `no ${sel} „${text}“` },
  );
  await app.browser.pause(80);
};
/** Empties a React-controlled input the way a user does (clearValue bypasses onChange). */
const clearInput = async (el) => {
  await el.click();
  await app.keys(["Control", "a"]);
  await app.keys(["Backspace"]);
  await app.browser.waitUntil(async () => (await el.getValue()) === "", { timeoutMsg: "input not cleared" });
};

test("the start page shows the default widgets with the demo data", async () => {
  await app.waitFor(".dash-grid .dw");
  // 1.6: the board „Heute“ of the preset „Tagesstart“, in reading order.
  assert.deepEqual(await order(), ["today", "agenda", "week", "budget", "recent"]);
  // Budgets: Vorgang 1010 of the demo is at the warning threshold.
  await app.waitText('[data-widget="budget"] .dw-budget', /NP-8801\/1010[\s\S]*Warnung/);
  // Week: seven bars with the booked hours; recent pages; quick timer starts in „Heute“.
  assert.equal((await app.$$('[data-widget="week"] .dw-bar-col')).length, 7);
  await app.waitText('[data-widget="week"] .dw-week-sum', /von \d+,\d\d h/);
  await app.waitText('[data-widget="recent"] .dw-page', /Architektur/);
  await app.waitFor('[data-widget="today"] [aria-label^="Timer starten: NP-88"]');
  await app.shot("dashboard");
});

test("Heute adds a task to the daily note and checks it off", async () => {
  const input = await app.waitFor('[aria-label="Aufgabe zur Tagesnotiz hinzufügen"]');
  await input.click();
  await app.type("Dashboard-Aufgabe E2E");
  await app.keys(["Enter"]);
  await app.waitText('[data-widget="today"] .dw-task', /Dashboard-Aufgabe E2E/);
  const daily = await app.invoke("daily_note", { date: null });
  assert.match((await app.invoke("page_get", { id: daily.id })).content, /- \[ \] Dashboard-Aufgabe E2E/);
  await app.click('[data-widget="today"] [aria-label="Erledigt: Dashboard-Aufgabe E2E"]');
  await app.browser.waitUntil(async () => /- \[x\] Dashboard-Aufgabe E2E/.test((await app.invoke("page_get", { id: daily.id })).content), { timeoutMsg: "task not checked" });
  await app.browser.waitUntil(async () => !/Dashboard-Aufgabe E2E/.test(await app.text('[data-widget="today"]')), { timeoutMsg: "done task still listed" });
});

test("the timer in „Heute“ starts the last reference and stops it", async () => {
  await app.click('[data-widget="today"] .dw-start');
  await app.waitFor('[data-widget="today"] .dw-timer.running');
  assert.ok(await app.invoke("timer_status"));
  await clickText('[data-widget="today"] button', "Stoppen");
  await app.browser.waitUntil(async () => (await app.invoke("timer_status")) === null, { timeoutMsg: "timer still running" });
  await app.waitFor('[data-widget="today"] .dw-start');
});

test("edit mode adds, removes, reorders and resizes, and it persists", async () => {
  await app.dismissToasts();
  await clickText(".dash-bar button", "Anpassen");
  await app.waitFor(".dash.editing");
  // Add a note widget from the gallery (it goes to the first free place, below the rest).
  await clickText(".dash-bar button", "Widget hinzufügen");
  await app.click('.dash-gallery-card[data-kind="note"]');
  await app.waitFor('[data-widget="note"]');
  // Remove „Budget“, make „Zuletzt bearbeitet“ wide and tall, move the note up with the keyboard.
  await app.click('[data-widget="budget"] [aria-label="Entfernen"]');
  // Narrow widgets offer the sizes in a menu.
  await app.click('[data-widget="recent"] [aria-label="Widget-Optionen"]');
  await clickText(".menu [role^=menuitem]", "Größe: Breit und hoch");
  const before = (await order()).indexOf("note");
  await app.browser.execute(() => document.querySelector('[data-widget="note"]').focus());
  await app.keys(["ArrowUp"]);
  await app.browser.waitUntil(async () => (await order()).indexOf("note") < before, { timeoutMsg: "keyboard move did not reorder" });
  await app.shot("dashboard-edit");
  await clickText(".dash-bar button", "Fertig");
  await app.browser.waitUntil(async () => !(await (await app.$(".dash.editing")).isExisting()));
  const expected = await order();
  const saved = (await app.invoke("settings_get")).settings.dashboard.boards[0].widgets;
  assert.deepEqual(saved.map((w) => w.id).sort(), [...expected].sort());
  assert.ok(!saved.some((w) => w.kind === "budget"));
  const recent = saved.find((w) => w.id === "recent");
  assert.deepEqual([recent.w, recent.h], [8, 14]);

  // The scratch note saves itself.
  const note = await app.waitFor('[data-widget="note"] textarea');
  await note.click();
  await app.type("Merkzettel E2E");
  await app.browser.waitUntil(async () => (await app.invoke("settings_get")).settings.dashboard.notes.note === "Merkzettel E2E", { timeoutMsg: "note not saved" });

  await reload();
  await app.waitFor(".dash-grid .dw");
  assert.deepEqual(await order(), expected);
  const grid = await app.browser.execute(() => {
    const st = document.querySelector('[data-widget="recent"]').style;
    return [st.gridColumn, st.gridRow];
  });
  assert.deepEqual(grid, [`${recent.x + 1} / span 8`, `${recent.y + 1} / span 14`]);
  assert.equal(await (await app.$('[data-widget="note"] textarea')).getValue(), "Merkzettel E2E");

  // Cancel leaves everything as saved; a new tab shows the dashboard too.
  await clickText(".dash-bar button", "Anpassen");
  await app.click('[data-widget="week"] [aria-label="Entfernen"]');
  await clickText(".dash-bar button", "Abbrechen");
  assert.deepEqual(await order(), expected);
  await app.keys(["Control", "t"]);
  await app.browser.waitUntil(async () => (await app.$$(".dash")).length >= 1 && (await app.$(".pane.active > .pane-content:not([hidden]) .dash-grid")).isExisting());
  assert.deepEqual(await app.consoleErrors(), []);
});

test("the quick-search shortcut is a setting with its own slot", async () => {
  const view = await app.invoke("settings_get");
  assert.equal(view.settings.search_shortcut, "Ctrl+Shift+O");
  await assert.rejects(app.invoke("settings_save", { settings: { ...view.settings, search_shortcut: view.settings.capture_shortcut } }), /verschiedene/);
  await assert.rejects(app.invoke("settings_save", { settings: { ...view.settings, search_shortcut: "Ctrl+Alt+F" } }), /AltGr/);
  const off = await app.invoke("settings_save", { settings: { ...view.settings, search_shortcut: "" } });
  assert.equal(off.settings.search_shortcut, "");
  // Saving the settings form keeps the dashboard as the start page saved it.
  assert.deepEqual(off.settings.dashboard, view.settings.dashboard);
  await app.invoke("settings_save", { settings: { ...view.settings } });
  assert.equal(typeof (await app.invoke("desktop_info")).search_shortcut_active, "boolean");

  await app.keys(["Control", ","]);
  await app.waitFor(".settings-nav");
  await app.browser.execute(() => [...document.querySelectorAll(".settings-nav-item")].find((b) => b.textContent.includes("Desktop"))?.click());
  const field = await app.waitFor('input[aria-label="Tastenkürzel für die Schnellsuche"]');
  assert.equal(await field.getValue(), "Ctrl+Shift+O");
});

test("the quick-search UI (#search) finds pages, books time and opens results in the main window", async () => {
  const arch = (await app.invoke("search_workspace", { query: "Architektur", limit: 5 })).find((h) => h.kind === "page" && h.title === "Architektur");
  assert.ok(arch, "demo page found");
  await reload("#search");
  const input = await app.waitFor('input[aria-label="Schnellsuche"]');
  await app.browser.waitUntil(() => app.browser.execute(() => document.activeElement?.getAttribute("aria-label") === "Schnellsuche"), { timeoutMsg: "search input not focused" });
  // Without a query: recent pages and quick actions.
  await app.waitText(".pal-section", /Zuletzt bearbeitet/i);
  await app.waitText(".pal-item", /Tagesnotiz/);
  // The main window receives `search://open` (here: this webview, which has the label "main").
  await app.browser.executeAsync((done) => {
    window.__opened = [];
    window.__TAURI__.event.listen("search://open", (e) => window.__opened.push(e.payload)).then(() => done());
  });

  // Passages come with marked snippets.
  await app.type("Middleware");
  await app.waitFor(".pal-snippet mark");
  await app.shot("quick-search");

  await clearInput(input);
  await app.type("Architektur");
  await app.waitText(".pal-item.sel .pal-title", /^Architektur$/);
  await app.keys(["ArrowDown"]);
  await app.keys(["ArrowUp"]);
  await app.waitText(".pal-item.sel .pal-title", /^Architektur$/);
  await app.keys(["Enter"]);
  await app.browser.waitUntil(() => app.browser.execute(() => window.__opened.length === 1), { timeoutMsg: "no search://open event" });
  assert.deepEqual(await app.browser.execute(() => window.__opened[0]), { kind: "page", page_id: arch.page_id, new_tab: false });

  // „Neue Seite …“ creates the page first.
  await clearInput(input);
  await app.type("Suchseite E2E");
  await app.waitText(".pal-item", /Neue Seite „Suchseite E2E“/);
  await app.browser.execute(() => document.querySelector('.pal-item[data-action="new_page"]').click());
  await app.browser.waitUntil(() => app.browser.execute(() => window.__opened.length === 2), { timeoutMsg: "new page not opened" });
  const created = await app.browser.execute(() => window.__opened[1]);
  assert.equal((await app.invoke("page_get", { id: created.page_id })).title, "Suchseite E2E");

  // /zeit books right here.
  await clearInput(input);
  await app.type("/zeit NP-8801/1020 0.5h #DEV Aus der Schnellsuche");
  await app.waitText(".pal-item.sel", /Buchen: NP-8801\/1020 0.5h/);
  await app.keys(["Enter"]);
  await app.waitText(".qs-notice", /0,50 h auf NP-8801\/1020 gebucht/);
  const entries = await app.invoke("time_entries", { from: null, to: null });
  assert.ok(entries.some((e) => e.description === "Aus der Schnellsuche" && e.duration_minutes === 30));
  await app.keys(["Escape"]);
  assert.deepEqual(await app.consoleErrors(), []);

  // Back in the main UI: `search_open` brings the page up in the main window.
  await reload("");
  await app.invoke("search_open", { target: { kind: "page", page_id: arch.page_id, new_tab: false } });
  await app.waitText(".pane.active .tab.active .tab-title", /Architektur/);
  await app.invoke("search_open", { target: { kind: "timesheet" } });
  await app.waitText(".pane.active .tab.active .tab-title", /Zeiterfassung/);
  assert.deepEqual(await app.consoleErrors(), []);
});
