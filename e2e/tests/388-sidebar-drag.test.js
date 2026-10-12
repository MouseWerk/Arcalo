// 1.19 file explorer, drag and drop: a page dragged into a note's text becomes a [[link]] there
// (several selected pages several links), onto a pane without a note or onto a tab bar it opens
// there, onto the empty area below the rows it goes to the top level (with „Rückgängig“), and a
// collapsed folder held under it opens; near the edges the tree scrolls. WebKitGTK does not run native drags under WebDriver: the
// same events with a DataTransfer.
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
const ids = {};

/** Drags the rows `titles` (the first one dragged; several: select them first) onto `target` (CSS, inside the active pane). */
const dragOnto = (title, target, { x = 0.5, y = 0.5 } = {}) =>
  app.browser.execute(
    (t, sel, x, y) => {
      const src = [...document.querySelectorAll(".sidebar .tree-row")].find((r) => r.querySelector(".tree-label")?.textContent === t);
      const dst = document.querySelector(sel);
      if (!src || !dst) return { error: `missing ${src ? sel : t}` };
      const dt = new DataTransfer();
      src.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
      const r = dst.getBoundingClientRect();
      const at = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + r.width * x, clientY: r.top + r.height * y };
      dst.dispatchEvent(new DragEvent("dragenter", at));
      const over = new DragEvent("dragover", at);
      dst.dispatchEvent(over);
      const drop = new DragEvent("drop", at);
      dst.dispatchEvent(drop);
      src.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: dt }));
      return { accepted: over.defaultPrevented, effect: dt.dropEffect, handled: drop.defaultPrevented };
    },
    title,
    target,
    x,
    y,
  );

test("setup", async () => {
  ids.target = (await T.create("Zielnotiz", null, "Erster Absatz.\n")).id;
  ids.folder = (await T.create("Zieh Ordner")).id;
  ids.child = (await T.create("Zieh Kind", ids.folder)).id;
  ids.other = (await T.create("Verlinkte Seite")).id;
  ids.second = (await T.create("Zweite Seite")).id;
  for (let i = 0; i < 40; i++) await T.create(`Zieh Füllseite ${i}`);
  await T.reload();
});

test("a page dragged into a note's text becomes a link there", async () => {
  await T.openPage(ids.target, "Zielnotiz");
  await app.waitFor(`${SHOWN} .ProseMirror p`);
  const r = await dragOnto("Verlinkte Seite", `${SHOWN} .ProseMirror p`, { x: 0.99 });
  assert.ok(r.accepted && r.handled, JSON.stringify(r));
  await app.waitFor(`${SHOWN} .ProseMirror a.wikilink[data-target="Verlinkte Seite"]`);
  await app.browser.waitUntil(async () => (await app.invoke("page_get", { id: ids.target })).content.includes("[[Verlinkte Seite]]"), { timeout: 8000, timeoutMsg: "the link was not saved" });
  // Nothing moved in the tree, and no tab opened.
  assert.equal((await app.invoke("workspace_tree")).some((n) => n.id === ids.other), true);
  assert.equal((await app.$$(".pane.active .tab")).length, 1);

  // Several selected pages: one link each.
  await app.browser.execute(() => {
    const row = (t) => [...document.querySelectorAll(".sidebar .tree-row")].find((r) => r.querySelector(".tree-label")?.textContent === t);
    row("Verlinkte Seite").dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
    row("Zweite Seite").dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
  });
  await app.browser.waitUntil(async () => (await app.$$(".sidebar .tree-row.selected")).length === 3);
  await app.browser.execute(() => {
    const row = (t) => [...document.querySelectorAll(".sidebar .tree-row")].find((r) => r.querySelector(".tree-label")?.textContent === t);
    row("Zielnotiz").dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
  });
  await dragOnto("Zweite Seite", `${SHOWN} .ProseMirror p`, { x: 0.99 });
  await app.waitFor(`${SHOWN} .ProseMirror a.wikilink[data-target="Zweite Seite"]`);
  await app.browser.waitUntil(async () => {
    const c = (await app.invoke("page_get", { id: ids.target })).content;
    return (c.match(/\[\[Verlinkte Seite\]\]/g) ?? []).length === 2 && c.includes("[[Zweite Seite]]");
  }, { timeout: 8000, timeoutMsg: "not one link per selected page" });
  await app.shot("388-drag-into-editor");
  await app.keys(["Escape"]);
  await app.browser.execute(() => document.querySelector(".tree-selection [aria-label='Auswahl aufheben']")?.click());
});

test("onto a pane without a note, or onto a tab bar, the page opens there", async () => {
  await app.keys(["Control", "t"]);
  await app.browser.waitUntil(async () => (await app.$$(".pane.active .tab")).length === 2);
  const r = await dragOnto("Zieh Ordner", `${SHOWN}`);
  assert.ok(r.accepted && r.handled, JSON.stringify(r));
  await app.browser.waitUntil(async () => (await app.browser.execute((s) => document.querySelector(`${s} .page-title`)?.value, SHOWN)) === "Zieh Ordner", { timeoutMsg: "did not open in the pane" });
  await dragOnto("Zweite Seite", ".pane.active .tabbar");
  await app.browser.waitUntil(async () => (await app.browser.execute((s) => document.querySelector(`${s} .page-title`)?.value, SHOWN)) === "Zweite Seite", { timeoutMsg: "the tab bar did not open it" });
  // The tree did not change.
  assert.equal((await app.invoke("workspace_tree")).find((n) => n.id === ids.folder).children.length, 1);
});

test("onto the empty area below the rows: to the top level, with „Rückgängig“", async () => {
  const r = await (async () => {
    const row = await T.row("Zieh Ordner");
    if ((await row.getAttribute("aria-expanded")) === "false") await (await row.$(".tree-twisty")).click();
    await T.row("Zieh Kind");
    return T.drag("Zieh Kind", ".sidebar .tree-end", { css: true });
  })();
  assert.ok(r.accepted && r.root, JSON.stringify(r));
  await app.browser.waitUntil(async () => (await app.invoke("workspace_tree")).at(-1)?.id === ids.child, { timeoutMsg: "not moved to the end of the top level" });
  await app.waitText(".toast-title", /1 Seite verschoben/);
  assert.ok(await T.toastAction("Rückgängig"));
  await app.waitText(".toast-title", /zurückverschoben/);
  assert.equal((await app.invoke("workspace_tree")).find((n) => n.id === ids.folder).children[0]?.id, ids.child);
});

test("a collapsed folder held under a dragged page opens", async () => {
  await (await (await T.row("Zieh Ordner")).$(".tree-twisty")).click();
  await app.browser.waitUntil(async () => (await T.rowState("Zieh Ordner")).expanded === "false");
  await app.browser.execute(() => {
    const row = (t) => [...document.querySelectorAll(".sidebar .tree-row")].find((r) => r.querySelector(".tree-label")?.textContent === t);
    const dt = new DataTransfer();
    window.__dt = dt;
    row("Zweite Seite").dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
    const dst = row("Zieh Ordner");
    const r = dst.getBoundingClientRect();
    dst.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 40, clientY: r.top + r.height / 2 }));
  });
  await app.browser.waitUntil(async () => (await T.rowState("Zieh Ordner")).expanded === "true", { timeout: 3000, timeoutMsg: "the folder did not open under the dragged page" });
  await app.browser.execute(() => [...document.querySelectorAll(".sidebar .tree-row")].find((r) => r.querySelector(".tree-label")?.textContent === "Zweite Seite").dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: window.__dt })));
  // Opened for the drag only, not stored.
  assert.ok(!(await T.expanded()).includes(ids.folder));
});

test("while dragging, the tree scrolls near its edges", async () => {
  const sc = ".sidebar .sidebar-scroll";
  await app.browser.execute((s) => (document.querySelector(s).scrollTop = 0), sc);
  const top = await app.browser.execute((s) => {
    const row = [...document.querySelectorAll(".sidebar .tree-row")][1];
    const dt = new DataTransfer();
    window.__dt = dt;
    row.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
    return document.querySelector(s).scrollTop;
  }, sc);
  for (let i = 0; i < 5; i++)
    await app.browser.execute((s) => {
      const el = document.querySelector(s);
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: window.__dt, clientX: r.left + 40, clientY: r.bottom - 6 }));
    }, sc);
  await T.sleep(100);
  const down = await app.browser.execute((s) => document.querySelector(s).scrollTop, sc);
  assert.ok(down > top, `scrolled down: ${top} -> ${down}`);
  for (let i = 0; i < 3; i++)
    await app.browser.execute((s) => {
      const el = document.querySelector(s);
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: window.__dt, clientX: r.left + 40, clientY: r.top + 6 }));
    }, sc);
  await T.sleep(100);
  assert.ok((await app.browser.execute((s) => document.querySelector(s).scrollTop, sc)) < down, "and up again");
  await app.browser.execute(() => document.querySelector(".sidebar .tree-row").dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: window.__dt })));
});
