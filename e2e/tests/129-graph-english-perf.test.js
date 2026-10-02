// Graph view (1.9), English: the realistic workspace in English (light and dark screenshots,
// no German left in the view and its panel, the local graph), then 5,000 generated pages with
// about 20,000 links: the first frame comes in under two seconds in the debug build and the
// view stays interactive (frames keep coming, zoom answers) while the layout runs in a worker.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { guarded } from "../lib/harness.js";
import { germanLeftovers, launchEnglish } from "../lib/english.js";
import { largeVault, realisticVault } from "../lib/graph-fixtures.js";

const test = guarded(nodeTest, () => app);
let app, dataDir, fx, big;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const canvasSel = ".graph-view .graph-canvas canvas";

async function reload() {
  await app.browser.execute(() => location.reload());
  await app.browser.pause(300);
  await app.browser.waitUntil(() => app.browser.execute(() => document.body.classList.contains("ready")), { timeout: 20000, timeoutMsg: "not ready after reload" });
}
const attr = (sel, a) => app.browser.execute((s, x) => document.querySelector(s)?.getAttribute(x), sel, a);
const num = async (sel, a) => Number(await attr(sel, a));
async function settled(sel = canvasSel, timeout = 30000) {
  await app.browser.waitUntil(async () => (await attr(sel, "data-layout")) === "done", { timeout, timeoutMsg: `layout of ${sel} did not settle` });
}
async function selectHub() {
  await app.browser.execute((s) => document.querySelector(s).focus(), canvasSel);
  await app.keys("Home");
  await app.browser.waitUntil(async () => app.browser.execute(() => !!document.querySelector(".graph-view .graph-canvas [aria-live]")?.textContent), { timeoutMsg: "no node selected" });
  await sleep(450);
}

before(async () => {
  fx = fs.mkdtempSync(path.join(os.tmpdir(), "annalo-graph-en-"));
  big = fs.mkdtempSync(path.join(os.tmpdir(), "annalo-graph-big-"));
  const root = realisticVault(fx, "en");
  ({ app, dataDir } = await launchEnglish());
  const report = await app.invoke("vault_import", { path: root });
  assert.ok(report.pages >= 250, `imported ${report.pages} pages`);
  await app.browser.execute(() => localStorage.setItem("annalo.panel", "0"));
  await reload();
});

after(async () => {
  await app?.close();
  for (const d of [fx, big, dataDir]) if (d) fs.rmSync(d, { recursive: true, force: true });
});

test("the graph in English, light and dark, without German", async () => {
  await app.click(".ribbon-graph");
  await app.waitFor(canvasSel, 20000);
  await app.browser.waitUntil(async () => (await num(canvasSel, "data-nodes")) > 250, { timeout: 20000, timeoutMsg: "nodes" });
  await settled();
  await app.waitText(".graph-stats", /pages · .* links/);
  await app.shot("129-graph-en-light");
  await selectHub();
  await app.shot("129-graph-en-light-focus");
  await app.click(".graph-panel-toggle");
  await app.waitFor(".graph-panel");
  // Page titles of the workspace may be anything; the view's own text must be English.
  const left = await germanLeftovers(app, [/Krüger|Möller|König/]);
  assert.deepEqual(left, []);
  await app.shot("129-graph-en-panel");
  await app.click(".graph-panel-head button");

  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", { settings: { ...view.settings, theme: "dark" } });
  await reload();
  await app.waitFor(canvasSel, 20000);
  await settled(canvasSel, 5000);
  await app.shot("129-graph-en-dark");
  await selectHub();
  await app.shot("129-graph-en-dark-focus");
  // The local graph of the selected hub, dark.
  await app.keys("Enter");
  await app.click(".ribbon button[aria-label^='Command palette']");
  await app.type("Show local graph");
  await sleep(200);
  await app.keys("Enter");
  await app.waitFor(".local-graph canvas", 10000);
  await settled(".local-graph canvas");
  await app.shot("129-local-graph-en-dark");
  assert.deepEqual(await app.consoleErrors(), []);
});

test("5,000 pages: first frame under 2 s, stays interactive", async () => {
  const { root, pages, links } = largeVault(big, 5000, "en");
  assert.ok(links >= 18000, `${links} links generated`);
  const report = await app.invoke("vault_import", { path: root });
  assert.ok(report.pages >= pages, `imported ${report.pages}`);
  // Fresh start of the view without a cached layout for the new pages.
  await reload();
  await app.browser.execute(() => [...document.querySelectorAll(".pane.active .tabbar .tab")].length);
  const t0 = await app.browser.execute(() => {
    window.__graphT0 = performance.now();
    document.querySelector(".ribbon-graph").click();
    return window.__graphT0;
  });
  // Time to the first drawn frame with all nodes, measured in the page.
  const first = await app.browser.executeAsync((start, done) => {
    const check = () => {
      const c = document.querySelector(".graph-view .graph-canvas canvas");
      if (c && Number(c.dataset.frames) > 0 && Number(c.getAttribute("data-nodes")) >= 5000) done(performance.now() - start);
      else if (performance.now() - start > 20000) done(-1);
      else requestAnimationFrame(check);
    };
    check();
  }, t0);
  assert.ok(first > 0, "no first frame");
  assert.ok(first < 2000, `first frame after ${Math.round(first)} ms`);
  const edges = await num(canvasSel, "data-edges");
  assert.ok(edges >= 18000, `${edges} edges`);

  // Interactive while the layout runs: the main thread keeps drawing frames quickly.
  const gaps = await app.browser.executeAsync((done) => {
    const out = [];
    let last = performance.now();
    const c = document.querySelector(".graph-view .graph-canvas canvas");
    const r = c.getBoundingClientRect();
    let n = 0;
    const step = (t) => {
      out.push(t - last);
      last = t;
      // Zoom with the wheel every few frames, like a user would.
      if (n++ % 10 === 0) c.dispatchEvent(new WheelEvent("wheel", { deltaY: n % 20 ? -100 : 100, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true }));
      if (out.length < 60) requestAnimationFrame(step);
      else done(out.slice(2));
    };
    requestAnimationFrame(step);
  });
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  assert.ok(median < 120, `median frame gap ${Math.round(median)} ms`);
  const framesBefore = await num(canvasSel, "data-frames");
  await app.browser.execute((s) => document.querySelector(s).focus(), canvasSel);
  await app.keys("+");
  await app.browser.waitUntil(async () => (await num(canvasSel, "data-frames")) > framesBefore, { timeout: 2000, timeoutMsg: "zoom did not redraw" });
  await settled(canvasSel, 60000);
  await app.keys("0");
  await sleep(500);
  await app.shot("129-graph-5k");
});
