// Performance budgets (1.16) that catch the regressions found in the 1.16 audit, with generous bounds for a
// debug build on a shared machine:
// - a running timer kept a CPU core busy (an endless box-shadow pulse on its dot, three displays re-rendered
//   every second): now no animation runs once the dots have pulsed, only the clock texts change each second;
// - typing in a 200 KB note: the bubble menus re-sent their options with a transaction on every key, which in
//   WebKit laid the whole note out once more;
// - closed tabs must give their editors back (the shared Markdown parser kept every closed editor reachable).
// 1.17 (budgets for the minimum of several runs, larger on CI): a long note opens, switches to the source view
// and back without being drawn twice; typing does not walk through the whole note (code highlighting, chat
// times, diagrams and time chips worked on every block per key), also not in the source view; views share
// one read of the WBS until it changes; the sidebar tree and the graph load compact rows.
import { test as nodeTest, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { execSync } from "node:child_process";
import { APP, budget, launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
// The long note of the 1.17 tests.
let longPage;
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
    // Work on the whole note per key: walks through every block of the document while a key's transaction is
    // applied and drawn (only the top-level list of blocks may be looked at).
    window.__walks = [];
    const doc = ed.state.doc;
    const proto = Object.getPrototypeOf(doc);
    let dispatching = 0;
    for (const m of ["descendants", "nodesBetween", "textBetween"]) {
      const f = proto[m];
      proto[m] = function (...a) {
        const whole = m === "descendants" || a[1] - a[0] > this.content.size / 2;
        if (dispatching && whole && this.content.size > 150_000) window.__walks.push(`${m} ${new Error().stack.split("\n")[2] ?? ""}`);
        return f.apply(this, a);
      };
    }
    const counted = view.dispatch;
    view.dispatch = (tr) => {
      dispatching++;
      try {
        return counted(tr);
      } finally {
        dispatching--;
      }
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
  const walks = await app.browser.execute(() => window.__walks);
  assert.deepEqual(walks.slice(0, 5), [], `${walks.length} walks through the whole note while typing`);
  assert.match(await app.browser.execute(() => document.querySelector(".pane.active .pane-content:not([hidden]) .ProseMirror").editor.state.doc.textContent), /budgettest/);
});

// A note of about `size` characters like a long working document: sections of paragraphs with bold text,
// links and tags, lists, tasks, every fourth with a table, every eighth with a Mermaid diagram, every tenth
// with a page embed and an image (deterministic).
function longNote(size) {
  const words = "Abstimmung Konzept Umsetzung Budget Termin Freigabe Prüfung Projekt Kunde Planung Ergebnis Bericht Anforderung Schnittstelle Datenbank Migration Workshop Entwurf Qualität Risiko bereits weiterhin außerdem deshalb".split(" ");
  let seed = 7;
  const w = (n) => Array.from({ length: n }, () => words[(seed = (seed * 1103515245 + 12345) % 2147483648) % words.length]).join(" ");
  let s = "# Langes Dokument\n\n";
  for (let sec = 0; s.length < size; sec++) {
    s += `## Kapitel ${sec + 1}\n\n`;
    for (let k = 0; k < 3; k++) s += `${w(25)} **${w(3)}** ${w(25)} [[Kleine Seite]] ${w(25)} #thema${k}\n\n`;
    s += `- ${w(6)}\n- ${w(5)} *${w(2)}*\n  - ${w(4)}\n\n`;
    if (sec % 4 === 0) s += `| Spalte A | Spalte B | Spalte C |\n| --- | --- | --- |\n${Array.from({ length: 12 }, (_, r) => `| ${w(2)} | ${w(3)} | ${r} |\n`).join("")}\n`;
    if (sec % 8 === 1) s += "```mermaid\ngraph TD\n  A[Start] --> B{Prüfung}\n  B -->|ja| C[Freigabe]\n  B -->|nein| D[Nacharbeit]\n```\n\n";
    if (sec % 10 === 2) s += `![[Kleine Seite]]\n\n![[anhang-${sec}.png]]\n\n`;
    s += `- [ ] Offener Punkt ${sec}\n- [x] Erledigt ${sec}\n\n`;
  }
  return s;
}

const SHOWN = ".pane.active .pane-content:not([hidden])";

/**
 * Runs `action` in the page (`open`: the page in a new tab, `toggle`: rich text <-> source) and returns the ms
 * until `until` holds (`rich`/`source`: the long note is shown so) and the next frame is painted, with the list
 * items created meanwhile (`drawn`) and those of the shown note (`items`): drawing the whole note once more
 * creates every one of them again.
 */
function timed(action, until, pageId) {
  return app.browser.executeAsync(
    (action, until, pageId, shown, done) => {
      const made = [];
      const create = Document.prototype.createElement;
      Document.prototype.createElement = function (tag, ...rest) {
        const el = create.call(this, tag, ...rest);
        if (String(tag).toLowerCase() === "li") made.push(el);
        return el;
      };
      const finish = (ms) => {
        Document.prototype.createElement = create;
        // Items of other lists on the screen (sidebar, panels) do not count; those of a drawing thrown away do.
        const drawn = made.filter((li) => !li.isConnected || li.closest(".ProseMirror")).length;
        done({ ms, drawn, items: document.querySelectorAll(`${shown} .ProseMirror li`).length });
      };
      const ok = () =>
        document.querySelector(`${shown} .page-title`)?.value === "Langes Dokument" &&
        (until === "rich"
          ? (document.querySelector(`${shown} .ProseMirror`)?.editor?.state.doc.content.size ?? 0) > 150_000
          : (document.querySelector(`${shown} .source-text`)?.value.length ?? 0) > 150_000);
      const t0 = performance.now();
      if (action === "open") window.__TAURI_INTERNALS__.invoke("search_open", { target: { kind: "page", page_id: pageId, new_tab: true } });
      else window.dispatchEvent(new CustomEvent("arcalo:page-command", { detail: "source" }));
      const check = () => {
        if (ok()) requestAnimationFrame(() => setTimeout(() => finish(performance.now() - t0), 0));
        else if (performance.now() - t0 > 120_000) finish(-1);
        else requestAnimationFrame(check);
      };
      check();
    },
    action,
    until,
    pageId,
    SHOWN,
  );
}

/** Keydown to the next painted frame, per key typed. */
async function typingLatency(text) {
  await app.browser.execute(() => {
    window.__lat = [];
    window.__latOff?.();
    const on = () => {
      const k0 = performance.now();
      requestAnimationFrame(() => setTimeout(() => window.__lat.push(performance.now() - k0), 0));
    };
    document.addEventListener("keydown", on, true);
    window.__latOff = () => document.removeEventListener("keydown", on, true);
  });
  for (const ch of text) await app.browser.keys(ch);
  await app.browser.pause(800);
  const lat = (await app.browser.execute(() => (window.__latOff(), window.__lat))).sort((x, y) => x - y);
  return lat[Math.floor(lat.length / 2)];
}

test("a long note with tables, diagrams and embeds: opened, to the source view and back within budget, drawn once (1.17)", async () => {
  await app.invoke("page_create", { parentId: null, title: "Kleine Seite", icon: null, content: "Kurzer Text auf der kleinen Seite." });
  const md = longNote(200_000);
  const page = (longPage = await app.invoke("page_create", { parentId: null, title: "Langes Dokument", icon: null, content: md }));
  const runs = { open: [], source: [], rich: [] };
  for (let i = 0; i < 3; i++) {
    const open = await timed("open", "rich", page.id);
    // Drawn once: Tiptap's React binding gave the node views anew when the content mounted, which drew the
    // whole note a second time (about 300 ms at 200 KB).
    assert.ok(open.items > 300, `${open.items} list items`);
    assert.equal(open.drawn, open.items, "list items created while opening");
    await app.browser.pause(1500);
    const source = await timed("toggle", "source");
    // Leaving the rich text editor does not draw the note again (it took the node views away first).
    assert.equal(source.drawn, 0, "the note was drawn again on the way to the source view");
    await app.browser.pause(1000);
    const rich = await timed("toggle", "rich");
    assert.equal(rich.drawn, rich.items, "list items created on the way back");
    for (const [k, v] of Object.entries({ open, source, rich })) runs[k].push(Math.round(v.ms));
    await app.browser.pause(1000);
    await app.keys(["Control", "w"]);
    await app.browser.pause(800);
  }
  const best = Object.fromEntries(Object.entries(runs).map(([k, v]) => [k, Math.min(...v)]));
  console.log(`[340] 200 KB note (min of 3): open ${best.open} ms, to source ${best.source} ms, back ${best.rich} ms (runs ${JSON.stringify(runs)})`);
  // Debug build on a shared machine; 1.16: open 1.4-1.9 s, to source 0.4-0.5 s, back 1.1-1.4 s.
  assert.ok(best.open < budget(2500), `open ${best.open} ms`);
  assert.ok(best.source < budget(350), `to the source view ${best.source} ms`);
  assert.ok(best.rich < budget(2500), `back to the rich text ${best.rich} ms`);
});

test("typing in a long note's source view stays fast (1.17)", async () => {
  const page = longPage;
  await app.invoke("search_open", { target: { kind: "page", page_id: page.id, new_tab: false } });
  await app.browser.waitUntil(() => app.browser.execute((s) => (document.querySelector(`${s} .ProseMirror`)?.editor?.state.doc.content.size ?? 0) > 150_000, SHOWN), { timeout: 60000, timeoutMsg: "the note did not open" });
  await timed("toggle", "source");
  await app.browser.execute((s) => {
    const el = document.querySelector(`${s} .source-text`);
    const at = el.value.indexOf("\n\n", Math.floor(el.value.length / 2));
    el.focus();
    el.setSelectionRange(at, at);
  }, SHOWN);
  // The minimum of the medians of two runs; 1.15: 152 ms per key at 200 KB, 1.16 and 1.17: about 20 ms.
  const medians = [];
  for (const text of [" Quelltext tippen", " und weiter tippen"]) medians.push(await typingLatency(text));
  const median = Math.min(...medians);
  console.log(`[340] 200 KB source view: typing median ${medians.map((m) => m.toFixed(0)).join(" / ")} ms`);
  assert.ok(median < budget(80), `typing median ${median.toFixed(0)} ms`);
  await app.browser.waitUntil(async () => (await app.invoke("page_get", { id: page.id })).content.includes("Quelltext tippen"), { timeout: 15000, timeoutMsg: "not saved" });
  await timed("toggle", "rich");
});

test("views and tabs share one read of the WBS until it changes, also from outside the UI (1.17)", async () => {
  await app.browser.execute(() => {
    window.__calls = [];
    if (window.__countingCalls) return;
    window.__countingCalls = true;
    const orig = window.fetch.bind(window);
    window.fetch = (url, init) => {
      const u = String(url);
      if (/^(ipc:|http:\/\/ipc\.)/.test(u)) window.__calls.push(decodeURIComponent(u.replace(/^.*localhost\//, "").split("?")[0]));
      return orig(url, init);
    };
  });
  const reads = async () => (await app.browser.execute(() => window.__calls)).filter((c) => c === "wbs_tree" || c === "leistungsarten_list");
  // Projects and the time sheet in new tabs, three times each.
  for (let i = 0; i < 3; i++) {
    for (const label of ["Zeiterfassung", "Projekte"]) {
      await app.keys(["Control", "t"]);
      await app.browser.pause(300);
      await app.browser.execute((l) => document.querySelector(`.ribbon button[aria-label^='${l}']`).click(), label);
      await app.browser.pause(700);
    }
  }
  await app.waitFor(`${SHOWN} .project-code`);
  const seen = await reads();
  console.log(`[340] WBS reads for 6 views: ${seen.join(", ")}`);
  assert.ok(seen.filter((c) => c === "wbs_tree").length <= 1 && seen.filter((c) => c === "leistungsarten_list").length <= 1, `read again: ${seen.join(", ")}`);
  // A project created outside the views (here: a command, elsewhere the assistant or the sample data) shows.
  await app.browser.execute(() => (window.__calls.length = 0));
  await app.invoke("project_create", { code: "PRJ-340", name: "Budgetprojekt" });
  await app.keys(["Control", "t"]);
  await app.browser.pause(300);
  await app.browser.execute(() => document.querySelector(".ribbon button[aria-label^='Projekte']").click());
  await app.waitText(`${SHOWN} .projects-view, ${SHOWN} .view`, /PRJ-340/, 10000);
  const after = await reads();
  assert.equal(after.filter((c) => c === "wbs_tree").length, 1, `after the change: ${after.join(", ")}`);
});

test("the sidebar tree and the graph come as compact rows (1.17)", async () => {
  // 400 pages linking each other: enough for the shapes to show.
  const ids = await app.browser.executeAsync((done) => {
    (async () => {
      const inv = window.__TAURI_INTERNALS__.invoke;
      const root = await inv("page_create", { parentId: null, title: "Netz", icon: null, content: "" });
      const out = [];
      for (let i = 0; i < 400; i++) {
        const links = [1, 2, 3].map((k) => `[[Knoten ${(i + k * 37) % 400}]]`).join(" ");
        out.push((await inv("page_create", { parentId: root.id, title: `Knoten ${i}`, icon: null, content: `Text ${i} mit ${links} #netz${i % 5}` })).id);
      }
      done(out);
    })();
  });
  const size = (v) => JSON.stringify(v).length;
  const tree = size(await app.invoke("workspace_tree"));
  const treeRows = size(await app.invoke("workspace_tree_compact"));
  const graph = size(await app.invoke("graph_data", { filter: null }));
  const graphRows = size(await app.invoke("graph_compact", { filter: null }));
  console.log(`[340] tree ${tree} -> ${treeRows} bytes, graph ${graph} -> ${graphRows} bytes`);
  assert.ok(treeRows < tree * 0.6, `tree rows ${treeRows} of ${tree} bytes`);
  assert.ok(graphRows < graph * 0.5, `graph rows ${graphRows} of ${graph} bytes`);
  // The sidebar and the graph view load the rows.
  await app.browser.execute(() => (window.__calls.length = 0));
  await app.invoke("search_open", { target: { kind: "page", page_id: ids[399], new_tab: false } });
  await app.waitFor(`.sidebar .tree-row[data-id="${ids[0]}"], .sidebar .tree-row[aria-level]`);
  await app.keys(["Control", "t"]);
  await app.browser.pause(300);
  await app.click(".ribbon-graph");
  await app.browser.waitUntil(() => app.browser.execute(() => Number(document.querySelector(".graph-view .graph-canvas canvas")?.getAttribute("data-nodes")) >= 400), { timeout: 30000, timeoutMsg: "graph not shown" });
  const calls = await app.browser.execute(() => window.__calls);
  assert.ok(calls.includes("workspace_tree_compact") && calls.includes("graph_compact"), calls.join(", "));
  assert.ok(!calls.includes("workspace_tree") && !calls.includes("graph_data"), calls.join(", "));
  await app.keys(["Control", "w"]);
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
