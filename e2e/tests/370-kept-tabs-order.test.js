// 1.17 kept tabs: the five places a pane keeps alive stay where they are in the document while
// the user switches between their tabs many times (clicks and Ctrl+Tab). Nothing is moved or
// mounted again: a marker on each editor survives, and each note keeps its scroll position,
// caret and undo history.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
before(async () => (app = await launch({ width: 1400, height: 900 })));
after(async () => app?.close());

const SHOWN = ".pane.active > .pane-content:not([hidden])";
const NAMES = ["Kette A", "Kette B", "Kette C", "Kette D", "Kette E"];
const open = (id, newTab = false) => app.invoke("search_open", { target: { kind: "page", page_id: id, new_tab: newTab } });
const activeTitle = () => app.browser.execute(() => document.querySelector(".pane.active .tab.active .tab-title")?.textContent ?? "");
/** Shows the tab with this title, as a click on it does. */
const showTab = (name) =>
  app.browser.execute((n) => [...document.querySelectorAll(".pane.active .tab")].find((t) => t.textContent.includes(n)).dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 })), name);
const waitShown = (name) =>
  app.browser.waitUntil(async () => (await activeTitle()).includes(name) && (await app.browser.execute((s) => document.querySelector(`${s} .page-title`)?.value ?? "", SHOWN)) === name, {
    timeoutMsg: `${name} is not shown`,
  });
/** What the shown place says about itself: its marker, scroll offset, caret and text. */
const shownState = () =>
  app.browser.execute((s) => {
    const pm = document.querySelector(`${s} .ProseMirror`);
    return {
      mark: pm?.__keptMark ?? null,
      scroll: document.querySelector(`${s} .page-scroll`)?.scrollTop ?? -1,
      caret: pm?.editor?.state.selection.from ?? -1,
      text: pm?.innerText ?? "",
    };
  }, SHOWN);

const placed = {};

test("five notes in five tabs, each scrolled, with a caret and an edit of its own", async () => {
  const long = (n) => Array.from({ length: 120 }, (_, i) => `${n} Absatz ${i + 1} mit etwas Text, damit die Seite lang wird.`).join("\n\n");
  for (const name of NAMES) {
    const page = await app.invoke("page_create", { parentId: null, title: name, icon: null, content: `${long(name)}\n` });
    await open(page.id, true);
    await waitShown(name);
    await app.waitFor(`${SHOWN} .ProseMirror`);
  }
  // Watch the pane: a kept place moved in the document shows as removed (and added again).
  await app.browser.execute(() => {
    window.__keptMoves = 0;
    const pane = document.querySelector(".pane.active");
    window.__keptOrder = [...pane.querySelectorAll(":scope > .pane-content")];
    window.__keptWatch = new MutationObserver((records) => {
      for (const r of records) for (const n of r.removedNodes) if (n.classList?.contains("pane-content")) window.__keptMoves++;
    });
    window.__keptWatch.observe(pane, { childList: true });
  });
  for (const [i, name] of NAMES.entries()) {
    await showTab(name);
    await waitShown(name);
    // An edit at the end (for the undo history), then a caret and a scroll offset of its own.
    await app.browser.execute(
      (s, word) => {
        const pm = document.querySelector(`${s} .ProseMirror`);
        pm.editor.chain().focus("end").insertContent(` ${word}`).run();
      },
      SHOWN,
      `Zusatz${i}`,
    );
    await app.browser.waitUntil(async () => (await shownState()).text.includes(`Zusatz${i}`), { timeoutMsg: `the edit in ${name} did not land` });
    await app.browser.execute(
      (s, i) => {
        const pm = document.querySelector(`${s} .ProseMirror`);
        pm.__keptMark = i;
        // The caret at the start of paragraph 10 + i.
        let pos = 0;
        pm.editor.state.doc.forEach((node, offset, index) => index === 10 + i && (pos = offset + 1));
        pm.editor.commands.setTextSelection(pos);
        document.querySelector(`${s} .page-scroll`).scrollTop = 400 + 300 * i;
      },
      SHOWN,
      i,
    );
    await app.browser.waitUntil(async () => Math.abs((await shownState()).scroll - (400 + 300 * i)) <= 2, { timeoutMsg: `${name} did not scroll` });
    placed[name] = await shownState();
    assert.equal(placed[name].mark, i);
  }
});

test("switching between them many times moves and remounts nothing and keeps scroll and caret", async () => {
  // An irregular order of clicks, with Ctrl+Tab in between.
  for (let n = 0; n < 40; n++) {
    let name;
    if (n % 5 === 4 && !(await activeTitle()).includes(NAMES.at(-1))) {
      // The next tab (the five are the last ones in the strip, in this order).
      const title = await activeTitle();
      name = NAMES[NAMES.findIndex((x) => title.includes(x)) + 1];
      await app.keys(["Control", "Tab"]);
    } else {
      name = NAMES[(n * 3 + (n >> 1)) % NAMES.length];
      await showTab(name);
    }
    await waitShown(name);
    const state = await shownState();
    assert.equal(state.mark, NAMES.indexOf(name), `${name} was mounted again (switch ${n + 1})`);
    assert.ok(Math.abs(state.scroll - placed[name].scroll) <= 24, `${name}: scroll ${state.scroll} instead of ${placed[name].scroll} (switch ${n + 1})`);
    assert.equal(state.caret, placed[name].caret, `${name}: the caret moved (switch ${n + 1})`);
  }
  const order = await app.browser.execute(() => {
    const now = [...document.querySelectorAll(".pane.active > .pane-content")];
    return { moves: window.__keptMoves, same: now.length === window.__keptOrder.length && now.every((el, i) => el === window.__keptOrder[i]), count: now.length };
  });
  assert.equal(order.count, 5, "the pane does not keep five places");
  assert.equal(order.moves, 0, "a kept place was moved or removed in the document");
  assert.ok(order.same, "the kept places changed their order");
});

test("each note's undo history survives the switches", async () => {
  for (const [i, name] of NAMES.entries()) {
    await showTab(name);
    await waitShown(name);
    await app.browser.execute((s) => document.querySelector(`${s} .ProseMirror`).focus(), SHOWN);
    await app.keys(["Control", "z"]);
    await app.browser.waitUntil(async () => !(await shownState()).text.includes(`Zusatz${i}`), { timeoutMsg: `Ctrl+Z did not take back the edit in ${name}` });
  }
  assert.equal(await app.browser.execute(() => window.__keptMoves), 0);
});

test("no console errors", async () => {
  await app.browser.execute(() => window.__keptWatch?.disconnect());
  assert.deepEqual(await app.consoleErrors(), []);
});
