// 1.19 file explorer, selection and „Neu“: the selection's bar is opaque, below the rows (they
// do not move when it appears) and keeps its count readable at 900 px; it and the context menu
// offer favorites, color, a tag, duplicate, HTML export and delete for all selected pages; Ctrl+
// click keeps selecting. „Neu“ offers every kind (page, folder, canvas, drawing, table, from a
// template) in the toolbar, in a page's context menu (inside that page) and in the empty area
// below the rows (the top level).
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, guarded } from "../lib/harness.js";
import { treeHelpers } from "../lib/tree.js";

const test = guarded(nodeTest, () => app);
let app;
const T = treeHelpers(() => app);
const out = fs.mkdtempSync(path.join(os.tmpdir(), "arcalo-e2e-387-"));
before(async () => (app = await launch({ width: 900, height: 760 })));
after(async () => {
  await app?.close();
  fs.rmSync(out, { recursive: true, force: true });
});

const SHOWN = ".pane.active > .pane-content:not([hidden])";
const ids = {};
const flat = (nodes) => nodes.flatMap((n) => [n, ...flat(n.children ?? [])]);
const page = async (id) => flat(await app.invoke("workspace_tree")).find((p) => p.id === id);
const byTitle = async (t) => flat(await app.invoke("workspace_tree")).find((p) => p.title === t);
const ctrlClick = (title) =>
  app.browser.execute((t) => {
    const r = [...document.querySelectorAll(".sidebar .tree-row")].find((x) => x.querySelector(".tree-label")?.textContent === t);
    r.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
  }, title);
const selected = () => app.browser.execute(() => [...document.querySelectorAll(".sidebar .tree-row.selected .tree-label")].map((e) => e.textContent));
const barButton = (label) => app.browser.execute((l) => {
  const b = [...document.querySelectorAll(".tree-selection button")].find((x) => x.getAttribute("aria-label") === l || x.textContent.trim() === l);
  b?.click();
  return !!b;
}, label);

test("setup", async () => {
  ids.folder = (await T.create("Auswahl Ordner")).id;
  for (const t of ["Sel Eins", "Sel Zwei", "Sel Drei"]) ids[t] = (await T.create(t, ids.folder, `Inhalt von ${t}\n`)).id;
  await T.reload();
  const r = await T.row("Auswahl Ordner");
  if ((await r.getAttribute("aria-expanded")) === "false") await (await r.$(".tree-twisty")).click();
  await T.row("Sel Drei");
});

test("the selection's bar: opaque, below the rows, the count readable at 900 px", async () => {
  await (await T.row("Sel Eins")).click();
  const before = await app.browser.execute(() => [...document.querySelectorAll(".sidebar .tree-row")].map((r) => Math.round(r.getBoundingClientRect().top)).slice(0, 12));
  await ctrlClick("Sel Zwei");
  await ctrlClick("Sel Drei");
  // Ctrl+click keeps selecting: the open page joined, then the others.
  assert.deepEqual((await selected()).sort(), ["Sel Drei", "Sel Eins", "Sel Zwei"]);
  await app.waitFor(".tree-selection");
  const bar = await app.browser.execute(() => {
    const el = document.querySelector(".tree-selection");
    const count = el.querySelector(".tree-selection-count");
    const scroll = document.querySelector(".sidebar .sidebar-scroll").getBoundingClientRect();
    const b = el.getBoundingClientRect();
    return {
      bg: getComputedStyle(el).backgroundColor,
      text: count.textContent,
      cut: count.scrollWidth > count.clientWidth + 1,
      below: b.top >= scroll.bottom - 1,
      inSidebar: b.right <= document.querySelector(".sidebar").getBoundingClientRect().right + 0.5,
      rows: [...document.querySelectorAll(".sidebar .tree-row")].map((r) => Math.round(r.getBoundingClientRect().top)).slice(0, 12),
    };
  });
  assert.equal(bar.text, "3 ausgewählt");
  assert.equal(bar.cut, false, "the count is not cut");
  assert.ok(!/rgba\(.*, 0(\.\d+)?\)$/.test(bar.bg) && bar.bg !== "transparent", `opaque: ${bar.bg}`);
  assert.ok(bar.below && bar.inSidebar);
  assert.deepEqual(bar.rows, before, "the rows did not move");
  // ARIA: with a selection the tree is multiselectable and says it for every row.
  assert.equal(await app.browser.execute(() => document.querySelector(".sidebar [role=tree]").getAttribute("aria-multiselectable")), "true");
  assert.equal((await T.rowState("Auswahl Ordner")).selected, "false");
  assert.equal((await T.rowState("Sel Zwei")).selected, "true");
  await app.shot("387-selection-900");
});

test("selection actions: favorites, color, tag, duplicate, export, all at once", async () => {
  assert.ok(await barButton("Zu Favoriten hinzufügen"));
  await app.waitText(".toast-title", /3 Seiten zu den Favoriten hinzugefügt/);
  for (const t of ["Sel Eins", "Sel Zwei", "Sel Drei"]) assert.equal((await page(ids[t])).favorite, true);
  // Color from the bar's menu.
  assert.ok(await barButton("Farbe"));
  await app.waitFor(".menu");
  assert.ok(await T.menuClick("Grün"));
  await app.browser.waitUntil(async () => (await page(ids["Sel Drei"])).style?.color === "success", { timeoutMsg: "no color" });
  for (const t of ["Sel Eins", "Sel Zwei"]) assert.equal((await page(ids[t])).style?.color, "success");
  // A tag into each page's properties.
  assert.ok(await barButton("Tag hinzufügen…"));
  await app.waitText(".dialog-title", /Tag für 3 Seiten/);
  await app.type("auswahl-tag");
  await app.keys(["Enter"]);
  await app.waitText(".toast-title", /#auswahl-tag bei 3 Seiten ergänzt/);
  for (const t of ["Sel Eins", "Sel Zwei", "Sel Drei"]) {
    const doc = await app.invoke("page_get", { id: ids[t] });
    assert.match(doc.content, /^---\ntags: \[auswahl-tag\]\n---\n/);
    assert.ok(doc.content.includes(`Inhalt von ${t}`));
  }
  assert.ok(await app.browser.execute(() => !![...document.querySelectorAll(".tree-selection button")].find((b) => b.getAttribute("aria-label") === "Als HTML-Datei exportieren…")));
  // The context menu has the same actions for the selection.
  await T.rowMenu("Sel Zwei");
  for (const l of ["3 Seiten verschieben nach…", "Aus den Favoriten entfernen", "Farbe", "Tag hinzufügen…", "Duplizieren", "Als HTML-Datei exportieren…", "3 Seiten löschen"]) assert.ok(await T.menuItem(l), l);
  assert.ok(await T.menuClick("Duplizieren"));
  await app.waitText(".toast-title", /3 Seiten dupliziert/);
  // Each copy right after its page.
  assert.deepEqual((await page(ids.folder)).children.map((c) => c.title), ["Sel Eins", "Sel Eins (Kopie)", "Sel Zwei", "Sel Zwei (Kopie)", "Sel Drei", "Sel Drei (Kopie)"]);
  // Export: one HTML file with every selected page (the save dialog is skipped with a path).
  const file = path.join(out, "auswahl.html");
  await app.browser.execute((ids, p) => window.dispatchEvent(new CustomEvent("arcalo:share-html", { detail: { ids, path: p } })), [ids["Sel Eins"], ids["Sel Drei"]], file);
  await app.browser.waitUntil(() => fs.existsSync(file), { timeout: 10000, timeoutMsg: "no HTML file" });
  const html = fs.readFileSync(file, "utf8");
  assert.ok(html.includes("Inhalt von Sel Eins") && html.includes("Inhalt von Sel Drei") && !html.includes("Inhalt von Sel Zwei"));
  assert.ok(await barButton("Auswahl aufheben"));
  await app.browser.waitUntil(async () => (await app.$$(".tree-selection")).length === 0);
});

test("„Neu“ in the toolbar offers every kind; a folder is named in the tree", async () => {
  await app.click(".side-toolbar [data-new-menu]");
  await app.waitFor(".menu");
  const labels = await app.browser.execute(() => [...document.querySelectorAll(".menu .menu-label")].map((x) => x.textContent));
  assert.deepEqual(labels, ["Seite", "Ordner", "Canvas", "Zeichnung", "Tabelle", "Aus Vorlage…"]);
  await app.shot("387-new-menu");
  assert.ok(await T.menuClick("Ordner"));
  await app.waitFor(".sidebar .tree-rename");
  await app.keys(["Control", "a"]);
  await app.type("neuer testordner");
  await app.keys(["Enter"]);
  await app.browser.waitUntil(async () => !!(await byTitle("neuer testordner")), { timeoutMsg: "folder not named" });
  assert.equal((await byTitle("neuer testordner")).icon, "folder");

  // Table: a page with the table view.
  await app.click(".side-toolbar [data-new-menu]");
  assert.ok(await T.menuClick("Tabelle"));
  await app.browser.waitUntil(async () => (await app.browser.execute((s) => document.querySelector(`${s} .page-title`)?.value, SHOWN)) === "Neue Tabelle");
  const table = await byTitle("Neue Tabelle");
  assert.match((await app.invoke("page_get", { id: table.id })).content, /ansicht: tabelle/);

  // Drawing: a page with the drawing, the drawing editor open over it.
  await app.click(".side-toolbar [data-new-menu]");
  assert.ok(await T.menuClick("Zeichnung"));
  await app.waitFor(".drawing-overlay canvas.excalidraw__canvas.interactive", 20000);
  const drawing = flat(await app.invoke("workspace_tree")).find((p) => p.icon === "drawing");
  assert.match((await app.invoke("page_get", { id: drawing.id })).content, /^!\[\[Zeichnung .*\.excalidraw\]\]\n$/);
  await app.click(".drawing-done");
  await app.browser.waitUntil(async () => (await app.$$(".drawing-overlay")).length === 0, { timeout: 10000, timeoutMsg: "drawing editor stayed open" });

  // Canvas (into its folder, as before) and a page from a template (the template picker).
  await app.click(".side-toolbar [data-new-menu]");
  assert.ok(await T.menuClick("Canvas"));
  await app.waitFor(".cv-board");
  await app.click(".side-toolbar [data-new-menu]");
  assert.ok(await T.menuClick("Aus Vorlage…"));
  await app.waitFor(".dialog");
  await app.keys(["Escape"]);
});

test("„Neu“ in a page's context menu creates inside it; in the empty area at the top level", async () => {
  await T.rowMenu("Auswahl Ordner");
  assert.ok(await T.menuClick("Neu"));
  const labels = await app.browser.execute(() => [...document.querySelectorAll(".menu")].at(-1).querySelectorAll(".menu-label").length);
  assert.equal(labels, 7, "every kind and „Seite daneben“");
  assert.ok(await T.menuClick("Canvas"));
  await app.waitFor(".cv-board");
  const cv = flat(await app.invoke("workspace_tree")).filter((p) => p.kind === "canvas" && p.parent_id === ids.folder);
  assert.equal(cv.length, 1, "the canvas is in the folder");

  await T.rowMenu("Auswahl Ordner");
  assert.ok(await T.menuClick("Neu"));
  assert.ok(await T.menuClick("Seite"));
  await app.browser.waitUntil(async () => (await page(ids.folder)).children.some((c) => c.title === "Unbenannt"), { timeoutMsg: "page not inside" });

  // The empty area below the rows: the top level.
  await app.browser.execute(() => {
    const end = document.querySelector(".sidebar .tree-end");
    end.scrollIntoView();
    const r = end.getBoundingClientRect();
    end.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 10 }));
  });
  await app.waitFor(".menu");
  assert.ok(await T.menuClick("Neu"));
  assert.ok(await T.menuClick("Ordner"));
  await app.waitFor(".sidebar .tree-rename");
  await app.keys(["Control", "a"]);
  await app.type("oberster ordner");
  await app.keys(["Enter"]);
  await app.browser.waitUntil(async () => (await app.invoke("workspace_tree")).some((n) => n.title === "oberster ordner"), { timeoutMsg: "not at the top level" });
});
