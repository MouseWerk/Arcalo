// 1.19 file explorer, navigation: folders that come later start collapsed and only the ones
// opened by hand are stored (also across a restart), the list of 1.18 (collapsed folders) is
// taken over once, deleted folders leave it; opening a page reveals it (ancestors open, the tree
// scrolled to it, also for a page in the split pane, whose other page is marked) and the folders
// opened for it close again for the next page; „Im Baum zeigen“ (Ctrl+Shift+R); a filed folder
// opens and closes on click; typeahead, the child count, the tree's ARIA attributes, the context
// menu outside the tree, tooltips for cut titles, the key help, and the tree keyboard model of
// the smart folders, favorites and tags.
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

test("folders that come later start collapsed; opened ones are stored and survive a restart", async () => {
  ids.folder = (await T.create("Navi Ordner")).id;
  ids.child = (await T.create("Navi Kind", ids.folder)).id;
  await T.reload();
  // The demo's folders were there at the first start: they stay open.
  assert.equal((await T.rowState("Projekte")).expanded, "true");
  assert.equal((await T.rowState("Navi Ordner")).expanded, "false", "a new folder starts collapsed");
  assert.equal(await T.findRow("Navi Kind"), null);
  assert.ok(!(await T.expanded()).includes(ids.folder));
  await (await (await T.row("Navi Ordner")).$(".tree-twisty")).click();
  await app.browser.waitUntil(async () => (await T.rowState("Navi Ordner")).expanded === "true");
  assert.ok((await T.expanded()).includes(ids.folder), "stored as open");
  await T.reload();
  assert.equal((await T.rowState("Navi Ordner")).expanded, "true", "still open after a restart");
  assert.ok(await T.findRow("Navi Kind"));
});

test("a deleted folder leaves the stored list", async () => {
  const gone = await T.create("Navi Weg");
  await T.create("Navi Weg Kind", gone.id);
  await T.reload();
  await (await (await T.row("Navi Weg")).$(".tree-twisty")).click();
  await app.browser.waitUntil(async () => (await T.expanded()).includes(gone.id));
  await app.invoke("page_delete", { id: gone.id });
  await T.reload();
  await app.browser.waitUntil(async () => !(await T.expanded()).includes(gone.id), { timeoutMsg: "the deleted folder stayed in the list" });
});

test("the collapsed list of 1.18 is taken over once", async () => {
  const projects = (await T.rowState("Projekte")).id;
  await app.browser.execute((p) => {
    localStorage.removeItem("arcalo.expanded");
    localStorage.setItem("arcalo.collapsed", JSON.stringify([p]));
  }, projects);
  await T.reload();
  assert.equal((await T.rowState("Projekte")).expanded, "false", "collapsed in 1.18: collapsed");
  assert.equal((await T.rowState("Navi Ordner")).expanded, "true", "open in 1.18: open");
  assert.equal(await app.browser.execute(() => localStorage.getItem("arcalo.collapsed")), null);
  await (await (await T.row("Projekte")).$(".tree-twisty")).click();
});

test("opening a page reveals it: ancestors open, scrolled into view; they close for the next page", async () => {
  for (let i = 0; i < 70; i++) await T.create(`Füllseite ${String(i).padStart(2, "0")}`);
  const a = await T.create("Navi Tief A");
  const b = await T.create("Navi Tief B", a.id);
  ids.deep = (await T.create("Navi Ziel", b.id)).id;
  ids.deepA = a.id;
  ids.deepB = b.id;
  await T.reload();
  await app.browser.execute(() => (document.querySelector(".sidebar .sidebar-scroll").scrollTop = 0));
  assert.equal((await T.rowState("Navi Tief A")).expanded, "false");
  await T.openPage(ids.deep, "Navi Ziel");
  await app.browser.waitUntil(async () => (await T.rowState("Navi Ziel"))?.inView, { timeoutMsg: "the open page was not scrolled into view" });
  const st = await T.rowState("Navi Ziel");
  assert.equal(st.current, "page");
  assert.equal((await T.rowState("Navi Tief A")).expanded, "true");
  assert.equal((await T.rowState("Navi Tief B")).expanded, "true");
  // Opened for the page only: not stored, and closed again when another page opens.
  assert.ok(!(await T.expanded()).includes(ids.deepA));
  await app.shot("385-reveal");
  const top = (await app.invoke("workspace_tree")).find((n) => n.title === "Füllseite 00");
  await T.openPage(top.id, "Füllseite 00");
  await app.browser.waitUntil(async () => (await T.rowState("Navi Tief A")).expanded === "false", { timeoutMsg: "the revealed folder stayed open" });
  await app.browser.waitUntil(async () => (await T.rowState("Füllseite 00"))?.inView, { timeoutMsg: "not scrolled back up" });
});

test("a page opened in the split pane is revealed; the other pane's page is marked", async () => {
  await T.openPage(ids.child, "Navi Kind");
  // Alt+click on a row: to the right.
  await app.browser.execute(() => {
    const r = [...document.querySelectorAll(".sidebar .tree-row")].find((x) => x.querySelector(".tree-label")?.textContent === "Navi Tief A");
    r.dispatchEvent(new MouseEvent("click", { bubbles: true, altKey: true }));
  });
  await app.browser.waitUntil(async () => (await app.$$(".pane")).length === 2, { timeoutMsg: "no split" });
  await app.browser.waitUntil(async () => (await T.rowState("Navi Tief A"))?.current === "page");
  const kind = await T.rowState("Navi Kind");
  assert.match(kind.classes, /\belsewhere\b/);
  assert.equal(await app.browser.execute(() => document.querySelector(".sidebar .tree-row.elsewhere .tree-elsewhere")?.getAttribute("aria-label")), "Im anderen Bereich geöffnet");
  // The deep page in the right pane: revealed there too.
  await T.openPage(ids.deep, "Navi Ziel");
  await app.browser.waitUntil(async () => (await T.rowState("Navi Ziel"))?.inView);
  await app.shot("385-split-elsewhere");
  await app.browser.execute(() => document.querySelectorAll(".pane")[1]?.querySelectorAll(".tab-close").forEach((b) => b.click()));
  await app.browser.waitUntil(async () => (await app.$$(".pane")).length === 1);
});

test("„Im Baum zeigen“ (Ctrl+Shift+R) switches to the tree and focuses the open page", async () => {
  await T.openPage(ids.deep, "Navi Ziel");
  await app.click('.side-tabs [aria-label="Favoriten"]');
  await app.waitFor(".sidebar .side-title");
  await app.browser.execute(() => document.querySelector(`.pane.active .ProseMirror`)?.focus());
  await app.keys(["Control", "Shift", "r"]);
  await app.browser.waitUntil(async () => (await T.rowState("Navi Ziel"))?.focused, { timeout: 5000, timeoutMsg: "the row of the open page did not get the focus" });
  assert.ok((await T.rowState("Navi Ziel")).inView);
});

test("a filed folder (Tagesnotizen, year, month) opens and closes on click", async () => {
  await app.invoke("daily_note", { date: null });
  await T.reload();
  const before = await app.browser.execute((s) => document.querySelector(`${s} .page-title`)?.value, SHOWN);
  const st = await T.rowState("Tagesnotizen");
  assert.ok(st, "daily folder shown");
  await (await T.row("Tagesnotizen")).click();
  await app.browser.waitUntil(async () => (await T.rowState("Tagesnotizen")).expanded !== st.expanded, { timeoutMsg: "the click did not toggle the folder" });
  assert.equal(await app.browser.execute((s) => document.querySelector(`${s} .page-title`)?.value, SHOWN), before, "no empty page opened");
  await (await T.row("Tagesnotizen")).click();
  await app.browser.waitUntil(async () => (await T.rowState("Tagesnotizen")).expanded === st.expanded);
});

test("typeahead, child count, ARIA attributes, menu outside the tree, tooltips", async () => {
  const long = "Navi Ein sehr langer Seitentitel der in der Seitenleiste ganz sicher abgeschnitten wird";
  await T.create(long);
  await T.reload();
  // Child count, drawn by CSS (the row's text stays its title).
  const count = await app.browser.execute(() => {
    const r = [...document.querySelectorAll(".sidebar .tree-row")].find((x) => x.querySelector(".tree-label")?.textContent === "Navi Ordner");
    return { attr: r.querySelector(".tree-count")?.dataset.count, text: r.textContent };
  });
  assert.deepEqual(count, { attr: "1", text: "Navi Ordner" });
  // ARIA: level, size and place among the siblings; no "not selected" without a selection.
  const kind = await T.rowState("Navi Kind");
  assert.deepEqual([kind.level, kind.setsize, kind.posinset, kind.selected], [2, "1", "1", null]);
  const tree = await app.browser.execute(() => document.querySelector(".sidebar [role=tree]").getAttribute("aria-multiselectable"));
  assert.equal(tree, null);
  // Typeahead: letters go to the next row starting with them.
  await (await T.row("Navi Ordner")).click();
  await app.browser.execute(() => document.querySelector(".sidebar .tree-row.active").focus());
  await app.keys(["n", "a", "v", "i", " ", "t"]);
  await app.browser.waitUntil(async () => (await T.rowState("Navi Tief A"))?.focused, { timeout: 3000, timeoutMsg: "typeahead did not reach Navi Tief A" });
  await T.sleep(800);
  await app.keys(["f"]);
  await app.browser.waitUntil(async () => app.browser.execute(() => document.activeElement?.querySelector(".tree-label")?.textContent.startsWith("Füllseite")), { timeout: 3000, timeoutMsg: "a new search did not start" });
  // The context menu is not inside the tree.
  await T.rowMenu("Navi Ordner");
  assert.equal(await app.browser.execute(() => !!document.querySelector(".menu").closest("[role=tree]")), false);
  await T.closeMenus();
  // A cut title has its full text as a tooltip; a short one has none.
  await (await T.row(long)).moveTo();
  await app.browser.waitUntil(async () => (await app.browser.execute((t) => [...document.querySelectorAll(".sidebar .tree-label")].find((x) => x.textContent === t)?.title, long)) === long, { timeoutMsg: "no tooltip" });
  await (await T.row("Navi Kind")).moveTo();
  assert.equal(await app.browser.execute(() => [...document.querySelectorAll(".sidebar .tree-label")].find((x) => x.textContent === "Navi Kind")?.title ?? ""), "");
});

test("the key help lists the tree's keys, Ctrl+Space among them", async () => {
  await app.keys(["Control", ","]);
  await app.waitFor(".settings");
  await app.browser.execute(() => document.querySelector('.settings-nav-item[data-section="keyboard"]')?.click());
  await app.waitText(".settings", /Seite auswählen oder abwählen/);
  await app.waitText(".settings", /Zur Seite mit diesen Anfangsbuchstaben/);
  await app.keys(["Control", "w"]);
});

test("smart folders, favorites and tags follow the tree keyboard model", async () => {
  await app.invoke("page_set_favorite", { id: ids.folder, favorite: true });
  await app.invoke("page_set_favorite", { id: ids.child, favorite: true });
  await T.reload();
  // Smart folders: one tree, arrows move, Right opens a folder.
  if ((await (await app.$(".smart-head")).getAttribute("aria-expanded")) === "false") await app.click(".smart-head");
  await app.waitFor(".smart-body[role=tree] [role=treeitem]");
  await app.browser.execute(() => document.querySelector(".smart-body [role=treeitem][tabindex='0']").focus());
  await app.keys(["ArrowDown"]);
  assert.equal(await app.browser.execute(() => document.activeElement.closest(".smart-folder")?.dataset.kind), "favorites");
  await app.keys(["ArrowRight"]);
  await app.browser.waitUntil(async () => app.browser.execute(() => document.activeElement.getAttribute("aria-expanded") === "true"), { timeoutMsg: "Right did not open the smart folder" });
  await app.waitFor('.smart-folder[data-kind="favorites"] [role=treeitem][aria-level="2"]');
  await app.keys(["ArrowRight"]);
  await app.browser.waitUntil(async () => app.browser.execute(() => document.activeElement.getAttribute("aria-level") === "2"), { timeoutMsg: "Right did not go to the first page" });
  await app.keys(["ArrowLeft"]);
  assert.equal(await app.browser.execute(() => document.activeElement.closest(".smart-folder")?.dataset.kind + document.activeElement.getAttribute("aria-level")), "favorites1");
  // Favorites: a tree too, Enter opens.
  await app.click('.side-tabs [aria-label="Favoriten"]');
  await app.waitFor(".sidebar [role=tree] [role=treeitem]");
  await app.browser.execute(() => document.querySelector(".sidebar-body [role=tree] [role=treeitem][tabindex='0']").focus());
  const favs = await app.browser.execute(() => [...document.querySelectorAll(".sidebar-body [role=tree] [role=treeitem]")].map((x) => x.textContent));
  assert.ok(favs.length >= 2 && favs.includes("Navi Kind"));
  await app.keys(["End"]);
  assert.equal(await app.browser.execute(() => document.activeElement.textContent), favs.at(-1));
  await app.keys(["Home"]);
  await app.keys(["ArrowDown"]);
  const last = await app.browser.execute(() => document.activeElement.textContent);
  assert.equal(last, favs[1]);
  await app.keys(["Enter"]);
  await app.browser.waitUntil(async () => (await app.browser.execute((s) => document.querySelector(`${s} .page-title`)?.value, SHOWN)) === last, { timeoutMsg: "Enter did not open the favorite" });
  // Tags: the same.
  await app.click('.side-tabs [aria-label="Tags"]');
  await app.waitFor(".sidebar [role=tree] [role=treeitem]");
  const n = await app.browser.execute(() => document.querySelectorAll(".sidebar-body [role=tree] [role=treeitem]").length);
  await app.browser.execute(() => document.querySelector(".sidebar-body [role=tree] [role=treeitem][tabindex='0']").focus());
  await app.keys(["End"]);
  assert.equal(await app.browser.execute(() => document.activeElement.getAttribute("aria-posinset")), String(n));
  await app.click('.side-tabs [aria-label="Dateien"]');
});
