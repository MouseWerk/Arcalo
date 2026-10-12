// The visual editor stays alive behind the Markdown source view (1.19): back from the source view the
// same editor shows again, with its undo history, selection and scroll position, and takes over only
// what was changed there (as one undo step, nothing lost or doubled). Also the time and memory of the
// switch on a note of 5,000 lines (logged; the budgets are generous for a debug build).
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { execSync } from "node:child_process";
import { APP, budget, launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
let page;
before(async () => {
  app = await launch({ width: 1480, height: 920 });
  await app.browser.setTimeout({ script: 300_000 });
});
after(async () => app?.close());

const SHOWN = ".pane.active > .pane-content:not([hidden])";
const RICH = `${SHOWN} .ProseMirror:not([hidden] *)`;

/** 5,000 lines: headings, paragraphs, lists and tasks; every paragraph line is unique. */
function longNote() {
  const lines = ["# Fünftausend Zeilen", ""];
  for (let sec = 1; lines.length < 5000; sec++) {
    lines.push(`## Abschnitt ${sec}`, "");
    for (let k = 0; k < 4; k++) lines.push(`Absatz ${sec}.${k} mit etwas Text über Planung, Termine und Ergebnisse.`, "");
    lines.push(`- Punkt ${sec} eins`, `- Punkt ${sec} zwei`, `- [ ] Aufgabe ${sec}`, "");
  }
  return lines.join("\n");
}

/** Resident memory (KB) of the app and its WebKit processes. */
function rssKb() {
  const rows = execSync("ps -eo pid=,ppid=,rss=,args=").toString().trim().split("\n").map((l) => l.trim().split(/\s+/));
  const ids = new Set(rows.filter((r) => r[3] === APP).map((r) => r[0]));
  for (let grew = true; grew; ) {
    grew = false;
    for (const r of rows) if (ids.has(r[1]) && !ids.has(r[0])) (ids.add(r[0]), (grew = true));
  }
  return rows.filter((r) => ids.has(r[0])).reduce((s, r) => s + Number(r[2]), 0);
}

/** Toggles the mode and returns the ms until the other view shows the long note and a frame is painted. */
function toggle(to) {
  return app.browser.executeAsync(
    (to, shown, done) => {
      const made = [];
      const create = Document.prototype.createElement;
      Document.prototype.createElement = function (tag, ...rest) {
        const el = create.call(this, tag, ...rest);
        if (String(tag).toLowerCase() === "li") made.push(el);
        return el;
      };
      const ok = () => {
        const src = document.querySelector(`${shown} .source-text`);
        const pm = document.querySelector(`${shown} .ProseMirror:not([hidden] *)`);
        return to === "source" ? (src?.value.length ?? 0) > 100_000 : !src && !!pm && pm.getClientRects().length > 0 && !document.querySelector(`${shown} .editor-switching`);
      };
      const t0 = performance.now();
      window.dispatchEvent(new CustomEvent("arcalo:page-command", { detail: "source" }));
      const check = () => {
        if (ok())
          requestAnimationFrame(() =>
            setTimeout(() => {
              Document.prototype.createElement = create;
              done({ ms: performance.now() - t0, drawn: made.filter((li) => !li.isConnected || li.closest(".ProseMirror")).length });
            }, 0),
          );
        else if (performance.now() - t0 > 120_000) done({ ms: -1, drawn: -1 });
        else requestAnimationFrame(check);
      };
      check();
    },
    to,
    SHOWN,
  );
}

const settle = async () => {
  await app.browser.pause(1500);
  await app.browser.execute(() => window.gc?.());
  await app.browser.pause(500);
};
const stored = async () => (await app.invoke("page_get", { id: page.id })).content;

test("a note of 5,000 lines: to the source view and back, time and memory", async () => {
  page = await app.invoke("page_create", { parentId: null, title: "Fünftausend Zeilen", icon: null, content: longNote() });
  const rss = { start: rssKb() };
  await app.invoke("search_open", { target: { kind: "page", page_id: page.id, new_tab: true } });
  await app.browser.waitUntil(() => app.browser.execute((s) => (document.querySelector(s)?.editor?.state.doc.content.size ?? 0) > 100_000, RICH), { timeout: 60_000, timeoutMsg: "the note did not open" });
  await settle();
  rss.rich = rssKb();
  const runs = { source: [], back: [], drawnBack: [] };
  for (let i = 0; i < 3; i++) {
    const s = await toggle("source");
    await settle();
    rss[`source${i + 1}`] = rssKb();
    const b = await toggle("rich");
    await settle();
    rss[`back${i + 1}`] = rssKb();
    runs.source.push(Math.round(s.ms));
    runs.back.push(Math.round(b.ms));
    runs.drawnBack.push(b.drawn);
  }
  const best = { source: Math.min(...runs.source), back: Math.min(...runs.back) };
  console.log(`[380] 5,000 lines (min of 3): to source ${best.source} ms, back ${best.back} ms (runs ${JSON.stringify(runs)})`);
  console.log(`[380] resident memory of the app and its WebKit processes (MB): ${Object.entries(rss).map(([k, v]) => `${k} ${(v / 1024).toFixed(0)}`).join(", ")}`);
  if (process.env.ARCALO_MEASURE_OUT) fs.writeFileSync(process.env.ARCALO_MEASURE_OUT, JSON.stringify({ runs, best, rss }, null, 1));
  assert.ok(best.source < budget(1500), `to the source view ${best.source} ms`);
  assert.ok(best.back < budget(1500), `back to the visual editor ${best.back} ms`);
  // The kept editor is shown again, not drawn anew.
  assert.deepEqual(runs.drawnBack, [0, 0, 0], "list items drawn on the way back");
});

test("back from the source view: the same editor with its history, selection and scroll; source edits are one undo step", async () => {
  const original = await stored();
  // A mark on the editor's element: the same element (and editor) must come back.
  await app.browser.execute((s) => (document.querySelector(s).dataset.kept = "1"), RICH);
  // Typing in the visual editor in the middle of the note, then scrolled somewhere else.
  await app.browser.execute((s) => {
    const ed = document.querySelector(s).editor;
    let at = -1;
    ed.state.doc.descendants((n, pos) => {
      if (at < 0 && n.isText && n.text.startsWith("Absatz 120.1 ")) at = pos + "Absatz 120.1".length;
    });
    ed.commands.focus();
    ed.commands.setTextSelection(at);
    ed.view.domAtPos(at).node.parentElement.scrollIntoView({ block: "center" });
  }, RICH);
  await app.browser.pause(300);
  await app.type(" visuell");
  await app.browser.waitUntil(async () => (await stored()).includes("Absatz 120.1 visuell mit"), { timeoutMsg: "the visual edit was not saved" });
  const before = await app.browser.execute((s) => {
    const ed = document.querySelector(s).editor;
    return { from: ed.state.selection.from, scroll: document.querySelector(".pane.active .page-scroll").scrollTop };
  }, RICH);
  assert.ok(before.scroll > 1000, `scrolled into the note (${before.scroll})`);

  await toggle("source");
  // In the source view: a line changed above the caret, one added below, a repeated line doubled.
  await app.browser.execute((shown) => {
    const t = document.querySelector(`${shown} .source-text`);
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    let v = t.value.replace("Absatz 3.2 mit", "Absatz 3.2 geändert mit").replace("- Punkt 300 zwei\n", "- Punkt 300 zwei\n- Punkt 300 zwei\n");
    v = v.replace("## Abschnitt 301\n", "Neuer Absatz aus dem Quelltext.\n\n## Abschnitt 301\n");
    setter.call(t, v);
    t.dispatchEvent(new Event("input", { bubbles: true }));
  }, SHOWN);
  await app.browser.waitUntil(async () => (await stored()).includes("Neuer Absatz aus dem Quelltext."), { timeoutMsg: "the source edit was not saved" });
  const afterSource = await stored();

  const back = await toggle("rich");
  // Only the doubled list item is new; the rest of the note is not drawn anew.
  assert.equal(back.drawn, 1, "list items drawn on the way back");
  const state = await app.browser.execute((s) => {
    const el = document.querySelector(s);
    const ed = el.editor;
    const text = ed.state.doc.textContent;
    const count = (w) => text.split(w).length - 1;
    return {
      kept: el.dataset.kept === "1",
      from: ed.state.selection.from,
      scroll: document.querySelector(".pane.active .page-scroll").scrollTop,
      changed: count("Absatz 3.2 geändert mit"),
      added: count("Neuer Absatz aus dem Quelltext."),
      doubled: count("Punkt 300 zwei"),
      visual: count("Absatz 120.1 visuell"),
      focused: ed.isFocused,
    };
  }, RICH);
  assert.ok(state.kept, "a new editor was built");
  assert.deepEqual([state.changed, state.added, state.doubled, state.visual], [1, 1, 2, 1], JSON.stringify(state));
  // The caret is still behind the typed word: moved by what was inserted above it.
  const insertedAbove = "geändert ".length;
  assert.equal(state.from, before.from + insertedAbove, JSON.stringify({ before, state }));
  assert.ok(Math.abs(state.scroll - before.scroll) < 2, `scroll ${state.scroll} instead of ${before.scroll}`);
  assert.ok(state.focused, "the editor has the focus again");
  // Taking the source view's text over is no edit of its own: nothing is saved again.
  await app.browser.pause(1500);
  assert.equal(await stored(), afterSource, "the page was saved again unchanged or differently");

  // Typing goes on at the caret; undo takes back that typing, then the source view's edits as one
  // step, then the visual edit from before.
  await app.type("!");
  await app.browser.waitUntil(async () => (await stored()).includes("Absatz 120.1 visuell! mit"), { timeoutMsg: "typing after the switch was not saved" });
  await app.keys(["Control", "z"]);
  await app.browser.waitUntil(async () => (await stored()) === afterSource, { timeoutMsg: "the first undo did not take back the typing" });
  await app.keys(["Control", "z"]);
  await app.browser.waitUntil(async () => !(await stored()).includes("Neuer Absatz aus dem Quelltext."), { timeoutMsg: "the second undo did not take back the source edits" });
  const undone = await stored();
  assert.ok(undone.includes("Absatz 3.2 mit") && !undone.includes("geändert"), "the source edits went back together");
  assert.equal(undone.split("- Punkt 300 zwei\n").length - 1, 1);
  assert.ok(undone.includes("Absatz 120.1 visuell mit"), "the visual edit stays");
  await app.keys(["Control", "z"]);
  await app.browser.waitUntil(async () => (await stored()) === original.replace("Absatz 120.1 visuell mit", "Absatz 120.1 mit"), { timeoutMsg: "the third undo did not take back the visual edit" });
  // Redo brings the source view's edits back, again as one step.
  await app.keys(["Control", "Shift", "z"]);
  await app.keys(["Control", "Shift", "z"]);
  await app.browser.waitUntil(async () => (await stored()) === afterSource, { timeoutMsg: "redo did not bring the edits back" });
});

test("a page opened in the source view builds the visual editor only when it is shown", async () => {
  await app.invoke("search_open", { target: { kind: "page", page_id: page.id, new_tab: true } });
  await app.browser.waitUntil(() => app.browser.execute((s) => !!document.querySelector(s), RICH), { timeout: 60_000 });
  await toggle("source");
  await app.keys(["Control", "w"]);
  await app.browser.pause(500);
  // Opened again: the page remembers the source view; no editor waits hidden behind it.
  await app.invoke("search_open", { target: { kind: "page", page_id: page.id, new_tab: true } });
  await app.browser.waitUntil(() => app.browser.execute((s) => (document.querySelector(`${s} .source-text`)?.value.length ?? 0) > 100_000, SHOWN), { timeout: 60_000 });
  assert.equal(await app.browser.execute((s) => document.querySelectorAll(`${s} .ProseMirror`).length, SHOWN), 0);
  const back = await toggle("rich");
  assert.ok(back.ms > 0, "the visual editor did not show");
  assert.ok(await app.browser.execute((s) => (document.querySelector(s)?.editor?.state.doc.content.size ?? 0) > 100_000, RICH));
});

test("no console errors", async () => {
  assert.deepEqual(await app.browser.execute(() => window.__arcaloErrors ?? []), []);
});
