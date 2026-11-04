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
  await (await app.$(".pane.active .tab.active")).click({ button: "right" });
  assert.ok(await menuClick("Rechts daneben öffnen"));
  await app.browser.waitUntil(async () => (await app.$$(".pane")).length === 2, { timeout: 8000, timeoutMsg: "no second pane" });
}

/** Clicks the card `nodeId` in pane `pane` (0 left, 1 right). */
async function clickCard(pane, nodeId) {
  const at = await app.browser.execute(
    (p, n) => {
      const el = document.querySelectorAll(".pane")[p].querySelector(`.pane-content:not([hidden]) [data-node="${n}"]`);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + 12) };
    },
    pane,
    nodeId,
  );
  assert.ok(at, `card ${nodeId} not shown in pane ${pane}`);
  await app.browser.action("pointer").move({ x: at.x, y: at.y }).down().up().perform();
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
  await app.keys(["Delete"]);
  await app.browser.waitUntil(async () => (await stored(id)).nodes.length !== 2, { timeout: 8000, timeoutMsg: "delete in the right pane not saved" });
  await app.browser.pause(600);
  assert.deepEqual((await stored(id)).nodes.map((n) => n.id), ["c"], "the card deleted in the left pane came back");
  await app.browser.waitUntil(async () => (await cardsIn(0)).join() === "c", { timeout: 8000, timeoutMsg: `left pane shows ${await cardsIn(0)}` });
});

test("no console errors", async () => {
  assert.deepEqual(await app.consoleErrors(), []);
});
