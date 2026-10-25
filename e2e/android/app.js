// The app on the emulator from its first start, as the phone tests and the tour use it: data
// cleared, the screen set to `w`×`h` dp, the page connected over its DevTools socket, German and
// the given theme in the settings, and some notes, tasks and an inbox page to show.

import * as device from "./device.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The app shell after a (re)load. */
export async function ready(page) {
  await page.waitForFunction(() => !!document.querySelector(".m-tabbar"), undefined, { timeout: 60000 });
  await sleep(500);
}

/** Starts the app fresh at `w`×`h` dp in `theme` ("light" or "dark"); `onPage`: functions that
 *  run in every document before the app (dialog stubs, the spinner log). */
export async function openApp(w, h, theme, { onPage = [] } = {}) {
  const step = (what) => console.log(`${w}×${h} ${theme}: ${what}`);
  device.fresh();
  device.setScreen(w, h, 2);
  const pid = await device.start();
  step(`started, pid ${pid}`);
  const page = await device.connect(pid);
  for (const f of onPage) await page.addInitScript(f);
  await page.waitForFunction(() => window.__TAURI_INTERNALS__ != null, undefined, { timeout: 60000 });
  // German whatever the emulator's language (the labels the steps look for), and the theme.
  await page.evaluate(async (t) => {
    const view = await window.__TAURI_INTERNALS__.invoke("mobile_settings_get", {});
    await window.__TAURI_INTERNALS__.invoke("mobile_settings_save", { settings: { ...view.settings, language: "de", theme: t } });
  }, theme);
  step("language and theme set");
  await page.reload();
  await ready(page);
  const dpr = await page.evaluate(() => window.devicePixelRatio);
  console.log(`connected at ${w}×${h}: ${page.url()}, ${await page.evaluate(() => `${innerWidth}×${innerHeight}`)} at ${dpr}x`);
  return { page, dpr };
}

/** Notes, tasks due today and an inbox page, as the capture writes them; the page reloaded. */
export async function seed(page) {
  await page.evaluate(async () => {
    const capture = (text, inbox) => window.__TAURI_INTERNALS__.invoke("mobile_capture", { text, inbox });
    await capture("Abstimmung mit dem Vertrieb: Termine für die Schulung im November festlegen.", false);
    for (let i = 1; i <= 12; i++) await capture(`- [ ] Aufgabe ${i}: Angebot für Kunde ${i} prüfen und zurückmelden due:today`, false);
    await capture("Idee: die Wochenplanung am Montag mit der Retro verbinden.", true);
    await capture("Buchtipp: Gute Entscheidungen in unsicheren Zeiten.", true);
  });
  await page.reload();
  await ready(page);
}
