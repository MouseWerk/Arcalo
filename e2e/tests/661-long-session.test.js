// A long session (q124 round 5): the window is used for hours, notes and views are opened and
// closed again and again. What one round leaves behind adds up: the listeners on the window and
// the document, the core's event listeners, the running intervals, the DOM and the core's memory
// must come back to where they were after the same work is done once more.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { launch, guarded, EDITOR } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
const pages = [];
const ROUNDS = 6;

before(async () => {
  app = await launch({ width: 1600, height: 1000 });
  for (let i = 0; i < 6; i++) {
    const p = await app.invoke("page_create", {
      parentId: null,
      title: `Lauf ${i}`,
      icon: null,
      content: `# Lauf ${i}\n\n- [ ] Aufgabe ${i} due:2026-11-0${(i % 8) + 1}\n\nText mit [[Lauf ${(i + 1) % 6}]] und #lauf.\n\n\`\`\`query\nfrom: tasks\nshow: table\n#lauf\n\`\`\`\n`,
    });
    pages.push(p.id);
  }
  await app.reload();
});
after(async () => app?.close());

/** Counts what is registered from now on: listeners per target, the core's event listeners, intervals. */
async function instrument() {
  await app.browser.execute(() => {
    if (window.__arcaloCount) return;
    const c = { listeners: new Map(), events: 0, intervals: new Set() };
    window.__arcaloCount = c;
    const name = (t) => (t === window ? "window" : t === document ? "document" : t === document.body ? "body" : null);
    const add = EventTarget.prototype.addEventListener;
    const remove = EventTarget.prototype.removeEventListener;
    const seen = new WeakMap();
    EventTarget.prototype.addEventListener = function (type, fn, opts) {
      const n = name(this);
      if (n && fn) {
        const capture = typeof opts === "boolean" ? opts : !!opts?.capture;
        const key = `${n}:${type}:${capture}`;
        let set = seen.get(fn);
        if (!set) seen.set(fn, (set = new Set()));
        if (!set.has(key)) {
          set.add(key);
          c.listeners.set(key, (c.listeners.get(key) ?? 0) + 1);
        }
      }
      return add.call(this, type, fn, opts);
    };
    EventTarget.prototype.removeEventListener = function (type, fn, opts) {
      const n = name(this);
      if (n && fn) {
        const capture = typeof opts === "boolean" ? opts : !!opts?.capture;
        const key = `${n}:${type}:${capture}`;
        const set = seen.get(fn);
        if (set?.has(key)) {
          set.delete(key);
          c.listeners.set(key, (c.listeners.get(key) ?? 0) - 1);
        }
      }
      return remove.call(this, type, fn, opts);
    };
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = function (cmd, args, options) {
      if (cmd === "plugin:event|listen") c.events++;
      if (cmd === "plugin:event|unlisten") c.events--;
      return invoke.call(this, cmd, args, options);
    };
    const si = window.setInterval;
    const ci = window.clearInterval;
    window.setInterval = function (...a) {
      const id = si.apply(this, a);
      c.intervals.add(id);
      return id;
    };
    window.clearInterval = function (id) {
      c.intervals.delete(id);
      return ci.call(this, id);
    };
  });
}

const counts = () =>
  app.browser.execute(() => {
    const c = window.__arcaloCount;
    return {
      listeners: Object.fromEntries([...c.listeners].filter(([, n]) => n !== 0)),
      events: c.events,
      intervals: c.intervals.size,
      handlers: window.__arcaloHandlers?.() ?? {},
      nodes: document.getElementsByTagName("*").length,
    };
  });

/** The resident memory of the app process (kB), found as the process whose window this is. */
function rss() {
  const pid = appPid();
  if (!pid) return null;
  const m = /VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${pid}/status`, "utf8"));
  return m ? Number(m[1]) : null;
}
let pidCache = null;
function appPid() {
  if (pidCache) return pidCache;
  const dir = app.dataDir;
  for (const p of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(p)) continue;
    try {
      const env = fs.readFileSync(`/proc/${p}/environ`, "utf8");
      const exe = fs.readlinkSync(`/proc/${p}/exe`);
      if (env.includes(`ARCALO_DATA_DIR=${dir}\0`) && /arcalo$/.test(exe)) return (pidCache = Number(p));
    } catch {
      /* gone or not ours */
    }
  }
  return null;
}

async function palette(text) {
  await app.keys(["Control", "k"]);
  await app.waitFor(".palette input");
  await app.type(text);
  await app.browser.waitUntil(() => app.browser.execute(() => !!document.querySelector(".pal-item.sel")), { timeoutMsg: `nothing found for ${text}` });
  await app.keys(["Enter"]);
  await app.browser.waitUntil(() => app.browser.execute(() => !document.querySelector(".palette")), { timeoutMsg: "the palette stayed open" });
}

const tabCount = () => app.browser.execute(() => document.querySelectorAll(".pane .tab").length);

/** One round of work: notes in tabs of their own, the views, the palette, a split pane; all closed again. */
async function round() {
  const before = await tabCount();
  for (const id of pages) {
    await app.invoke("search_open", { target: { kind: "page", page_id: id, new_tab: true } });
    await app.waitFor(EDITOR);
  }
  for (const view of ["Aufgaben", "Kalender", "Zeiterfassung", "Aktivität", "Einstellungen", "Startseite"]) await palette(view);
  await app.keys(["Control", "k"]);
  await app.waitFor(".palette input");
  await app.keys(["Escape"]);
  await app.browser.waitUntil(() => app.browser.execute(() => !document.querySelector(".palette")));
  // Back to the tabs there were.
  for (let n = await tabCount(); n > before; n = await tabCount()) {
    await app.keys(["Control", "w"]);
    await app.browser.waitUntil(async () => (await tabCount()) < n, { timeout: 5000, timeoutMsg: "a tab did not close" });
  }
}

test("a long session does not pile up listeners, intervals, DOM nodes or memory", { timeout: 900000 }, async () => {
  await instrument();
  // A first round loads what is loaded once (lazy views, caches).
  await round();
  await round();
  await app.browser.pause(1500);
  const base = await counts();
  const baseRss = rss();
  for (let i = 0; i < ROUNDS; i++) await round();
  await app.browser.pause(1500);
  const end = await counts();
  const endRss = rss();
  console.log(JSON.stringify({ base, end, baseRss, endRss }));
  for (const [key, n] of Object.entries(end.listeners)) {
    const was = base.listeners[key] ?? 0;
    assert.ok(n - was <= 0, `${key}: ${n - was} more listeners after ${ROUNDS} rounds (${was} → ${n})`);
  }
  assert.ok(end.events - base.events <= 0, `the core's event listeners grew by ${end.events - base.events}`);
  for (const [event, n] of Object.entries(end.handlers)) {
    const was = base.handlers[event] ?? 0;
    assert.ok(n - was <= 0, `${event}: ${n - was} more handlers after ${ROUNDS} rounds (${was} → ${n})`);
  }
  assert.ok(end.intervals - base.intervals <= 0, `${end.intervals - base.intervals} more intervals run`);
  assert.ok(end.nodes - base.nodes < 300, `the DOM grew by ${end.nodes - base.nodes} nodes`);
  if (baseRss && endRss) assert.ok(endRss - baseRss < 150 * 1024, `the app's memory grew by ${Math.round((endRss - baseRss) / 1024)} MB`);
});
