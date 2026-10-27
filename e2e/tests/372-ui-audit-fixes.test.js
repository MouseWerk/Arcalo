// 1.17 UI audit fixes (docs/quality/q117/ui-findings.md): a palette command that shows a tab of
// the other pane keeps that pane active (the focus going back made the old one active again);
// the note's toolbar fades out at an edge where it hides buttons instead of cutting one in half;
// in a narrow pane a project's „Netzplan“ and menu stay inside its card and the booked hours
// under a Vorgang stay in their column.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
before(async () => (app = await launch({ width: 1280, height: 800 })));
after(async () => app?.close());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SHOWN = ".pane.active > .pane-content:not([hidden])";
const RIGHT = ".workspace > .pane:last-child > .pane-content:not([hidden])";
let page;

async function palette(label) {
  await app.keys(["Control", "k"]);
  const input = await app.waitFor(".palette input");
  await input.setValue(label);
  await app.browser.waitUntil(async () => (await app.browser.execute(() => document.querySelector(".pal-item.sel")?.textContent ?? "")).startsWith(label), { timeoutMsg: `no palette entry ${label}` });
  await app.keys(["Enter"]);
  await app.browser.waitUntil(async () => !(await app.browser.execute(() => !!document.querySelector(".palette"))), { timeoutMsg: "the palette stayed open" });
}
const activePane = () => app.browser.execute(() => [...document.querySelectorAll(".workspace > .pane")].findIndex((p) => p.classList.contains("active")));

test("setup: a note, split into two panes", async () => {
  page = await app.invoke("page_create", { parentId: null, title: "Audit 117", icon: null, content: "Erste Zeile\n\nZweite Zeile\n" });
  await app.invoke("search_open", { target: { kind: "page", page_id: page.id, new_tab: false } });
  await app.waitFor(`${SHOWN} .ProseMirror`);
  await app.click('.pane.active .tabbar [aria-label="Rechts teilen"]');
  await app.browser.waitUntil(async () => (await app.browser.execute(() => document.querySelectorAll(".workspace > .pane").length)) === 2, { timeoutMsg: "no split" });
});

test("a palette command that shows the other pane's tab keeps that pane active", async () => {
  // Kalender in the right pane, then the focus in the left pane's note.
  await palette("Kalender");
  await app.waitFor(`${RIGHT} .calv`, 10000);
  await app.browser.execute(() => {
    const pm = document.querySelector(".workspace > .pane:first-child > .pane-content:not([hidden]) .ProseMirror");
    pm.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    pm.focus();
  });
  await app.browser.waitUntil(async () => (await activePane()) === 0, { timeoutMsg: "the left pane did not become active" });
  // „Kalender“ again: shown in the right pane, which stays the active one after the focus went back.
  await palette("Kalender");
  await app.browser.waitUntil(async () => (await activePane()) === 1, { timeoutMsg: "the right pane did not become active" });
  await sleep(400);
  assert.equal(await activePane(), 1, "the left pane became active again when the palette closed");
  assert.match(await app.text(".pane.active .tab.active"), /Kalender/);
});

test("the note's toolbar fades out where it hides buttons in a narrow pane", async () => {
  await app.browser.setWindowSize(900, 700);
  await app.browser.execute(() => document.querySelector(".workspace > .pane:first-child > .pane-content:not([hidden]) .ProseMirror")?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
  await app.browser.waitUntil(async () => (await activePane()) === 0, { timeoutMsg: "the left pane did not become active" });
  await sleep(600);
  const bar = () =>
    app.browser.execute((s) => {
      const el = document.querySelector(`${s} .vh-toolbar .editor-toolbar`);
      return { hides: el.scrollWidth > el.clientWidth + 1, left: el.classList.contains("fade-left"), right: el.classList.contains("fade-right") };
    }, SHOWN);
  const start = await bar();
  assert.ok(start.hides, "the toolbar fits: the pane is not narrow enough for this check");
  assert.deepEqual(start, { hides: true, left: false, right: true });
  await app.browser.execute((s) => {
    const el = document.querySelector(`${s} .vh-toolbar .editor-toolbar`);
    el.scrollLeft = el.scrollWidth;
  }, SHOWN);
  await app.browser.waitUntil(async () => (await bar()).left, { timeoutMsg: "no fade at the left edge after scrolling" });
  assert.deepEqual(await bar(), { hides: true, left: true, right: false });
});

test("a project's actions and a Vorgang's booked hours stay inside a narrow card", async () => {
  await app.browser.execute(() => document.querySelector(".workspace > .pane:last-child > .pane-content:not([hidden])")?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
  await app.browser.waitUntil(async () => (await activePane()) === 1, { timeoutMsg: "the right pane did not become active" });
  await palette("Projekte öffnen");
  await app.waitFor(`${RIGHT} .project-head`, 10000);
  await sleep(400);
  const r = await app.browser.execute((s) => {
    const card = document.querySelector(`${s} .project`).getBoundingClientRect();
    const menu = document.querySelector(`${s} .project-head [aria-label="Projektaktionen"]`).getBoundingClientRect();
    const subs = [...document.querySelectorAll(`${s} .vorgaenge tbody th.vg-name`)].map((th) => {
      const hours = th.querySelector(".vg-sub-hours");
      return hours && getComputedStyle(hours).display !== "none" ? Math.round(hours.getBoundingClientRect().right - th.getBoundingClientRect().right) : null;
    });
    return { cardRight: Math.round(card.right), menuRight: Math.round(menu.right), subs };
  }, RIGHT);
  assert.ok(r.menuRight <= r.cardRight, `the project menu ends at ${r.menuRight}, outside the card (${r.cardRight})`);
  const shownSubs = r.subs.filter((x) => x !== null);
  assert.ok(shownSubs.length > 0, "the narrow table shows no booked hours under the names");
  assert.deepEqual(shownSubs.filter((x) => x > 1), [], "booked hours run past the name column");
  await app.browser.setWindowSize(1280, 800);
});

test("in a narrow pane the week's hours on the start page stay on one line; the calendar's week review button is big enough to hit", async () => {
  // 1280 px with the side panel open: each pane about 300 px wide.
  await app.browser.setWindowSize(1280, 800);
  await app.browser.execute(() => {
    if (!document.querySelector(".app > .panel")) document.querySelector(".workspace > .pane:last-child .tabbar > button:last-of-type").click();
  });
  await app.waitFor(".app > .panel");
  await app.browser.execute(() => document.querySelector(".workspace > .pane:last-child .tabbar-home")?.click());
  await app.waitFor(`${RIGHT} .dw-week-sum`, 10000);
  await sleep(400);
  const sum = await app.browser.execute((s) => {
    const of = document.querySelector(`${s} .dw-week-sum > .faint`);
    return { height: of.getBoundingClientRect().height, line: parseFloat(getComputedStyle(of).lineHeight) || parseFloat(getComputedStyle(of).fontSize) * 1.5, text: of.textContent };
  }, RIGHT);
  assert.ok(sum.height <= sum.line + 1, `„${sum.text}“ wraps (${sum.height} px for a ${sum.line} px line)`);
  await palette("Kalender");
  await app.waitFor(`${RIGHT} .calv-week-review`, 10000);
  const size = await app.browser.execute((s) => document.querySelector(`${s} .calv-week-review`).getBoundingClientRect().height, RIGHT);
  assert.ok(size >= 20, `the week review button is ${size} px high`);
});

test("no console errors", async () => {
  assert.deepEqual(await app.consoleErrors(), []);
});
