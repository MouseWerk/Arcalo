// Window backdrop (Settings → Darstellung „Hintergrundeffekt“, „Deckkraft“). Linux has no Mica,
// so ANNALO_TEST_BACKDROP=1 makes the shell offer Mica and Acrylic and report the chosen one as
// active without touching the window; the page then paints its translucent layers, and a
// magenta page background stands in for the desktop. Checked: the effect choice, the slider
// (live while dragged, saved when let go, off without an effect), one base layer with every
// panel transparent over it, and in the pixels of screenshots: no column between the ribbon,
// the sidebar, the split panes and the side panel lets more of the backdrop through than the
// panels beside it (the reported see-through line), at 40, 80 and 100 %, light and dark.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { launch, guarded, SHOTS } from "../lib/harness.js";
import { readPng } from "../lib/png.js";

const test = guarded(nodeTest, () => app);
let app;
before(async () => (app = await launch({ width: 1480, height: 900, env: { ANNALO_TEST_BACKDROP: "1" } })));
after(async () => app?.close());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settings = async () => (await app.invoke("settings_get")).settings.appearance;
/** Alpha of an element's background color (0 = transparent). */
const alphas = (sels) =>
  app.browser.execute((list) => {
    const out = {};
    for (const s of list) {
      const el = document.querySelector(s);
      const bg = el ? getComputedStyle(el).backgroundColor : "";
      const m = /rgba?\(([^)]+)\)|color\(srgb ([^)]+)\)/.exec(bg);
      const parts = m ? (m[1] ?? m[2]).split(/[\s,/]+/).filter(Boolean) : [];
      out[s] = !el ? null : bg === "transparent" ? 0 : parts.length === 4 ? Number(parts[3]) : 1;
    }
    return out;
  }, sels);
const radios = (label) =>
  app.browser.execute((l) => [...document.querySelectorAll(`.settings [role="radiogroup"][aria-label="${l}"] [role="radio"]`)].map((b) => ({ text: b.textContent, on: b.getAttribute("aria-checked") === "true" })), label);
const pick = (label, text) =>
  app.browser.execute((l, t) => [...document.querySelectorAll(`.settings [role="radiogroup"][aria-label="${l}"] [role="radio"]`)].find((b) => b.textContent === t).click(), label, text);
const slider = () => app.browser.execute(() => {
  const s = document.querySelector('.settings input[type="range"][aria-label="Deckkraft"]');
  return s && { value: Number(s.value), disabled: s.disabled, shown: s.closest(".opacity-slider").querySelector("output").textContent };
});
/** Drags the slider to `v` (input events like a pointer drag), `release`: lets go (saves). */
const drag = (v, release) =>
  app.browser.execute((value, up) => {
    const s = document.querySelector('.settings input[type="range"][aria-label="Deckkraft"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(s, String(value));
    s.dispatchEvent(new Event("input", { bubbles: true }));
    if (up) s.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  }, v, release);
let headColor = "";
const glass = () => app.browser.execute(() => getComputedStyle(document.documentElement).getPropertyValue("--glass").trim());

test("without an effect: Mica and Acrylic offered, the slider off, the window opaque", async () => {
  await app.keys(["Control", ","]);
  await app.click('.settings-nav-item[data-section="appearance"]');
  await app.waitText(".settings-head h1", /Darstellung/);
  assert.deepEqual(await radios("Hintergrundeffekt"), [{ text: "Aus", on: true }, { text: "Mica", on: false }, { text: "Acrylic", on: false }]);
  assert.deepEqual(await slider(), { value: 80, disabled: true, shown: "80 %" });
  assert.equal(await app.browser.execute(() => document.documentElement.dataset.backdrop ?? null), null);
  const a = await alphas(["body", ".sidebar", ".main"]);
  assert.deepEqual(a, { body: 1, ".sidebar": 1, ".main": 1 }, "solid theme colors");
  headColor = await app.browser.execute(() => getComputedStyle(document.querySelector(".settings-head h1")).color);
});

test("Mica: one base layer, every panel transparent over it", async () => {
  await pick("Hintergrundeffekt", "Mica");
  await app.browser.waitUntil(async () => (await app.browser.execute(() => document.documentElement.dataset.backdrop)) === "mica", { timeoutMsg: "backdrop not shown" });
  await app.browser.waitUntil(async () => (await settings()).window_effect === "mica", { timeoutMsg: "effect not saved" });
  assert.equal((await slider()).disabled, false, "slider on with an effect");
  const a = await alphas(["html", "body", ".app", ".ribbon", ".sidebar", ".side-resizer", ".main", ".pane.active .tabbar", ".statusbar"]);
  assert.deepEqual(a, { html: 0, body: 0.8, ".app": 0, ".ribbon": 0, ".sidebar": 0, ".side-resizer": 0, ".main": 0.8, ".pane.active .tabbar": 0, ".statusbar": 0 });
  // Text colors stay those of the theme.
  assert.equal(await app.browser.execute(() => getComputedStyle(document.querySelector(".settings-head h1")).color), headColor);
});

test("the opacity slider applies live while dragged and saves once let go", async () => {
  await drag(62, false);
  assert.equal(await glass(), "0.62");
  assert.equal((await alphas(["body"])).body, 0.62, "base layer follows live");
  assert.equal((await slider()).shown, "62 %");
  await sleep(300);
  assert.equal((await settings()).window_opacity, 80, "nothing saved while dragging");
  await drag(45, false);
  await drag(50, true);
  await app.browser.waitUntil(async () => (await settings()).window_opacity === 50, { timeoutMsg: "opacity not saved" });
  assert.equal((await alphas(["body"])).body, 0.5);
  // The lower end keeps content readable.
  await drag(10, true);
  assert.equal((await slider()).value, 40);
  await app.browser.waitUntil(async () => (await settings()).window_opacity === 40);
  // Switched off: opaque again, the slider keeps its value but is off.
  await pick("Hintergrundeffekt", "Aus");
  await app.browser.waitUntil(async () => (await app.browser.execute(() => document.documentElement.dataset.backdrop ?? null)) === null);
  assert.deepEqual(await slider(), { value: 40, disabled: true, shown: "40 %" });
  assert.equal((await alphas(["body"])).body, 1);
  await pick("Hintergrundeffekt", "Acrylic");
  await app.browser.waitUntil(async () => (await app.browser.execute(() => document.documentElement.dataset.backdrop)) === "acrylic");
});

/** Share of the magenta page background in a pixel (0: none shows, 1: a hole). */
const magenta = ([r, g, b]) => ((r + b) / 2 - g) / 255;

/**
 * Checks every seam in a screenshot: no column around it shows more of the backdrop than the
 * panels beside it or the base layer alone (1 − opacity). A hole would show all of it.
 */
async function seams(name, pct) {
  const chrome = 1 - pct / 100;
  await app.dismissToasts();
  await sleep(200);
  const geo = await app.browser.execute(() => {
    const r = (s) => document.querySelector(s)?.getBoundingClientRect();
    const panes = [...document.querySelectorAll(".workspace > .pane")].map((p) => p.getBoundingClientRect());
    return {
      w: innerWidth,
      h: innerHeight,
      seams: {
        ribbon: r(".ribbon").right,
        sidebar: r(".sidebar").right,
        split: panes[1]?.left,
        panel: r(".app > .panel")?.left,
      },
    };
  });
  assert.ok(geo.seams.split, `split view open: ${JSON.stringify(geo)}`);
  const shot = readPng(await app.browser.takeScreenshot());
  fs.writeFileSync(path.join(SHOTS, `${name}.png`), await app.browser.takeScreenshot(), "base64");
  const k = shot.width / geo.w;
  const m = (x, y) => magenta(shot.pixel(Math.round(x * k), Math.round(y * k)));
  // Rows: the tab row, the middle, the lower part and the status bar.
  const rows = [18, Math.round(geo.h * 0.4), Math.round(geo.h * 0.8), geo.h - 12];
  const report = [];
  for (const [seam, x0] of Object.entries(geo.seams).filter(([, x]) => x !== undefined)) {
    for (const y of rows) {
      const around = Math.max(m(x0 - 9, y), m(x0 + 9, y));
      for (let dx = -3; dx <= 3; dx++) {
        const v = m(x0 + dx, y);
        if (v > Math.max(around, chrome) + 0.05) report.push(`${seam} x=${Math.round(x0 + dx)} y=${y}: ${v.toFixed(2)} vs ${around.toFixed(2)}`);
      }
    }
  }
  assert.deepEqual(report, [], `${name}: columns let the backdrop through`);
  return { sidebar: m(geo.seams.sidebar - 30, rows[1]), content: m(geo.seams.split - 60, rows[1]) };
}

test("no see-through seams between sidebar, split panes and panel (40/80/100 %, light and dark)", async () => {
  // Split view: the settings on the left, a page on the right; the side panel open.
  await app.click(".pane.active .tabbar [aria-label='Rechts teilen']");
  await app.browser.waitUntil(async () => (await app.$$(".workspace > .pane")).length === 2);
  await app.browser.execute(() => [...document.querySelectorAll(".sidebar .tree-row")].find((r) => r.textContent.trim() === "Architektur").click());
  await app.waitText(".workspace > .pane:last-child .tab.active .tab-title", /Architektur/);
  assert.equal((await app.$$(".settings")).length, 1);
  await app.browser.execute(() => {
    if (!document.querySelector(".app > .panel")) document.querySelector(".workspace > .pane:last-child .tabbar > button:last-of-type").click();
  });
  await app.waitFor(".app > .panel");
  await app.browser.execute(() => (document.documentElement.style.background = "#ff00ff"));
  const results = {};
  for (const mode of ["Hell", "Dunkel"]) {
    await pick("Modus", mode);
    await sleep(200);
    for (const pct of [40, 80, 100]) {
      await drag(pct, true);
      await app.browser.waitUntil(async () => (await settings()).window_opacity === pct, { timeoutMsg: `${pct} not saved` });
      results[`${mode}-${pct}`] = await seams(`backdrop-seams-${mode === "Hell" ? "light" : "dark"}-${pct}`, pct);
    }
  }
  // The backdrop shows as chosen: the sidebar more than the content, nothing at 100 %.
  for (const mode of ["Hell", "Dunkel"]) {
    const [lo, mid, full] = [40, 80, 100].map((p) => results[`${mode}-${p}`]);
    assert.ok(Math.abs(lo.sidebar - 0.6) < 0.08 && Math.abs(mid.sidebar - 0.2) < 0.06, `${mode} sidebar: ${JSON.stringify(results)}`);
    assert.ok(lo.content < lo.sidebar && mid.content < mid.sidebar && lo.content < 0.45, `${mode} content: ${JSON.stringify(results)}`);
    assert.ok(full.sidebar < 0.02 && full.content < 0.02, `${mode} opaque at 100 %: ${JSON.stringify(results)}`);
  }
  // Without the side panel (80 %), and with the backdrop off: opaque, no seam at all.
  await drag(80, true);
  await app.browser.execute(() => document.querySelector(".workspace > .pane:last-child .tabbar > button:last-of-type").click());
  await app.browser.waitUntil(async () => !(await app.browser.execute(() => !!document.querySelector(".app > .panel"))));
  await app.browser.waitUntil(async () => (await settings()).window_opacity === 80);
  await seams("backdrop-seams-dark-80-no-panel", 80);
  await pick("Hintergrundeffekt", "Aus");
  await app.browser.waitUntil(async () => (await app.browser.execute(() => document.documentElement.dataset.backdrop ?? null)) === null);
  const off = await seams("backdrop-seams-off", 100);
  assert.ok(off.sidebar < 0.02 && off.content < 0.02, `opaque without the effect: ${JSON.stringify(off)}`);
  assert.deepEqual(await app.consoleErrors(), []);
});

test("screenshots over a colorful desktop (for review)", async () => {
  await pick("Hintergrundeffekt", "Mica");
  await app.browser.execute(() => {
    if (!document.querySelector(".app > .panel")) document.querySelector(".workspace > .pane:last-child .tabbar > button:last-of-type").click();
    document.documentElement.style.background = "radial-gradient(circle at 12% 20%, #ff5f6d 0, transparent 38%), radial-gradient(circle at 85% 30%, #2bc0e4 0, transparent 40%), radial-gradient(circle at 50% 95%, #f9d423 0, transparent 45%), linear-gradient(135deg, #3a1c71, #d76d77 55%, #ffaf7b)";
  });
  await app.waitFor(".app > .panel");
  for (const mode of ["Hell", "Dunkel"]) {
    await pick("Modus", mode);
    for (const pct of [40, 80, 100]) {
      await drag(pct, true);
      await app.browser.waitUntil(async () => (await settings()).window_opacity === pct);
      await app.dismissToasts();
      await app.shot(`backdrop-${mode === "Hell" ? "light" : "dark"}-${pct}`);
    }
  }
});
