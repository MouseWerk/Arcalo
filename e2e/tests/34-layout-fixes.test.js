// Layout fixes from the design audit: find and replace stack at the pane's top right, the header
// toolbar moves what does not fit into a menu, tabs shrink and keep the active one in view,
// task rows cut the page name at its end, narrow windows show the side panel instead of the sidebar.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
before(async () => (app = await launch()));
after(async () => app?.close());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const openTree = async (title) => {
  for (const r of await app.$$(".sidebar .tree-row")) if ((await app.textOf(r)) === title) return r.click();
  throw new Error(`no ${title}`);
};
const rect = (sel) => app.browser.execute((s) => {
  const r = document.querySelector(s)?.getBoundingClientRect();
  return r ? { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width } : null;
}, sel);

test("find and replace: two bars under each other at the top right of the pane", async () => {
  await openTree("Architektur");
  await app.waitFor(".pane.active .ProseMirror h2");
  await app.keys(["Control", "h"]);
  await app.waitFor(".find-bar.find-replace");
  const [find, repl] = await app.browser.execute(() => [...document.querySelectorAll(".find-bar")].map((b) => { const r = b.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, right: r.right }; }));
  assert.ok(repl.top >= find.bottom, `no overlap: ${JSON.stringify([find, repl])}`);
  const header = await rect(".pane.active .vh");
  const pane = await rect(".pane.active .page-scroll");
  assert.ok(find.top >= header.bottom && find.top < header.bottom + 30, "right below the header row");
  assert.ok(pane.right - find.right < 40, "at the right edge");
  assert.equal(await app.browser.execute(() => document.activeElement?.getAttribute("aria-label")), "In Seite suchen");
  await app.shot("find-replace-stack");
  await app.keys(["Escape"]);
});

test("many tabs: they shrink, the active one stays visible, + and the tab list are reachable", async () => {
  // Open pages are not opened twice: extra pages make the row overflow.
  const extra = Array.from({ length: 8 }, (_, i) => `Tab-Seite ${i + 1}`);
  for (const title of extra) await app.invoke("page_create", { parentId: null, title });
  await app.browser.refresh();
  await app.browser.waitUntil(async () => app.browser.execute(() => document.body.classList.contains("ready")));
  const titles = ["Willkommen", "Jour fixe 22.09.", "SAP CATS Leitfaden", "Kundentermin", "Besprechung", "PRJ-2026-X Rollout", ...extra, "Architektur"];
  for (const title of titles) {
    await app.keys(["Control", "t"]);
    await openTree(title);
    await sleep(150);
  }
  await sleep(400);
  const r = await app.browser.execute(() => {
    const tabs = document.querySelector(".pane.active .tabs");
    const t = tabs.getBoundingClientRect();
    const a = tabs.querySelector(".tab.active").getBoundingClientRect();
    const plus = document.querySelector('.pane.active .tabbar [aria-label^="Neuer Tab"]').getBoundingClientRect();
    const widths = [...tabs.querySelectorAll(".tab")].map((x) => x.getBoundingClientRect().width);
    return { activeIn: a.left >= t.left - 1 && a.right <= t.right + 1, plus: plus.width > 0, list: !!document.querySelector('.pane.active .tabbar [aria-label="Alle Tabs"]'), shrunk: Math.max(...widths) < 200 };
  });
  assert.deepEqual(r, { activeIn: true, plus: true, list: true, shrunk: true });
  await app.click('.pane.active .tabbar [aria-label="Alle Tabs"]');
  await app.waitText(".menu", /Kundentermin/);
  await app.shot("tabs-overflow");
  await app.browser.execute(() => [...document.querySelectorAll(".menu-item")].find((b) => b.textContent.includes("Kundentermin")).click());
  await app.waitText(".pane.active .tab.active .tab-title", /Kundentermin/);
});

test("header toolbar in a narrow pane: essentials stay, the rest is in „Weitere Formatierung“", async () => {
  await openTree("Architektur");
  await app.waitFor(".pane.active .vh .editor-toolbar");
  await app.browser.execute(() => document.querySelector('.pane.active .tabbar [aria-label="Rechts teilen"]').click());
  await app.browser.waitUntil(async () => (await app.$$(".pane")).length === 2);
  await app.browser.execute(() => { if (!document.querySelector(".app > .panel")) document.querySelector(".workspace > .pane:last-child .tabbar > button:last-of-type").click(); });
  await sleep(500);
  const state = await app.browser.execute(() => {
    const bar = document.querySelector(".pane.active .vh .editor-toolbar");
    const vis = (label) => { const b = bar.querySelector(`[aria-label^="${label}"]`); if (!b) return false; const r = b.getBoundingClientRect(), br = bar.getBoundingClientRect(); return r.width > 0 && r.right <= br.right + 1 && r.left >= br.left - 1; };
    return { more: !!bar.querySelector('[aria-label="Weitere Formatierung"]'), insert: vis("Einfügen"), tools: vis("Werkzeuge"), bold: vis("Fett"), fits: bar.scrollWidth <= bar.clientWidth + 1 };
  });
  assert.deepEqual(state, { more: true, insert: true, tools: true, bold: true, fits: true });
  await app.click('.pane.active .vh [aria-label="Weitere Formatierung"]');
  await app.waitText(".menu", /Aufzählung/);
  await app.shot("toolbar-overflow");
  await app.browser.execute(() => [...document.querySelectorAll(".menu-item")].find((b) => b.textContent.includes("Aufgabenliste")).click());
  await app.waitFor(".pane.active .ProseMirror ul[data-type=taskList]");
  await app.keys(["Control", "z"]);
});

test("tasks: the page name is cut at its end, with its icon", async () => {
  const p = await app.invoke("page_create", { parentId: null, title: "Eine Seite mit einem ziemlich langen Titel für die Aufgabenliste" });
  await app.invoke("page_save", { id: p.id, content: "- [ ] Lange Aufgabe prüfen\n" });
  await app.keys(["Control", "Shift", "a"]);
  const row = `.tasks-view .task-row[data-page="${p.id}"] .task-page`;
  await app.waitFor(row);
  const r = await app.browser.execute((sel) => {
    const b = document.querySelector(sel);
    const label = b.querySelector(".task-page-label");
    return { icon: !!b.querySelector("svg") && b.querySelector("svg").getBoundingClientRect().width > 0, cut: label.scrollWidth > label.clientWidth, startsLeft: label.getBoundingClientRect().left >= b.getBoundingClientRect().left };
  }, row);
  assert.deepEqual(r, { icon: true, cut: true, startsLeft: true });
});

test("narrow window: the side panel takes the sidebar's place; the sidebar button brings it back", async () => {
  const size = await app.browser.getWindowSize();
  await app.browser.setWindowSize(960, size.height);
  await sleep(300);
  await app.browser.execute(() => { if (!document.querySelector(".app > .panel")) document.querySelector(".workspace > .pane:last-child .tabbar > button:last-of-type").click(); });
  await sleep(300);
  assert.equal(await app.browser.execute(() => !!document.querySelector(".app > .sidebar")), false, "no sidebar next to the panel");
  await app.shot("narrow-with-panel");
  await app.click(".ribbon > .icon-btn:first-of-type");
  await sleep(300);
  assert.deepEqual(await app.browser.execute(() => [!!document.querySelector(".app > .sidebar"), !!document.querySelector(".app > .panel")]), [true, false]);
  await app.browser.setWindowSize(size.width, size.height);
});

test("no console errors", async () => {
  assert.deepEqual(await app.browser.execute(() => window.__annaloErrors ?? []), []);
});
