// Canvas (1.9), English: a realistic project-planning board (an SAP S/4HANA rollout along the SAP
// Activate phases, with notes, a Mermaid cutover plan, Jira issues from a fake Jira, links and
// labelled connections) for the marketing screenshots, light and dark; no German on the board;
// the slash menu creates a linked canvas; and a board of 300 cards stays smooth (culling, pan
// and zoom frame times).
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { guarded } from "../lib/harness.js";
import { launchEnglish, germanLeftovers } from "../lib/english.js";
import { startFakeJira } from "../lib/fake-jira.js";

const test = guarded(nodeTest, () => app);
let app, dataDir, jira, board;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function reload() {
  await app.browser.execute(() => location.reload());
  await app.browser.pause(300);
  await app.browser.waitUntil(() => app.browser.execute(() => document.body.classList.contains("ready")), { timeout: 20000, timeoutMsg: "not ready after reload" });
}
const count = (sel) => app.browser.execute((s) => document.querySelectorAll(s).length, sel);
async function setTheme(theme) {
  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", { settings: { ...view.settings, theme } });
  await app.browser.waitUntil(() => app.browser.execute((t) => document.documentElement.dataset.theme === t, theme), { timeoutMsg: `theme ${theme}` });
  await sleep(400);
}
/** Explore to Deploy at 78 %: the view is stored per page, the reload opens the tab with it. */
async function detailView() {
  await app.browser.execute((id) => localStorage.setItem("arcalo.canvas-view", JSON.stringify({ [id]: { zoom: 0.78, x: 16 - 560 * 0.78, y: 70 } })), board.id);
  await reload();
  await app.waitFor(`.cv-board[data-canvas="${board.id}"]`);
  await app.browser.waitUntil(() => app.browser.execute(() => !!document.querySelector(".cv-card[data-kind=note] .mmd-view svg")), { timeout: 15000, timeoutMsg: "diagram after reload" });
  await sleep(1500);
}
async function openPage(id) {
  await app.browser.waitUntil(() => app.browser.execute((i) => document.querySelector(`.tree-row[data-id="${i}"]`) != null, id), { timeoutMsg: "page in the tree" });
  await app.click(`.tree-row[data-id="${id}"]`);
  await app.browser.waitUntil(() => app.browser.execute((i) => document.querySelector(`.cv-board[data-canvas="${i}"]`) != null, id), { timeoutMsg: "canvas opened" });
}

const ISSUES = [
  { key: "SAP-97", summary: "Sandbox system provisioned and client copied", type: "Task", status: "Done", category: "done", priority: "Medium", assignee: "Lena Fischer", project: "SAP", projectName: "S/4HANA Rollout", due: null, sprint: "", description: "" },
  { key: "SAP-101", summary: "Configure company codes and chart of accounts", type: "Story", status: "In Progress", category: "indeterminate", priority: "High", assignee: "Mia Meyer", project: "SAP", projectName: "S/4HANA Rollout", due: null, sprint: "Sprint 7", description: "" },
  { key: "SAP-114", summary: "Migrate material master data (42,000 records)", type: "Story", status: "To Do", category: "new", priority: "High", assignee: "Jonas Weber", project: "SAP", projectName: "S/4HANA Rollout", due: null, sprint: "Sprint 8", description: "" },
  { key: "SAP-120", summary: "Cutover rehearsal 2 with full data load", type: "Task", status: "To Do", category: "new", priority: "Highest", assignee: "Mia Meyer", project: "SAP", projectName: "S/4HANA Rollout", due: null, sprint: "Sprint 9", description: "" },
  { key: "SAP-126", summary: "EDI interface to logistics partner fails on ORDERS05", type: "Bug", status: "In Review", category: "indeterminate", priority: "High", assignee: "Tom Becker", project: "SAP", projectName: "S/4HANA Rollout", due: null, sprint: "Sprint 8", description: "" },
];

const NOTES = {
  "Fit-to-Standard Workshops": "Results of the workshops with the process owners.\n\n- **Finance:** 14 of 18 processes fit the standard\n- **Procurement:** 3 gaps logged, 2 resolved by configuration\n- **Sales:** pricing procedure needs one extension\n\n> [!note] Sign-off\n> Process owners sign off on **Oct 17**.",
  "Data Migration Strategy": "Objects, volumes and tools of the migration.\n\n| Object | Records | Tool |\n|---|---|---|\n| Customers | 8,400 | Migration Cockpit |\n| Materials | 42,000 | Migration Cockpit |\n| Open items | 3,150 | LTMC file |\n\nTwo full test loads before the cutover.",
  "Cutover Plan": "Cutover weekend, Nov 6 to 9.\n\n```mermaid\nflowchart TD\n  A[Freeze legacy system] --> B[Final data load]\n  B --> C{Reconciliation OK?}\n  C -- yes --> D[Go-live]\n  C -- no --> E[Fallback to legacy]\n```",
};

function rolloutCanvas(paths, url) {
  const issue = (id, key, x, y, color) => ({ id, type: "link", url: `${url}/browse/${key}`, issue: key, x, y, width: 400, height: 112, ...(color ? { color } : {}) });
  const group = (id, label, x, color) => ({ id, type: "group", label, x, y: 0, width: 480, height: 940, color });
  return {
    nodes: [
      group("g1", "1 · Prepare", 0, "5"),
      group("g2", "2 · Explore", 560, "6"),
      group("g3", "3 · Realize", 1120, "4"),
      group("g4", "4 · Deploy", 1680, "2"),
      { id: "title", type: "text", text: "# SAP S/4HANA Rollout\nFinance, Procurement and Sales for three company codes. Go-live **Nov 9, 2026**.", x: 0, y: -260, width: 760, height: 150 },
      { id: "charter", type: "text", text: "## Project charter\n- Scope: FI, MM, SD in 3 company codes\n- Steering committee every second Thursday\n- Budget: 2,400 person days", x: 40, y: 60, width: 400, height: 200 },
      issue("i97", "SAP-97", 40, 300),
      { id: "roadmap", type: "link", url: "https://go.support.sap.com/roadmapviewer/", title: "SAP Activate Roadmap Viewer", x: 40, y: 450, width: 400, height: 96 },
      { id: "team", type: "text", text: "### Core team\nLena (PM) · Mia (Finance) · Jonas (Data) · Tom (Integration)", x: 40, y: 590, width: 400, height: 130, color: "5" },
      { id: "fts", type: "file", file: paths["Fit-to-Standard Workshops"], x: 600, y: 60, width: 400, height: 380 },
      issue("i101", "SAP-101", 600, 480),
      { id: "gaps", type: "text", text: "**3 gaps** go to the backlog as RICEFW objects", x: 600, y: 640, width: 400, height: 90, color: "6" },
      { id: "dms", type: "file", file: paths["Data Migration Strategy"], x: 1160, y: 60, width: 400, height: 330 },
      issue("i114", "SAP-114", 1160, 430),
      issue("i126", "SAP-126", 1160, 580),
      { id: "tests", type: "text", text: "### Integration tests\n- [x] Bank interface (EBICS)\n- [x] Tax engine\n- [ ] EDI with logistics partner", x: 1160, y: 730, width: 400, height: 170, color: "4" },
      { id: "cut", type: "file", file: paths["Cutover Plan"], x: 1720, y: 60, width: 400, height: 400 },
      issue("i120", "SAP-120", 1720, 480),
      { id: "gonogo", type: "text", text: "## Go / No-Go\nNov 6, 10:00 · Steering committee", x: 1720, y: 640, width: 400, height: 120, color: "1" },
    ],
    edges: [
      { id: "e1", fromNode: "charter", fromSide: "right", toNode: "fts", toSide: "left", label: "kick-off" },
      { id: "e2", fromNode: "gaps", fromSide: "right", toNode: "dms", toSide: "left", label: "gaps to backlog", color: "6" },
      { id: "e3", fromNode: "i114", fromSide: "right", toNode: "i120", toSide: "left", label: "blocks", color: "1", path: "straight" },
      { id: "e4", fromNode: "tests", fromSide: "right", toNode: "gonogo", toSide: "left", label: "ready for cutover", color: "4" },
      { id: "e5", fromNode: "gonogo", fromSide: "top", toNode: "i120", toSide: "bottom" },
      { id: "e6", fromNode: "i101", fromSide: "bottom", toNode: "gaps", toSide: "top", toEnd: "none" },
    ],
  };
}

before(async () => {
  jira = await startFakeJira({ flavor: "cloud", issues: ISSUES });
  ({ app, dataDir } = await launchEnglish({ width: 1600, height: 1000, env: { ARCALO_JIRA_DELAY_SECS: "600" } }));
  await app.invoke("jira_site_save", {
    site: { id: "", name: "Acme", color: "", kind: "cloud", url: jira.url, email: "mia@firma.de", enabled: true, log_work: false, allow_writes: false },
    token: "secret-token",
  });
  await app.invoke("jira_sync_now", { site: "acme" });
  const folder = await app.invoke("page_create", { title: "SAP Rollout", parentId: null, icon: "briefcase" });
  const paths = {};
  for (const [title, content] of Object.entries(NOTES)) {
    const p = await app.invoke("page_create", { title, parentId: folder.id, icon: "file-text" });
    await app.invoke("page_save", { id: p.id, content });
    paths[title] = await app.invoke("canvas_note_path", { pageId: p.id });
  }
  board = await app.invoke("canvas_create", { parentId: folder.id, title: "Rollout Roadmap" });
  await app.invoke("page_save", { id: board.id, content: JSON.stringify(rolloutCanvas(paths, jira.url), null, "\t") });
  // The side panel closed: the board gets the room.
  await app.browser.execute(() => localStorage.setItem("arcalo.panel", "0"));
  await reload();
});
after(async () => {
  await app?.close();
  await jira?.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("the rollout board shows notes, the Mermaid plan, Jira issues and connections (light)", async () => {
  await setTheme("light");
  await openPage(board.id);
  await app.browser.waitUntil(async () => (await count(".cv-card")) === 15, { timeoutMsg: "15 cards" });
  assert.equal(await count(".cv-group"), 4);
  assert.equal(await count(".cv-edge"), 6);
  await app.waitText(".cv-card[data-kind=issue] .cv-issue-summary", /Configure company codes/);
  await app.waitText(".cv-card[data-kind=issue] .cv-issue-status", /In Progress/);
  // Issues outside the cache (not assigned to me) are fetched for their cards.
  await app.waitText(".cv-card[data-kind=issue] .cv-issue-summary", /Migrate material master/, 10000);
  await app.waitText(".cv-card[data-kind=issue] .cv-issue-status", /Done/, 10000);
  await app.waitText(".cv-card[data-kind=note] .cv-note-body", /Process owners sign off/, 10000);
  await app.browser.waitUntil(() => app.browser.execute(() => !!document.querySelector(".cv-card[data-kind=note] .rich-mermaid svg, .cv-card[data-kind=note] .mmd-view svg")), { timeout: 15000, timeoutMsg: "Mermaid plan rendered" });
  await app.browser.execute(() => document.querySelector(".cv-board").focus());
  await app.keys(["Shift", "!"]);
  await sleep(1200);
  const leftovers = await germanLeftovers(app, [/Steering/]);
  assert.deepEqual(leftovers, []);
  await app.shot("131-canvas-rollout-light");
  // Closer: Explore, Realize and Deploy.
  await detailView();
  await app.shot("131-canvas-rollout-detail-light");
});

test("the same board in dark", async () => {
  await setTheme("dark");
  await app.browser.execute(() => document.querySelector(".cv-board").focus());
  await app.keys(["Shift", "!"]);
  await sleep(1500);
  await app.shot("131-canvas-rollout-dark");
  await detailView();
  await app.shot("131-canvas-rollout-detail-dark");
});

test("/canvas in a note creates a linked canvas below it", async () => {
  const p = await app.invoke("page_create", { title: "Kickoff notes", parentId: null });
  await reload();
  await app.click(`.tree-row[data-id="${p.id}"]`);
  await app.caretToEnd();
  await app.type("/canvas");
  await app.waitText(".sugg-item.sel", /Canvas/);
  await app.keys(["Enter"]);
  // Shown next to the note (the board left in the note's tab stays mounted there, hidden).
  await app.browser.waitUntil(
    () =>
      app.browser.execute(() => {
        const boards = [...document.querySelectorAll(".pane > .pane-content:not([hidden]) .cv-board")];
        const note = [...document.querySelectorAll(".pane > .pane-content:not([hidden]) .page-title")].find((t) => t.value === "Kickoff notes")?.closest(".pane");
        return boards.length === 1 && !!note && boards[0].closest(".pane") !== note;
      }),
    { timeoutMsg: "canvas opened next to the note" },
  );
  const tree = await app.invoke("workspace_tree");
  const flat = tree.flatMap(function f(n) { return [n, ...n.children.flatMap(f)]; });
  const created = flat.find((n) => n.parent_id === p.id && n.kind === "canvas");
  assert.equal(created?.title, "Untitled canvas");
  await app.browser.waitUntil(async () => (await app.invoke("page_get", { id: p.id })).content.includes("[[Untitled canvas]]"), { timeoutMsg: "link inserted" });
  await app.keys(["Control", "w"]);
});

test("300 cards: culled when zoomed in, pan and zoom stay smooth", async () => {
  const nodes = [];
  const edges = [];
  for (let i = 0; i < 300; i++) {
    const x = (i % 20) * 320;
    const y = Math.floor(i / 20) * 220;
    nodes.push({ id: `n${i}`, type: "text", text: `### Card ${i + 1}\nTask ${i % 7 === 0 ? "**blocked**" : "on track"} · sprint ${1 + (i % 9)}`, x, y, width: 280, height: 160, ...(i % 11 === 0 ? { color: String(1 + (i % 6)) } : {}) });
    if (i % 20 !== 19) edges.push({ id: `e${i}`, fromNode: `n${i}`, fromSide: "right", toNode: `n${i + 1}`, toSide: "left" });
  }
  const big = await app.invoke("canvas_create", { parentId: null, title: "Large board" });
  await app.invoke("page_save", { id: big.id, content: JSON.stringify({ nodes, edges }) });
  await app.browser.execute((id) => localStorage.setItem("arcalo.canvas-view", JSON.stringify({ [id]: { zoom: 1, x: 40, y: 40 } })), big.id);
  await reload();
  const t0 = Date.now();
  await openPage(big.id);
  await app.browser.waitUntil(async () => (await count(".cv-card .cv-md h3")) > 10, { timeout: 15000, timeoutMsg: "cards rendered" });
  const openMs = Date.now() - t0;
  const shown = await count(".cv-card");
  assert.ok(shown > 10 && shown < 120, `only cards near the view are rendered (${shown})`);
  const frames = await app.browser.executeAsync((done) => {
    const b = document.querySelector(".cv-board");
    const times = [];
    let i = 0;
    let last = performance.now();
    const step = () => {
      const now = performance.now();
      if (i > 0) times.push(now - last);
      last = now;
      if (i++ >= 40) return done(times);
      b.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaX: 60, deltaY: 40, clientX: 500, clientY: 400 }));
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
  const idle = await app.browser.executeAsync((done) => {
    const times = [];
    let last = performance.now();
    const step = () => {
      const now = performance.now();
      times.push(now - last);
      last = now;
      if (times.length < 30) requestAnimationFrame(step);
      else done(times.slice(1));
    };
    requestAnimationFrame(step);
  });
  const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const avg = median(frames);
  const base = median(idle);
  // Fit: all 300 cards and 285 edges at once.
  await app.browser.execute(() => document.querySelector(".cv-board").focus());
  const fitMs = await app.browser.executeAsync((done) => {
    const t = performance.now();
    document.querySelector(".cv-board").dispatchEvent(new KeyboardEvent("keydown", { key: "!", shiftKey: true, bubbles: true }));
    requestAnimationFrame(() => requestAnimationFrame(() => done(performance.now() - t)));
  });
  await app.browser.waitUntil(async () => (await count(".cv-card")) === 300, { timeout: 15000, timeoutMsg: "all cards when fitted" });
  assert.equal(await count(".cv-edge"), 285);
  console.log(`canvas 300: open ${openMs} ms, pan frame median ${avg.toFixed(1)} ms (idle ${base.toFixed(1)} ms), fit ${fitMs.toFixed(0)} ms`);
  // Debug build under Xvfb (software rendering): a frame with a pan step stays close to an idle one.
  assert.ok(avg < 100, `pan frames ${avg.toFixed(1)} ms`);
  assert.ok(fitMs < 1500, `fit ${fitMs.toFixed(0)} ms`);
  await app.shot("131-canvas-300");
});
