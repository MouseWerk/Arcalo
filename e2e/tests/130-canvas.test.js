// Canvas (1.9), German: a new canvas from the sidebar lands in the „Canvas“ folder; a text card
// (double-click, Markdown) and a note card (live page) are added, connected by dragging from a
// side handle, grouped, the group is renamed and moved with its cards, undo/redo restore and
// repeat the move, a page dropped from the tree becomes a note card, keyboard copy/paste and
// delete work, a reload keeps everything, the note card is a backlink, the mirror writes the
// `.canvas` file, PNG/SVG export, and an Obsidian `.canvas` from a vault opens with its cards,
// group, link and edges (stored byte for byte).
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app, canvasId, out;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function reload() {
  await app.browser.execute(() => location.reload());
  await app.browser.pause(300);
  await app.browser.waitUntil(() => app.browser.execute(() => document.body.classList.contains("ready")), { timeout: 20000, timeoutMsg: "not ready after reload" });
}
const rect = (sel) =>
  app.browser.execute((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2) };
  }, sel);
const count = (sel) => app.browser.execute((s) => document.querySelectorAll(s).length, sel);
async function stored() {
  const doc = await app.invoke("page_get", { id: canvasId });
  return JSON.parse(doc.content);
}
async function waitStored(check, msg) {
  let last;
  await app.browser.waitUntil(async () => check((last = await stored())), { timeout: 8000, timeoutMsg: `${msg}: ${JSON.stringify(last)?.slice(0, 400)}` });
  return last;
}
async function drag(from, to, steps = 6) {
  let a = app.browser.action("pointer").move({ x: from.x, y: from.y }).down().pause(40);
  for (let i = 1; i <= steps; i++) a = a.move({ x: Math.round(from.x + ((to.x - from.x) * i) / steps), y: Math.round(from.y + ((to.y - from.y) * i) / steps), duration: 30 });
  await a.up().perform();
  await app.browser.pause(150);
}
async function dblclick(x, y) {
  await app.browser.action("pointer").move({ x, y }).down().up().pause(40).down().up().perform();
  await app.browser.pause(200);
}
const nodeBox = (n) => ({ x: n.x, y: n.y, width: n.width, height: n.height });

before(async () => {
  out = fs.mkdtempSync(path.join(os.tmpdir(), "arcalo-canvas-"));
  app = await launch({ width: 1480, height: 920 });
});
after(async () => {
  await app?.close();
  fs.rmSync(out, { recursive: true, force: true });
});

test("Neue Canvas in der Seitenleiste legt sie im Ordner „Canvas“ an", async () => {
  await app.click("[data-new-canvas]");
  await app.waitFor(".cv-board");
  canvasId = Number(await app.browser.execute(() => document.querySelector(".cv-board").dataset.canvas));
  const page = await app.invoke("page_get", { id: canvasId });
  assert.equal(page.kind, "canvas");
  assert.deepEqual(JSON.parse(page.content), { nodes: [], edges: [] });
  const tree = await app.invoke("workspace_tree");
  const folder = tree.find((n) => n.children.some((c) => c.id === canvasId));
  assert.equal(folder?.title, "Canvas", "filed flat into the canvas folder");
  await app.waitText(".cv-empty", /Leere Canvas/);
});

test("Textkarte per Doppelklick, Notizkarte aus der Auswahl, verbinden durch Ziehen", async () => {
  const board = await rect(".cv-board");
  await dblclick(board.x + 300, board.y + 260);
  await app.waitFor(".cv-text-input");
  await app.type("# Phase 1");
  await app.keys(["Enter"]);
  await app.type("Kickoff mit [[Architektur]]");
  await app.keys(["Escape"]);
  await app.waitText(".cv-card[data-kind=text] .cv-md h1", /Phase 1/);

  await app.click("[data-cv-add=note]");
  await app.waitFor(".cv-picker input");
  await app.type("Architektur");
  await app.keys(["Enter"]);
  await app.waitText(".cv-card[data-kind=note] .cv-note-title", /Architektur/);
  await app.waitText(".cv-card[data-kind=note] .cv-note-body", /Middleware/, 10000);
  // The note card sits in the middle of the view: move it right of the text card by its header.
  const head = await rect(".cv-card[data-kind=note] .cv-note-head");
  const text = await rect(".cv-card[data-kind=text]");
  await drag({ x: head.cx - 60, y: head.cy }, { x: text.x + text.w + 260, y: text.y + 10 });

  let doc = await waitStored((d) => d.nodes.length === 2, "two cards stored");
  const t = doc.nodes.find((n) => n.type === "text");
  const note = doc.nodes.find((n) => n.type === "file");
  assert.equal(t.text, "# Phase 1\nKickoff mit [[Architektur]]");
  assert.match(note.file, /Architektur\.md$/);
  assert.ok(note.x > t.x + t.width, "note right of the text card");

  // Connect: from the text card's right handle onto the note card.
  await app.browser.action("pointer").move({ x: text.cx, y: text.cy }).perform();
  const handle = await rect(".cv-card[data-kind=text] .cv-connect-right");
  const target = await rect(".cv-card[data-kind=note]");
  await drag({ x: handle.cx, y: handle.cy }, { x: target.x + 30, y: target.cy });
  doc = await waitStored((d) => d.edges.length === 1, "edge stored");
  assert.equal(doc.edges[0].fromNode, t.id);
  assert.equal(doc.edges[0].toNode, note.id);
  assert.equal(doc.edges[0].fromSide, "right");
  assert.equal(doc.edges[0].toSide, "left");
  assert.equal(await count(".cv-edge"), 1);
  await app.shot("130-canvas-connected");
});

test("Gruppieren, umbenennen, Gruppe mit Karten verschieben, Rückgängig und Wiederholen", async () => {
  await app.browser.execute(() => document.querySelector(".cv-board").focus());
  await app.keys(["Control", "a"]);
  await app.click(`.cv-selbar [aria-label="Gruppieren"]`);
  let doc = await waitStored((d) => d.nodes.some((n) => n.type === "group"), "group stored");
  const group = doc.nodes.find((n) => n.type === "group");
  assert.equal(doc.nodes[0].id, group.id, "groups are stored first (drawn below)");
  for (const n of doc.nodes.filter((x) => x.type !== "group")) {
    assert.ok(n.x >= group.x && n.y >= group.y && n.x + n.width <= group.x + group.width && n.y + n.height <= group.y + group.height, "cards inside the group");
  }
  const label = await rect(".cv-group-label");
  await dblclick(label.cx, label.cy);
  await app.waitFor(".cv-group-input");
  await app.browser.execute(() => {
    const i = document.querySelector(".cv-group-input");
    i.select();
  });
  await app.type("Vorbereitung");
  await app.keys(["Enter"]);
  doc = await waitStored((d) => d.nodes.find((n) => n.type === "group").label === "Vorbereitung", "label stored");
  const before = Object.fromEntries(doc.nodes.map((n) => [n.id, nodeBox(n)]));

  const l2 = await rect(".cv-group-label");
  await drag({ x: l2.cx, y: l2.cy }, { x: l2.cx + 200, y: l2.cy + 100 });
  doc = await waitStored((d) => d.nodes.find((n) => n.type === "group").x !== before[group.id].x, "group moved");
  const dx = doc.nodes.find((n) => n.type === "group").x - before[group.id].x;
  const dy = doc.nodes.find((n) => n.type === "group").y - before[group.id].y;
  assert.ok(Math.abs(dx - 200) <= 20 && Math.abs(dy - 100) <= 20, `moved by ${dx},${dy}`);
  for (const n of doc.nodes) assert.deepEqual([n.x - before[n.id].x, n.y - before[n.id].y], [dx, dy], "every card moved with the group");
  assert.equal(dx % 20, 0, "snapped to the grid");

  await app.browser.execute(() => document.querySelector(".cv-board").focus());
  await app.keys(["Control", "z"]);
  doc = await waitStored((d) => d.nodes.every((n) => n.x === before[n.id].x && n.y === before[n.id].y), "undo restores the positions");
  await app.keys(["Control", "Shift", "z"]);
  doc = await waitStored((d) => d.nodes.every((n) => n.x === before[n.id].x + dx && n.y === before[n.id].y + dy), "redo moves again");
  // Undo also takes back the rename and the grouping, step by step.
  await app.keys(["Control", "z"]);
  await app.keys(["Control", "z"]);
  await waitStored((d) => d.nodes.find((n) => n.type === "group")?.label === "Gruppe", "rename undone");
  await app.keys(["Control", "z"]);
  await waitStored((d) => !d.nodes.some((n) => n.type === "group"), "grouping undone");
  for (let i = 0; i < 3; i++) await app.keys(["Control", "y"]);
  await waitStored((d) => d.nodes.find((n) => n.type === "group")?.label === "Vorbereitung" && d.nodes.find((n) => n.type === "group").x === before[group.id].x + dx, "redo all");
});

test("Seite aus dem Baum ablegen, Tastatur: kopieren, einfügen, Pfeile, Entfernen", async () => {
  const projekte = (await app.invoke("workspace_tree")).find((n) => n.title === "Projekte");
  const board = await rect(".cv-board");
  await app.browser.execute(
    (id, x, y) => {
      const row = document.querySelector(`.tree-row[data-id="${id}"]`);
      const dst = document.querySelector(".cv-board");
      const dt = new DataTransfer();
      row.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
      dst.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
      dst.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
      row.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: dt }));
    },
    projekte.id,
    board.x + board.w - 300,
    board.y + 200,
  );
  let doc = await waitStored((d) => d.nodes.filter((n) => n.type === "file").length === 2, "dropped page stored");
  const dropped = doc.nodes.find((n) => n.type === "file" && /Projekte\.md$/.test(n.file));
  assert.ok(dropped, "note card for the dropped page");
  await app.waitText(".cv-card[data-kind=note] .cv-note-title", /Projekte/);

  // The dropped card is selected: copy, paste, move with the arrows, delete.
  await app.browser.execute(() => document.querySelector(".cv-board").focus());
  await app.keys(["Control", "c"]);
  await app.keys(["Control", "v"]);
  doc = await waitStored((d) => d.nodes.filter((n) => n.type === "file").length === 3, "pasted copy");
  const copy = doc.nodes.find((n) => n.type === "file" && /Projekte\.md$/.test(n.file) && n.id !== dropped.id);
  await app.keys(["ArrowRight"]);
  await app.keys(["ArrowRight"]);
  doc = await waitStored((d) => d.nodes.find((n) => n.id === copy.id).x === copy.x + 40, "arrows move by the grid");
  await app.keys(["Control", "d"]);
  await waitStored((d) => d.nodes.filter((n) => n.type === "file").length === 4, "duplicate");
  await app.keys(["Delete"]);
  await waitStored((d) => d.nodes.filter((n) => n.type === "file").length === 3, "duplicate deleted");
  await app.browser.execute((id) => {
    const el = document.querySelector(`.cv-card[data-node="${id}"]`);
    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: 0, clientY: 0 }));
  }, copy.id).catch(() => {});
  await app.keys(["Escape"]);
});

test("Nach dem Neuladen ist alles da; die Notizkarte ist ein Rückverweis", async () => {
  const beforeDoc = await stored();
  await reload();
  await app.waitFor(".cv-board");
  await app.browser.waitUntil(async () => (await count(".cv-card")) === beforeDoc.nodes.filter((n) => n.type !== "group").length, { timeoutMsg: "cards after reload" });
  assert.equal(await count(".cv-group"), 1);
  assert.equal(await count(".cv-edge"), 1);
  await app.waitText(".cv-group-label", /Vorbereitung/);
  await app.waitText(".cv-card[data-kind=text] .cv-md", /Kickoff mit/);
  const arch = (await app.invoke("workspace_tree")).flatMap(function flat(n) { return [n, ...n.children.flatMap(flat)]; }).find((n) => n.title === "Architektur");
  const doc = await app.invoke("page_get", { id: arch.id });
  const back = doc.backlinks.find((b) => b.page_id === canvasId);
  assert.ok(back, "the canvas is a backlink of Architektur");
  assert.equal(back.context, "Karte auf dieser Canvas");
  await app.shot("130-canvas-reloaded");
});

test("Markdown-Kopie schreibt die .canvas-Datei; Export als PNG und SVG", async () => {
  await app.invoke("backup_now");
  const status = await app.invoke("mirror_status");
  const file = path.join(status.path, "Canvas", "Unbenannte Canvas.canvas");
  assert.ok(fs.existsSync(file), `mirror file ${file}`);
  const mirrored = fs.readFileSync(file, "utf8");
  assert.equal(mirrored, (await app.invoke("page_get", { id: canvasId })).content, "the mirror holds the page as stored");
  assert.ok(JSON.parse(mirrored).nodes.some((n) => n.type === "group" && n.label === "Vorbereitung"));

  const png = path.join(out, "board.png");
  const svg = path.join(out, "board.svg");
  await app.browser.execute((id, p) => window.dispatchEvent(new CustomEvent("arcalo:canvas-export", { detail: { pageId: id, format: "png", path: p } })), canvasId, png);
  await app.browser.execute((id, p) => window.dispatchEvent(new CustomEvent("arcalo:canvas-export", { detail: { pageId: id, format: "svg", path: p } })), canvasId, svg);
  await app.browser.waitUntil(() => fs.existsSync(png) && fs.existsSync(svg), { timeout: 15000, timeoutMsg: "exports written" });
  await sleep(300);
  assert.deepEqual([...fs.readFileSync(png).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  const svgText = fs.readFileSync(svg, "utf8");
  assert.match(svgText, /<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
  assert.match(svgText, /Vorbereitung/);
  assert.match(svgText, /Phase 1/);
});

test("Eine Obsidian-Canvas aus einem Vault öffnet mit Karten, Gruppe, Link und Verbindungen", async () => {
  const vault = path.join(out, "Obsidian Vault");
  fs.mkdirSync(path.join(vault, "Projekt", "assets"), { recursive: true });
  fs.writeFileSync(path.join(vault, "Projekt", "Plan.md"), "# Plan\n\nMeilensteine für den Go-live.");
  const board = {
    nodes: [
      { id: "g1", type: "group", label: "Go-live", x: -60, y: -80, width: 900, height: 520, color: "4" },
      { id: "t1", type: "text", text: "## Cutover\n- Daten migrieren\n- Abnahme", x: 0, y: 0, width: 280, height: 160, color: "2" },
      { id: "f1", type: "file", file: "Projekt/Plan.md", x: 360, y: 0, width: 400, height: 300 },
      { id: "l1", type: "link", url: "https://example.com/handbuch", x: 0, y: 240, width: 300, height: 90 },
    ],
    edges: [
      { id: "e1", fromNode: "t1", fromSide: "right", toNode: "f1", toSide: "left", label: "plant", color: "5" },
      { id: "e2", fromNode: "t1", fromSide: "bottom", toNode: "l1", toSide: "top", toEnd: "none" },
    ],
    obsidianExtra: { keep: [1, "x"] },
  };
  const text = JSON.stringify(board, null, "\t");
  fs.writeFileSync(path.join(vault, "Projekt", "Board.canvas"), text);
  const report = await app.invoke("vault_import", { path: vault });
  assert.equal(report.pages, 2);
  await reload();
  const tree = await app.invoke("workspace_tree");
  const flat = tree.flatMap(function f(n) { return [n, ...n.children.flatMap(f)]; });
  const page = flat.find((n) => n.title === "Board");
  assert.equal(page.kind, "canvas");
  assert.equal((await app.invoke("page_get", { id: page.id })).content, text, "stored byte for byte");
  // Open it from the tree, as a user would.
  await app.browser.waitUntil(() => app.browser.execute((id) => document.querySelector(`.tree-row[data-id="${id}"]`) != null, page.id), { timeoutMsg: "imported canvas in the tree" });
  await app.click(`.tree-row[data-id="${page.id}"]`);
  await app.browser.waitUntil(() => app.browser.execute((id) => document.querySelector(`.cv-board[data-canvas="${id}"]`) != null, page.id), { timeout: 10000, timeoutMsg: "imported canvas opened" });
  await app.browser.waitUntil(async () => (await count(`.cv-board[data-canvas="${page.id}"] .cv-card`)) === 3, { timeoutMsg: "three cards" });
  assert.equal(await count(".cv-board .cv-group"), 1);
  assert.equal(await count(".cv-board .cv-edge"), 2);
  assert.equal(await count(".cv-board .cv-edge-arrow"), 1, "the second edge has no arrow");
  await app.waitText(".cv-group-label", /Go-live/);
  await app.waitText(".cv-card[data-kind=text] .cv-md", /Daten migrieren/);
  await app.waitText(".cv-card[data-kind=note] .cv-note-body", /Meilensteine/, 10000);
  await app.waitText(".cv-card[data-kind=link] .cv-link-url", /example\.com\/handbuch/);
  await app.waitText(".cv-edge-label", /plant/);
  const [colored, preset] = await app.browser.execute(() => [
    getComputedStyle(document.querySelector(".cv-card[data-kind=text]")).getPropertyValue("--cv-color").trim(),
    getComputedStyle(document.querySelector(".cv-board")).getPropertyValue("--cv-c2").trim(),
  ]);
  assert.equal(colored, preset, "preset color 2 follows the theme");
  await app.shot("130-canvas-obsidian-import");
  // Merely opening it changes nothing.
  await sleep(900);
  assert.equal((await app.invoke("page_get", { id: page.id })).content, text);
});
