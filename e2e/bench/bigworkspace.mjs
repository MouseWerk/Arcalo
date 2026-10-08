// UI benchmark on the large workspace (docs/performance.md). From the e2e folder, after
// `npm --prefix ../ui run build` and a `cargo build -p arcalo --features custom-protocol`:
//   ARCALO_APP=$PWD/../target/debug/arcalo node bench/bigworkspace.mjs [label]
// Writes <label>.json to BENCH_OUT (default: the system temp folder) and prints a summary.
// PERF_LOOP_MIN sets the minutes of the usage loop (memory and leaks, default 3).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

const E2E = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const { launch } = await import(path.join(E2E, "lib/harness.js"));
const { bigWorkspace } = await import(path.join(E2E, "lib/bigworkspace.js"));
const label = process.argv[2] ?? "run";
const LOOP_MIN = Number(process.env.PERF_LOOP_MIN ?? 3);
const out = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : -1; };
const p95 = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] : -1; };
const r1 = (x) => Math.round(x * 10) / 10;

const dataDir = bigWorkspace();
const W = (id, kind, x, y, w, h, config = {}) => ({ id, kind, x, y, w, h, config });

function rssKb() {
  // The app process and its WebKit children (by parent PID).
  const rows = execSync("ps -eo pid=,ppid=,rss=,args=").toString().trim().split("\n").map((l) => l.trim().split(/\s+/));
  const app = rows.find((r) => r.slice(3).join(" ").startsWith(process.env.ARCALO_APP));
  if (!app) return -1;
  const ids = new Set([app[0]]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const r of rows) if (ids.has(r[1]) && !ids.has(r[0])) (ids.add(r[0]), (grew = true));
  }
  return rows.filter((r) => ids.has(r[0])).reduce((s, r) => s + Number(r[2]), 0);
}

async function startTimes(app, spawnedAt) {
  return app.browser.execute((spawned) => {
    const nav = performance.getEntriesByType("navigation")[0];
    const paint = Object.fromEntries(performance.getEntriesByType("paint").map((p) => [p.name, p.startTime]));
    const ready = performance.getEntriesByName("arcalo-ready")[0]?.startTime ?? -1;
    return {
      domContentLoaded: nav?.domContentLoadedEventEnd ?? -1,
      load: nav?.loadEventEnd ?? -1,
      firstPaint: paint["first-paint"] ?? -1,
      firstContentfulPaint: paint["first-contentful-paint"] ?? -1,
      ready,
      spawnToReady: ready > 0 ? performance.timeOrigin + ready - spawned : -1,
      entryTypes: PerformanceObserver.supportedEntryTypes,
    };
  }, spawnedAt);
}

/** Instruments IPC, intervals and listeners from now on. */
async function instrument(app) {
  await app.browser.execute(() => {
    if (window.__perf) return;
    const p = (window.__perf = { calls: [], intervals: 0, listeners: 0, longtasks: [] });
    // IPC goes through fetch (ipc:// or http://ipc.localhost/<cmd>).
    const orig = window.fetch.bind(window);
    window.fetch = (url, init) => {
      const u = String(url);
      if (!/^(ipc:|http:\/\/ipc\.)/.test(u)) return orig(url, init);
      const cmd = decodeURIComponent(u.replace(/^.*localhost\//, "").split("?")[0]);
      const t0 = performance.now();
      const argBytes = typeof init?.body === "string" ? init.body.length : init?.body?.byteLength ?? 0;
      return orig(url, init).then((r) => {
        const rec = { cmd, ms: performance.now() - t0, bytes: Number(r.headers.get("content-length") ?? -1), argBytes };
        p.calls.push(rec);
        if (rec.bytes < 0) r.clone().arrayBuffer().then((b) => (rec.bytes = b.byteLength), () => {});
        if (p.calls.length > 20000) p.calls.shift();
        return r;
      });
    };
    const si = window.setInterval, ci = window.clearInterval;
    const live = new Set();
    window.setInterval = (...a) => { const id = si(...a); live.add(id); p.intervals = live.size; return id; };
    window.clearInterval = (id) => { live.delete(id); p.intervals = live.size; return ci(id); };
    const add = EventTarget.prototype.addEventListener, rem = EventTarget.prototype.removeEventListener;
    EventTarget.prototype.addEventListener = function (...a) { p.listeners++; return add.apply(this, a); };
    EventTarget.prototype.removeEventListener = function (...a) { p.listeners--; return rem.apply(this, a); };
    try {
      new PerformanceObserver((l) => l.getEntries().forEach((e) => p.longtasks.push(e.duration))).observe({ type: "longtask", buffered: true });
    } catch {}
  });
}

/** Runs an action in the page and returns the ms until `cond` holds and the next frame is painted. */
function timed(app, action, cond, timeout = 60000) {
  return app.browser.executeAsync(
    (action, cond, timeout, done) => {
      const ok = () => {
        const els = [...document.querySelectorAll(cond.sel)];
        if (cond.text) return els.some((e) => e.textContent.includes(cond.text));
        if (cond.value) return els.some((e) => e.value === cond.value);
        if (cond.none) return els.length === 0;
        return els.length >= (cond.min ?? 1);
      };
      const t0 = performance.now();
      if (action.click) document.querySelector(action.click).click();
      if (action.invoke) window.__TAURI_INTERNALS__.invoke(action.invoke[0], action.invoke[1]);
      if (action.key) document.dispatchEvent(new KeyboardEvent("keydown", { key: action.key, ctrlKey: !!action.ctrl, bubbles: true }));
      const check = () => {
        if (ok()) requestAnimationFrame(() => setTimeout(() => done(performance.now() - t0), 0));
        else if (performance.now() - t0 > timeout) done(-1);
        else requestAnimationFrame(check);
      };
      check();
    },
    action,
    cond,
    timeout,
  );
}

/** Frame times while scrolling `sel` (or wheeling over it) for `n` frames. */
function frames(app, sel, n, mode, delta) {
  return app.browser.executeAsync(
    (sel, n, mode, delta, done) => {
      const el = document.querySelector(sel);
      if (!el) return done(null);
      const r = el.getBoundingClientRect();
      const out = [];
      let last = performance.now();
      let i = 0;
      const step = (t) => {
        out.push(t - last);
        last = t;
        if (mode === "scroll") el.scrollTop += delta;
        else el.dispatchEvent(new WheelEvent("wheel", { deltaX: delta, deltaY: delta / 2, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true }));
        if (++i < n) requestAnimationFrame(step);
        else done(out.slice(2));
      };
      requestAnimationFrame(step);
    },
    sel,
    n,
    mode,
    delta,
  );
}
const frameStats = (f) => (f ? { avg: r1(f.reduce((a, b) => a + b, 0) / f.length), p95: r1(p95(f)), max: r1(Math.max(...f)), over50: f.filter((x) => x > 50).length } : null);

async function openPage(app, id, title, extra = {}) {
  return timed(app, { invoke: ["search_open", { target: { kind: "page", page_id: id, new_tab: false, ...extra } }] }, { sel: ".pane.active .page-title", value: title });
}

const ids = {};
async function lookup(app) {
  const tree = await app.invoke("workspace_tree");
  const flat = [];
  const walk = (ns) => ns.forEach((n) => (flat.push(n.page ?? n), walk(n.children ?? [])));
  walk(tree);
  const by = (t) => flat.find((p) => p.title === t);
  ids.big = by("Großes Dokument");
  ids.canvas = by("Große Leinwand");
  ids.small = ["0101", "0202", "0303", "0404", "0505"].map((n) => flat.find((p) => p.title.startsWith(`Seite ${n} `)));
  out.treeNodes = flat.length;
}

// ---------------------------------------------------------------- cold start
let t = Date.now();
let app = await launch({ demo: false, dataDir, width: 1480, height: 920 });
await app.browser.setTimeout({ script: 300_000 });
out.coldStart = await startTimes(app, t);
await sleep(1500);
try {
await instrument(app);
await lookup(app);

// ---------------------------------------------------------------- sidebar
out.sidebar = await app.browser.execute(() => ({ rows: document.querySelectorAll(".sidebar .tree [role=treeitem]").length, virtual: !!document.querySelector(".sidebar .tree.is-virtual") }));
// Expand all top folders by keyboard is slow; scroll whatever the tree has.
out.sidebarScroll = frameStats(await frames(app, ".sidebar .tree", 60, "scroll", 120));

// ---------------------------------------------------------------- large page + typing
out.openLarge = [];
for (let i = 0; i < 3; i++) {
  await openPage(app, ids.small[0].id, ids.small[0].title);
  await sleep(300);
  out.openLarge.push(r1(await openPage(app, ids.big.id, ids.big.title)));
  await app.waitText(".pane.active .ProseMirror", /Kapitel 40/, 60000);
}
const embedsShown = await app.browser.execute(() => ({ mermaid: document.querySelectorAll(".pane.active .ProseMirror svg").length, tables: document.querySelectorAll(".pane.active .ProseMirror table").length }));
out.largeContent = embedsShown;
// Caret in the middle of the long page, then type.
await app.browser.execute(() => {
  const ed = document.querySelector(".pane.active .ProseMirror").editor;
  let pos = null;
  ed.state.doc.descendants((n, p) => {
    if (pos == null && n.isTextblock && n.textContent.length > 100 && p > ed.state.doc.content.size / 2) pos = p + n.nodeSize - 1;
    return pos == null;
  });
  ed.chain().focus().setTextSelection(pos).scrollIntoView().run();
  window.__lat = [];
  document.addEventListener("keydown", (e) => {
    const t0 = performance.now();
    requestAnimationFrame(() => setTimeout(() => window.__lat.push(performance.now() - t0), 0));
  }, true);
});
await sleep(500);
await app.browser.execute(() => (window.__perf.calls.length = 0));
const typeStart = Date.now();
for (const ch of " Messung der Tippverzoegerung im langen Dokument") {
  await app.browser.keys(ch);
}
const lat = await app.browser.execute(() => window.__lat);
out.typingLarge = { median: r1(med(lat)), p95: r1(p95(lat)), max: r1(Math.max(...lat)), n: lat.length };
await app.browser.waitUntil(async () => (await app.browser.execute(() => window.__perf.calls.some((c) => c.cmd === "page_save"))), { timeout: 15000 }).catch(() => {});
await sleep(1500);
const saves = await app.browser.execute(() => window.__perf.calls.filter((c) => c.cmd === "page_save").map((c) => c.ms));
out.saveLarge = { calls: saves.length, ms: saves.map(r1), typedForMs: Date.now() - typeStart };

// ---------------------------------------------------------------- page switching
out.switchPage = [];
for (let i = 0; i < 10; i++) {
  const p = ids.small[i % ids.small.length];
  out.switchPage.push(r1(await openPage(app, p.id, p.title)));
}
// Typing in a normal page.
await app.caretToEnd();
await app.browser.execute(() => (window.__lat = []));
for (const ch of " kurze Notiz mit Text") await app.browser.keys(ch);
const lat2 = await app.browser.execute(() => window.__lat);
out.typingSmall = { median: r1(med(lat2)), p95: r1(p95(lat2)), max: r1(Math.max(...lat2)) };

// ---------------------------------------------------------------- tabs
for (const p of ids.small.slice(0, 4)) {
  await app.keys(["Control", "t"]);
  await sleep(400);
  await openPage(app, p.id, p.title);
}
await sleep(1000);
out.switchTab = [];
for (let i = 0; i < 8; i++) {
  const ms = await app.browser.executeAsync((i, done) => {
    const tabs = [...document.querySelectorAll(".tabbar .tab")];
    const tab = tabs.filter((t) => !t.classList.contains("active"))[i % Math.max(1, tabs.length - 1)];
    if (!tab) return done(-tabs.length - 1);
    const t0 = performance.now();
    tab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    const check = () => (tab.classList.contains("active") ? requestAnimationFrame(() => setTimeout(() => done(performance.now() - t0), 0)) : performance.now() - t0 > 10000 ? done(-1) : requestAnimationFrame(check));
    check();
  }, i);
  out.switchTab.push(r1(ms));
  await sleep(1000);
}

// ---------------------------------------------------------------- palette / quick search
out.paletteOpen = [];
out.paletteSearch = [];
for (let i = 0; i < 3; i++) {
  await app.keys(["Escape"]);
  out.paletteOpen.push(r1(await timed(app, { click: ".ribbon button[aria-label^='Befehlspalette'], .ribbon button[aria-label^='Suche']" }, { sel: ".palette .pal-item" })));
  const input = await app.$(".palette .pal-input input");
  const q = ["abstimmung", "Seite 0202", "migration"][i];
  const t0 = await app.browser.execute(() => performance.now());
  await input.setValue(q);
  const ms = await app.browser.executeAsync((q, t0, done) => {
    const check = () => {
      const first = document.querySelector(".palette .pal-item .pal-title, .palette .pal-item");
      if (first && document.querySelector(".palette .pal-input input").value === q && !document.querySelector(".palette .pal-loading") && [...document.querySelectorAll(".palette .pal-item")].some((e) => e.textContent.toLowerCase().includes(q.toLowerCase().split(" ")[0]))) requestAnimationFrame(() => done(performance.now() - t0));
      else if (performance.now() - t0 > 20000) done(-1);
      else requestAnimationFrame(check);
    };
    check();
  }, q, t0);
  out.paletteSearch.push(r1(ms));
  await app.keys(["Escape"]);
  await sleep(200);
}
// Floor of the keypress → paint measurement: a plain text field (the settings' search is not
// needed; a temporary input outside React).
await app.browser.execute(() => {
  const i = document.createElement("input");
  i.id = "perf-floor";
  i.style.cssText = "position:fixed;top:4px;left:300px;z-index:99999;width:200px";
  document.body.append(i);
  i.focus();
  window.__lat = [];
});
for (const ch of "grundrauschen messen") await app.browser.keys(ch);
const floor = await app.browser.execute(() => (document.getElementById("perf-floor").remove(), window.__lat));
out.typingFloor = { median: r1(med(floor)), p95: r1(p95(floor)) };
const searchCalls = await app.browser.execute(() => window.__perf.calls.filter((c) => c.cmd.startsWith("search")).map((c) => [c.cmd, Math.round(c.ms), c.bytes]));
out.searchCalls = searchCalls.slice(-12);

// ---------------------------------------------------------------- dashboard (15 widgets)
const np = (await app.invoke("wbs_tree").catch(() => []))[0]?.netzplaene?.[0];
const boards = [
  {
    id: "perf",
    name: "Perf",
    widgets: [
      W("today", "today", 0, 0, 8, 12),
      W("agenda", "agenda", 8, 0, 4, 12, { days: 7 }),
      W("week", "week", 0, 12, 6, 7, { mode: "wbs" }),
      W("budget", "budget", 6, 12, 6, 7, { count: 4 }),
      W("tasks", "tasks", 0, 19, 4, 8, { due: "any" }),
      W("query", "query", 4, 19, 4, 8, { display: "bar", query: { source: "entries", range: "month", group: "wbs" } }),
      W("q2", "query", 8, 19, 4, 8, { display: "table", query: { source: "pages", parent_id: ids.small[0].parent_id ?? null, filters: [{ field: "status", op: "ist", value: "offen" }], columns: ["status"] } }),
      W("project", "project", 0, 27, 6, 9, { netzplan: np?.id }),
      W("activity", "activity", 6, 27, 3, 9),
      W("recent", "recent", 9, 27, 3, 9),
      W("favorites", "favorites", 0, 36, 3, 6),
      W("calendar", "calendar", 3, 36, 3, 6),
      W("review", "review", 6, 36, 3, 6),
      W("focus", "focus", 9, 36, 3, 6),
      W("jira", "jira", 0, 42, 6, 8),
    ],
  },
];
await app.invoke("dashboard_save", { dashboard: { version: 2, boards, active: "perf", notes: {} } });
out.dashboard = [];
for (let i = 0; i < 3; i++) {
  await app.browser.execute(() => (window.__arcaloDashPerf = []));
  await app.keys(["Control", "t"]);
  await app.browser.waitUntil(() => app.browser.execute(() => !!document.querySelector(".pane.active .dw")), { timeout: 30000 });
  await app.browser.waitUntil(async () => (await app.$$(".pane.active .dw .dw-skel")).length === 0, { timeout: 60000 }).catch(() => {});
  await sleep(800);
  const perf = await app.browser.execute(() => window.__arcaloDashPerf ?? []);
  out.dashboard.push(perf.map((p) => ({ backend: r1(p.backendMs), roundTrip: r1(p.roundTripMs), commit: r1(p.commitMs), render: r1(p.renderMs), parts: p.parts })));
  await app.keys(["Control", "w"]);
  await sleep(300);
}

// ---------------------------------------------------------------- views
const view = async (name, click, cond) => {
  await app.keys(["Control", "t"]);
  await sleep(500);
  out[name] = r1(await timed(app, { click }, cond));
};
await view("calendarWeek", ".ribbon-calendar-view", { sel: ".pane.active .calv-ev", min: 5 });
out.calendarMonth = r1(await timed(app, { click: ".pane.active .calv-view-select" }, { sel: ".menu, [role=listbox]" }).catch(() => -1));
await app.keys(["Escape"]);
await view("timesheet", ".ribbon button[aria-label='Zeiterfassung']", { sel: ".pane.active .week-grid, .pane.active table tbody tr", min: 1 });
await view("issues", ".ribbon-issues", { sel: ".pane.active [data-issue-row]", min: 10 });
await view("tasks", ".ribbon button[aria-label^='Aufgaben']", { sel: ".pane.active .task-row, .pane.active [data-task]", min: 5 });
out.tasksScroll = frameStats(await frames(app, ".pane.active .tasks-list, .pane.active .tasks-scroll, .pane.active .view-body", 60, "scroll", 200));
await app.keys(["Control", "t"]);
await sleep(500);
out.graphOpen = r1(await app.browser.executeAsync((done) => {
  const t0 = performance.now();
  document.querySelector(".ribbon-graph").click();
  const check = () => {
    const c = document.querySelector(".graph-view .graph-canvas canvas");
    if (c && Number(c.dataset.frames) > 0 && Number(c.getAttribute("data-nodes")) > 1000) done(performance.now() - t0);
    else if (performance.now() - t0 > 30000) done(-1);
    else requestAnimationFrame(check);
  };
  check();
}));
await app.keys(["Control", "t"]);
await sleep(500);
out.canvasOpen = r1(await timed(app, { invoke: ["search_open", { target: { kind: "page", page_id: ids.canvas.id, new_tab: false } }] }, { sel: ".pane.active .cv-card", min: 20 }));
await sleep(1000);
out.canvasPan = frameStats(await frames(app, ".pane.active .cv-board", 60, "wheel", 40));

// ---------------------------------------------------------------- backup
const tb = Date.now();
await app.invoke("backup_now").catch((e) => (out.backupError = String(e)));
out.backupMs = Date.now() - tb;

// ---------------------------------------------------------------- IPC summary
const calls = await app.browser.execute(() => window.__perf.calls);
const agg = {};
for (const c of calls) {
  const a = (agg[c.cmd] ??= { n: 0, total: 0, max: 0, bytes: 0 });
  a.n++;
  a.total += c.ms;
  a.max = Math.max(a.max, c.ms);
  a.bytes = Math.max(a.bytes, c.bytes);
}
out.ipcSlowest = Object.entries(agg).sort((a, b) => b[1].max - a[1].max).slice(0, 15).map(([k, v]) => `${k} n=${v.n} max=${Math.round(v.max)} avg=${Math.round(v.total / v.n)} bytes=${v.bytes}`);
out.ipcBiggest = Object.entries(agg).sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 8).map(([k, v]) => `${k} bytes=${v.bytes} n=${v.n}`);

// ---------------------------------------------------------------- usage loop (leaks)
const snap = async () => ({ rssMb: Math.round(rssKb() / 1024), ...(await app.browser.execute(() => ({ dom: document.getElementsByTagName("*").length, intervals: window.__perf.intervals, listeners: window.__perf.listeners }))) });
await app.keys(["Control", "t"]);
await sleep(1000);
out.memStart = await snap();
const until = Date.now() + LOOP_MIN * 60_000;
let rounds = 0;
while (Date.now() < until) {
  for (const p of ids.small) await openPage(app, p.id, p.title);
  await app.caretToEnd();
  for (const ch of " x") await app.browser.keys(ch);
  await openPage(app, ids.big.id, ids.big.title);
  for (const sel of [".ribbon-calendar-view", ".ribbon-issues", ".ribbon-graph"]) {
    await app.browser.execute((s) => document.querySelector(s).click(), sel);
    await sleep(700);
  }
  await app.keys(["Control", "t"]);
  await sleep(700);
  // Close extra tabs.
  await app.browser.execute(() => {
    const tabs = [...document.querySelectorAll(".pane.active .tabbar .tab")];
    tabs.slice(0, -2).forEach((t) => t.querySelector("[aria-label^='Schließen'], .tab-close")?.click());
  });
  await sleep(300);
  rounds++;
  if (rounds === 1) out.memAfter1 = await snap();
}
out.memEnd = { ...(await snap()), rounds, minutes: LOOP_MIN };

} catch (e) {
  out.error = String(e.stack ?? e);
  console.error(e);
}
// ---------------------------------------------------------------- warm start
await app.close();
t = Date.now();
app = await launch({ demo: false, dataDir, width: 1480, height: 920 });
out.warmStart = await startTimes(app, t);
await app.close();
fs.rmSync(dataDir, { recursive: true, force: true });

const file = path.join(process.env.BENCH_OUT ?? os.tmpdir(), `${label}.json`);
fs.writeFileSync(file, JSON.stringify(out, null, 1));
const brief = { ...out };
delete brief.ipcSlowest;
delete brief.ipcBiggest;
console.log(JSON.stringify(brief, (k, v) => (k === "entryTypes" ? undefined : v)));
console.log((out.ipcSlowest ?? []).join("\n"));
console.log((out.ipcBiggest ?? []).join("\n"));
