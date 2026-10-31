// The app on the emulator from its first start, as the phone tests and the tour use it: data
// cleared, the screen set to `w`×`h` dp, the page connected over its DevTools socket, German and
// the given theme in the settings, and some notes, tasks and an inbox page to show.

import * as device from "./device.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The app shell after a (re)load, the splash gone; how long the splash stayed after the shell
 *  was there (ms). */
export async function ready(page) {
  await page.waitForFunction(() => !!document.querySelector(".m-tabbar"), undefined, { timeout: 60000 });
  const shell = Date.now();
  await page.waitForFunction(() => !document.getElementById("splash"), undefined, { timeout: 30000 });
  const splash = Date.now() - shell;
  await sleep(300);
  return splash;
}

/** The colors the system bars should have, as `#rrggbb`: the shell's background on top, the tab
 *  bar's (or the screen's) at the bottom; with a sheet open the shell under the sheet's scrim on
 *  top and the sheet's own color at the bottom, where the sheet ends. */
export function appBarColors() {
  const rgba = (c) => {
    const m = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?/.exec(c);
    if (!m) return null;
    const a = m[4] == null ? 1 : m[4].endsWith("%") ? Number(m[4].slice(0, -1)) / 100 : Number(m[4]);
    return [Number(m[1]), Number(m[2]), Number(m[3]), a];
  };
  const hex = (v) => (v ? `#${v.slice(0, 3).map((x) => Math.round(x).toString(16).padStart(2, "0")).join("")}` : null);
  const color = (sel) => {
    const e = document.querySelector(sel);
    return e ? rgba(getComputedStyle(e).backgroundColor) : null;
  };
  const app = color(".m-app");
  const bar = color(".m-tabbar");
  const scrim = color(".m-choice-scrim");
  const sheet = color(".m-choice-sheet");
  const top = scrim && app ? app.map((v, i) => (i < 3 ? scrim[i] * scrim[3] + v * (1 - scrim[3]) : 1)) : app;
  return { top: hex(top), bottom: hex(sheet || bar || app) };
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
    const s = view.settings;
    await window.__TAURI_INTERNALS__.invoke("mobile_settings_save", { settings: { ...s, theme: t, locale: { ...s.locale, language: "de" } } });
  }, theme);
  step("language and theme set");
  await page.reload();
  const splash = await ready(page);
  const dpr = await page.evaluate(() => window.devicePixelRatio);
  console.log(`connected at ${w}×${h}: ${page.url()}, ${await page.evaluate(() => `${innerWidth}×${innerHeight}`)} at ${dpr}x`);
  return { page, dpr, splash };
}

/** A project with two networks and their activities (as the desktop's sync brings them), notes,
 *  tasks due today and an inbox page as the capture writes them; the page reloaded. */
export async function seed(page) {
  await page.evaluate(async () => {
    const call = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args);
    const project = await call("project_create", { code: "PRJ-2026-X", name: "Arcalo Rollout" });
    for (const [nr, description, steps] of [
      ["NP-8801", "Systemintegration", [["1010", "Konzept"], ["1020", "Umsetzung"], ["1030", "Test"]]],
      ["NP-8802", "Schulung", [["2010", "Vorbereitung"]]],
    ]) {
      const np = await call("netzplan_create", { projectId: project.id, netzplanNr: nr, wbsElement: "", description, plannedHours: 40 });
      for (const [vorgangNr, text] of steps) await call("vorgang_create", { netzplanId: np.id, vorgangNr, description: text, durationDays: 1, plannedHours: 8, predecessors: [] });
    }
    const capture = (text, inbox) => call("mobile_capture", { text, inbox });
    // Due dates are ISO days (`due:today` is no syntax: it stayed text, and „Fällig“ was empty).
    const day = (offset) => {
      const d = new Date();
      d.setDate(d.getDate() + offset);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    };
    await capture("Abstimmung mit dem Vertrieb: Termine für die Schulung im November festlegen.", false);
    for (let i = 1; i <= 12; i++) await capture(`- [ ] Aufgabe ${i}: Angebot für Kunde ${i} prüfen und zurückmelden due:${day(i <= 4 ? 0 : i <= 6 ? -1 : i - 5)}${i === 2 ? " !!" : ""}`, false);
    await capture("- [ ] Reisekosten einreichen", false);
    await capture("- [x] Raum für die Retro buchen", false);
    // Bookings of this week (the week list of „Zeit“) and today (the hours on „Heute“).
    await call("mobile_book", { line: "/zeit NP-8801/1020 1h30m #DEV Schnittstelle zum ERP" });
    await call("mobile_book", { line: "/zeit NP-8802/2010 45m Schulungsunterlagen" });
    await capture("Idee: die Wochenplanung am Montag mit der Retro verbinden.", true);
    await capture("Buchtipp: Gute Entscheidungen in unsicheren Zeiten.", true);
  });
  await page.reload();
  await ready(page);
}
