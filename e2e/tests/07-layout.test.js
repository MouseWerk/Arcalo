// Obsidian-style workspace: resizable sidebars, split panes, per-tab history, sidebar search.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
before(async () => (app = await launch()));
after(async () => app?.close());

const openFromTree = async (title, mods = {}) => {
  for (const r of await app.$$(".sidebar .tree-row"))
    if ((await app.textOf(r)) === title) {
      if (mods.alt) {
        await app.browser.execute((el) => el.dispatchEvent(new MouseEvent("click", { bubbles: true, altKey: true })), r);
        return;
      }
      return r.click();
    }
  throw new Error(`tree row ${title} not found`);
};
const width = (sel) => app.browser.execute((s) => document.querySelector(s)?.getBoundingClientRect().width ?? 0, sel);
const drag = async (sel, dx) => {
  const el = await app.$(sel);
  await app.browser.performActions([
    {
      type: "pointer",
      id: "mouse",
      parameters: { pointerType: "mouse" },
      actions: [
        { type: "pointerMove", origin: el, x: 0, y: 0 },
        { type: "pointerDown", button: 0 },
        { type: "pointerMove", origin: "pointer", x: Math.round(dx / 2), y: 0, duration: 80 },
        { type: "pointerMove", origin: "pointer", x: dx - Math.round(dx / 2), y: 0, duration: 80 },
        { type: "pointerUp", button: 0 },
      ],
    },
  ]);
  await app.browser.releaseActions();
};
const titles = () => app.browser.execute(() => [...document.querySelectorAll(".pane")].map((p) => p.querySelector(".tab.active .tab-title")?.textContent ?? ""));

test("sidebar and panel are resizable and remember their width", async () => {
  const before = await width(".sidebar");
  await drag(".side-resizer", 90);
  await app.browser.waitUntil(async () => Math.abs((await width(".sidebar")) - (before + 90)) < 12, { timeoutMsg: "sidebar did not grow" });
  const stored = await app.browser.execute(() => Number(localStorage.getItem("annalo.sidebar-w")));
  assert.ok(Math.abs(stored - (before + 90)) < 12, `stored ${stored}`);

  const panelBefore = await width(".panel");
  await drag(".panel-resizer", 60);
  await app.browser.waitUntil(async () => Math.abs((await width(".panel")) - (panelBefore - 60)) < 12, { timeoutMsg: "panel did not shrink" });

  // Clamped to its minimum.
  await drag(".side-resizer", -200);
  await app.browser.waitUntil(async () => Math.abs((await width(".sidebar")) - 200) < 2, { timeoutMsg: "sidebar not clamped" });
  // Double-click resets.
  await (await app.$(".side-resizer")).doubleClick();
  await app.browser.waitUntil(async () => Math.abs((await width(".sidebar")) - 264) < 2);
});

test("navigating a tab keeps history for back and forward", async () => {
  await openFromTree("Architektur");
  await app.waitText(".pane.active .tab.active .tab-title", /Architektur/);
  await openFromTree("PRJ-2026-X Rollout");
  await app.waitText(".pane.active .tab.active .tab-title", /PRJ-2026-X Rollout/);
  assert.equal((await app.$$(".pane.active .tab")).length, 1, "same tab is reused");

  await app.keys(["Alt", "ArrowLeft"]);
  await app.waitText(".pane.active .tab.active .tab-title", /Architektur/);
  await app.click('.pane.active .vh-nav [aria-label^="Vorwärts"]');
  await app.waitText(".pane.active .tab.active .tab-title", /PRJ-2026-X Rollout/);
});

test("split view shows two notes side by side and edits stay in sync", async () => {
  await openFromTree("Architektur");
  await app.waitText(".pane.active .tab.active .tab-title", /Architektur/);
  await app.click('.pane.active .tabbar [aria-label="Rechts teilen"]');
  await app.browser.waitUntil(async () => (await app.$$(".pane")).length === 2);
  assert.deepEqual(await titles(), ["Architektur", "Architektur"]);

  // Type in the right pane; the left one picks up the saved text.
  await app.waitFor(".pane.active .ProseMirror");
  await app.browser.execute(() => {
    const pm = document.querySelector(".pane.active .ProseMirror");
    pm.focus();
    const sel = window.getSelection();
    sel.selectAllChildren(pm);
    sel.collapseToEnd();
  });
  await app.keys(["Enter"]);
  for (const ch of "Synchron geprüft") await app.keys([ch]);
  await app.browser.waitUntil(
    async () => app.browser.execute(() => document.querySelectorAll(".pane")[0].querySelector(".ProseMirror")?.textContent.includes("Synchron geprüft")),
    { timeout: 6000, timeoutMsg: "left pane did not sync" },
  );

  // Alt+click in the tree opens into the other pane.
  await (await app.$(".pane:not(.active) .pane-content")).click();
  await openFromTree("PRJ-2026-X Rollout", { alt: true });
  await app.browser.waitUntil(async () => (await titles()).includes("PRJ-2026-X Rollout"));
  await app.shot("split-view");

  // The pane divider resizes both panes.
  const left = await width(".pane");
  await drag(".pane-resizer", -120);
  await app.browser.waitUntil(async () => Math.abs((await width(".pane")) - (left - 120)) < 16, { timeoutMsg: "pane divider did not move" });

  // Closing every tab of a pane removes it.
  for (const t of await app.$$(".pane:nth-of-type(2) .tab")) await app.browser.execute((e) => e.querySelector(".tab-close")?.click(), t);
  await app.browser.waitUntil(async () => (await app.$$(".pane")).length === 1, { timeoutMsg: "empty pane not removed" });
});

test("tabs can be reordered by dragging", async () => {
  await app.keys(["Control", "t"]);
  await app.browser.waitUntil(async () => (await app.$$(".pane.active .tab")).length >= 2);
  const order = () => app.browser.execute(() => [...document.querySelectorAll(".pane.active .tab-title")].map((t) => t.textContent));
  const before = await order();
  await app.browser.execute(() => {
    const tabs = document.querySelectorAll(".pane.active .tab");
    const src = tabs[tabs.length - 1];
    const dst = tabs[0];
    const dt = new DataTransfer();
    src.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
    dst.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
    dst.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
  });
  const after = await order();
  assert.equal(after[0], before[before.length - 1]);
  await app.keys(["Control", "w"]);
});

test("Ctrl+Shift+F searches all notes in the sidebar", async () => {
  await app.keys(["Control", "Shift", "f"]);
  await app.waitFor(".side-search input");
  const input = await app.$(".side-search input");
  await input.setValue("Rollout");
  await app.waitFor(".side-result");
  assert.match(await app.textOf(await app.$(".side-result-count")), /Seite/);
  const marks = await app.$$(".side-result mark");
  assert.ok(marks.length > 0, "hits are highlighted");
  await (await app.$(".side-result")).click();
  await app.waitFor(".pane.active .ProseMirror");
  await app.shot("sidebar-search");
  await app.click('.side-tabs [aria-label="Dateien"]');
});

test("renaming a page updates links shown in another pane", async () => {
  // Architektur links to nothing; PRJ-2026-X Rollout links to [[Architektur]].
  await openFromTree("PRJ-2026-X Rollout");
  await app.waitText(".pane.active .tab.active .tab-title", /PRJ-2026-X Rollout/);
  await openFromTree("Architektur", { alt: true });
  await app.browser.waitUntil(async () => (await app.$$(".pane")).length === 2);
  await app.waitFor(".pane.active .page-title");
  await app.browser.execute(() => {
    const t = document.querySelector(".pane.active .page-title");
    t.focus();
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    set.call(t, "Architektur neu");
    t.dispatchEvent(new Event("input", { bubbles: true }));
    t.blur();
  });
  await app.browser.waitUntil(
    async () => app.browser.execute(() => document.querySelectorAll(".pane")[0].querySelector(".ProseMirror")?.textContent.includes("Architektur neu")),
    { timeout: 6000, timeoutMsg: "left pane kept the old link" },
  );
  // Nothing writes the old title back.
  await app.browser.pause(1200);
  const id = (await app.invoke("page_resolve", { title: "PRJ-2026-X Rollout", create: false })).id;
  const doc = await app.invoke("page_get", { id });
  assert.match(doc.content, /\[\[Architektur neu\]\]/);
  assert.doesNotMatch(doc.content, /\[\[Architektur\]\]/);
  for (const t of await app.$$(".pane:nth-of-type(2) .tab")) await app.browser.execute((e) => e.querySelector(".tab-close")?.click(), t);
  await app.browser.waitUntil(async () => (await app.$$(".pane")).length === 1);
});

test("status bar shows word count of the active note", async () => {
  await openFromTree("Architektur neu");
  await app.waitText(".statusbar", /Wörter/);
});
