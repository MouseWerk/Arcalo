// Round 5 review of the round 1 to 4 fixes (docs/quality/q124/r5-fix-review.md): what two fixes
// do together, and the paths a fix did not reach.

import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { launch, guarded, APP } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
const run = promisify(execFile);
let app;
before(async () => (app = await launch()));
after(async () => app?.close());

/** Runs the app's program as the command line on the app's workspace. */
const cli = (...args) =>
  run(APP, ["--json", ...args], {
    env: { ...process.env, ARCALO_DATA_DIR: app.dataDir, ARCALO_LOCALE: "de-DE" },
    encoding: "utf8",
    timeout: 30000,
  });

/** A command answered within `ms`, or an error naming it (a hung app never answers). */
const answers = (cmd, ms) =>
  Promise.race([
    app.invoke(cmd),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${cmd} had no answer after ${ms} ms: the app hangs`)), ms)),
  ]);

// R5D-1: a settings write taken over in the background (the command line here, a settings sync
// in the same way) changed a shortcut while holding the settings write lock, and the shortcut is
// registered on the main thread. A settings write from the window waited for that lock on the
// main thread meanwhile: neither went on, and the app hung for good.
// A hung app also stops the WebDriver: the test's own limit ends it.
test("the app keeps answering when the command line changes a shortcut while the window stores a key", { timeout: 240000 }, async () => {
  // The window stores keys without a pause (as the AI settings do when a key is pasted and taken
  // back), each on the main thread and as a settings write; none changes the settings, so each
  // shortcut of the command line is taken over.
  await app.browser.execute(() => {
    window.__r5dSaving = true;
    window.__r5dSaves = 0;
    (async () => {
      while (window.__r5dSaving) {
        await window.__TAURI_INTERNALS__.invoke("api_key_set", { key: null }).catch(() => {});
        window.__r5dSaves++;
      }
    })();
  });
  try {
    for (let i = 0; i < 16; i++) {
      const shortcut = i % 2 ? "Ctrl+Shift+Space" : "Ctrl+Shift+K";
      await cli("settings", "set", "capture_shortcut", shortcut);
      // Asked until it shows the shortcut; an app that hangs fails at once (no retry hides it).
      const until = Date.now() + 15000;
      while ((await answers("settings_get", 10000)).settings.capture_shortcut !== shortcut) {
        assert.ok(Date.now() < until, `round ${i}: the app did not take over the shortcut of the command line`);
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  } finally {
    // A hung app runs no script either: the stop is not waited for then.
    await Promise.race([app.browser.execute(() => (window.__r5dSaving = false)), new Promise((r) => setTimeout(r, 3000))]);
  }
  assert.ok((await app.browser.execute(() => window.__r5dSaves)) > 16, "the window stored keys meanwhile");
  assert.equal((await answers("settings_get", 5000)).settings.capture_shortcut, "Ctrl+Shift+Space");
});

// R5D-4: a dropdown below the fold, scrolled into view and clicked at once (WebDriver's click, a
// field reached with Tab and opened with Space): the scroll is reported after the list opened and
// closed it again (e2e 37 on CI: „… did not open“).
test("a dropdown scrolled into view and opened in the same moment stays open", async () => {
  await app.keys(["Control", ","]);
  await app.waitFor(".settings-head h1");
  for (let i = 0; i < 3; i++) {
    const r = await app.browser.executeAsync((done) => {
      const el = [...document.querySelectorAll('[role="combobox"]')].find((e) => e.getBoundingClientRect().top > window.innerHeight + 100);
      if (!el) return done("no dropdown below the fold");
      el.scrollIntoView({ block: "center" });
      el.click();
      setTimeout(() => {
        const open = el.getAttribute("aria-expanded");
        if (open === "true") el.click();
        // Back to the top for the next round.
        for (const s of document.querySelectorAll("*")) if (s.scrollTop > 0 && s.contains(el)) s.scrollTop = 0;
        done(`${el.getAttribute("aria-label")}: ${open}`);
      }, 300);
    });
    assert.match(r, /: true$/, `round ${i}: ${r}`);
  }
});

// R6D-1 (round 6): the trigger moved after the list was placed, by content above it changing height
// and a scroll the person did not make (the provider rows of „KI & Modelle“ change height while
// their status is checked): the list closed (e2e 37 in the soak of 2026-11-08: „… did not open“).
// It follows the trigger; a scroll the person makes still closes it.
test("a dropdown follows its trigger when content above it changes, closes when the person scrolls", async () => {
  await app.keys(["Control", ","]);
  await app.waitFor(".settings-head h1");
  const r = await app.browser.executeAsync((done) => {
    const frame = () => new Promise((f) => requestAnimationFrame(() => requestAnimationFrame(f)));
    (async () => {
      const area = document.querySelector(".pane.active > .pane-content:not([hidden]) .settings-scroll");
      // A dropdown of the open section in the middle of the view (its scroll done before the click).
      const el = area.querySelector('[role="combobox"]');
      if (!el) return done({ error: "no dropdown in the settings section" });
      el.scrollIntoView({ block: "center" });
      await frame();
      el.click();
      await frame();
      // A row above it gets taller, and the area is scrolled a little (not by the person).
      const spacer = document.createElement("div");
      spacer.style.height = "40px";
      area.querySelector(".settings-body").prepend(spacer);
      area.scrollTop += 1;
      await frame();
      const pop = document.getElementById(el.getAttribute("aria-controls") ?? "");
      const followed = { open: el.getAttribute("aria-expanded"), gap: pop ? Math.round(pop.getBoundingClientRect().top - el.getBoundingClientRect().bottom) : null };
      // Now the person scrolls with the wheel.
      area.dispatchEvent(new WheelEvent("wheel", { deltaY: 60, bubbles: true }));
      area.scrollTop += 60;
      await frame();
      const scrolled = el.getAttribute("aria-expanded");
      spacer.remove();
      area.scrollTop = 0;
      done({ followed, scrolled });
    })();
  });
  assert.equal(r.error, undefined, r.error);
  assert.equal(r.followed.open, "true", "the list stays open when the trigger is moved by the page");
  assert.ok(Math.abs(r.followed.gap - 4) <= 1 || r.followed.gap < 0, `the list sits at the trigger (gap ${r.followed.gap})`);
  assert.equal(r.scrolled, "false", "the person's scroll closes it");
});

// R6D-4: switching the language lays out every text anew; e2e 83 caught „ResizeObserver loop
// completed with undelivered notifications“ (soak of q124-r6d, round 3). Back and forth twenty
// times, the console stays clean (under WebDriver the message names the observers of its frame).
test("switching the language back and forth leaves no ResizeObserver loop", async () => {
  await app.keys(["Control", ","]);
  await app.click('.settings-nav-item[data-section="locale"]');
  const before = (await app.consoleErrors()).length;
  for (let i = 0; i < 20; i++) {
    const lang = i % 2 ? "de" : "en";
    await app.click(`[role="radiogroup"] [role="radio"]:${lang === "de" ? "nth-child(2)" : "last-child"}`);
    await app.browser.waitUntil(async () => (await app.invoke("settings_get")).settings.locale.language === lang, { timeoutMsg: `${lang} not saved` });
    await app.browser.waitUntil(
      async () => app.browser.execute((l) => [...document.querySelectorAll(".ribbon [aria-label]")].some((b) => (l === "de" ? /^Einstellungen/ : /^Settings/).test(b.getAttribute("aria-label"))), lang),
      { timeoutMsg: `UI not ${lang}` },
    );
    await new Promise((r) => setTimeout(r, 150));
  }
  assert.deepEqual((await app.consoleErrors()).slice(before), []);
});
