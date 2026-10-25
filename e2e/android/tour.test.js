// A screenshot tour of the Android app on the emulator, for review and as the baseline of each
// screen: every screen, every menu that opens from it (buttons with aria-haspopup), the sheets,
// at 360×800 and 412×915 dp, light and dark. The whole screen is captured (status and navigation
// bar included) to e2e/screenshots/android/tour-<size>-<theme>/NN-<name>.png. On every picture
// the page is also checked for the platform's own UI (lib/stockui.js); the findings are listed in
// e2e/screenshots/android/stock-ui-findings.txt and printed. The tour fails when it cannot go on
// or when it found the platform's UI; the layout checks are android/phone.test.js's.
//
//   cd e2e && ARCALO_APK=path/to/arcalo-debug.apk node --test android/tour.test.js

import { test as nodeTest, after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { guarded } from "../lib/harness.js";
import * as stock from "../lib/stockui.js";
import * as device from "./device.js";
import { appBarColors, openApp, seed } from "./app.js";

const OUT = path.resolve(import.meta.dirname, "../screenshots/android");
const APK = process.env.ARCALO_APK;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A failing test leaves the phone's screen behind (FAIL-*.png), as the desktop tests do.
const test = guarded(nodeTest, () => ({ browser: { saveScreenshot: async (file) => device.screencap(file) } }));
const findings = new Map();

before(() => {
  if (APK) device.install(APK);
});

after(() => {
  const lines = [...findings.entries()].map(([f, where]) => `${f}\n    on: ${[...where].join(", ")}`);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "stock-ui-findings.txt"), `${lines.join("\n")}\n`);
  console.log(`stock UI findings (${lines.length}):\n${lines.join("\n")}`);
  try {
    device.resetScreen();
  } catch {
    /* the emulator is gone */
  }
});

for (const [W, H] of [
  [360, 800],
  [412, 915],
]) {
  for (const theme of ["light", "dark"]) {
    test(`tour at ${W}×${H}, ${theme}`, async () => {
      const dir = path.join(OUT, `tour-${W}x${H}-${theme}`);
      let n = 0;
      const found = new Set();
      const { page } = await openApp(W, H, theme, { onPage: [stock.stubDialogs] });
      try {
        await seed(page);

        /** The whole screen as it is now, and what the page shows of the platform's UI. */
        const shot = async (name) => {
          device.dismissSystemDialogs();
          await sleep(700);
          const file = `${String(++n).padStart(2, "0")}-${name}`;
          device.screencap(path.join(dir, `${file}.png`));
          const seen = [...(await page.evaluate(stock.measureStockUi).catch((e) => [`(not measured: ${e.message})`])), ...(await page.evaluate(stock.nativeDialogs).catch(() => []))];
          // The system bars in the app's colors (MobileApp sets them with every theme).
          const want = await page.evaluate(appBarColors);
          const got = device.barColors(path.join(dir, `${file}.png`));
          for (const side of ["top", "bottom"]) {
            if (want[side] && !device.sameColor(want[side], got[side])) seen.push(`system bar ${side === "top" ? "status" : "navigation"}: ${got[side]} on the screen, the app's ${want[side]}`);
          }
          for (const f of seen) {
            found.add(f);
            if (!findings.has(f)) findings.set(f, new Set());
            findings.get(f).add(`${W}x${H}-${theme}/${file}`);
          }
        };
        /** Every menu the screen offers: opened, pictured, closed again with Back. */
        const menus = async (where) => {
          const count = await page.evaluate(() => [...document.querySelectorAll("[aria-haspopup]")].filter((b) => b.getBoundingClientRect().width > 0).length);
          for (let i = 0; i < count; i++) {
            const at = await page.evaluate((k) => {
              const b = [...document.querySelectorAll("[aria-haspopup]")].filter((x) => x.getBoundingClientRect().width > 0)[k];
              if (!b) return null;
              b.scrollIntoView({ block: "nearest" });
              const r = b.getBoundingClientRect();
              return { x: r.left + r.width / 2, y: r.top + r.height / 2, label: (b.getAttribute("aria-label") || b.textContent || "").trim().slice(0, 24) };
            }, i);
            if (!at) continue;
            await page.clickAt(at.x, at.y);
            await shot(`${where}-menu-${at.label.replace(/[^a-z0-9äöüß]+/gi, "-").toLowerCase() || i}`);
            device.back();
            await sleep(500);
          }
        };
        /** Back until the tab bar shows (a keyboard, an edit mode and a stacked screen each take one). */
        const toTabs = async () => {
          for (let i = 0; i < 4 && !(await page.evaluate(() => !!document.querySelector(".m-tabbar")).catch(() => false)); i++) {
            device.back();
            await sleep(500);
          }
        };
        const tab = async (k) => {
          await page.click(`.m-tabbar .m-tab:nth-child(${k})`);
          await sleep(600);
        };
        /** One part of the tour: a failure is noted (with a picture) and the tour goes on from
         *  „Heute“. */
        const broken = [];
        const section = async (name, f) => {
          try {
            await f();
          } catch (e) {
            broken.push(`${name}: ${e.message.split("\n")[0]}`);
            device.screencap(path.join(dir, `FAIL-${name}.png`));
            await toTabs();
            if (!device.inFront()) device.bringToFront();
            await tab(1).catch(() => {});
          }
        };

        await section("today", async () => {
          await tab(1);
          await shot("today");
          await menus("today");
        });
        await section("tasks", async () => {
          await tab(2);
          await shot("tasks");
          await menus("tasks");
          const segs = await page.evaluate(() => [...document.querySelectorAll(".m-seg-opt")].map((b) => b.textContent.trim()));
          for (const [i, label] of segs.entries()) {
            await page.click(`.m-seg-opt:nth-child(${i + 1})`);
            await shot(`tasks-${label.toLowerCase().replace(/[^a-z0-9äöüß]+/g, "-")}`);
          }
        });
        await section("time", async () => {
          await tab(4);
          await shot("time");
          await menus("time");
          if (await page.$("#m-zeit-la")) {
            await page.click("#m-zeit-la");
            await page.waitForSelector(".m-choice-sheet");
            await shot("time-leistungsart");
            device.back();
            await sleep(500);
          }
        });
        await section("notes", async () => {
          await tab(5);
          await page.waitForSelector(".m-tree-page");
          await shot("notes");
          await menus("notes");
          await page.click(".m-tree-page", { text: /Posteingang|Eingang|Inbox/ });
          await page.waitForSelector(".m-read");
          await shot("page");
          await menus("page");
          await page.click(".m-head-actions .m-icon-btn");
          await sleep(800);
          await shot("page-edit");
          await toTabs();
        });
        await section("search", async () => {
          await tab(5);
          if (await page.$('.m-app input[type="search"]')) {
            await page.click('.m-app input[type="search"]');
            await sleep(1200);
            await shot("notes-search-keyboard");
            device.back();
            await sleep(500);
          }
        });
        await section("capture", async () => {
          await tab(1);
          await page.click(".m-tab-capture");
          await page.waitForSelector(".m-sheet");
          await sleep(1200);
          await shot("capture-note");
          await page.click(".m-seg-opt:nth-child(2)");
          await shot("capture-task");
          await page.click(".m-seg-opt:nth-child(3)");
          await shot("capture-booking");
          await page.click("#m-zeit-la");
          await page.waitForSelector(".m-choice-sheet");
          await shot("capture-booking-leistungsart");
          device.back();
          await sleep(400);
          device.back();
          await sleep(600);
          if (await page.$(".m-sheet")) {
            device.back();
            await sleep(600);
          }
        });
        await section("settings", async () => {
          await tab(1);
          await page.click('.m-head-actions [aria-label="Einstellungen"]');
          await page.waitForSelector(".m-screen .m-section");
          await shot("settings");
          await menus("settings");
          const heights = await page.evaluate(() => {
            const s = [...document.querySelectorAll(".m-app *")].find((el) => el.scrollHeight > el.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(el).overflowY));
            return s ? { total: s.scrollHeight, view: s.clientHeight } : { total: 0, view: 1 };
          });
          for (let k = 1; k * heights.view < heights.total && k < 8; k++) {
            await page.evaluate((y) => {
              const s = [...document.querySelectorAll(".m-app *")].find((el) => el.scrollHeight > el.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(el).overflowY));
              if (s) s.scrollTop = y;
            }, k * heights.view * 0.9);
            await shot(`settings-${k + 1}`);
          }
          device.back();
          await sleep(600);
        });

        assert.deepEqual(broken, [], "parts of the tour that could not be shown");
        assert.deepEqual([...found], [], "the platform's own UI on the screens");
      } finally {
        await page.close();
        device.unforward();
      }
    });
  }
}
