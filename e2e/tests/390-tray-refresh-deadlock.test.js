// The tray is refreshed from other threads (the 30-second tick, timer and voice commands) while the
// window takes its lock too (settings saves, `desktop_info`). A tray call waits for the main
// thread; made under the lock, the window froze for good once both met (CI, 115: time tracking off,
// a settings save in the moment of the tick). Bursts of both, with time tracking off and on.
// The tray icon's reference count is not atomic: a copy of it on another thread aborted the app
// ("RefCell already borrowed", CI soak), so the tray is only ever touched on the main thread.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;

before(async () => {
  app = await launch({ demo: false });
});
after(async () => {
  await app?.close();
});

async function setTimeTracking(on) {
  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", { settings: { ...view.settings, time: { ...view.settings.time, enabled: on } } });
}

/**
 * For `ms`: `timer_discard` (async, refreshes the tray on a worker thread; no timer runs, so it
 * changes nothing) against `desktop_info` (on the main thread, reads the tray under its lock);
 * with `toggle` each round also switches time tracking (the save rebuilds the tray menu).
 */
const burst = (ms, toggle) =>
  app.browser.executeAsync(
    (ms, toggle, done) => {
      const inv = window.__TAURI_INTERNALS__.invoke;
      const end = Date.now() + ms;
      let rounds = 0;
      (async () => {
        while (Date.now() < end) {
          const jobs = [];
          for (let i = 0; i < 4; i++) jobs.push(inv("timer_discard", {}), inv("desktop_info", {}));
          if (toggle) {
            const { settings } = await inv("settings_get", {});
            jobs.push(inv("settings_save", { settings: { ...settings, time: { ...settings.time, enabled: rounds % 2 === 1 } } }));
          }
          await Promise.all(jobs);
          rounds++;
        }
        done(rounds);
      })().catch((e) => done(String(e)));
    },
    ms,
    toggle,
  );

test("tray refreshes on other threads never hold up the window (time tracking off)", async () => {
  await setTimeTracking(false);
  assert.equal(typeof (await app.invoke("desktop_info")).tray_menu, "object");
  const rounds = await burst(6000, false);
  assert.ok(Number.isInteger(rounds) && rounds > 0, String(rounds));
  // The window still answers.
  assert.equal(await app.browser.execute(() => document.body.classList.contains("ready")), true);
  assert.equal((await app.invoke("desktop_info")).tray_off_main, 0);
});

test("the same while time tracking is switched on and off", async () => {
  const rounds = await burst(6000, true);
  assert.ok(Number.isInteger(rounds) && rounds > 0, String(rounds));
  await setTimeTracking(true);
  const info = await app.invoke("desktop_info");
  if (info.tray_menu) assert.ok(info.tray_menu.includes("stop"), info.tray_menu.join(","));
  assert.equal(info.tray_off_main, 0);
});
