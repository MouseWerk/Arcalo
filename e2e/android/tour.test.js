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
import { startFakeJira } from "../lib/fake-jira.js";
import * as stock from "../lib/stockui.js";
import * as device from "./device.js";
import { appBarColors, openApp, seed } from "./app.js";

const OUT = path.resolve(import.meta.dirname, "../screenshots/android");
const APK = process.env.ARCALO_APK;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A failing test leaves the phone's screen behind (FAIL-*.png), as the desktop tests do, and what
// the device says (FAIL-*-diagnose.txt: the process, the crash buffer, the end of the log).
const test = guarded(nodeTest, () => ({
  browser: {
    saveScreenshot: async (file) => {
      device.screencap(file);
      device.diagnose(file.replace(/\.png$/, "-diagnose.txt"));
    },
  },
}));
const findings = new Map();

before(() => {
  if (APK) device.install(APK);
  device.settle();
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
          // With the keyboard up the bottom is the keyboard's own bar.
          for (const side of device.keyboardShown() ? ["top"] : ["top", "bottom"]) {
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
            // What it opened is on the picture (a picture of the closed screen hid that a menu
            // never opened, or opened only after the screenshot): a sheet or menu laid out with a
            // size, as the sheet's own step waits for it.
            await page
              .waitForFunction(
                () =>
                  [...document.querySelectorAll('[role="dialog"][aria-modal="true"], [role="menu"]')].some((e) => {
                    const r = e.getBoundingClientRect();
                    const s = getComputedStyle(e);
                    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
                  }),
                undefined,
                { timeout: 5000 },
              )
              .catch(() => {
                throw new Error(`the menu of „${at.label}“ on ${where} did not open`);
              });
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
          const end = await page.evaluate(() => {
            const s = document.querySelector(".m-scroll");
            if (!s || s.scrollHeight <= s.clientHeight + 1) return false;
            s.scrollTop = s.scrollHeight;
            return true;
          });
          if (end) await shot("today-end");
        });
        await section("daily", async () => {
          await tab(1);
          await page.click(".m-row", { text: /Tagesnotiz/ });
          await page.waitForSelector(".m-head-back");
          await page.waitForFunction(() => !document.querySelector(".m-loading"));
          await shot("daily");
          await menus("daily");
          // The day before: no note yet, the empty state with its button.
          await page.click('.m-head-actions [aria-label="Vorheriger Tag"]');
          await page.waitForFunction(() => !document.querySelector(".m-loading"));
          await shot("daily-yesterday");
          await toTabs();
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
          await page.click(".m-tree-toggle");
          await page.waitForSelector('.m-tree-toggle[aria-expanded="true"]');
          await shot("notes-tree-open");
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
            const title = () => page.evaluate(() => getComputedStyle(document.querySelector(".m-title")).fontSize);
            const before = await title();
            await page.click('.m-app input[type="search"]');
            await sleep(1200);
            await shot("notes-search-keyboard");
            if (device.keyboardShown()) {
              // The tab bar steps aside for the keyboard (it rode on it, switched to its sideways
              // layout and cut off „Zeit“ and „Notizen“), and the header keeps its size.
              const bar = await page.evaluate(() => {
                const b = document.querySelector(".m-tabbar");
                return b ? b.getBoundingClientRect().height : 0;
              });
              assert.equal(bar, 0, "the tab bar is hidden while the keyboard is up");
              assert.equal(await title(), before, "the title keeps its size with the keyboard up");
            }
            await page.insertText("Retro");
            await sleep(1200);
            await shot("notes-search-hits");
            await page.evaluate(() => {
              const i = document.querySelector('.m-app input[type="search"]');
              const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
              set.call(i, "");
              i.dispatchEvent(new Event("input", { bubbles: true }));
            });
            await page.insertText("Quartalsbericht Zebra");
            await sleep(1200);
            await shot("notes-search-none");
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
          if (device.keyboardShown()) {
            // The note's field gives way to the keyboard; „Speichern“ stays above it.
            const save = await page.evaluate(() => {
              const b = document.querySelector(".m-sheet .m-form-actions .m-btn-primary");
              const r = b.getBoundingClientRect();
              return { bottom: Math.round(r.bottom), view: Math.round(Math.min(window.innerHeight, window.visualViewport?.height ?? window.innerHeight)) };
            });
            assert.ok(save.bottom <= save.view, `„Speichern“ ends at ${save.bottom} px, the keyboard begins at ${save.view} px`);
          }
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
        await section("gitsetup", async () => {
          await tab(1);
          await page.click('.m-head-actions [aria-label="Einstellungen"]');
          await page.waitForSelector(".m-gs-entry");
          await page.click(".m-gs-entry .m-btn-primary");
          await page.waitForSelector(".m-gs");
          await shot("gitsetup-provider");
          await page.click(".m-gs-provider");
          await shot("gitsetup-github");
          await page.click(".m-gs-actions .m-btn-primary");
          await page.waitForSelector("#m-gs-token");
          await shot("gitsetup-token");
          // Back goes a step back, then closes the setup.
          device.back();
          await page.waitForSelector(".m-gs-provider");
          device.back();
          await page.waitForSelector(".m-gs-entry");
          await page.click(".m-gs-entry .m-btn-quiet");
          await page.waitForSelector("#m-git-url");
          await shot("settings-manual");
          await toTabs();
        });
        // Last, as it leaves the phone app: the full app („Oberfläche auf Android: Vollständig“)
        // on the phone with a Jira issue open (1.22), as e2e/tests/153-issue-view-phone.test.js
        // shows it on the desktop at phone size. The fake Jira runs here; `adb reverse` gives the
        // emulator its port.
        await section("full-app-jira", async () => {
          const jira = await startFakeJira({ flavor: "cloud" });
          const port = new URL(jira.url).port;
          device.adb("reverse", `tcp:${port}`, `tcp:${port}`);
          try {
            await page.evaluate(async (url) => {
              const call = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args);
              await call("jira_site_save", {
                site: { id: "", name: "Acme", color: "", kind: "cloud", url, email: "mia@firma.de", enabled: true, log_work: false, allow_writes: false },
                token: "secret-token",
              });
              await call("jira_sync_now", { site: "acme" });
            }, jira.url);
            await tab(1);
            await page.click('.m-head-actions [aria-label="Einstellungen"]');
            await page.click(".m-seg-opt", { text: /^Vollständig$/ });
            await page.waitForFunction(() => !!document.querySelector(".ribbon") && document.body.classList.contains("ready") && !document.getElementById("splash"), undefined, { timeout: 60000 });
            // As wide as the screen (Android widened the page to 515 px to fit the setup's cards).
            assert.equal(await page.evaluate(() => window.innerWidth), W, "the full app's page is as wide as the screen");
            // The data never went through the full app's first run: its intro plays (it keeps the
            // keys, so Strg+K would not reach the palette), then the setup. Both pictured, the
            // setup checked to fit the screen, then closed.
            await page.waitForSelector(".fr-intro");
            await shot("full-app-intro");
            await page.click(".fr-skip");
            await page.waitForSelector(".fr-close");
            await shot("full-app-setup");
            const outside = await page.evaluate(() => {
              const card = document.querySelector(".fr-card").getBoundingClientRect();
              return [".fr-main", ".fr-step", ".fr-foot", ".fr-next"].filter((s) => {
                const e = document.querySelector(s);
                return e && e.getBoundingClientRect().right > card.right + 1;
              });
            });
            assert.deepEqual(outside, [], "parts of the setup past the card's edge");
            await page.click(".fr-close");
            await page.waitForFunction(() => !document.querySelector(".fr-overlay"), undefined, { timeout: 15000 });
            await shot("full-app");
            await page.ctrl("k");
            await page.waitForSelector(".palette input");
            await page.insertText("PROJ-123");
            await page.waitForFunction(() => (document.querySelector(".pal-item.sel")?.textContent ?? "").includes("PROJ-123"), undefined, { timeout: 15000 });
            await page.key("Enter");
            const V = (sel) => `[data-issue-view="PROJ-123"] ${sel}`;
            await page.waitForSelector(V(".iv-summary"), { timeout: 30000 });
            await page.waitForFunction((s) => !document.querySelector(s), V(".iv-refreshing"), { timeout: 30000 });
            const box = await page.evaluate(() => {
              const r = document.querySelector(".iv").getBoundingClientRect();
              const main = document.querySelector(".iv-main").getBoundingClientRect();
              const side = document.querySelector(".iv-side").getBoundingClientRect();
              return {
                at: [r.x, r.y, Math.round(r.width), Math.round(r.height)],
                view: [0, 0, window.innerWidth, window.innerHeight],
                wide: [".iv", ".iv-scroll", ".iv-main", ".iv-side"].filter((s) => {
                  const e = document.querySelector(s);
                  return e.scrollWidth > e.clientWidth + 1;
                }),
                stacked: side.top >= main.bottom - 1,
                small: [...document.querySelectorAll(".iv-head-actions .icon-btn")].filter((b) => b.getBoundingClientRect().height < 44).map((b) => b.getAttribute("aria-label")),
              };
            });
            await shot("full-app-issue");
            await page.evaluate(() => (document.querySelector(".iv-scroll").scrollTop = 1400));
            await shot("full-app-issue-details");
            assert.deepEqual(box.at, box.view, "the issue fills the screen");
            assert.deepEqual(box.wide, [], "no sideways scrolling");
            assert.ok(box.stacked, "the details below the description");
            assert.deepEqual(box.small, [], "header buttons under 44 px");
          } finally {
            await jira.close();
            try {
              device.adb("reverse", "--remove", `tcp:${port}`);
            } catch {
              /* gone */
            }
          }
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
