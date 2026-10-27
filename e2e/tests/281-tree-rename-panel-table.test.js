// Shell 1.13: renaming in the page tree in place (F2, double click; Enter saves with the links
// rewritten and an undo toast, Escape cancels, empty and taken names and link characters are told
// under the field; folders too), the right panel's view strip as one Tab stop with arrows/Home/End,
// and the Projekte table in a narrow pane (shadow and button for the hidden columns, arrow keys).
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
before(async () => (app = await launch({ width: 1280, height: 800 })));
after(async () => app?.close());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const row = (id) => `.sidebar .tree .tree-row[data-id="${id}"]`;
const label = (id) => app.browser.execute((sel) => document.querySelector(`${sel} .tree-label`)?.textContent ?? null, row(id));
const focusRow = (id) => app.browser.execute((sel) => document.querySelector(sel).focus(), row(id));
const activeTab = () => app.browser.execute(() => document.querySelector(".pane.active .tab.active .tab-title")?.textContent);
const field = () =>
  app.browser.execute(() => {
    const el = document.querySelector(".sidebar .tree-rename");
    const msg = document.querySelector(".sidebar .tree-rename-msg");
    return el && { value: el.value, focused: document.activeElement === el, invalid: el.getAttribute("aria-invalid"), msg: msg?.textContent ?? null, role: msg?.getAttribute("role") ?? null, described: el.getAttribute("aria-describedby") === msg?.id };
  });
const content = async (id) => (await app.invoke("page_get", { id })).content;
let src, target, folder, child;

test("F2 renames a page in its tree row without opening it; Enter rewrites the links, the toast undoes it", async () => {
  src = (await app.invoke("page_create", { parentId: null, title: "Quelle Umbenennen", icon: null, content: "x\n" })).id;
  target = (await app.invoke("page_create", { parentId: null, title: "Ziel Umbenennen", icon: null, content: "Siehe [[Quelle Umbenennen]].\n" })).id;
  await app.invoke("search_open", { target: { kind: "page", page_id: target, new_tab: false } });
  await app.waitText(".pane.active .tab.active", /Ziel Umbenennen/);
  await app.waitFor(row(src));
  await focusRow(src);
  await app.keys("F2");
  await app.waitFor(".sidebar .tree-rename");
  assert.deepEqual(await field(), { value: "Quelle Umbenennen", focused: true, invalid: null, msg: null, role: null, described: false });
  assert.equal(await activeTab(), "Ziel Umbenennen", "the page did not open");
  assert.equal(await app.browser.execute(() => document.querySelector(".sidebar .tree-rename").getAttribute("aria-label")), "Neuer Name für „Quelle Umbenennen“");
  await app.keys(["Control", "a"]);
  await app.type("Quelle Neu");
  await app.keys("Enter");
  await app.browser.waitUntil(async () => (await label(src)) === "Quelle Neu", { timeoutMsg: "the row was not renamed" });
  assert.equal(await app.browser.execute((sel) => document.activeElement === document.querySelector(sel), row(src)), true, "the focus is back on the row");
  assert.equal(await activeTab(), "Ziel Umbenennen");
  assert.match(await content(target), /\[\[Quelle Neu\]\]/);
  await app.waitText(".toast", /Umbenannt in „Quelle Neu“/);
  assert.match(await app.text(".toast"), /Links in 1 Seite aktualisiert/);
  await app.shot("281-tree-renamed");
  await app.browser.execute(() => [...document.querySelectorAll(".toast button")].find((b) => b.textContent.trim() === "Rückgängig").click());
  await app.browser.waitUntil(async () => (await label(src)) === "Quelle Umbenennen", { timeoutMsg: "undo did not restore the name" });
  assert.match(await content(target), /\[\[Quelle Umbenennen\]\]/);
  await app.dismissToasts();
});

test("Escape cancels; empty, taken and link characters are told under the field", async () => {
  await focusRow(src);
  await app.keys("F2");
  await app.waitFor(".sidebar .tree-rename");
  await app.type(" weg");
  await app.keys("Escape");
  await app.browser.waitUntil(async () => !(await field()));
  assert.equal(await label(src), "Quelle Umbenennen");
  assert.equal(await app.browser.execute((sel) => document.activeElement === document.querySelector(sel), row(src)), true);

  await app.keys("F2");
  await app.waitFor(".sidebar .tree-rename");
  await app.keys(["Control", "a"]);
  await app.keys("Backspace");
  await app.keys("Enter");
  await sleep(200);
  let f = await field();
  assert.equal(f.invalid, "true");
  assert.equal(f.role, "alert");
  assert.equal(f.described, true);
  assert.match(f.msg, /darf nicht leer sein/);
  await app.type("ziel umbenennen");
  await app.keys("Enter");
  await sleep(200);
  f = await field();
  assert.match(f.msg, /„Ziel Umbenennen“ gibt es schon/);
  await app.shot("281-tree-rename-taken");
  await app.keys(["Control", "a"]);
  await app.type("A#B [x]");
  await sleep(150);
  f = await field();
  assert.equal(f.value, "A＃B (x)");
  assert.equal(f.role, "status");
  assert.match(f.msg, /Link-Schreibweise/);
  await app.keys("Escape");
  await app.browser.waitUntil(async () => !(await field()));
  assert.equal(await label(src), "Quelle Umbenennen");
});

test("a double click on a folder's title renames it in place; its subpages stay under it", async () => {
  folder = (await app.invoke("page_create", { parentId: null, title: "Ordner Umbenennen", icon: null, content: "" })).id;
  child = (await app.invoke("page_create", { parentId: folder, title: "Kind Umbenennen", icon: null, content: "x\n" })).id;
  await app.invoke("search_open", { target: { kind: "page", page_id: child, new_tab: true } });
  await app.waitFor(row(child));
  const el = await app.$(`${row(folder)} .tree-label`);
  await el.doubleClick();
  await app.waitFor(".sidebar .tree-rename");
  assert.equal((await field()).value, "Ordner Umbenennen");
  await app.keys(["Control", "a"]);
  await app.type("Ordner Neu");
  await app.keys("Enter");
  await app.browser.waitUntil(async () => (await label(folder)) === "Ordner Neu");
  const tree = await app.invoke("page_get", { id: child });
  assert.equal(tree.parent_id, folder);
  // Leaving the field saves too.
  await focusRow(child);
  await app.keys("F2");
  await app.waitFor(".sidebar .tree-rename");
  await app.keys(["Control", "a"]);
  await app.type("Kind Neu");
  await app.browser.execute(() => document.querySelector(".sidebar .tree-rename").blur());
  await app.browser.waitUntil(async () => (await label(child)) === "Kind Neu", { timeoutMsg: "leaving the field did not save" });
  await app.dismissToasts();
});

test("the right panel's view strip is one Tab stop: arrows, Home and End switch the view", async () => {
  if (!(await app.browser.execute(() => !!document.querySelector(".panel-tabs")))) await app.keys(["Control", "Shift", "\\"]);
  await app.waitFor(".panel-tabs");
  const strip = () =>
    app.browser.execute(() => ({
      stops: [...document.querySelectorAll(".panel-tab")].filter((b) => b.tabIndex === 0).length,
      focused: document.activeElement?.closest(".panel-tab")?.id ?? null,
      selected: document.querySelector('.panel-tab[aria-selected="true"]')?.id,
      panel: document.querySelector(".panel-body")?.getAttribute("aria-labelledby"),
      name: document.querySelector(".panel-tabs").getAttribute("aria-label"),
    }));
  await app.browser.execute(() => document.querySelector('.panel-tab[aria-selected="true"]').focus());
  await app.keys("Home");
  await sleep(150);
  let s = await strip();
  assert.deepEqual(s, { stops: 1, focused: "panel-tab-assistant", selected: "panel-tab-assistant", panel: "panel-tab-assistant", name: "Seitenpanel-Ansichten" });
  await app.keys("ArrowRight");
  await sleep(150);
  s = await strip();
  assert.equal(s.focused, "panel-tab-outline");
  assert.equal(s.selected, "panel-tab-outline");
  assert.equal(s.stops, 1);
  await app.keys("End");
  await sleep(150);
  assert.equal((await strip()).focused, "panel-tab-graph");
  await app.keys("ArrowRight");
  await sleep(150);
  assert.equal((await strip()).focused, "panel-tab-assistant", "the arrows wrap around");
  await app.keys("ArrowLeft");
  await sleep(150);
  s = await strip();
  assert.equal(s.focused, "panel-tab-graph");
  assert.equal(s.panel, "panel-tab-graph");
  await app.keys("Home");
  await sleep(150);
});

test("the Projekte table in a narrow pane shows that more columns follow and scrolls by keyboard", async () => {
  await app.click('.ribbon [aria-label^="Projekte"]');
  await app.waitFor(".pane.active > .pane-content:not([hidden]) .vorgaenge");
  const state = () =>
    app.browser.execute(() => {
      const wrap = document.querySelector(".pane.active > .pane-content:not([hidden]) .side-scroll");
      const box = wrap.querySelector(".table-wrap");
      const first = box.querySelector(".vorgaenge tbody tr > :first-child");
      return {
        right: wrap.classList.contains("more-right"),
        left: wrap.classList.contains("more-left"),
        button: !!wrap.querySelector(".side-scroll-more"),
        tab: box.getAttribute("tabindex"),
        role: box.getAttribute("role"),
        label: box.getAttribute("aria-label"),
        scroll: Math.round(box.scrollLeft),
        sticky: Math.round(first.getBoundingClientRect().left - box.getBoundingClientRect().left),
      };
    });
  await app.click('.pane.active .tabbar [aria-label="Rechts teilen"]');
  await app.browser.setWindowSize(1100, 800);
  await sleep(700);
  await app.waitFor(".pane.active > .pane-content:not([hidden]) .side-scroll.more-right");
  let s = await state();
  assert.deepEqual({ ...s, label: undefined }, { right: true, left: false, button: true, tab: "0", role: "region", label: undefined, scroll: 0, sticky: 0 });
  assert.match(s.label, /weitere Spalten rechts/);
  await app.shot("281-projects-narrow");
  await app.browser.execute(() => document.querySelector(".pane.active > .pane-content:not([hidden]) .side-scroll .table-wrap").focus());
  for (let i = 0; i < 4; i++) await app.keys("ArrowRight");
  await sleep(400);
  s = await state();
  assert.ok(s.scroll > 0, "the arrow keys scroll the table");
  assert.equal(s.left, true);
  assert.equal(s.sticky, 0, "the name column stays");
  await app.shot("281-projects-scrolled");
  // The button pages to the end; there the hint goes away.
  for (let i = 0; i < 6 && (await state()).button; i++) {
    await app.click(".pane.active > .pane-content:not([hidden]) .side-scroll-more");
    await sleep(500);
  }
  s = await state();
  assert.equal(s.right, false);
  assert.equal(s.button, false);
  // The name column leaves room for the scrolled ones.
  const nameW = await app.browser.execute(() => {
    const box = document.querySelector(".pane.active > .pane-content:not([hidden]) .side-scroll .table-wrap");
    return [Math.round(box.querySelector("th").getBoundingClientRect().width), Math.round(box.clientWidth)];
  });
  assert.ok(nameW[0] < nameW[1] * 0.75, `name column ${nameW[0]} px of ${nameW[1]} px`);
  // Wide again (side panel closed): nothing hidden, no extra Tab stop.
  await app.keys(["Control", "Shift", "\\"]);
  await app.browser.setWindowSize(1600, 1000);
  await app.browser.execute(() => {
    const panes = document.querySelectorAll(".pane");
    for (const b of panes[panes.length - 1].querySelectorAll(".tab .tab-close")) b.click();
  });
  await app.browser.waitUntil(async () => (await app.browser.execute(() => document.querySelectorAll(".pane").length)) === 1);
  await app.click('.ribbon [aria-label^="Projekte"]');
  await sleep(700);
  s = await state();
  const dims = await app.browser.execute(() => {
    const box = document.querySelector(".pane.active > .pane-content:not([hidden]) .side-scroll .table-wrap");
    return { win: innerWidth, panel: !!document.querySelector(".panel-tabs"), box: box.clientWidth, table: box.scrollWidth, panes: document.querySelectorAll(".pane").length };
  });
  assert.equal(s.right || s.left, false, `nothing hidden in a wide pane (${JSON.stringify(dims)})`);
  assert.equal(s.tab, null);
  await app.keys(["Control", "Shift", "\\"]);
  await app.browser.setWindowSize(1280, 800);
});
