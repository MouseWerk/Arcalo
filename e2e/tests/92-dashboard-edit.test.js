// Start page 1.6: edit mode, the widget gallery, moving and resizing by keyboard and by drag,
// per-widget settings, duplicate, boards as tabs (add, rename, reorder, delete), presets,
// import of a board, narrow panes, and everything after a restart.
import { test as nodeTest, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "annalo-dash-"));
after(async () => {
  await app?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const order = () => app.browser.execute(() => [...document.querySelectorAll(".pane.active .dash-grid .dw")].map((e) => e.dataset.widget));
const place = (id) =>
  app.browser.execute((i) => {
    const el = document.querySelector(`.pane.active .dw[data-widget="${i}"]`);
    if (!el) return null;
    const [x, w] = el.style.gridColumn.split(" / span ").map(Number);
    const [y, h] = el.style.gridRow.split(" / span ").map(Number);
    return { x: x - 1, y: y - 1, w, h };
  }, id);
const tabs = () => app.browser.execute(() => [...document.querySelectorAll(".pane.active .dash-tab")].map((t) => t.textContent.trim()));
const activeTab = () => app.browser.execute(() => document.querySelector('.pane.active .dash-tab[aria-selected="true"]')?.textContent.trim());
const clickText = async (sel, text) => {
  await app.browser.waitUntil(
    () =>
      app.browser.execute(
        (s, t) => {
          const el = [...document.querySelectorAll(s)].find((b) => b.textContent.trim() === t && !b.disabled);
          el?.click();
          return !!el;
        },
        sel,
        text,
      ),
    { timeoutMsg: `no ${sel} „${text}“` },
  );
  await app.browser.pause(80);
};
const menuItem = (label) => clickText(".menu [role^=menuitem]", label);
const heading = (id) => app.browser.execute((i) => document.querySelector(`.pane.active .dw[data-widget="${i}"] .dw-head h2`)?.textContent, id);
const saved = async () => (await app.invoke("settings_get")).settings.dashboard;
/** A pointer drag from the centre of `from` by (dx, dy) pixels, as the browser sends it. */
const drag = (from, dx, dy) =>
  app.browser.execute(
    async (sel, dx, dy) => {
      const el = document.querySelector(sel);
      const r = el.getBoundingClientRect();
      const x = r.left + Math.min(r.width / 2, 40);
      const y = r.top + r.height / 2;
      const opts = (cx, cy) => ({ bubbles: true, cancelable: true, pointerId: 7, pointerType: "mouse", button: 0, buttons: 1, clientX: cx, clientY: cy });
      el.dispatchEvent(new PointerEvent("pointerdown", opts(x, y)));
      const pause = () => new Promise((res) => requestAnimationFrame(() => res()));
      for (let i = 1; i <= 6; i++) {
        el.dispatchEvent(new PointerEvent("pointermove", opts(x + (dx * i) / 6, y + (dy * i) / 6)));
        await pause();
      }
      el.dispatchEvent(new PointerEvent("pointerup", opts(x + dx, y + dy)));
      await pause();
    },
    from,
    dx,
    dy,
  );

test("two boards by default; edit mode shows handles only while customizing", async () => {
  app = await launch({ dataDir: path.join(dir, "data") });
  await app.waitFor(".pane.active .dash-grid .dw");
  assert.deepEqual(await tabs(), ["Heute", "Projekte"]);
  assert.equal(await activeTab(), "Heute");
  // Normal use: no grips, sizes or resize handles.
  assert.equal((await app.$$(".pane.active .dw-grip, .pane.active .dw-resize, .pane.active .dw-sizes")).length, 0);
  await clickText(".pane.active .dash-tab", "Projekte");
  await app.waitFor('.pane.active .dw[data-kind="project"]');
  // Widget ids are unique across boards („Heute“ has a „budget“ and a „week“ already).
  assert.deepEqual(await order(), ["budget-2", "week-2", "project", "tasks", "agenda-2", "activity", "proposal"]);
  await clickText(".pane.active .dash-tab", "Heute");
  await app.waitFor('.pane.active .dw[data-widget="today"]');

  await clickText(".pane.active .dash-bar button", "Anpassen");
  await app.waitFor(".pane.active .dash.editing");
  assert.ok((await app.$$(".pane.active .dw-resize")).length >= 5);
  assert.equal(await app.browser.execute(() => document.querySelector('.pane.active .dw[data-widget="today"]').getAttribute("tabindex")), "0");
});

test("the gallery searches, previews and adds a widget", async () => {
  await clickText(".pane.active .dash-bar button", "Widget hinzufügen");
  await app.waitFor(".dash-gallery");
  assert.ok((await app.$$(".dash-gallery-card")).length >= 21);
  await app.shot("92-gallery");
  await app.type("abfr");
  await app.browser.waitUntil(async () => (await app.$$(".dash-gallery-card")).length === 1, { timeoutMsg: "search did not filter" });
  assert.equal(await app.browser.execute(() => document.querySelector(".dash-gallery-card").dataset.kind), "query");
  await app.keys(["Control", "a"]);
  await app.type("uhr");
  await app.browser.waitUntil(async () => (await app.browser.execute(() => document.querySelector(".dash-gallery-card")?.dataset.kind)) === "clock");
  await app.keys(["Enter"]);
  await app.waitFor('.pane.active .dw[data-widget="clock"]');
  // Placed at the first free spot: below the other widgets, at the left.
  assert.deepEqual(await place("clock"), { x: 0, y: 20, w: 3, h: 4 });
});

test("the keyboard moves and resizes a widget, and a screen reader hears where it is", async () => {
  await app.browser.execute(() => document.querySelector('.pane.active .dw[data-widget="clock"]').focus());
  await app.keys(["Shift", "ArrowRight"]);
  await app.browser.waitUntil(async () => (await place("clock"))?.w === 4, { timeoutMsg: "Shift+Arrow did not grow" });
  await app.keys(["Shift", "ArrowDown"]);
  await app.browser.waitUntil(async () => (await place("clock"))?.h === 5);
  // Up swaps it with the widget above („Zeit diese Woche“).
  await app.keys(["ArrowUp"]);
  await app.browser.waitUntil(async () => (await place("clock"))?.y === 13, { timeoutMsg: "ArrowUp did not move" });
  assert.equal((await place("week")).y, 18);
  assert.match(await app.text(".pane.active .dash .sr-only[aria-live]"), /Uhr: Spalte 1, Zeile 14, 4 × 5/);
  assert.equal(await app.browser.execute(() => document.activeElement?.dataset.widget), "clock", "focus stays on the widget");
  // Right moves it one column (nothing next to it that fits a swap).
  await app.keys(["ArrowRight"]);
  await app.browser.waitUntil(async () => (await place("clock"))?.x === 1 || (await place("clock"))?.x > 0, { timeoutMsg: "ArrowRight did not move" });
});

test("dragging moves a widget and the handle resizes it on the grid", async () => {
  // Drag „Uhr“ by its header to the top left.
  const grid = await app.browser.execute(() => {
    const r = document.querySelector(".pane.active .dash-grid").getBoundingClientRect();
    const c = document.querySelector('.pane.active .dw[data-widget="clock"] .dw-head').getBoundingClientRect();
    return { gx: r.left, gy: r.top, cx: c.left, cy: c.top };
  });
  await drag('.pane.active .dw[data-widget="clock"] .dw-head', grid.gx - grid.cx + 4, grid.gy - grid.cy + 4);
  await app.browser.waitUntil(async () => {
    const p = await place("clock");
    return p?.x === 0 && p?.y === 0;
  }, { timeoutMsg: "drag did not move the widget" });
  // Everything it hit made room: nothing overlaps.
  const all = await app.browser.execute(() =>
    [...document.querySelectorAll(".pane.active .dash-grid .dw")].map((el) => {
      const [x, w] = el.style.gridColumn.split(" / span ").map(Number);
      const [y, h] = el.style.gridRow.split(" / span ").map(Number);
      return { x, y, w, h };
    }),
  );
  for (const a of all) for (const b of all) if (a !== b) assert.ok(!(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h), "overlap after drag");
  // The resize handle: two columns wider.
  const colW = await app.browser.execute(() => (document.querySelector(".pane.active .dash-grid").clientWidth + 12) / 12);
  const before = await place("clock");
  await drag('.pane.active .dw[data-widget="clock"] .dw-resize', colW * 2, 0);
  await app.browser.waitUntil(async () => (await place("clock"))?.w === before.w + 2, { timeoutMsg: "resize handle did not resize" });
  // The preset size buttons (small, medium, wide, tall, wide and tall).
  await app.click('.pane.active .dw[data-widget="clock"] [aria-label="Größe: Klein"]');
  // Narrow now: the sizes are in the menu.
  await app.click('.pane.active .dw[data-widget="clock"] [aria-label="Widget-Optionen"]');
  await menuItem("Größe: Mittel");
  await app.browser.waitUntil(async () => (await place("clock"))?.w === 4);
  await app.click('.pane.active .dw[data-widget="clock"] [aria-label="Widget-Optionen"]');
  await menuItem("Größe: Klein");
  await app.browser.waitUntil(async () => (await place("clock"))?.w === 3);
});

test("per-widget settings and duplicate", async () => {
  await app.click('.pane.active .dw[data-widget="agenda"] [aria-label="Einstellungen"]');
  await app.waitFor(".dialog .dws");
  const title = await app.$(".dialog .dws input");
  await title.setValue("Meine Termine");
  await app.select('.dialog [aria-label="Zeitraum"]', "7");
  await app.shot("92-widget-settings");
  await clickText(".dialog-foot button", "Übernehmen");
  await app.browser.waitUntil(async () => (await heading("agenda")) === "Meine Termine", { timeoutMsg: "title not applied" });
  // Narrow widgets have „Duplizieren“ and the sizes in a menu.
  await app.click('.pane.active .dw[data-widget="clock"] [aria-label="Widget-Optionen"]');
  await menuItem("Duplizieren");
  await app.waitFor('.pane.active .dw[data-widget="clock-2"]');
  await clickText(".pane.active .dash-bar button", "Fertig");
  await app.browser.waitUntil(async () => !(await (await app.$(".pane.active .dash.editing")).isExisting()));
  const d = await saved();
  const heute = d.boards.find((b) => b.id === "heute");
  const agenda = heute.widgets.find((w) => w.id === "agenda");
  assert.equal(agenda.title, "Meine Termine");
  assert.equal(agenda.config.days, 7);
  assert.deepEqual(heute.widgets.filter((w) => w.kind === "clock").map((w) => w.id), ["clock", "clock-2"]);
  // Outside edit mode the gear still opens the settings (hover); a change is saved at once.
  await app.browser.execute(() => document.querySelector('.pane.active .dw[data-widget="clock-2"] .dw-gear').click());
  await app.waitFor(".dialog .dws");
  await app.click('.dialog [role="switch"][aria-label="Sekunden"]');
  await clickText(".dialog-foot button", "Übernehmen");
  await app.browser.waitUntil(async () => (await saved()).boards[0].widgets.find((w) => w.id === "clock-2")?.config.seconds === true, { timeoutMsg: "setting not saved" });
});

test("boards: add from a preset, rename, reorder, delete", async () => {
  await app.click('.pane.active .dash-tabs [aria-label="Board hinzufügen"]');
  await menuItem("Minimal");
  await app.waitFor(".pane.active .dash-tab-input");
  await app.browser.waitUntil(() => app.browser.execute(() => document.activeElement?.classList.contains("dash-tab-input")), { timeoutMsg: "rename field not focused" });
  await app.keys(["Control", "a"]);
  await app.type("Fokus-Board");
  await app.keys(["Enter"]);
  await app.browser.waitUntil(async () => (await tabs()).includes("Fokus-Board"), { timeoutMsg: "board not added" });
  assert.equal(await activeTab(), "Fokus-Board");
  await app.waitFor('.pane.active .dw[data-kind="focus"]');
  assert.deepEqual((await order()).map((id) => id.replace(/-\d+$/, "")), ["clock", "timer", "focus", "tasks", "note"]);
  // Reorder with the context menu, and with Alt+Arrow on the tab.
  await app.browser.execute(() => {
    const t = [...document.querySelectorAll(".pane.active .dash-tab")].find((b) => b.textContent.trim() === "Fokus-Board");
    t.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 200, clientY: 100 }));
  });
  await menuItem("Nach links");
  await app.browser.waitUntil(async () => JSON.stringify(await tabs()) === JSON.stringify(["Heute", "Fokus-Board", "Projekte"]));
  await app.browser.execute(() => [...document.querySelectorAll(".pane.active .dash-tab")].find((b) => b.textContent.trim() === "Fokus-Board").focus());
  await app.keys(["Alt", "ArrowRight"]);
  await app.browser.waitUntil(async () => JSON.stringify(await tabs()) === JSON.stringify(["Heute", "Projekte", "Fokus-Board"]), { timeoutMsg: "Alt+Arrow did not reorder" });
  // Delete „Projekte“ (asks first).
  await app.browser.execute(() => {
    const t = [...document.querySelectorAll(".pane.active .dash-tab")].find((b) => b.textContent.trim() === "Projekte");
    t.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 200, clientY: 100 }));
  });
  await menuItem("Board löschen");
  await app.waitFor(".dialog");
  await app.click(".dialog-foot .btn-danger, .dialog-foot .btn-primary");
  await app.browser.waitUntil(async () => JSON.stringify(await tabs()) === JSON.stringify(["Heute", "Fokus-Board"]), { timeoutMsg: "board not deleted" });
  const d = await saved();
  assert.deepEqual(d.boards.map((b) => b.name), ["Heute", "Fokus-Board"]);
  // Widget ids stay unique across boards (the notes are keyed by them).
  const ids = d.boards.flatMap((b) => b.widgets.map((w) => w.id));
  assert.equal(new Set(ids).size, ids.length);
});

test("presets and reset replace the widgets of a board", async () => {
  await clickText(".pane.active .dash-bar button", "Anpassen");
  await clickText(".pane.active .dash-bar button", "Vorlage");
  await menuItem("Projektleitung");
  await app.waitFor('.pane.active .dw[data-kind="project"]');
  await clickText(".pane.active .dash-bar button", "Vorlage");
  await menuItem("Auf Standard zurücksetzen");
  // An own board resets to „Tagesstart“ („Projekte“ to „Projektleitung“).
  await app.browser.waitUntil(async () => (await order()).map((id) => id.replace(/-\d+$/, "")).join() === "today,agenda,week,budget,recent", { timeoutMsg: "reset did nothing" });
  // Cancel: the board keeps what was saved.
  await clickText(".pane.active .dash-bar button", "Abbrechen");
  assert.deepEqual((await order()).map((id) => id.replace(/-\d+$/, "")), ["clock", "timer", "focus", "tasks", "note"]);
});

test("a board exported as JSON comes back as a new tab", async () => {
  const d = await saved();
  const heute = d.boards.find((b) => b.id === "heute");
  const json = JSON.stringify({ format: "annalo-dashboard", version: 1, board: { name: "Kopie", widgets: heute.widgets }, notes: {} });
  await app.browser.execute((j) => window.dispatchEvent(new CustomEvent("annalo:dashboard-import", { detail: j })), json);
  await app.browser.waitUntil(async () => (await tabs()).includes("Kopie"), { timeoutMsg: "import did not add a board" });
  await app.browser.waitUntil(async () => (await saved()).boards.length === 3);
  const copy = (await saved()).boards.find((b) => b.name === "Kopie");
  assert.equal(copy.widgets.length, heute.widgets.length);
  assert.ok(copy.widgets.every((w) => !heute.widgets.some((h) => h.id === w.id)), "imported widgets get new ids");
  // A file of another kind is refused with a message.
  await app.browser.execute(() => window.dispatchEvent(new CustomEvent("annalo:dashboard-import", { detail: '{"format":"anders"}' })));
  await app.waitText(".toast-title", /Board nicht importiert/);
  await app.dismissToasts();
});

test("narrow panes reflow the board into fewer columns", async () => {
  await clickText(".pane.active .dash-tab", "Heute");
  await app.waitFor('.pane.active .dw[data-widget="today"]');
  await app.browser.setWindowSize(900, 900);
  await app.browser.waitUntil(async () => (await app.browser.execute(() => document.querySelector(".pane.active .dash-grid").dataset.cols)) !== "12", { timeoutMsg: "no reflow" });
  const noOverflow = await app.browser.execute(() => {
    const g = document.querySelector(".pane.active .dash-grid").getBoundingClientRect();
    return [...document.querySelectorAll(".pane.active .dash-grid .dw")].every((el) => el.getBoundingClientRect().right <= g.right + 1);
  });
  assert.ok(noOverflow, "a widget sticks out of the narrow grid");
  await app.shot("92-narrow");
  await app.browser.setWindowSize(1480, 920);
  await app.browser.waitUntil(async () => (await app.browser.execute(() => document.querySelector(".pane.active .dash-grid").dataset.cols)) === "12");
});

test("boards, widgets, settings and the active tab survive a restart", async () => {
  await clickText(".pane.active .dash-tab", "Fokus-Board");
  await app.browser.waitUntil(async () => (await saved()).active !== "heute");
  const before = await saved();
  await app.close();
  app = await launch({ dataDir: path.join(dir, "data") });
  await app.waitFor(".pane.active .dash-grid .dw");
  assert.equal(await activeTab(), "Fokus-Board");
  assert.deepEqual(await tabs(), ["Heute", "Fokus-Board", "Kopie"]);
  assert.deepEqual((await saved()).boards, before.boards);
  await clickText(".pane.active .dash-tab", "Heute");
  await app.browser.waitUntil(async () => (await heading("agenda")) === "Meine Termine", { timeoutMsg: "title not applied" });
  assert.equal((await place("clock")).x, 0);
  assert.deepEqual(await app.consoleErrors(), []);
});
