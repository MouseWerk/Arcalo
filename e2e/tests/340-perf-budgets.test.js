// Performance budgets (1.16) that catch the regressions found in the 1.16 audit, with generous bounds for a
// debug build on a shared machine:
// - a running timer kept a CPU core busy (an endless box-shadow pulse on its dot, three displays re-rendered
//   every second): now no animation runs once the dots have pulsed, only the clock texts change each second;
// - typing in a 200 KB note: the bubble menus re-sent their options with a transaction on every key, which in
//   WebKit laid the whole note out once more;
// - closed tabs must give their editors back (the shared Markdown parser kept every closed editor reachable).
import { test as nodeTest, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { execSync } from "node:child_process";
import { APP, launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
after(async () => app?.close());

/** CPU time (ticks of 10 ms) of the app and its WebKit processes. */
function cpuTicks() {
  const rows = execSync("ps -eo pid=,ppid=,args=").toString().trim().split("\n").map((l) => l.trim().split(/\s+/));
  const ids = new Set(rows.filter((r) => r[2] === APP).map((r) => r[0]));
  let grew = true;
  while (grew) {
    grew = false;
    for (const r of rows) if (ids.has(r[1]) && !ids.has(r[0])) (ids.add(r[0]), (grew = true));
  }
  let sum = 0;
  for (const id of ids) {
    try {
      const f = fs.readFileSync(`/proc/${id}/stat`, "utf8").split(") ")[1].split(" ");
      sum += Number(f[11]) + Number(f[12]);
    } catch {
      /* gone */
    }
  }
  return { sum, n: ids.size };
}

test("a running timer: no endless animation, only the clock texts change, little CPU", async () => {
  app = await launch({ width: 1480, height: 920 });
  await app.browser.setTimeout({ script: 300_000 });
  const [np] = (await app.invoke("wbs_tree")).flatMap((p) => p.netzplaene);
  await app.invoke("timer_start", { netzplanId: np.id, vorgangNr: null, leistungsart: null, description: "Budget" });
  await app.browser.execute(() => window.dispatchEvent(new Event("focus")));
  await app.waitFor(".timer-dock .rec-dot");
  await app.waitFor(".statusbar .sb-timer .rec-dot");
  // The time sheet shows the third clock.
  await app.click(".timer-dock-main");
  await app.waitFor(".timer-card .rec-dot");
  // The dots pulse a few times when they appear, then stand still.
  await app.browser.pause(6000);
  const running = await app.browser.execute(() =>
    document
      .getAnimations()
      .filter((a) => a.playState === "running")
      .map((a) => `${a.animationName ?? a.constructor.name} on ${a.effect?.target?.className ?? "?"}`),
  );
  assert.deepEqual(running, [], "animations still running with a timer");

  // Over three seconds only the texts of the clocks change.
  const changed = await app.browser.executeAsync((done) => {
    const seen = new Set();
    const mo = new MutationObserver((list) => {
      for (const m of list) {
        const el = m.target.nodeType === 1 ? m.target : m.target.parentElement;
        const clock = el?.closest(".timer-dock-time, .sb-timer .num, .timer-clock, .dw-big");
        seen.add(clock ? "clock" : `${m.type} ${el?.className || el?.tagName}`);
      }
    });
    mo.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    setTimeout(() => (mo.disconnect(), done([...seen])), 3200);
  });
  assert.deepEqual(changed, ["clock"], "something besides the clock texts changes every second");

  // CPU: was about 100 % of a core with the pulse, 8 % with three re-rendered panels.
  const a = cpuTicks();
  await app.browser.pause(15000);
  const b = cpuTicks();
  assert.ok(a.n >= 2, "app processes not found");
  const pct = (b.sum - a.sum) / 15;
  console.log(`[340] CPU with a running timer: ${pct.toFixed(1)} % (${b.n} processes)`);
  assert.ok(pct < 20, `CPU with a running timer ${pct.toFixed(1)} %`);
  await app.invoke("timer_discard");
});

test("typing in a 200 KB note stays fast", async () => {
  const block = (i) => `## Abschnitt ${i}\n\nDies ist Absatz ${i} mit **fettem Text**, einem [[Seite 0101]] Link und etwas mehr Inhalt, damit die Zeile lang genug ist.\n\n- Punkt ${i}a\n- [ ] Aufgabe ${i}\n\n`;
  let md = "";
  for (let i = 0; md.length < 200_000; i++) md += block(i);
  const page = await app.invoke("page_create", { parentId: null, title: "Budget gross", icon: null, content: md });
  const t0 = Date.now();
  await app.invoke("search_open", { target: { kind: "page", page_id: page.id, new_tab: false } });
  await app.browser.waitUntil(() => app.browser.execute(() => (document.querySelector(".pane.active .pane-content:not([hidden]) .ProseMirror")?.editor?.state.doc.content.size ?? 0) > 150_000), { timeout: 60000, timeoutMsg: "the note did not open" });
  const open = Date.now() - t0;
  await app.browser.pause(1500);
  await app.browser.execute(() => {
    const ed = document.querySelector(".pane.active .pane-content:not([hidden]) .ProseMirror").editor;
    let pos = null;
    ed.state.doc.descendants((n, q) => {
      if (pos == null && n.isTextblock && n.textContent.length > 40 && q > ed.state.doc.content.size / 2) pos = q + n.nodeSize - 1;
      return pos == null;
    });
    ed.chain().focus().setTextSelection(pos).scrollIntoView().run();
    // Transactions that only carry plugin options (the bubble menus re-sent theirs on every render):
    // in WebKit each lays the whole note out once more.
    window.__optionTrs = 0;
    const view = ed.view;
    const dispatch = view.dispatch.bind(view);
    view.dispatch = (tr) => {
      if (!tr.docChanged && Object.values(tr.meta ?? {}).some((m) => m && m.type === "updateOptions")) window.__optionTrs++;
      return dispatch(tr);
    };
    window.__lat = [];
    document.addEventListener(
      "keydown",
      () => {
        const k0 = performance.now();
        requestAnimationFrame(() => setTimeout(() => window.__lat.push(performance.now() - k0), 0));
      },
      true,
    );
  });
  await app.browser.pause(500);
  for (const ch of "budgettest") await app.browser.keys(ch);
  await app.browser.pause(800);
  const lat = (await app.browser.execute(() => window.__lat)).sort((x, y) => x - y);
  const median = lat[Math.floor(lat.length / 2)];
  console.log(`[340] 200 KB note: open ${open} ms, typing median ${median.toFixed(0)} ms`);
  assert.ok(lat.length >= 8, "keys not measured");
  // Generous for a debug build on a shared machine (about 130 ms here; 1.7 s per key when every block was
  // contained); the transaction count below is the exact guard.
  assert.ok(median < 400, `typing median ${median.toFixed(0)} ms`);
  assert.ok(open < 20000, `open ${open} ms`);
  assert.equal(await app.browser.execute(() => window.__optionTrs), 0, "menus re-sent their options while typing");
  assert.match(await app.browser.execute(() => document.querySelector(".pane.active .pane-content:not([hidden]) .ProseMirror").editor.state.doc.textContent), /budgettest/);
});

test("closed tabs give their editors back", async () => {
  const ids = [];
  for (let i = 0; i < 24; i++) {
    const content = Array.from({ length: 20 }, (_, k) => `## Teil ${k}\n\nAbsatz ${i}/${k} mit **fett** und [[Seite ${i}]].\n\n- [ ] Aufgabe ${i}.${k}\n`).join("\n");
    ids.push((await app.invoke("page_create", { parentId: null, title: `Tab ${i}`, icon: null, content })).id);
  }
  await app.browser.execute(() => {
    window.__refs = [];
    window.__listeners = 0;
    const add = EventTarget.prototype.addEventListener;
    const rem = EventTarget.prototype.removeEventListener;
    const global = (t) => t === window || t === document || t === document.body || t === document.documentElement;
    EventTarget.prototype.addEventListener = function (...a) {
      if (global(this)) window.__listeners++;
      return add.apply(this, a);
    };
    EventTarget.prototype.removeEventListener = function (...a) {
      if (global(this)) window.__listeners--;
      return rem.apply(this, a);
    };
  });
  const tabs = () => app.browser.execute(() => document.querySelectorAll(".pane .tab").length);
  const before = await tabs();
  for (const [i, id] of ids.entries()) {
    await app.invoke("search_open", { target: { kind: "page", page_id: id, new_tab: true } });
    await app.browser.waitUntil(() => app.browser.execute((t) => document.querySelector(".pane.active .pane-content:not([hidden]) .page-title")?.value === t && !!document.querySelector(".pane.active .pane-content:not([hidden]) .ProseMirror")?.editor, `Tab ${i}`), { timeout: 20000 });
    await app.browser.execute(() => {
      const pm = document.querySelector(".pane.active .pane-content:not([hidden]) .ProseMirror");
      window.__refs.push(new WeakRef(pm.editor), new WeakRef(pm));
    });
  }
  assert.equal(await tabs(), before + ids.length);
  for (let i = 0; i < ids.length; i++) {
    await app.keys(["Control", "w"]);
    await app.browser.pause(60);
  }
  await app.browser.waitUntil(async () => (await tabs()) === before, { timeout: 15000, timeoutMsg: "tabs not closed" });
  await app.browser.pause(1500);
  // Collect garbage: long-lived allocations grow the old generation until the engine runs full collections.
  for (let round = 0; round < 2; round++) {
    await app.browser.executeAsync((done) => {
      let keep = [];
      let k = 0;
      const step = () => {
        const a = [];
        for (let j = 0; j < 200000; j++) a.push({ j, s: "x" + j });
        keep.push(a);
        if (++k < 30) setTimeout(step, 30);
        else {
          keep = null;
          setTimeout(done, 500);
        }
      };
      step();
    });
    await app.browser.pause(700);
  }
  const left = await app.browser.execute(() => ({ alive: window.__refs.filter((r) => r.deref() !== undefined).length, of: window.__refs.length, listeners: window.__listeners }));
  console.log(`[340] after closing ${ids.length} tabs: ${left.alive} of ${left.of} editors/DOM still reachable, listeners net ${left.listeners}`);
  // The garbage collector scans the stack conservatively: one or two may stay by chance.
  assert.ok(left.alive <= 4, `${left.alive} of ${left.of} closed editors are still reachable`);
  assert.ok(left.listeners <= 0, `${left.listeners} listeners on window/document left behind`);
});
