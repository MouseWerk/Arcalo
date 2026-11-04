// q124 round 3, hunt B: the same place open in two panes. A canvas shown side by side takes over
// what the other pane changed, so an edit in one pane never brings back what was deleted in the
// other.

import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
before(async () => (app = await launch({ width: 1480, height: 900 })));
after(async () => app?.close());

const card = (id, text, x) => ({ id, type: "text", text, x, y: 0, width: 220, height: 100 });
const board = (...nodes) => JSON.stringify({ nodes, edges: [] }, null, "\t");
const stored = async (id) => JSON.parse((await app.invoke("page_get", { id })).content);
const menuClick = (label) =>
  app.browser.execute((l) => {
    const item = [...document.querySelectorAll(".menu-item, [role^=menuitem]")].find((b) => b.textContent.trim().startsWith(l));
    item?.click();
    return !!item;
  }, label);

async function openInTwoPanes(id, title) {
  await app.invoke("search_open", { target: { kind: "page", page_id: id, new_tab: true } });
  await app.browser.waitUntil(() => app.browser.execute((t) => document.querySelector(".pane.active .tab.active .tab-title")?.textContent === t, title), { timeout: 8000, timeoutMsg: "not opened" });
  // The tab menu without a real right click (that leaves the pointer pressed for the next clicks).
  await app.browser.execute(() => document.querySelector(".pane.active .tab.active").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 400, clientY: 20 })));
  await app.browser.waitUntil(() => menuClick("Rechts daneben öffnen"), { timeout: 5000, timeoutMsg: "no tab menu" });
  await app.browser.waitUntil(async () => (await app.$$(".pane")).length === 2, { timeout: 8000, timeoutMsg: "no second pane" });
}

/** Clicks the card `nodeId` in pane `pane` (0 left, 1 right). */
async function clickCard(pane, nodeId) {
  const origin = await (await app.$$(".pane"))[pane].$(`.pane-content:not([hidden]) [data-node="${nodeId}"]`);
  assert.ok(await origin.isExisting(), `card ${nodeId} not shown in pane ${pane}`);
  // Near the card's left edge: a card can reach past the pane's right edge.
  const { width } = await origin.getSize();
  const x = -Math.round(width / 2) + 24;
  await app.browser.performActions([
    {
      type: "pointer",
      id: "mouse",
      parameters: { pointerType: "mouse" },
      actions: [
        { type: "pointerMove", origin, x, y: 0 },
        { type: "pointerDown", button: 0 },
        { type: "pause", duration: 40 },
        { type: "pointerUp", button: 0 },
      ],
    },
  ]);
  await app.browser.releaseActions();
  await app.browser.pause(120);
}
const cardsIn = (pane) =>
  app.browser.execute((p) => [...document.querySelectorAll(".pane")[p].querySelectorAll(".pane-content:not([hidden]) [data-node]")].map((e) => e.dataset.node).sort(), pane);

test("a canvas in two panes: a delete in one pane is not undone by an edit in the other", async () => {
  const id = (await app.invoke("canvas_create", { parentId: null, title: "Zwei Bereiche Canvas" })).id;
  await app.invoke("page_save", { id, content: board(card("a", "Erste", 0), card("b", "Zweite", 300), card("c", "Dritte", 600)) });
  await openInTwoPanes(id, "Zwei Bereiche Canvas");
  await app.browser.waitUntil(async () => (await cardsIn(0)).length === 3 && (await cardsIn(1)).length === 3, { timeout: 8000, timeoutMsg: "cards not shown in both panes" });

  await clickCard(0, "a");
  await app.keys(["Delete"]);
  await app.browser.waitUntil(async () => (await stored(id)).nodes.length === 2, { timeout: 8000, timeoutMsg: "delete in the left pane not saved" });
  // The right pane shows the change too.
  await app.browser.waitUntil(async () => (await cardsIn(1)).join() === "b,c", { timeout: 8000, timeoutMsg: `right pane still shows ${await cardsIn(1)}` });

  await clickCard(1, "b");
  assert.ok(await app.browser.execute(() => document.activeElement?.closest(".pane") === document.querySelectorAll(".pane")[1]), "the right board has the focus");
  await app.keys(["Delete"]);
  await app.browser.waitUntil(async () => (await stored(id)).nodes.length !== 2, { timeout: 8000, timeoutMsg: "delete in the right pane not saved" });
  await app.browser.pause(600);
  assert.deepEqual((await stored(id)).nodes.map((n) => n.id), ["c"], "the card deleted in the left pane came back");
  await app.browser.waitUntil(async () => (await cardsIn(0)).join() === "c", { timeout: 8000, timeoutMsg: `left pane shows ${await cardsIn(0)}` });

  // Undo in the right pane takes back its own delete, not the left pane's.
  await app.keys(["Control", "z"]);
  await app.browser.waitUntil(async () => (await stored(id)).nodes.length === 2, { timeout: 8000, timeoutMsg: "undo not saved" });
  await app.browser.pause(600);
  assert.deepEqual((await stored(id)).nodes.map((n) => n.id).sort(), ["b", "c"], "undo brought back the wrong card");
  await app.browser.waitUntil(async () => (await cardsIn(0)).join() === "b,c", { timeout: 8000, timeoutMsg: `left pane shows ${await cardsIn(0)}` });
});

const shownTitle = () => app.browser.execute(() => document.querySelector(".pane.active > .pane-content:not([hidden]) .page-title")?.value ?? null);

test("a page renamed in the sidebar shows its new title in its open tab", async () => {
  const id = (await app.invoke("page_create", { parentId: null, title: "Alter Name Baum", icon: "file-text", content: "Text.\n" })).id;
  await app.invoke("search_open", { target: { kind: "page", page_id: id, new_tab: true } });
  await app.browser.waitUntil(async () => (await shownTitle()) === "Alter Name Baum", { timeout: 8000, timeoutMsg: "not opened" });
  const label = await app.$(`.sidebar .tree-row[data-id="${id}"] .tree-label`);
  await label.scrollIntoView({ block: "center" });
  await label.doubleClick();
  const input = await app.$(`.sidebar .tree-row[data-id="${id}"] input`);
  await input.waitForExist({ timeout: 5000 });
  await app.keys(["Control", "a"]);
  await app.type("neuer name baum");
  await app.keys(["Enter"]);
  await app.browser.waitUntil(async () => (await app.invoke("page_get", { id })).title === "neuer name baum", { timeout: 8000, timeoutMsg: "not renamed" });
  await app.browser.waitUntil(async () => (await shownTitle()) === "neuer name baum", { timeout: 5000, timeoutMsg: `the open page still shows „${await shownTitle()}“` });
});

const tabClosed = (title) =>
  app.browser.waitUntil(() => app.browser.execute((t) => ![...document.querySelectorAll(".tab-title")].some((x) => x.textContent.startsWith(t)), title), { timeout: 5000, timeoutMsg: "tab not closed" });

test("a title typed and the tab closed right away is kept", async () => {
  const id = (await app.invoke("page_create", { parentId: null, title: "Titel Schliessen", icon: "file-text", content: "Text.\n" })).id;
  await app.invoke("search_open", { target: { kind: "page", page_id: id, new_tab: true } });
  await app.browser.waitUntil(async () => (await shownTitle()) === "Titel Schliessen", { timeout: 8000, timeoutMsg: "not opened" });
  await app.browser.execute(() => {
    const el = document.querySelector(".pane.active > .pane-content:not([hidden]) .page-title");
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  });
  await app.type(" neu");
  await app.keys(["Control", "w"]);
  await tabClosed("Titel Schliessen");
  await app.browser.waitUntil(async () => (await app.invoke("page_get", { id })).title === "Titel Schliessen neu", { timeout: 5000, timeoutMsg: `title lost: ${(await app.invoke("page_get", { id })).title}` });
});

test("a property typed and the tab closed right away is kept", async () => {
  const id = (await app.invoke("page_create", { parentId: null, title: "Eigenschaft Schliessen", icon: "file-text", content: "---\nkunde: alt\n---\nText.\n" })).id;
  await app.invoke("search_open", { target: { kind: "page", page_id: id, new_tab: true } });
  const input = '.pane.active > .pane-content:not([hidden]) .properties [data-prop-key="kunde"] .prop-value-input';
  await app.waitFor(input);
  await app.browser.execute((sel) => {
    const el = document.querySelector(sel);
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, input);
  await app.type(" und neu");
  await app.keys(["Control", "w"]);
  await tabClosed("Eigenschaft Schliessen");
  await app.browser.waitUntil(async () => /\nkunde: alt und neu\n/.test((await app.invoke("page_get", { id })).content), { timeout: 5000, timeoutMsg: `property lost: ${(await app.invoke("page_get", { id })).content}` });
  assert.equal((await app.invoke("page_get", { id })).content, "---\nkunde: alt und neu\n---\nText.\n");
});

test("no console errors", async () => {
  assert.deepEqual(await app.consoleErrors(), []);
});
