// 1.19 file explorer, look: the tree at 900, 1280 and 1920 px in the light, dark and both
// contrast themes (open page, hover, selection, a drop into a page and between pages, the filter,
// the context menu, „Symbol ändern…“, the sorted folder's hint), screenshotted for review
// (389-*.png) and checked: no clipped controls, the open page and the selection look different
// (and in the contrast themes have different edges), drop states and focus are neutral (no accent
// color), the context menu is far from window height, and the empty sidebar during the first
// start has no collapse or options buttons.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";
import { treeHelpers } from "../lib/tree.js";
import { auditLayout } from "../lib/layout-audit.js";

const test = guarded(nodeTest, () => app);
let app;
const T = treeHelpers(() => app);
before(async () => (app = await launch({ width: 1280, height: 800 })));
after(async () => app?.close());

const THEMES = [
  ["light", "arcalo-light"],
  ["dark", "arcalo-dark"],
  ["light", "contrast-light"],
  ["dark", "contrast-dark"],
];
const SIZES = [
  [900, 640],
  [1280, 800],
  [1920, 1080],
];
const ids = {};

async function theme(mode, id) {
  const view = await app.invoke("settings_get");
  const ap = { ...view.settings.appearance };
  if (mode === "light") ap.theme_light = id;
  else ap.theme_dark = id;
  await app.invoke("settings_save", { settings: { ...view.settings, theme: mode, appearance: ap } });
  await app.browser.refresh();
  await app.browser.waitUntil(async () => app.browser.execute(() => document.body.classList.contains("ready")), { timeout: 20000, timeoutMsg: "not ready after the reload" });
  await app.browser.waitUntil(async () => (await app.browser.execute(() => document.documentElement.dataset.themeId)) === id, { timeoutMsg: `theme ${id} not applied` });
  await app.waitFor(".sidebar .tree-row");
}

/** Whether a CSS color is the theme's accent (or a mix with it): drop and focus states must not be. */
const accentIn = (prop, sel) =>
  app.browser.execute(
    (prop, sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const probe = document.createElement("span");
      probe.style.color = "var(--accent)";
      document.body.append(probe);
      const accent = getComputedStyle(probe).color.match(/\d+/g).slice(0, 3).join(",");
      probe.remove();
      const st = getComputedStyle(el);
      const values = prop.split(",").map((p) => st.getPropertyValue(p.trim()));
      return values.some((v) => (v.match(/rgba?\(([^)]+)\)/g) ?? []).some((c) => c.match(/\d+(\.\d+)?/g).slice(0, 3).map(Math.round).join(",") === accent));
    },
    prop,
    sel,
  );

const rowLook = (title) =>
  app.browser.execute((t) => {
    const r = [...document.querySelectorAll(".sidebar .tree-row")].find((x) => x.querySelector(".tree-label")?.textContent === t);
    const st = getComputedStyle(r);
    return { bg: st.backgroundColor, shadow: st.boxShadow, weight: st.fontWeight, check: !!r.querySelector(".tree-check") };
  }, title);

test("setup: a project tree with a long title and a sorted folder", async () => {
  ids.p = (await T.create("Kunde Bäckerei Großmann")).id;
  for (const t of ["Angebot Bäckerei", "Kickoff Bäckerei", "Anforderungen Bäckerei mit einem langen Titel"]) ids[t] = (await T.create(t, ids.p)).id;
  ids.deep = (await T.create("Fachkonzept Schnittstelle Warenwirtschaft", ids["Anforderungen Bäckerei mit einem langen Titel"])).id;
  ids.sorted = (await T.create("Archiv sortiert")).id;
  for (const t of ["Zeta", "Alpha"]) await T.create(t, ids.sorted);
  await app.invoke("folder_style_set", { pageId: ids.sorted, style: { sort: "name", folders_first: false, color: "info" } });
  await T.reload();
  for (const f of ["Kunde Bäckerei Großmann", "Anforderungen Bäckerei mit einem langen Titel", "Archiv sortiert"]) {
    const r = await T.row(f);
    if ((await r.getAttribute("aria-expanded")) === "false") await (await r.$(".tree-twisty")).click();
  }
});

const problems = [];
for (const [mode, id] of THEMES) {
  test(`${id}: the tree's states at 900, 1280 and 1920 px`, async () => {
    await theme(mode, id);
    await T.openPage(ids.deep, "Fachkonzept Schnittstelle Warenwirtschaft");
    for (const [w, h] of SIZES) {
      await app.browser.setWindowSize(w, h);
      await T.sleep(300);
      const sidebarW = await app.browser.execute(() => document.querySelector(".sidebar").getBoundingClientRect().width);
      if (w === 900) assert.ok(sidebarW >= 239, `sidebar ${sidebarW} px at 900`);
      await T.openPage(ids.deep, "Fachkonzept Schnittstelle Warenwirtschaft");
      await app.shot(`389-${id}-${w}-default`);
      // Hover: the buttons lie over the title's end; the title keeps its width.
      const label = () => app.browser.execute(() => document.querySelector(".sidebar .tree-row.active .tree-label").getBoundingClientRect().width);
      const before = await label();
      await (await T.row("Fachkonzept Schnittstelle Warenwirtschaft")).moveTo();
      await app.waitFor(".sidebar .tree-row.active .tree-row-actions");
      assert.ok(Math.abs((await label()) - before) < 1, "the hover buttons do not squeeze the title");
      await app.shot(`389-${id}-${w}-hover`);
      // Selection next to the open page: they look different.
      await app.browser.execute(() => {
        const row = (t) => [...document.querySelectorAll(".sidebar .tree-row")].find((r) => r.querySelector(".tree-label")?.textContent === t);
        row("Angebot Bäckerei").dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
        row("Kickoff Bäckerei").dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
        row("Fachkonzept Schnittstelle Warenwirtschaft").dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
      });
      await app.waitFor(".tree-selection");
      const active = await rowLook("Fachkonzept Schnittstelle Warenwirtschaft");
      const sel = await rowLook("Kickoff Bäckerei");
      assert.ok(sel.check && !active.check, "a selected row shows a check");
      assert.notEqual(active.bg, sel.bg, "open and selected differ in tint");
      if (id.startsWith("contrast")) assert.notEqual(active.shadow, sel.shadow, "and in their edge");
      assert.ok(Number(active.weight) > Number((await rowLook("Angebot Bäckerei")).weight) || active.weight === "500");
      problems.push(...(await app.browser.execute(auditLayout, ".sidebar")).map((p) => `${id} ${w} selection: ${p}`));
      await app.shot(`389-${id}-${w}-selection`);
      await app.browser.execute(() => document.querySelector(".tree-selection [aria-label='Auswahl aufheben']").click());
      // A drop into a page and between pages: neutral.
      await app.browser.execute(() => {
        const row = (t) => [...document.querySelectorAll(".sidebar .tree-row")].find((r) => r.querySelector(".tree-label")?.textContent === t);
        const dt = new DataTransfer();
        window.__dt = dt;
        row("Angebot Bäckerei").dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
        const r = row("Kickoff Bäckerei").getBoundingClientRect();
        row("Kickoff Bäckerei").dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 50, clientY: r.top + r.height / 2 }));
      });
      await app.waitFor(".sidebar .tree-row.drop-inside");
      assert.equal(await accentIn("background-color,box-shadow,outline-color", ".sidebar .tree-row.drop-inside"), false, "drop into a page: no accent");
      await app.shot(`389-${id}-${w}-drop-inside`);
      await app.browser.execute(() => {
        const row = (t) => [...document.querySelectorAll(".sidebar .tree-row")].find((r) => r.querySelector(".tree-label")?.textContent === t);
        const r = row("Kickoff Bäckerei").getBoundingClientRect();
        row("Kickoff Bäckerei").dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: window.__dt, clientX: r.left + 50, clientY: r.bottom - 2 }));
      });
      await app.waitFor(".sidebar .tree-row.drop-after");
      const line = await app.browser.execute(() => {
        const r = document.querySelector(".sidebar .tree-row.drop-after");
        const st = getComputedStyle(r, "::after");
        return { left: parseFloat(st.left), bg: st.backgroundColor, icon: r.querySelector(".tree-icon").getBoundingClientRect().left - r.getBoundingClientRect().left };
      });
      assert.ok(line.left >= line.icon - 1, `the line starts at the drop depth (${line.left} vs ${line.icon})`);
      await app.shot(`389-${id}-${w}-drop-line`);
      // The sorted folder: refused with a hint.
      await app.browser.execute(() => {
        const row = (t) => [...document.querySelectorAll(".sidebar .tree-row")].find((r) => r.querySelector(".tree-label")?.textContent === t);
        const dt = new DataTransfer();
        row("Alpha").dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
        row("Zeta").scrollIntoView({ block: "nearest" });
        const r = row("Zeta").getBoundingClientRect();
        row("Zeta").dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 50, clientY: r.top + 2 }));
      });
      await app.browser.waitUntil(async () => app.browser.execute(() => !!document.querySelector(".sidebar .tree-drop-hint")), { timeoutMsg: "no hint for the sorted folder" });
      await app.shot(`389-${id}-${w}-drop-refused`);
      await app.browser.execute(() => document.querySelector(".sidebar .tree-row").dispatchEvent(new DragEvent("dragend", { bubbles: true })));
      await app.browser.waitUntil(async () => (await app.$$(".sidebar .tree-drop-hint, .sidebar .drop-inside, .sidebar .drop-after")).length === 0, { timeoutMsg: "drop markers stayed" });
      // Keyboard focus: neutral.
      await app.browser.execute(() => document.querySelector(".sidebar .tree-row.active").focus());
      await app.keys(["ArrowUp"]);
      await app.keys(["ArrowDown"]);
      assert.equal(await accentIn("outline-color,box-shadow", ".sidebar .tree-row:focus-visible"), false, "focus: no accent");
      // The filter with its marks.
      await app.browser.execute(() => {
        const i = document.querySelector(".sidebar .tree-filter input");
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(i, "Kunde/schnitt");
        i.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await app.waitFor(".sidebar .tree-mark");
      await app.shot(`389-${id}-${w}-filter`);
      problems.push(...(await app.browser.execute(auditLayout, ".sidebar")).map((p) => `${id} ${w} filter: ${p}`));
      await app.browser.execute(() => document.querySelector(".sidebar .tree-filter [aria-label='Filter leeren']").click());
      // The context menu: well below window height.
      await T.rowMenu("Kunde Bäckerei Großmann");
      const menu = await app.browser.execute(() => document.querySelector(".menu").getBoundingClientRect().height);
      assert.ok(menu < h * 0.85, `menu ${menu} px of ${h}`);
      await app.shot(`389-${id}-${w}-menu`);
      await T.menuClick("Symbol ändern…");
      await app.waitFor(".tree-style-pop");
      const pop = await app.browser.execute(() => {
        const r = document.querySelector(".tree-style-pop").getBoundingClientRect();
        return r.bottom <= innerHeight && r.right <= innerWidth && r.left >= 0 && r.top >= 0;
      });
      assert.ok(pop, "the icon popover stays in the window");
      await app.shot(`389-${id}-${w}-icons`);
      await app.keys(["Escape"]);
      await app.browser.waitUntil(async () => (await app.$$(".tree-style-pop")).length === 0);
    }
    await app.browser.setWindowSize(1280, 800);
  });
}

test("no clipped or overflowing controls in the sidebar", () => {
  assert.deepEqual(problems, []);
});

test("an empty workspace (first start) shows no collapse or options buttons", async () => {
  const empty = await launch({ demo: false, onboarding: true, width: 1280, height: 800 });
  try {
    await empty.browser.pause(800);
    const buttons = await empty.browser.execute(() => [...document.querySelectorAll(".sidebar .side-toolbar button")].map((b) => b.getAttribute("aria-label")));
    assert.ok(!buttons.some((l) => /einklappen|aufklappen|Baumoptionen/.test(l ?? "")), buttons.join(", "));
    assert.equal(await empty.browser.execute(() => !!document.querySelector(".sidebar .tree-filter")), false);
    await empty.shot("389-empty-first-start");
  } finally {
    await empty.close();
  }
});
