// Graph view (1.9), German: the demo plus a realistic workspace of about 300 pages. Opens from
// the ribbon with every page, keyboard selection and a click open pages (Ctrl in a new tab),
// search focuses a node, tag and folder filters run in SQL, a color group shows in the legend
// and is stored, „Als Liste anzeigen“ lists the nodes, a save updates the graph in place, the
// local graph in the side panel follows the active page, PNG export at 2x, presets, and the
// layout cache makes reopening instant. Screenshots light and dark.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, guarded } from "../lib/harness.js";
import { realisticVault } from "../lib/graph-fixtures.js";
import { readPng } from "../lib/png.js";

const test = guarded(nodeTest, () => app);
let app, fx, out;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const canvasSel = ".graph-view .graph-canvas canvas";

async function reload() {
  await app.browser.execute(() => location.reload());
  await app.browser.pause(300);
  await app.browser.waitUntil(() => app.browser.execute(() => document.body.classList.contains("ready")), { timeout: 20000, timeoutMsg: "not ready after reload" });
}
const attr = (sel, a) => app.browser.execute((s, x) => document.querySelector(s)?.getAttribute(x), sel, a);
const num = async (sel, a) => Number(await attr(sel, a));
async function openGraph() {
  await app.click(".ribbon-graph");
  await app.waitFor(canvasSel, 20000);
}
async function settled(sel = canvasSel, timeout = 30000) {
  await app.browser.waitUntil(async () => (await attr(sel, "data-layout")) === "done", { timeout, timeoutMsg: `layout of ${sel} did not settle` });
}
const announced = () => app.browser.execute(() => document.querySelector(".graph-view .graph-canvas [aria-live]")?.textContent ?? "");
const activeTabTitle = () => app.browser.execute(() => document.querySelector(".pane.active .tabbar .tab.active")?.textContent?.trim() ?? "");
const tabCount = () => app.browser.execute(() => document.querySelectorAll(".pane.active .tabbar .tab").length);
async function graphNodes(filter) {
  const d = await app.invoke("graph_data", { filter });
  return d.nodes.length;
}
/** Keyboard: Home selects the most linked node and centers it. */
async function selectHub() {
  await app.browser.execute((s) => document.querySelector(s).focus(), canvasSel);
  await app.keys("Home");
  await app.browser.waitUntil(async () => (await announced()).length > 0, { timeoutMsg: "no node selected" });
  await sleep(450);
  return (await announced()).split(".")[0];
}

before(async () => {
  fx = fs.mkdtempSync(path.join(os.tmpdir(), "arcalo-graph-"));
  out = fs.mkdtempSync(path.join(os.tmpdir(), "arcalo-graph-out-"));
  const root = realisticVault(fx, "de");
  app = await launch();
  const report = await app.invoke("vault_import", { path: root });
  assert.ok(report.pages >= 250, `imported ${report.pages} pages`);
  // The side panel closed: the graph gets the room (the local graph test opens it again).
  await app.browser.execute(() => localStorage.setItem("arcalo.panel", "0"));
  await reload();
});

after(async () => {
  await app?.close();
  for (const d of [fx, out]) if (d) fs.rmSync(d, { recursive: true, force: true });
});

test("the graph opens from the ribbon with every page, light", async () => {
  await openGraph();
  const expected = await graphNodes({});
  assert.ok(expected > 250, `${expected} pages in the graph`);
  await app.browser.waitUntil(async () => (await num(canvasSel, "data-nodes")) === expected, { timeout: 20000, timeoutMsg: "node count" });
  assert.ok((await num(canvasSel, "data-edges")) > 350, "links drawn");
  await settled();
  await app.waitText(".graph-stats", /Seiten · .* Verknüpfungen/);
  // The folder colors are explained in the legend.
  await app.waitText(".graph-legend", /Projekte/);
  await app.shot("128-graph-light");
  const hub = await selectHub();
  assert.ok(hub.length > 2, `selected ${hub}`);
  await app.shot("128-graph-light-focus");
  assert.deepEqual(await app.consoleErrors(), []);
});

test("a click opens the page, Ctrl+click in a new tab", async () => {
  const hub = await selectHub();
  // The selected node is centered: a click in the middle hits it.
  await (await app.$(canvasSel)).click();
  await app.browser.waitUntil(async () => (await activeTabTitle()).includes(hub), { timeout: 8000, timeoutMsg: `page ${hub} not opened` });
  await openGraph();
  await settled();
  const tabs = await tabCount();
  await selectHub();
  await app.browser.execute((s) => {
    const c = document.querySelector(s);
    const r = c.getBoundingClientRect();
    const o = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, pointerId: 7, bubbles: true, ctrlKey: true };
    c.dispatchEvent(new PointerEvent("pointerdown", o));
    c.dispatchEvent(new PointerEvent("pointerup", o));
  }, canvasSel);
  await app.browser.waitUntil(async () => (await tabCount()) === tabs + 1, { timeout: 8000, timeoutMsg: "no new tab" });
  // Back to the graph's tab.
  const graphTab = await app.browser.execute(() => [...document.querySelectorAll(".pane.active .tabbar .tab")].findIndex((t) => /Graph/.test(t.textContent)));
  await (await app.$$(".pane.active .tabbar .tab"))[graphTab].click();
  await app.waitFor(canvasSel);
});

test("search highlights and focuses a node", async () => {
  const input = await app.$(".graph-search-input");
  await input.click();
  await app.type("Kundenportal Relaunch");
  await app.waitText(".graph-search-count", /\d+ Treffer/);
  await app.keys("Enter");
  await app.browser.waitUntil(async () => (await announced()).startsWith("Kundenportal Relaunch."), { timeoutMsg: "search did not focus the node" });
  await sleep(450);
  await app.shot("128-graph-search");
  await (await app.$(canvasSel)).click();
  await app.browser.waitUntil(async () => /^Kundenportal Relaunch/.test(await activeTabTitle()), { timeout: 8000, timeoutMsg: "searched page not opened" });
  await openGraph();
  await app.browser.execute(() => {
    const i = document.querySelector(".graph-search-input");
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    set.call(i, "");
    i.dispatchEvent(new Event("input", { bubbles: true }));
  });
});

test("tag and folder filters narrow the graph in SQL", async () => {
  await app.click(".graph-panel-toggle");
  await app.waitFor(".graph-panel");
  const kunden = await graphNodes({ tags: ["kunde"] });
  assert.ok(kunden >= 12, `${kunden} customer pages`);
  // The picker adds the tag and goes back to its placeholder.
  await app.select(".graph-tag-select", "kunde").catch((e) => {
    if (!/does not show/.test(e.message)) throw e;
  });
  await app.browser.waitUntil(async () => (await num(canvasSel, "data-nodes")) === kunden, { timeout: 8000, timeoutMsg: "tag filter" });
  await app.waitText(".graph-panel-toggle .graph-badge", /^1$/);
  // The chip removes it again.
  await app.click(".graph-chip");
  const all = await graphNodes({});
  await app.browser.waitUntil(async () => (await num(canvasSel, "data-nodes")) === all, { timeout: 8000, timeoutMsg: "tag filter removed" });

  const tree = await app.invoke("workspace_tree");
  const projekte = tree.find((p) => p.title === "Arbeit").children.find((p) => p.title === "Projekte");
  const inFolder = await graphNodes({ folder: projekte.id });
  assert.ok(inFolder >= 40 && inFolder < all, `${inFolder} pages below Projekte`);
  await app.select(".graph-folder-select", String(projekte.id));
  await app.browser.waitUntil(async () => (await num(canvasSel, "data-nodes")) === inFolder, { timeout: 8000, timeoutMsg: "folder filter" });
  await settled();
  await app.shot("128-graph-folder-filter");
});

test("a color group shows in the legend and is stored with the view", async () => {
  await app.click(".graph-add-group");
  const input = await app.waitFor(".graph-group-value");
  await input.click();
  await app.type("projekt");
  await app.waitText(".graph-legend", /#projekt/);
  await app.browser.waitUntil(
    async () => {
      const v = await app.invoke("graph_state_get", { key: "view" });
      return v?.groups?.[0]?.value === "projekt" && v.groups[0].kind === "tag";
    },
    { timeout: 5000, timeoutMsg: "group not stored" },
  );
});

test("presets keep filters and groups", async () => {
  const inFolder = await num(canvasSel, "data-nodes");
  const name = await app.$(".graph-preset-new input");
  await name.click();
  await app.type("Nur Projekte");
  await app.click(".graph-preset-new button[type=submit]");
  await app.waitText(".graph-preset-apply", /Nur Projekte/);
  await app.click(".graph-reset");
  await app.browser.waitUntil(async () => (await num(canvasSel, "data-nodes")) > inFolder, { timeout: 8000, timeoutMsg: "reset" });
  await app.click(".graph-preset-apply");
  await app.browser.waitUntil(async () => (await num(canvasSel, "data-nodes")) === inFolder, { timeout: 8000, timeoutMsg: "preset not applied" });
  const presets = await app.invoke("graph_state_get", { key: "presets" });
  assert.equal(presets.length, 1);
  assert.equal(presets[0].name, "Nur Projekte");
  // Back to everything, without the group.
  await app.click(".graph-reset");
  await app.click(".graph-group button[aria-label='Gruppe entfernen']");
  await app.browser.waitUntil(async () => (await num(canvasSel, "data-nodes")) === (await graphNodes({})), { timeout: 8000, timeoutMsg: "back to all" });
  await app.click(".graph-panel-head button");
});

test("a save updates the graph in place", async () => {
  const tree = await app.invoke("workspace_tree");
  const flat = (n) => n.flatMap((p) => [p, ...flat(p.children ?? [])]);
  const page = flat(tree).find((p) => p.title === "Wissensdatenbank");
  const edges = await num(canvasSel, "data-edges");
  const frames = await num(canvasSel, "data-frames");
  await app.invoke("page_save", { id: page.id, content: "Siehe [[Scrum]] und [[Docker]]." });
  await app.browser.execute((id) => window.dispatchEvent(new CustomEvent("arcalo:page-saved", { detail: { id } })), page.id);
  await app.browser.waitUntil(async () => (await num(canvasSel, "data-edges")) === edges + 2, { timeout: 8000, timeoutMsg: "edges not updated" });
  // The same canvas kept drawing: no reload of the view.
  assert.ok((await num(canvasSel, "data-frames")) > frames);
});

test("„Als Liste anzeigen“ lists the nodes and opens a page", async () => {
  const nodes = await num(canvasSel, "data-nodes");
  await app.click(".graph-list-toggle");
  await app.waitFor(".graph-list tbody tr");
  const rows = await app.browser.execute(() => document.querySelectorAll(".graph-list tbody tr").length);
  assert.equal(rows, Math.min(nodes, 300));
  await app.waitText(".graph-list", /Anna Berger/);
  await app.browser.execute(() => [...document.querySelectorAll(".graph-list-open")].find((b) => b.textContent === "Anna Berger").click());
  await app.browser.waitUntil(async () => /Anna Berger/.test(await activeTabTitle()), { timeout: 8000, timeoutMsg: "row did not open the page" });
});

test("the local graph follows the active page", async () => {
  await app.click(".ribbon button[aria-label^='Befehlspalette'], .ribbon button[aria-label^='Suchen']");
  await app.type("Lokalen Graph");
  await sleep(200);
  await app.keys("Enter");
  const local = ".local-graph canvas";
  await app.waitFor(local, 10000);
  await app.browser.waitUntil(async () => /Anna Berger/.test((await attr(local, "aria-label")) ?? ""), { timeout: 8000, timeoutMsg: "local graph of Anna Berger" });
  const n1 = await num(local, "data-nodes");
  assert.ok(n1 >= 2, `${n1} nodes around Anna Berger`);
  await settled(local);
  await app.shot("128-local-graph");
  // Another page: the local graph follows.
  await app.click(".ribbon button[aria-label^='Befehlspalette'], .ribbon button[aria-label^='Suchen']");
  await app.type("Kundenportal Relaunch");
  await sleep(400);
  await app.keys("Enter");
  await app.browser.waitUntil(async () => /Kundenportal Relaunch/.test((await attr(local, "aria-label")) ?? ""), { timeout: 8000, timeoutMsg: "local graph did not follow" });
  assert.notEqual(await num(local, "data-nodes"), n1);
  // Depth 2 brings more.
  const d1 = await num(local, "data-nodes");
  await app.browser.execute(() => [...document.querySelectorAll(".local-graph .segmented button")][1].click());
  await app.browser.waitUntil(async () => (await num(local, "data-nodes")) > d1, { timeout: 8000, timeoutMsg: "depth 2" });
});

test("PNG export of the current view at 2x", async () => {
  await openGraph();
  await settled();
  const width = await app.browser.execute((s) => document.querySelector(s).getBoundingClientRect().width, canvasSel);
  const file = path.join(out, "graph.png");
  await app.browser.execute((p) => window.dispatchEvent(new CustomEvent("arcalo:graph-export", { detail: { path: p } })), file);
  await app.browser.waitUntil(() => fs.existsSync(file) && fs.statSync(file).size > 10000, { timeout: 15000, timeoutMsg: "no PNG written" });
  await sleep(300);
  const png = readPng(fs.readFileSync(file));
  assert.equal(png.width, Math.round(width * 2));
});

test("reopening uses the layout cache; dark", async () => {
  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", { settings: { ...view.settings, theme: "dark" } });
  await reload();
  const t0 = Date.now();
  await openGraph();
  await app.browser.waitUntil(async () => (await num(canvasSel, "data-frames")) > 0 && (await num(canvasSel, "data-nodes")) > 250, { timeout: 10000, timeoutMsg: "no frame" });
  await settled(canvasSel, 4000);
  assert.ok(Date.now() - t0 < 4000, `reopened in ${Date.now() - t0} ms`);
  const layout = await app.invoke("graph_state_get", { key: "layout" });
  assert.ok(Object.keys(layout.pos).length > 250, "layout stored");
  await app.shot("128-graph-dark");
  await selectHub();
  await app.shot("128-graph-dark-focus");
  assert.deepEqual(await app.consoleErrors(), []);
});
