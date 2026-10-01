// Start page 1.7, chart widgets (German): a chart over a page's table (bars, donut, the table
// view and the hidden data table), a chart of the bookings per Netzplan in hours, the activity
// heatmap (notes and hours) and the Kanban mini-board with a card moved by keyboard and by drag.
// Light and dark.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
let parent;

const W = (id, kind, x, y, w, h, config = {}) => ({ id, kind, x, y, w, h, config });
const SCHEMA = "---\neigenschaften:\n  status: {typ: auswahl, optionen: {Offen: grau, In Arbeit: blau, Fertig: grün}}\n  aufwand: zahl\nansicht: board\n---\n# Vorhaben\n";
const reload = async () => {
  await app.browser.execute(() => location.reload());
  await app.browser.pause(300);
  await app.browser.waitUntil(() => app.browser.execute(() => document.body.classList.contains("ready")), { timeout: 20000, timeoutMsg: "not ready" });
};
const board = async (widgets) => {
  await app.invoke("dashboard_save", { dashboard: { version: 2, active: "daten", notes: {}, boards: [{ id: "daten", name: "Daten", widgets }] } });
  await reload();
};

before(async () => {
  app = await launch();
  parent = await app.invoke("page_create", { parentId: null, title: "Vorhaben", icon: null, content: SCHEMA });
  for (const [title, status, effort] of [["Login", "Offen", 3], ["Export", "Offen", 5], ["Suche", "In Arbeit", 8], ["Archiv", "Fertig", 2], ["Druck", "", 1]]) {
    const fm = status ? `status: ${status}\naufwand: ${effort}` : `aufwand: ${effort}`;
    await app.invoke("page_create", { parentId: parent.id, title, icon: null, content: `---\n${fm}\n---\n# ${title}\n` });
  }
  await app.keys(["Control", "t"]);
});
after(async () => {
  await app?.close();
});

const page = { source: "pages", group: "status", value: "count", field: "", weeks: 12 };

test("a chart over a page's table: bars in the options' order, table view, donut", async () => {
  await board([W("chart", "chart", 0, 0, 6, 8, { type: "bar", chart: { ...page, page: parent.id } }), W("sum", "chart", 6, 0, 6, 8, { type: "pie", chart: { ...page, page: parent.id, value: "sum", field: "aufwand" } })]);
  await app.waitFor('.pane.active [data-widget="chart"] svg .wc-bar', 15000);
  assert.equal(await app.text('.pane.active [data-widget="chart"] .wc-top .dw-big'), "5");
  // The data table is there for screen readers, in the options' order.
  const rows = await app.browser.execute(() => [...document.querySelectorAll('.pane.active [data-widget="chart"] table tbody tr')].map((r) => r.textContent));
  assert.deepEqual(rows, ["Offen2", "In Arbeit1", "Fertig1", "Ohne Wert1"]);
  assert.match(await app.browser.execute(() => document.querySelector('.pane.active [data-widget="chart"] svg title')?.textContent), /Diagramm/);
  // The table view.
  await app.click('.pane.active [data-widget="chart"] .wc-top button');
  await app.waitFor('.pane.active [data-widget="chart"] table.wc-table');
  assert.ok(!(await (await app.$('.pane.active [data-widget="chart"] svg .wc-bar')).isExisting()));
  await app.click('.pane.active [data-widget="chart"] .wc-top button');
  // Donut of the summed effort: 8 + 8 + 2 + 1.
  await app.waitFor('.pane.active [data-widget="sum"] .wc-slice');
  assert.equal(await app.browser.execute(() => document.querySelectorAll('.pane.active [data-widget="sum"] .wc-slice').length), 4);
  assert.equal(await app.browser.execute(() => document.querySelector('.pane.active [data-widget="sum"] .wc-donut-total').textContent), "19");
  assert.match(await app.text('.pane.active [data-widget="sum"] .wc-legend'), /Offen\s*8[\s\S]*In Arbeit\s*8/);
});

test("a chart of the bookings per Netzplan in hours with German decimals", async () => {
  await board([W("hours", "chart", 0, 0, 6, 8, { type: "bar", chart: { source: "bookings", group: "netzplan", weeks: 8 } }), W("weeks", "chart", 6, 0, 6, 8, { type: "line", chart: { source: "bookings", group: "week", weeks: 8 } })]);
  await app.waitFor('.pane.active [data-widget="hours"] .wc-bar', 15000);
  assert.match(await app.text('.pane.active [data-widget="hours"] .wc-top .dw-big'), /^\d+(\.\d{3})*,\d\d h$/);
  const rows = await app.browser.execute(() => [...document.querySelectorAll('.pane.active [data-widget="hours"] table tbody tr')].map((r) => r.textContent));
  assert.ok(rows.length >= 1 && rows.every((r) => /^NP-.+\d+,\d\d h$/.test(r)), rows.join(" / "));
  await app.waitFor('.pane.active [data-widget="weeks"] .wc-line');
  const weeks = await app.browser.execute(() => [...document.querySelectorAll('.pane.active [data-widget="weeks"] table tbody th')].map((r) => r.textContent));
  assert.equal(weeks.length, 8);
  assert.ok(weeks.every((w) => /^KW \d+$/.test(w)), weeks.join(","));
  // Hovering a bar shows its value.
  await (await app.$('.pane.active [data-widget="hours"] .wc-hit')).moveTo();
  await app.waitText('.pane.active [data-widget="hours"] .wc-tip', /NP-[\s\S]*h/);
  await app.shot("109-charts-bookings");
});

test("the heatmap shows a year of edited notes and booked hours with tooltips", async () => {
  await board([W("heat", "heatmap", 0, 0, 12, 6, { mode: "notes" }), W("heat-h", "heatmap", 0, 6, 12, 6, { mode: "hours" })]);
  await app.waitFor('.pane.active [data-widget="heat"] .wh-cell', 15000);
  const cells = await app.browser.execute(() => document.querySelectorAll('.pane.active [data-widget="heat"] .wh-cell').length);
  assert.ok(cells > 300, `${cells} cells`);
  // Pages were created today: today's cell is not empty.
  const today = await app.browser.execute(() => {
    const d = new Date();
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const el = document.querySelector(`.pane.active [data-widget="heat"] .wh-cell[data-date="${iso}"]`);
    return el ? `${el.getAttribute("class")}|${el.querySelector("title").textContent}` : null;
  });
  assert.match(today, /wh-cell l[1-4][\s\S]*\|\d\d\.\d\d\.\d{4}: \d+ Seiten?/);
  assert.match(await app.text('.pane.active [data-widget="heat"] .wh-top'), /Seiten? an \d+ Tag(en)?/);
  const booked = await app.browser.execute(() => [...document.querySelectorAll('.pane.active [data-widget="heat-h"] .wh-cell')].filter((c) => !/ l0/.test(c.getAttribute("class"))).length);
  assert.ok(booked > 3, `${booked} days with bookings`);
  assert.match(await app.text('.pane.active [data-widget="heat-h"] .wh-top'), /\d+,\d\d h/);
  await (await app.$('.pane.active [data-widget="heat-h"] .wh-cell.l4')).moveTo();
  await app.waitText('.pane.active [data-widget="heat-h"] .wh-top [role="status"]', /\d\d\.\d\d\.\d{4}: \d+,\d\d h/);
});

const statusOf = async (title) => {
  const kids = await app.invoke("page_collection", { parentId: parent.id });
  return /^status: (.*)$/m.exec(kids.rows.find((r) => r.title === title).frontmatter)?.[1]?.trim() ?? "";
};
const columnOf = (title) =>
  app.browser.execute((t) => [...document.querySelectorAll('.pane.active [data-widget="kanban"] .wk-col')].find((c) => [...c.querySelectorAll(".wk-card")].some((x) => x.textContent === t))?.dataset.kanbanCol ?? null, title);

test("Kanban: columns of the board view; a card moves by keyboard and by drag", async () => {
  await board([W("kanban", "kanban", 0, 0, 12, 9, { page: parent.id })]);
  await app.waitFor('.pane.active [data-widget="kanban"] .wk-card', 15000);
  const heads = await app.browser.execute(() => [...document.querySelectorAll('.pane.active [data-widget="kanban"] .wk-head')].map((h) => h.textContent));
  assert.deepEqual(heads, ["Offen2", "In Arbeit1", "Fertig1", "Ohne Wert1"]);
  assert.equal(await columnOf("Login"), "Offen");
  // Keyboard: Alt+→ moves the card one column on.
  await app.browser.execute(() => [...document.querySelectorAll('.pane.active [data-widget="kanban"] .wk-card')].find((c) => c.textContent === "Login").focus());
  await app.keys(["Alt", "ArrowRight"]);
  await app.browser.waitUntil(async () => (await statusOf("Login")) === "In Arbeit", { timeout: 8000, timeoutMsg: "status not written" });
  assert.equal(await columnOf("Login"), "In Arbeit");
  // Drag Export from „Offen“ onto „Fertig“.
  const card = await app.browser.execute(() => {
    const r = [...document.querySelectorAll('.pane.active [data-widget="kanban"] .wk-card')].find((c) => c.textContent === "Export").getBoundingClientRect();
    return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)];
  });
  const target = await app.browser.execute(() => {
    const r = document.querySelector('.pane.active [data-widget="kanban"] .wk-col[data-kanban-col="Fertig"]').getBoundingClientRect();
    return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height - 12)];
  });
  await app.browser
    .action("pointer")
    .move({ x: card[0], y: card[1] })
    .down()
    .move({ x: card[0] + 20, y: card[1] + 4, duration: 100 })
    .move({ x: target[0], y: target[1], duration: 250 })
    .up()
    .perform();
  await app.browser.waitUntil(async () => (await statusOf("Export")) === "Fertig", { timeout: 8000, timeoutMsg: "drag did not write" });
  assert.equal(await columnOf("Export"), "Fertig");
  await app.shot("109-kanban");
});

test("screenshots light and dark", async () => {
  await board([
    W("chart", "chart", 0, 0, 4, 8, { type: "bar", chart: { ...page, page: parent.id } }),
    W("sum", "chart", 4, 0, 4, 8, { type: "pie", chart: { ...page, page: parent.id, value: "sum", field: "aufwand" } }),
    W("hours", "chart", 8, 0, 4, 8, { type: "line", chart: { source: "bookings", group: "week", weeks: 8 } }),
    W("heat", "heatmap", 0, 8, 7, 6, { mode: "hours" }),
    W("kanban", "kanban", 7, 8, 5, 9, { page: parent.id }),
  ]);
  await app.waitFor('.pane.active [data-widget="kanban"] .wk-card', 15000);
  for (const theme of ["light", "dark"]) {
    const view = await app.invoke("settings_get");
    await app.invoke("settings_save", { settings: { ...view.settings, theme } });
    await app.browser.execute((t) => (document.documentElement.dataset.theme = t), theme);
    await app.browser.pause(400);
    await app.shot(`109-charts-${theme}`);
  }
});
