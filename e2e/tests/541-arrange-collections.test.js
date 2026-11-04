// q124 round 3, hunt B: the board and table of a page's subpages. A card dragged to another
// column stays there (also when the page order changes with it), and the stored value matches.

import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app, parent;
const kids = {};
before(async () => (app = await launch({ width: 1480, height: 900 })));
after(async () => app?.close());

const VIEW = ".pane.active > .pane-content:not([hidden])";
const col = (name) => `${VIEW} .board-col[data-group="${name}"]`;
const content = async (id) => (await app.invoke("page_get", { id })).content;
const columnOf = (id) => app.browser.execute((sel, i) => document.querySelector(`${sel} .board-card[data-row="${i}"]`)?.closest(".board-col")?.dataset.group ?? null, VIEW, id);

async function dragCard(id, to) {
  const card = await app.$(`${VIEW} .board-card[data-row="${id}"]`);
  const target = await app.$(`${col(to)} .board-add`);
  await app.browser.performActions([
    {
      type: "pointer",
      id: "mouse",
      parameters: { pointerType: "mouse" },
      actions: [
        { type: "pointerMove", origin: card, x: 0, y: 0 },
        { type: "pointerDown", button: 0 },
        { type: "pointerMove", origin: "pointer", x: 40, y: 10, duration: 100 },
        { type: "pointerMove", origin: target, x: 0, y: -6, duration: 200 },
        { type: "pointerUp", button: 0 },
      ],
    },
  ]);
  await app.browser.releaseActions();
}

test("board: a card dragged to another column stays there", async () => {
  parent = (
    await app.invoke("page_create", {
      parentId: null,
      title: "Board Spalten",
      icon: "file-text",
      content: "---\neigenschaften:\n  status: {typ: auswahl, optionen: {Offen: grau, Fertig: grün}}\nansicht: board\n---\nDie Karten.\n",
    })
  ).id;
  for (const [key, title, status] of [["a", "Karte A", "Offen"], ["b", "Karte B", "Offen"], ["c", "Karte C", "Fertig"], ["d", "Karte D", "Fertig"]])
    kids[key] = (await app.invoke("page_create", { parentId: parent, title, icon: "file-text", content: `---\nstatus: ${status}\n---\n${title}\n` })).id;
  await app.invoke("search_open", { target: { kind: "page", page_id: parent, new_tab: true } });
  await app.waitFor(`${col("Fertig")} .board-card[data-row="${kids.d}"]`);

  for (const [key, to] of [["a", "Fertig"], ["b", "Fertig"], ["a", "Offen"], ["c", "Offen"]]) {
    await dragCard(kids[key], to);
    await app.browser.waitUntil(async () => new RegExp(`\nstatus: ${to}\n`).test(await content(kids[key])), { timeout: 8000, timeoutMsg: `${key} not stored in ${to}` });
    await app.browser.waitUntil(async () => (await columnOf(kids[key])) === to, { timeout: 8000, timeoutMsg: `${key} not shown in ${to}` });
    // Still there once every answer is in (the page order and the reload after it).
    await app.browser.pause(1500);
    assert.equal(await columnOf(kids[key]), to, `card ${key} went back to its old column`);
  }
});

test("a canvas below a board page is no card: its file stays a canvas", async () => {
  const board = JSON.stringify({ nodes: [{ id: "k", type: "text", text: "Karte", x: 0, y: 0, width: 200, height: 80 }], edges: [] }, null, "\t");
  const canvas = (await app.invoke("canvas_create", { parentId: parent, title: "Skizze im Board" })).id;
  await app.invoke("page_save", { id: canvas, content: board });
  // Opened afresh, the board loads the folder as it is now.
  await app.keys(["Control", "w"]);
  await app.invoke("search_open", { target: { kind: "page", page_id: parent, new_tab: true } });
  await app.waitFor(`${col("Fertig")} .board-card[data-row="${kids.d}"]`);
  await app.browser.pause(800);
  assert.equal(await app.browser.execute((sel, id) => !!document.querySelector(`${sel} .board-card[data-row="${id}"]`), VIEW, canvas), false, "a canvas is shown as a card it cannot be");
  assert.match(await app.text(`${VIEW} .coll-count`), /^4 Seiten$/);
  assert.equal(await content(canvas), board);

  // With the canvas first among the subpages, a card dropped onto another lands right before it.
  await app.invoke("page_move", { id: canvas, parentId: parent, position: 0 });
  const order = async () => (await app.invoke("page_collection", { parentId: parent })).rows.map((r) => r.title);
  const before = await order();
  const fertig = before.filter((t) => t === "Karte B" || t === "Karte D");
  const [first, second] = fertig.map((t) => kids[t.slice(-1).toLowerCase()]);
  const card = await app.$(`${VIEW} .board-card[data-row="${second}"]`);
  const target = await app.$(`${VIEW} .board-card[data-row="${first}"]`);
  await app.browser.performActions([
    {
      type: "pointer",
      id: "mouse",
      parameters: { pointerType: "mouse" },
      actions: [
        { type: "pointerMove", origin: card, x: 0, y: 0 },
        { type: "pointerDown", button: 0 },
        { type: "pointerMove", origin: "pointer", x: 30, y: -10, duration: 100 },
        { type: "pointerMove", origin: target, x: 0, y: -8, duration: 200 },
        { type: "pointerUp", button: 0 },
      ],
    },
  ]);
  await app.browser.releaseActions();
  const want = before.filter((t) => t !== fertig[1]);
  want.splice(want.indexOf(fertig[0]), 0, fertig[1]);
  await app.browser.waitUntil(async () => (await order()).join() === want.join(), { timeout: 8000, timeoutMsg: `order ${await order()}, wanted ${want}` });
});

test("no console errors", async () => {
  assert.deepEqual(await app.consoleErrors(), []);
});
