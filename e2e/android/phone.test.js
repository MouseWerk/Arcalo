// The Android app on an emulator, measured: the debug APK (ARCALO_APK) at 360×800 and 412×915 dp,
// portrait. Every screen (Heute, Aufgaben, Zeit, Notizen, a page, the capture with its three
// kinds, the Leistungsart sheet, the settings) is as wide as the screen, nothing wider, nothing
// tappable under the status or navigation bar (their frames from `dumpsys window`, the WebView's
// from the view tree); the tab bar holds its five tabs on screen, each at least 44 px; the end of
// a long screen is clear of the tab bar; spinners stay small and round. No stock Android UI shows
// on any screen (lib/stockui.js: platform form controls and pickers, a datalist's strip,
// alert/confirm/prompt, tap highlight, selectable chrome, focus rings after a tap, overscroll
// stretch, scrollbars, search fields' keyboards), and with the system's font size at 130 % no
// label is cut off. Screenshots of the whole screen land in e2e/screenshots/android.
//
//   cd e2e && ARCALO_APK=path/to/arcalo-debug.apk node --test android/phone.test.js

import { describe, test as nodeTest, after, before } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { guarded } from "../lib/harness.js";
import * as geo from "../lib/geometry.js";
import * as stock from "../lib/stockui.js";
import * as device from "./device.js";
import { appBarColors, openApp, ready, seed } from "./app.js";

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

before(() => {
  if (APK) device.install(APK);
  device.settle();
});

after(() => {
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
  describe(`Android phone ${W}×${H}`, () => {
    let page;
    let dpr = 2;
    let splash = 0;
    const spinnerLog = [];
    /** The platform's own UI found on the screens so far. */
    const stockFound = [];

    const shot = (name) => device.screencap(path.join(OUT, `android-${W}x${H}-${name}.png`));
    const visible = (sel, timeout = 30000) => page.waitForSelector(sel, { timeout });
    const keepSpinners = async () => spinnerLog.push(...(await page.evaluate(geo.recordedSpinners).catch(() => [])));

    /** The layout checks of the screen shown now, with the bars where they are now. */
    const screen = async (name) => {
      device.dismissSystemDialogs();
      await sleep(700);
      shot(name);
      const where = device.insetsCss(dpr);
      const m = await page.evaluate(geo.measureLayout, where.insets);
      const out = geo.layoutProblems(m);
      stockFound.push(...(await page.evaluate(stock.measureStockUi)).map((f) => `${name}: ${f}`));
      if (Math.abs(m.viewport.w - W) > 1) out.push(`the page is ${m.viewport.w} px wide on a ${W} dp screen`);
      return out.map((p) => `${name}: ${p}`);
    };
    const tab = async (n) => {
      await page.click(`.m-tabbar .m-tab:nth-child(${n})`);
      await sleep(500);
    };

    before(async () => {
      try {
        ({ page, dpr, splash } = await openApp(W, H, "light", { onPage: [geo.recordSpinners, stock.stubDialogs] }));
        await seed(page);
        await page.evaluate(geo.recordSpinners);
      } catch (e) {
        // What the device says, for the artifact and the log.
        console.error(`could not open the app at ${W}×${H}: ${e?.stack ?? e}`);
        device.diagnose(path.join(OUT, `android-${W}x${H}-diagnose.txt`));
        throw e;
      }
    });

    after(async () => {
      await page?.close();
      device.unforward();
    });

    test("lets the splash go as soon as the app is there", async () => {
      // lib/splash.ts: its animation (under 1 s) and the fade once the app marks itself ready,
      // never the 8 s limit. A cold emulator without a GPU runs the timers late (3.3 s seen).
      assert.ok(splash < 6000, `the splash stayed ${splash} ms after the app was drawn (its limit is 8 s)`);
    });

    test("shows Heute on a screen that fits, with the five tabs in reach", async () => {
      await visible(".m-tabbar");
      const problems = await screen("today");
      problems.push(...geo.tabbarProblems(await page.evaluate(geo.measureTabbar)));
      problems.push(...geo.screenEndProblems(await page.evaluate(geo.measureScreenEnd)).map((p) => `today: ${p}`));
      assert.deepEqual(problems, []);
    });

    test("shows the tasks, the time and the notes on screens that fit", async () => {
      const problems = [];
      await tab(2);
      problems.push(...(await screen("tasks")));
      problems.push(...geo.screenEndProblems(await page.evaluate(geo.measureScreenEnd)).map((p) => `tasks: ${p}`));
      await tab(4);
      problems.push(...(await screen("time")));
      problems.push(...geo.screenEndProblems(await page.evaluate(geo.measureScreenEnd)).map((p) => `time: ${p}`));
      await tab(5);
      await visible(".m-tree-page");
      problems.push(...(await screen("notes")));
      await page.click(".m-tree-page", { text: /Posteingang|Eingang|Inbox/ });
      await visible(".m-read");
      problems.push(...(await screen("page")));
      device.back();
      await sleep(600);
      await tab(1);
      assert.deepEqual(problems, []);
    });

    test("captures a note, a task and a booking; the Leistungsart opens the app's own sheet", async () => {
      const problems = [];
      await page.click(".m-tab-capture");
      await visible(".m-sheet");
      problems.push(...(await screen("capture-note")));
      await page.click(".m-seg-opt:nth-child(2)");
      problems.push(...(await screen("capture-task")));
      await page.click(".m-seg-opt:nth-child(3)");
      await visible("#m-zeit-la");
      problems.push(...(await screen("capture-booking")));
      await page.click("#m-zeit-la");
      await visible(".m-choice-sheet");
      problems.push(...(await screen("capture-booking-la")));
      const options = await page.evaluate(() => [...document.querySelectorAll(".m-choice-opt")].map((o) => o.textContent.trim()));
      assert.ok(options.length >= 2, `Leistungsarten in the sheet: ${options}`);
      await page.click(".m-choice-opt:nth-child(2)");
      await page.waitForFunction(() => !document.querySelector(".m-choice-sheet"), undefined, { timeout: 5000 });
      const picked = await page.evaluate(() => document.querySelector("#m-zeit-la")?.textContent.trim());
      assert.equal(picked, options[1], "the picked Leistungsart shows in the field");
      // Back closes the sheet first, then the capture.
      await page.click("#m-zeit-la");
      await visible(".m-choice-sheet");
      device.back();
      await page.waitForFunction(() => !document.querySelector(".m-choice-sheet"), undefined, { timeout: 5000 });
      assert.ok(await page.$(".m-sheet"), "Back closed the sheet, not the capture");
      device.back();
      await page.waitForFunction(() => !document.querySelector(".m-sheet"), undefined, { timeout: 5000 });
      assert.deepEqual(problems, []);
    });

    test("opens the settings on a screen that fits", async () => {
      await tab(1);
      await page.click('.m-head-actions [aria-label="Einstellungen"]');
      await visible(".m-screen .m-section");
      const problems = await screen("settings");
      problems.push(...geo.screenEndProblems(await page.evaluate(geo.measureScreenEnd)).map((p) => `settings: ${p}`));
      shot("settings-end");
      device.back();
      await sleep(600);
      assert.deepEqual(problems, []);
    });

    // R4A-2: Back (or the close button) closed the capture and its text was gone.
    test("keeps the capture's text after Back until it is saved", async () => {
      const value = () => page.evaluate(() => document.querySelector(".m-sheet textarea")?.value ?? null);
      const closed = async () => {
        for (let i = 0; i < 3 && (await page.$(".m-sheet")); i++) {
          device.back();
          await page.waitForFunction(() => !document.querySelector(".m-sheet"), undefined, { timeout: 3000 }).catch(() => {});
        }
        assert.equal(await page.$(".m-sheet"), null, "Back closed the capture");
      };
      // The tab bar is tapped once the keyboard is down and the page has its full height again:
      // a tap aimed while the WebView grew back landed beside the button (run 41870629053).
      const full = await page.evaluate(() => window.innerHeight);
      const capture = async () => {
        await page.waitForFunction((h) => window.innerHeight === h && !document.querySelector(".m-typing"), full, { timeout: 10000 });
        await page.click(".m-tab-capture");
        await visible(".m-sheet textarea");
      };
      await tab(1);
      await page.click(".m-tab-capture");
      await visible(".m-sheet textarea");
      await page.click(".m-seg-opt:nth-child(2)");
      await page.click(".m-sheet textarea");
      await page.insertText("Entwurf: Rückruf beim Kunden");
      await closed();
      await capture();
      await page.waitForFunction(() => document.querySelector(".m-sheet textarea")?.value === "Entwurf: Rückruf beim Kunden", undefined, { timeout: 10000 }).catch(() => {});
      assert.equal(await value(), "Entwurf: Rückruf beim Kunden", "the text typed before Back");
      assert.equal(await page.evaluate(() => document.querySelector(".m-seg-opt[aria-checked='true'], .m-seg-opt.on")?.textContent.trim() ?? null), "Aufgabe", "as a task again");
      // Saved: the next capture starts empty. „Speichern“ pressed in the page: the keyboard the
      // field's focus brings up moves the button while a tap is aimed at it (run 41859894534).
      await page.evaluate(() => document.querySelector(".m-sheet .m-form-actions .m-btn-primary").click());
      await page.waitForFunction(() => !document.querySelector(".m-sheet"), undefined, { timeout: 10000 });
      assert.equal(await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("mobile_capture_draft_get", {})), null, "the draft after saving");
      await capture();
      assert.equal(await value(), "", "the capture after saving");
      await closed();
    });

    // R4A-1: a key stored (here: none for the LiteLLM provider) reads the keys again and builds the
    // AI clients with the settings of before; a save in between was taken back in the running app
    // (the language chosen in the first seconds after the start turned back to English).
    test("keeps a saved setting while the app reads its keys again", async () => {
      const lost = await page.evaluate(async () => {
        const call = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args);
        const out = [];
        for (let i = 0; i < 12; i++) {
          const theme = i % 2 ? "dark" : "light";
          const view = await call("mobile_settings_get", {});
          await Promise.all([call("provider_key_set", { id: "litellm", key: null }), call("mobile_settings_save", { settings: { ...view.settings, theme } })]);
          const now = (await call("mobile_settings_get", {})).settings.theme;
          if (now !== theme) out.push(`round ${i}: saved ${theme}, the app has ${now}`);
        }
        const view = await call("mobile_settings_get", {});
        await call("mobile_settings_save", { settings: { ...view.settings, theme: "light" } });
        return out;
      });
      assert.deepEqual(lost, []);
    });

    test("shows no stock Android UI", async () => {
      const dialogs = await page.evaluate(stock.nativeDialogs);
      assert.deepEqual([...new Set(stockFound)], [], "the platform's own UI");
      assert.deepEqual(dialogs, [], "alert, confirm or prompt called");
    });

    test("colors the system bars like the app, also in the dark theme", async () => {
      await tab(1);
      await page.evaluate(async () => {
        const view = await window.__TAURI_INTERNALS__.invoke("mobile_settings_get", {});
        await window.__TAURI_INTERNALS__.invoke("mobile_settings_save", { settings: { ...view.settings, theme: "dark" } });
      });
      await keepSpinners();
      await page.reload();
      await ready(page);
      await sleep(800);
      const file = path.join(OUT, `android-${W}x${H}-bars-dark.png`);
      device.screencap(file);
      const want = await page.evaluate(appBarColors);
      const got = device.barColors(file);
      if (device.sameColor(want.top, got.top) && device.sameColor(want.bottom, got.bottom)) return;
      // What the shell says when the page asks for the colors itself.
      const direct = await page.evaluate(async (w) => {
        try {
          await window.__TAURI_INTERNALS__.invoke("mobile_bars", { dark: true, top: w.top, bottom: w.bottom });
          return "answered";
        } catch (e) {
          return `refused: ${e}`;
        }
      }, want);
      await sleep(800);
      device.screencap(file.replace(".png", "-direct.png"));
      const after = device.barColors(file.replace(".png", "-direct.png"));
      const log = device.adb("logcat", "-d", "-v", "brief").split("\n").filter((l) => /bar|setBars|ShellPlugin|Tauri/i.test(l)).slice(-15).join("\n");
      assert.fail(`bars ${JSON.stringify(got)}, the app's ${JSON.stringify(want)}; asked directly: ${direct}, then ${JSON.stringify(after)}\n${log}`);
    });

    test("draws every spinner small and round", async () => {
      await keepSpinners();
      assert.deepEqual(geo.spinnerProblems(spinnerLog), []);
    });

    // Last, as it changes a setting of the system. Android hands the new font size to the running
    // app (the manifest keeps the activity, ShellPlugin sets the WebView's text zoom): the page
    // this test drives stays the one on the screen, its text grows. A new activity showed a second
    // WebView with the app from its start (the pictures were of that one, the checks of the old
    // page), and Back then closed the app.
    test("keeps every label whole with the system's font at 130 %", async () => {
      await tab(1);
      // The width of the screen title's text (Heute) in CSS px, or whether it is wider than `min`.
      const titleText = (min) => {
        const h = [...document.querySelectorAll(".m-title")].find((e) => e.getBoundingClientRect().width > 0);
        const r = document.createRange();
        if (h) r.selectNodeContents(h);
        const w = h ? r.getBoundingClientRect().width : 0;
        return min == null ? w : w > min;
      };
      await page.evaluate(() => (window.__fontMark = true));
      const before = await page.evaluate(titleText);
      assert.ok(before > 0, "the title of Heute");
      device.shell("settings put system font_scale 1.3");
      try {
        await page
          .waitForFunction(titleText, before * 1.2, { timeout: 15000 })
          .catch(async (e) => {
            const now = await page.evaluate(titleText).catch(() => null);
            const state = await page.evaluate(() => ({ mark: window.__fontMark === true, visible: document.visibilityState })).catch((x) => x.message);
            throw new Error(`the title's text stayed ${before} px wide (now ${now}) on the driven page ${JSON.stringify(state)}: ${e.message.split("\n")[0]}`);
          });
        const kept = await page.evaluate(() => ({ mark: window.__fontMark === true, visible: document.visibilityState === "visible" }));
        assert.deepEqual(kept, { mark: true, visible: true }, "the same page, shown, after the font size changed");
        const cut = [];
        const look = async (name) => {
          await sleep(800);
          shot(`font-130-${name}`);
          cut.push(...(await page.evaluate(stock.measureStockUi)).filter((f) => f.startsWith("text cut off")).map((f) => `${name}: ${f}`));
        };
        await tab(1);
        await look("today");
        await tab(2);
        await look("tasks");
        await tab(4);
        await look("time");
        await tab(1);
        await page.click('.m-head-actions [aria-label="Einstellungen"]');
        await visible(".m-screen .m-section");
        await look("settings");
        // The Git setup's long title („Git-Synchronisierung einrichten“) wraps, uncut.
        await page.click(".m-gs-entry .m-btn-primary");
        await visible(".m-gs");
        await look("gitsetup");
        const title = await page.evaluate(() => {
          const h = document.querySelector(".m-gs .m-title");
          return { text: h.textContent, cut: h.scrollWidth > h.clientWidth + 1 };
        });
        if (title.cut) cut.push(`gitsetup: the title „${title.text}“ is cut to „…“`);
        device.back();
        await page.waitForSelector(".m-gs-entry");
        device.back();
        await sleep(500);
        assert.deepEqual(cut, []);
      } finally {
        device.shell("settings put system font_scale 1.0");
      }
    });
  });
}
