// App shell, keyboard and screen reader names (1.12 quality pass): the command palette finds
// umlaut titles typed without umlauts and tells assistive technology which result is chosen;
// the page tree selects ranges with Shift+arrows, deletes with Entf (several pages at once, one
// undo), and its context menu takes the focus from the keyboard and hands it back; the tab bar
// is a proper tab list; toasts wait while pointed at; finishing a task under „Offen“ can be undone.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
before(async () => (app = await launch({ width: 1280, height: 800 })));
after(async () => app?.close());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const active = () => app.browser.execute(() => {
  const el = document.activeElement;
  return { cls: String(el?.className ?? ""), role: el?.getAttribute("role"), text: (el?.textContent ?? "").trim().slice(0, 60), id: el?.getAttribute("data-id") };
});
const treeRow = (id) => `.sidebar .tree .tree-row[data-id="${id}"]`;

test("the palette finds „Übersicht“ by „ubersicht“ and „uebersicht“ and names the chosen result", async () => {
  const page = await app.invoke("page_create", { parentId: null, title: "Übersicht Straße", icon: null, content: "x\n" });
  await app.invoke("search_open", { target: { kind: "page", page_id: page.id, new_tab: false } });
  await app.waitText(".pane.active .tab.active", /Übersicht/);
  for (const q of ["ubersicht", "uebersicht", "strasse"]) {
    await app.keys(["Control", "k"]);
    await app.waitFor(".palette input");
    await app.type(q);
    await app.browser.waitUntil(async () => (await app.browser.execute(() => document.querySelector(".pal-item.sel .pal-title")?.textContent ?? "")).startsWith("Übersicht Straße"), {
      timeoutMsg: `„${q}“ did not put the page first`,
    });
    const aria = await app.browser.execute(() => {
      const input = document.querySelector(".palette input");
      const id = input.getAttribute("aria-activedescendant");
      return { role: input.getAttribute("role"), controls: input.getAttribute("aria-controls"), chosen: id && document.getElementById(id)?.getAttribute("aria-selected") };
    });
    assert.deepEqual(aria, { role: "combobox", controls: "pal-list", chosen: "true" });
    // Tab stays in the palette.
    await app.keys("Tab");
    assert.equal(await app.browser.execute(() => !!document.activeElement?.closest(".palette")), true, "Tab left the palette");
    await app.keys("Escape");
    await app.browser.waitUntil(async () => !(await app.browser.execute(() => !!document.querySelector(".palette"))));
  }
});

test("Shift+arrows select a range from the anchor, Entf moves the pages to the trash with one undo", async () => {
  const ids = [];
  for (const title of ["Bulk Eins", "Bulk Zwei", "Bulk Drei"]) ids.push((await app.invoke("page_create", { parentId: null, title, icon: null, content: "x\n" })).id);
  await app.invoke("search_open", { target: { kind: "page", page_id: ids[0], new_tab: false } });
  await app.waitFor(treeRow(ids[2]));
  // Rows in tree order (the sort may place them anywhere, but next to each other).
  const order = await app.browser.execute((list) => [...document.querySelectorAll(".sidebar .tree .tree-row")].map((r) => Number(r.dataset.id)).filter((id) => list.includes(id)), ids);
  await app.browser.execute((sel) => document.querySelector(sel).focus(), treeRow(order[0]));
  await app.keys(["Shift", "ArrowDown"]);
  await app.keys(["Shift", "ArrowDown"]);
  await app.keys(["Shift", "ArrowUp"]);
  const selected = () => app.browser.execute(() => [...document.querySelectorAll(".sidebar .tree .tree-row.selected")].map((r) => Number(r.dataset.id)));
  assert.deepEqual((await selected()).sort(), [order[0], order[1]].sort(), "going back shrinks the range");
  await app.keys(["Shift", "ArrowDown"]);
  assert.equal((await selected()).length, 3);
  // The menu of the selection, from the keyboard: the focus moves onto its first item.
  await app.keys(["Shift", "F10"]);
  await app.waitFor(".menu");
  await app.browser.waitUntil(async () => (await active()).role === "menuitem", { timeoutMsg: "the menu did not take the focus" });
  const labels = await app.browser.execute(() => [...document.querySelectorAll(".menu .menu-item")].map((b) => b.textContent));
  assert.ok(labels.some((l) => /3 Seiten löschen/.test(l)), labels.join(" | "));
  await app.keys("Escape");
  await app.browser.waitUntil(async () => (await active()).id === String(order[2]), { timeoutMsg: "Escape did not hand the focus back to the row" });
  // Entf: one confirmation, one toast.
  await app.keys("Delete");
  await app.waitFor(".dialog");
  assert.match(await app.text(".dialog"), /3 Seiten löschen\?/);
  await app.browser.execute(() => document.querySelector(".dialog .btn-danger").click());
  await app.waitText(".toast", /3 Seiten im Papierkorb/);
  const trash = await app.invoke("trash_list");
  for (const id of ids) assert.ok(trash.some((t) => t.id === id), `page ${id} not in the trash`);
  // The toast stays while pointed at, longer than its own time.
  await app.browser.$(".toast").moveTo();
  await sleep(8500);
  assert.ok(await app.browser.execute(() => !!document.querySelector(".toast")), "the toast closed under the pointer");
  await app.browser.execute(() => {
    const toast = [...document.querySelectorAll(".toast")].find((t) => /Seiten im Papierkorb/.test(t.textContent));
    [...toast.querySelectorAll("button")].find((b) => /Rückgängig/.test(b.textContent)).click();
  });
  await app.browser.waitUntil(async () => (await app.browser.execute((sel) => !!document.querySelector(sel), treeRow(ids[1]))), { timeoutMsg: "undo did not restore the pages" });
  const tree = await app.invoke("workspace_tree");
  for (const id of ids) assert.ok(tree.some((n) => n.id === id), `page ${id} not back`);
  await app.browser.$(".pane.active .pane-content").moveTo();
});

test("Entf on one page moves it to the trash; F2 opens it with the title selected", async () => {
  const page = await app.invoke("page_create", { parentId: null, title: "Einzeln weg", icon: null, content: "x\n" });
  const other = await app.invoke("page_create", { parentId: null, title: "Umbenennen per F2", icon: null, content: "x\n" });
  await app.invoke("search_open", { target: { kind: "page", page_id: page.id, new_tab: false } });
  await app.waitFor(treeRow(other.id));
  await app.browser.execute((sel) => document.querySelector(sel).focus(), treeRow(page.id));
  await app.keys("Delete");
  await app.browser.waitUntil(async () => (await app.invoke("trash_list")).some((t) => t.id === page.id), { timeoutMsg: "Entf did not delete the page" });
  await app.browser.execute((sel) => document.querySelector(sel).focus(), treeRow(other.id));
  await app.keys("F2");
  await app.browser.waitUntil(
    async () => app.browser.execute(() => {
      const t = document.querySelector(".pane.active .page-title");
      return !!t && document.activeElement === t && t.selectionEnd - t.selectionStart === t.value.length && t.value === "Umbenennen per F2";
    }),
    { timeoutMsg: "F2 did not select the title" },
  );
});

test("the tab bar is one tab list: arrows, Home and End move, the close buttons are no Tab stops", async () => {
  await app.browser.execute(() => document.querySelector(".ribbon-graph").click());
  await app.browser.execute(() => document.querySelector('.pane.active .tabbar [aria-label^="Neuer Tab"]').click());
  const info = await app.browser.execute(() => {
    const bar = document.querySelector(".pane.active .tabbar");
    const list = bar.querySelector("[role=tablist]");
    return {
      barRole: bar.getAttribute("role"),
      listName: list?.getAttribute("aria-label"),
      onlyTabs: [...list.children].every((c) => c.getAttribute("role") === "tab"),
      closeStops: [...list.querySelectorAll(".tab-close")].filter((b) => b.tabIndex >= 0).length,
      named: [...list.querySelectorAll("[role=tab]")].every((t) => !!t.getAttribute("aria-label")),
      count: list.children.length,
    };
  });
  assert.equal(info.barRole, null);
  assert.ok(info.listName);
  assert.ok(info.onlyTabs);
  assert.equal(info.closeStops, 0);
  assert.ok(info.named);
  assert.ok(info.count >= 2);
  await app.browser.execute(() => document.querySelector(".pane.active .tab.active").focus());
  await app.keys("Home");
  assert.equal(await app.browser.execute(() => document.activeElement === document.querySelector(".pane.active .tab")), true);
  await app.keys("End");
  assert.equal(await app.browser.execute(() => document.activeElement === [...document.querySelectorAll(".pane.active .tab")].at(-1)), true);
});

test("the sidebar panes are one Tab stop with arrow keys", async () => {
  await app.browser.execute(() => document.querySelector('.side-tabs [aria-selected="true"]').focus());
  const stops = await app.browser.execute(() => [...document.querySelectorAll(".side-tabs [role=tab]")].filter((b) => b.tabIndex >= 0).length);
  assert.equal(stops, 1);
  await app.keys("ArrowRight");
  await app.browser.waitUntil(async () => app.browser.execute(() => document.activeElement?.getAttribute("aria-selected") === "true" && document.activeElement?.closest(".side-tabs") != null && !!document.querySelector(".side-search input")), {
    timeoutMsg: "ArrowRight did not open the search pane with the focus on its tab",
  });
  await app.keys("Home");
  await app.browser.waitUntil(async () => app.browser.execute(() => !!document.querySelector(".sidebar .tree")), { timeoutMsg: "Home did not go back to the files" });
});

test("a task finished under „Offen“ can be brought back from the toast", async () => {
  await app.invoke("page_create", { parentId: null, title: "Aufgaben-Rückgängig", icon: null, content: "- [ ] Rückgängig prüfen\n" });
  await app.browser.execute(() => document.querySelector('.ribbon [aria-label^="Aufgaben"]').click());
  await app.waitText(".tasks-view", /Rückgängig prüfen/);
  await app.browser.execute(() => {
    const row = [...document.querySelectorAll(".task-row")].find((r) => /Rückgängig prüfen/.test(r.textContent));
    row.querySelector(".task-check").click();
  });
  await app.waitText(".toast", /Aufgabe erledigt/);
  await app.browser.execute(() => {
    const toast = [...document.querySelectorAll(".toast")].find((t) => /Aufgabe erledigt/.test(t.textContent));
    [...toast.querySelectorAll("button")].find((b) => /Rückgängig/.test(b.textContent)).click();
  });
  await app.browser.waitUntil(
    async () => {
      const list = await app.invoke("tasks_list", { filter: { status: "open" } });
      return list.some((t) => t.text.includes("Rückgängig prüfen"));
    },
    { timeoutMsg: "the task did not come back" },
  );
  await app.waitText(".tasks-view", /Rückgängig prüfen/);
});
