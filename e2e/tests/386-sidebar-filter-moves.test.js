// 1.19 file explorer, filter and moves: the filter marks what matched, matches a path
// („Kunde/Angebot“), falls back to similar titles, opens the first hit on Enter and starts at the
// top; every move has its „Rückgängig“ (Nach oben/unten, Eine Ebene höher, Auf die oberste Ebene,
// a drop between pages and into a page), the tree options name the move they undo; in a folder
// sorted by name „Nach oben/unten“ say why they do nothing and a drop between its pages is refused
// with a hint (a page from elsewhere still goes in).
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";
import { treeHelpers } from "../lib/tree.js";

const test = guarded(nodeTest, () => app);
let app;
const T = treeHelpers(() => app);
before(async () => (app = await launch({ width: 1280, height: 800 })));
after(async () => app?.close());

const SHOWN = ".pane.active > .pane-content:not([hidden])";
const filterInput = ".sidebar .tree-filter input";
const ids = {};
const title = () => app.browser.execute((s) => document.querySelector(`${s} .page-title`)?.value, SHOWN);
async function filter(text) {
  await app.browser.execute((sel, v) => {
    const i = document.querySelector(sel);
    i.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(i, v);
    i.dispatchEvent(new Event("input", { bubbles: true }));
  }, filterInput, text);
  await T.sleep(150);
}
const shownTitles = () => app.browser.execute(() => [...document.querySelectorAll(".sidebar .tree-row .tree-label")].map((x) => x.textContent));
const marks = (t) => app.browser.execute((t) => [...([...document.querySelectorAll(".sidebar .tree-row")].find((r) => r.querySelector(".tree-label").textContent === t)?.querySelectorAll("mark") ?? [])].map((m) => m.textContent), t);
async function undoToast() {
  await app.waitText(".toast-title", /verschoben/);
  assert.ok(await T.toastAction("Rückgängig"), "the toast offers „Rückgängig“");
  await app.waitText(".toast-title", /zurückverschoben/);
}

test("setup", async () => {
  ids.kunde = (await T.create("Kunde Meier")).id;
  ids.angebot = (await T.create("Angebot Meier", ids.kunde)).id;
  ids.intern = (await T.create("Intern")).id;
  await T.create("Angebot Intern", ids.intern);
  for (let i = 0; i < 60; i++) await T.create(`Filter Füllseite ${i}`);
  ids.order = (await T.create("Reihenfolge")).id;
  for (const t of ["Eins", "Zwei", "Drei"]) ids[t] = (await T.create(t, ids.order)).id;
  ids.sorted = (await T.create("Sortiert nach Name")).id;
  for (const t of ["Beta", "Alpha"]) ids[t] = (await T.create(t, ids.sorted)).id;
  await app.invoke("folder_style_set", { pageId: ids.sorted, style: { sort: "name", folders_first: false, color: null } });
  await T.reload();
  for (const f of ["Reihenfolge", "Sortiert nach Name", "Kunde Meier", "Intern"]) {
    const r = await T.row(f);
    if ((await r.getAttribute("aria-expanded")) === "false") await (await r.$(".tree-twisty")).click();
  }
});

test("the filter marks the match, matches paths, finds similar titles, opens the first hit on Enter", async () => {
  // Scrolled down first: the filter starts at the top.
  await app.browser.execute(() => (document.querySelector(".sidebar .sidebar-scroll").scrollTop = 99999));
  await filter("meier");
  assert.equal(await app.browser.execute(() => document.querySelector(".sidebar .sidebar-scroll").scrollTop), 0);
  assert.deepEqual(await marks("Angebot Meier"), ["Meier"]);
  assert.deepEqual(await shownTitles(), ["Kunde Meier", "Angebot Meier"]);
  await app.shot("386-filter-marks");
  // A path: the page below a match of the part before.
  await filter("Kunde/Angebot");
  assert.deepEqual(await shownTitles(), ["Kunde Meier", "Angebot Meier"]);
  assert.deepEqual(await marks("Angebot Meier"), ["Angebot"]);
  await filter("intern / ang");
  assert.deepEqual(await shownTitles(), ["Intern", "Angebot Intern"]);
  // Similar titles when none contains the text.
  await filter("xyzqv");
  assert.deepEqual(await shownTitles(), []);
  await filter("angbt");
  await app.waitText(".tree-filter-note", /ähnliche Seiten/);
  assert.ok((await shownTitles()).includes("Angebot Meier"));
  assert.ok((await marks("Angebot Meier")).length > 0);
  // Enter opens the first hit.
  await filter("Kunde/Angebot");
  await app.keys(["Enter"]);
  await app.browser.waitUntil(async () => (await title()) === "Angebot Meier", { timeoutMsg: "Enter did not open the first hit" });
  await app.browser.execute(() => document.querySelector(".sidebar .tree-filter [aria-label='Filter leeren']")?.click());
  await app.browser.waitUntil(async () => (await shownTitles()).length > 10);
});

test("Nach oben, Nach unten, Eine Ebene höher, Auf die oberste Ebene: each with „Rückgängig“", async () => {
  const start = ["Eins", "Zwei", "Drei"];
  assert.deepEqual(await T.pathOrder(ids.order), start);
  await T.rowMenu("Zwei");
  await T.menuClick("Verschieben");
  assert.ok(await T.menuClick("Nach oben"));
  await app.browser.waitUntil(async () => (await T.pathOrder(ids.order))[0] === "Zwei");
  await undoToast();
  assert.deepEqual(await T.pathOrder(ids.order), start);

  await T.rowMenu("Zwei");
  await T.menuClick("Verschieben");
  assert.ok(await T.menuClick("Nach unten"));
  await app.browser.waitUntil(async () => (await T.pathOrder(ids.order))[2] === "Zwei");
  await undoToast();
  assert.deepEqual(await T.pathOrder(ids.order), start);

  const top = await T.pathOrder(null);
  await T.rowMenu("Zwei");
  await T.menuClick("Verschieben");
  assert.ok(await T.menuClick("Eine Ebene höher"));
  await app.browser.waitUntil(async () => (await T.pathOrder(null)).includes("Zwei"));
  const up = await T.pathOrder(null);
  assert.equal(up[up.indexOf("Reihenfolge") + 1], "Zwei", "right after its old folder");
  await undoToast();
  assert.deepEqual([await T.pathOrder(ids.order), await T.pathOrder(null)], [start, top]);

  await T.rowMenu("Drei");
  await T.menuClick("Verschieben");
  assert.ok(await T.menuClick("Auf die oberste Ebene"));
  await app.browser.waitUntil(async () => (await T.pathOrder(null)).at(-1) === "Drei");
  await undoToast();
  assert.deepEqual([await T.pathOrder(ids.order), await T.pathOrder(null)], [start, top]);
});

test("drops between pages and into a page can be undone", async () => {
  const start = ["Eins", "Zwei", "Drei"];
  const before = await T.drag("Drei", "Eins", { y: 0.1 });
  assert.ok(before.accepted);
  assert.deepEqual(before.line, ["Eins"]);
  await app.browser.waitUntil(async () => (await T.pathOrder(ids.order))[0] === "Drei");
  await undoToast();
  assert.deepEqual(await T.pathOrder(ids.order), start);

  const inside = await T.drag("Eins", "Zwei", { y: 0.5 });
  assert.deepEqual(inside.inside, ["Zwei"]);
  await app.browser.waitUntil(async () => (await T.pathOrder(ids.Zwei)).includes("Eins"));
  await undoToast();
  assert.deepEqual(await T.pathOrder(ids.order), start);
});

test("the tree options name the move they undo", async () => {
  await T.drag("Drei", "Eins", { y: 0.1 });
  await app.waitText(".toast-title", /verschoben/);
  await app.dismissToasts();
  await app.click(".sidebar .tree-options");
  await app.waitFor(".menu");
  assert.ok(await T.menuItem("Letzte Verschiebung rückgängig machen"));
  assert.ok(await T.menuClick("Letzte Verschiebung rückgängig machen"));
  await app.waitText(".toast-title", /zurückverschoben/);
  assert.deepEqual(await T.pathOrder(ids.order), ["Eins", "Zwei", "Drei"]);
  await app.click(".sidebar .tree-options");
  await app.waitFor(".menu");
  assert.deepEqual(await T.menuItem("Letzte Verschiebung rückgängig machen"), { disabled: true, hint: "Nichts rückgängig zu machen" });
  await T.closeMenus();
});

test("a folder sorted by name: Nach oben/unten say why, a drop between its pages is refused with a hint", async () => {
  await T.rowMenu("Beta");
  await T.menuClick("Verschieben");
  assert.deepEqual(await T.menuItem("Nach oben"), { disabled: true, hint: "Sortiert: Name" });
  assert.deepEqual(await T.menuItem("Nach unten"), { disabled: true, hint: "Sortiert: Name" });
  await app.shot("386-sorted-menu");
  await T.closeMenus();
  const refused = await T.drag("Beta", "Alpha", { y: 0.1 });
  assert.equal(refused.accepted, false, "the drop is not accepted");
  assert.match(refused.hint ?? "", /„Sortiert nach Name“ ist sortiert \(Name\): Seiten darin lassen sich nicht umstellen\./);
  assert.deepEqual(refused.line, []);
  assert.deepEqual(await T.pathOrder(ids.sorted), ["Beta", "Alpha"], "nothing moved");
  assert.equal(await app.browser.execute(() => document.querySelector(".tree-drop-hint")), null, "the hint goes with the drag");
  // A page from elsewhere goes into the sorted folder (it sorts it), shown on the folder.
  const into = await T.drag("Eins", "Alpha", { y: 0.9 });
  assert.ok(into.accepted);
  assert.deepEqual(into.inside, ["Sortiert nach Name"]);
  await app.browser.waitUntil(async () => (await T.pathOrder(ids.sorted)).includes("Eins"));
  await app.browser.waitUntil(async () => (await app.browser.execute(() => [...document.querySelectorAll(".sidebar .tree-row[aria-level='2'] .tree-label")].map((x) => x.textContent))).join(",").includes("Alpha,Beta,Eins"));
  await undoToast();
  assert.deepEqual(await T.pathOrder(ids.order), ["Eins", "Zwei", "Drei"]);
});
