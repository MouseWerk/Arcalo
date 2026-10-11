// Browser check of the Android companion app's UI (ui/src/mobile): the built UI (`ui/dist`) in
// phone and tablet viewports with Tauri's IPC mocked by fixtures. Every screen is opened by
// tapping through the app in light, dark and high contrast, and the check fails on
//
//   - console errors,
//   - touch targets smaller than 44 px,
//   - anything wider than the screen (horizontal scrolling of the page or a screen),
//   - a command the UI invokes that the Android app does not register (src-tauri/src/mobile/mod.rs),
//   - Android's back button not closing the edit mode, then the screen, then going to „Heute“ and
//     then to the background (never quitting),
//   - the update banner, „Update installieren“ and the permission flow not working,
//   - text shared from another app not opening a capture with it,
//   - the focused field hidden under the on-screen keyboard (the WebView shrinks, as on Android),
//   - layout breaking with Android's font size at 130 %.
//
// It writes a screenshot per screen, size and theme for review (look at them).
//
//   npm --prefix ui run build
//   node e2e/mobile/shots.mjs [--out <folder>] [--lang de|en] [--quick] [--dist <built ui>]
//
// `--quick` takes the two main phone sizes only. Playwright is not a dependency of the
// repository: the script takes the `playwright` package from `e2e/node_modules`, `ui/node_modules`
// or the global npm folder, and its Chromium from PLAYWRIGHT_BROWSERS_PATH (or an installed
// Chrome with ARCALO_CHROME=<path>).

import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(here, "../..");
const dist = resolve(process.argv.includes("--dist") ? process.argv[process.argv.indexOf("--dist") + 1] : join(root, "ui/dist"));
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const out = resolve(arg("--out", join(root, "e2e/screenshots/mobile")));
const lang = arg("--lang", "de");
const quick = process.argv.includes("--quick");

function loadPlaywright() {
  const places = [join(root, "e2e/node_modules/"), join(root, "ui/node_modules/")];
  try {
    places.push(join(execSync("npm root -g", { encoding: "utf8" }).trim(), "/"));
  } catch {
    // No npm on the path: only the local folders.
  }
  for (const p of places) {
    try {
      return createRequire(p)("playwright");
    } catch {
      // Next place.
    }
  }
  throw new Error("playwright not found (npm i -g playwright, or in e2e/)");
}

// The commands the Android app registers (its `generate_handler!` list), by their names.
async function registeredCommands() {
  const src = await readFile(join(root, "src-tauri/src/mobile/mod.rs"), "utf8");
  const list = /generate_handler!\[([\s\S]*?)\]/.exec(src)?.[1] ?? "";
  return new Set(
    list
      .split(",")
      .map((s) => s.trim().split("::").pop())
      .filter(Boolean),
  );
}

// ------------------------------------------------------------------ fixtures

const settingsBase = JSON.parse(await readFile(join(here, "settings.json"), "utf8"));
const pad = (n) => String(n).padStart(2, "0");
const day = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const now = new Date();
now.setHours(14, 20, 0, 0);
const at = (daysBack, h, m = 0) => {
  const d = new Date(now);
  d.setDate(d.getDate() - daysBack);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
};
const today = day(now);
// The running timer started 45 minutes before the real clock (its screen counts from it).
const timerStart = new Date(Date.now() - 45 * 60_000).toISOString();
const plus = (n) => {
  const d = new Date(now);
  d.setDate(d.getDate() + n);
  return day(d);
};

const NOTES = "## Improved\n\n- The phone app updates itself: it downloads a new version on Wi-Fi and installs it with one tap.\n- Faster start.\n\n## Fixed\n\n- Links in notes open the linked page.";

/** The updater's status in a given phase (`apk_update_status`). */
function updateStatus(phase, extra = {}) {
  const offered = phase === "idle" ? null : { version: "1.18.0", notes: NOTES, size: 48_500_000, pub_date: at(0, 8), page: "https://github.com/MouseWerk/Arcalo/releases/tag/v1.18.0" };
  return { configured: true, current: "1.17.0", phase, offered, downloaded: phase === "downloading" ? 19_400_000 : 0, total: phase === "downloading" ? 48_500_000 : null, metered: false, error: null, blocked: null, last_check: at(0, 9, 5), allow_mobile_data: false, ...extra };
}

function fixtures(theme) {
  const settings = structuredClone(settingsBase);
  settings.theme = theme.startsWith("contrast") ? (theme === "contrast-dark" ? "dark" : "light") : theme;
  if (theme.startsWith("contrast")) Object.assign(settings.appearance, { theme_light: "contrast-light", theme_dark: "contrast-dark" });
  settings.locale.language = lang;
  settings.git_sync = { ...settings.git_sync, enabled: true, remote_url: "https://github.com/maurice/notizen.git", author_name: "Maurice", author_email: "maurice@example.com" };
  const page = (id, title, extra = {}) => ({ id, parent_id: null, title, icon: "file-text", position: id, updated_at: at(id % 5, 9 + (id % 6)), favorite: false, daily_date: null, deleted_at: null, ...extra });
  // `workspace_tree_compact`: a page as an array (lib/tree.ts), its children last.
  const row = (p, children = []) => [p.id, p.parent_id, p.title, p.icon, p.position, p.updated_at, p.favorite, p.daily_date, null, p.updated_at, null, null, children];
  const daily = page(40, lang === "de" ? "Donnerstag, 8. Oktober" : "Thursday, 8 October", { daily_date: today, icon: "calendar" });
  const task = (id, text, due, page_title, extra = {}) => ({ page_id: id, page_title, page_icon: null, ordinal: 0, line: 3, text, done: false, due, priority: 0, tags: [], recur: null, ...extra });
  const tasks = [
    task(11, "Angebot für die Schnittstelle an [[Kunde Nord]] senden", plus(-2), "Projekt Rollout", { priority: 2 }),
    task(12, "Testplan mit dem Team abstimmen #qa", today, "Projekt Rollout"),
    task(13, "Wochenbericht schreiben", today, "Journal", { recur: { unit: "week", interval: 1, weekdays: [4], until: null } }),
    task(14, "Zugänge für neue Kollegin beantragen", plus(1), "Posteingang"),
    task(15, "Abnahmeprotokoll prüfen", plus(3), "Projekt Rollout"),
    task(16, "Reisekosten einreichen", plus(16), "Posteingang"),
    task(17, "Ideen für den Workshop sammeln", null, "Workshop"),
  ];
  // `tasks_compact`: the pages once, a task as an array (lib/tasks.ts).
  const taskTable = {
    pages: Object.fromEntries(tasks.map((x) => [x.page_id, [x.page_title, null]])),
    rows: tasks.map((x) => [x.page_id, x.ordinal, x.line, x.text, x.done, x.due, x.priority, x.tags.join(" "), x.recur]),
  };
  const ev = (key, h1, m1, h2, m2, title, location = "") => ({ key, source: "outlook", uid: key, instance: "", recurring: false, start: at(0, h1, m1), end: at(0, h2, m2), all_day: false, title, location, organizer: "", attendees: [], body: null, link: null, busy: "busy", private: false, categories: [], skip: false, note_page_id: null, entry_id: null });
  const events = [ev("a", 9, 0, 9, 15, "Daily Stand-up", "Teams"), ev("b", 11, 0, 12, 0, "Abstimmung Schnittstelle Kunde Nord", "Raum 2.14"), ev("c", 15, 30, 16, 30, "Review Sprint 42")];
  const entry = (id, daysBack, h, minutes, vorgang, description, la = "DEV", np = "NP-8801") => ({ id, netzplan_id: 1, vorgang_nr: vorgang, leistungsart: la, start_time: at(daysBack, h), end_time: at(daysBack, h + Math.ceil(minutes / 60)), duration_minutes: minutes, description, status_flag: "draft", source: "slash", page_id: 40, project_code: "PRJ-2026-X", netzplan_nr: np, wbs_element: "NP-8801-1020" });
  const entries = [
    entry(1, 0, 8, 90, "1020", "Schnittstelle Kunde Nord"),
    entry(2, 0, 11, 60, "1010", "Abstimmung Konzept", "PM"),
    entry(3, 0, 13, 135, "1020", "Code-Review und Tests"),
    entry(4, 1, 8, 240, "1020", "Implementierung Import"),
    entry(5, 1, 13, 180, "1030", "Testlauf mit Fachbereich", "TEST"),
    entry(6, 2, 9, 420, "1020", "Datenmigration"),
  ];
  const content = `## Ziel\n\nDie Schnittstelle zu [[Kunde Nord]] geht Ende Oktober live. Offene Punkte stehen unten, Buchungen auf **NP-8801/1020**.\n\n## Aufgaben\n\n- [ ] Angebot für die Schnittstelle senden due:${plus(-2)}\n- [x] Testdaten anfordern\n- [ ] Abnahmeprotokoll prüfen due:${plus(3)}\n\n## Notizen\n\nGebucht <time-entry id="3" hours="2,25" target="NP-8801/1020" la="DEV" date="${today}">Code-Review und Tests</time-entry>\n\n> Rückmeldung vom Kunden bis Freitag abwarten.\n\n| Meilenstein | Datum |\n|---|---|\n| Testlauf | 14.10. |\n| Go-live | 30.10. |\n\nhttps://intranet.example.com/projekte/rollout-kunde-nord/schnittstellenbeschreibung-version-3-final.pdf\n\n![[Architektur.excalidraw]]\n`;
  const dailyContent = `## Fokus\n\n- [ ] Testplan mit dem Team abstimmen\n- [ ] Wochenbericht schreiben\n\n## Notizen\n\nStand-up: Import läuft stabil, Abnahme nächste Woche.\n\n<time-entry id="1" hours="1,50" target="NP-8801/1020" la="DEV" date="${today}">Schnittstelle Kunde Nord</time-entry>\n`;
  const tree = [
    row(page(10, "Projekt Rollout"), [row(page(11, "Kunde Nord")), row(page(12, "Testplan")), row(page(13, "Abnahme"))]),
    row(page(20, "Journal", { icon: "folder" }), [row(page(21, "2026"), [row(page(22, "10 – Oktober"), [row(daily)])])]),
    row(page(30, "Besprechungen"), [row(page(31, "Review Sprint 41"))]),
    row(page(35, "Posteingang", { icon: "inbox" })),
    row(page(36, "Workshop")),
  ];
  const conflict = { page_id: 12, title: "Testplan", path: "Projekt Rollout/Testplan.md", at: at(0, 9) };
  return {
    mobile_settings_get: { settings, api_key_set: false, api_key_storage: lang === "de" ? "Android-Schlüsselspeicher (Keystore)" : "Android Keystore", provider_keys: [], data_dir: "/data/user/0/de.mousewerk.arcalo", backup_dir: "", version: "1.17.0", system_language: lang },
    mobile_today: {
      date: today,
      booked_minutes: 285,
      target_minutes: 480,
      week_minutes: 1125,
      timer: { entry: { id: 9, netzplan_id: 1, vorgang_nr: "1020", leistungsart: "DEV", start_time: timerStart, end_time: null, duration_minutes: null, description: "Code-Review", status_flag: "running", source: "timer" }, reference: "NP-8801/1020", worked_minutes: 45, paused_since: null, paused_seconds: 0 },
      tasks: tasks.filter((x) => x.due && x.due <= today),
      events,
      events_from: at(0, 12, 5),
      time_tracking: true,
    },
    mobile_recent_targets: [
      { netzplan_nr: "NP-8801", vorgang_nr: "1020", leistungsart: "DEV", reference: "NP-8801/1020", label: "Systemintegration", last_text: "Code-Review" },
      { netzplan_nr: "NP-8801", vorgang_nr: "1010", leistungsart: "PM", reference: "NP-8801/1010", label: "Konzept", last_text: "Abstimmung" },
      { netzplan_nr: "NP-8801", vorgang_nr: "1030", leistungsart: "TEST", reference: "NP-8801/1030", label: "Test", last_text: "Testlauf" },
    ],
    mobile_daily: daily,
    timer_status: { entry: { id: 9, netzplan_id: 1, vorgang_nr: "1020", leistungsart: "DEV", start_time: timerStart, end_time: null, duration_minutes: null, description: "Code-Review", status_flag: "running", source: "timer" }, idle_minutes: 0, is_idle: false, paused_since: null, paused_seconds: 0 },
    tasks_compact: taskTable,
    time_entries: entries,
    wbs_tree: [{ id: 1, project_code: "PRJ-2026-X", name: "Rollout Kunde Nord", created_at: at(30, 9), netzplaene: [{ id: 1, project_id: 1, netzplan_nr: "NP-8801", wbs_element: "NP-8801-1020", description: "Integration", planned_hours: 320, vorgaenge: [{ id: 1, netzplan_id: 1, vorgang_nr: "1010", description: "Konzept", duration_days: 5, planned_hours: 40, remaining_hours: null, predecessors: [] }, { id: 2, netzplan_id: 1, vorgang_nr: "1020", description: "Systemintegration", duration_days: 20, planned_hours: 200, remaining_hours: null, predecessors: [] }] }] }],
    leistungsarten_list: [["DEV", "Entwicklung"], ["PM", "Projektmanagement"], ["TEST", "Test & Qualitätssicherung"], ["CONSULTING", "Beratung"]],
    workspace_tree_compact: tree,
    recent_pages: [page(10, "Projekt Rollout"), daily, page(11, "Kunde Nord"), page(31, "Review Sprint 41")],
    pages: { 40: { ...daily, content: dailyContent, tags: [], backlinks: [], unresolved_links: [] }, default: { ...page(10, "Projekt Rollout"), content, tags: [], backlinks: [], unresolved_links: [] } },
    page_resolve: page(11, "Kunde Nord"),
    search_workspace: [{ kind: "page", page_id: 10, title: "Projekt Rollout", icon: null, score: 1 }, { kind: "note", page_id: 11, title: "Kunde Nord", icon: null, snippet: "… die <mark>Schnittstelle</mark> zu Kunde Nord geht Ende Oktober live …", score: 0.8 }],
    git_sync_status: { enabled: true, repo_path: "", last_at: at(0, 14, 12), last_commit: "a1b2c3d", last_branch: "main", last_error: null, pending_changes: 2, token_set: true, blocked_deletions: null, after_restore: null },
    git_conflicts: [conflict],
    git_conflict_get: { page_id: 12, title: "Testplan", at: conflict.at, base: "", mine: "", theirs: "", merge: { chunks: [{ kind: "stable", text: "# Testplan\n" }, { kind: "conflict", base: "a", mine: "b", theirs: "c" }, { kind: "conflict", base: "d", mine: "e", theirs: "f" }], conflicts: 2 } },
    mobile_sync: { commit: "a1b2c3d", committed: true, changed_files: 3, branch: "main", fallback: false, message: "3 Dateien geändert", reference: { projects: 1, netzplaene: 2, vorgaenge: 6, leistungsarten: 4, events: 12, skipped: null } },
    apk_update_status: updateStatus("ready"),
    apk_update_check: updateStatus("idle"),
    apk_update_set_mobile_data: updateStatus("ready", { allow_mobile_data: true }),
  };
}

// The IPC as the page sees it: `window.__TAURI_INTERNALS__.invoke` answers from the fixtures,
// events can be sent to the page's listeners (`__emit`) and Android's back button pressed
// (`__pressBack`) through the channel the app registered, as Tauri delivers them.
const ipcMock = (data) => `
  (() => {
    const data = ${JSON.stringify(data)};
    let next = 1;
    const callbacks = new Map();
    const listeners = [];
    let back = null;
    let backIndex = 0;
    window.__calls = [];
    window.__shared = null;
    window.__installAnswers = ["needs_permission", "started"];
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    window.__emit = (event, payload) => {
      for (const l of listeners) if (l.event === event) callbacks.get(l.handler)?.({ event, id: 1, payload });
    };
    window.__pressBack = () => back && callbacks.get(back)?.({ index: backIndex++, message: { canGoBack: false } });
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
      transformCallback(cb) { const id = next++; callbacks.set(id, cb); return id; },
      unregisterCallback(id) { callbacks.delete(id); },
      convertFileSrc: (p) => p,
      async invoke(cmd, args) {
        window.__calls.push(cmd);
        if (cmd === "plugin:event|listen") { listeners.push({ event: args.event, handler: args.handler }); return next++; }
        if (cmd.startsWith("plugin:event|")) return next++;
        if (cmd === "plugin:app|register_listener") { back = args.handler.id; return null; }
        if (cmd === "page_get") return structuredClone(data.pages[args.id] ?? { ...data.pages.default, id: args.id });
        if (cmd === "mobile_shared_text") { const t = window.__shared; window.__shared = null; return t; }
        if (cmd === "apk_update_install") return window.__installAnswers.shift() ?? "started";
        if (cmd === "apk_update_allow_install") return true;
        if (cmd in data) return structuredClone(data[cmd]);
        if (cmd === "mobile_settings_save") return { ...data.mobile_settings_get, settings: args.settings };
        return null;
      },
    };
  })();
`;

// ---------------------------------------------------------------------- server

const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json", ".wasm": "application/wasm" };
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const file = join(dist, path === "/" ? "index.html" : path);
  try {
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": types[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const base = `http://127.0.0.1:${server.address().port}/index.html?mobile`;

// ------------------------------------------------------------------------ run

const { chromium } = loadPlaywright();
const browser = await chromium.launch({ executablePath: process.env.ARCALO_CHROME || undefined });
await mkdir(out, { recursive: true });
const registered = await registeredCommands();
const problems = [];
const shots = [];
const fail = (where, what) => problems.push(`${where}: ${what}`);

async function open(size, theme, opts = {}) {
  const [width, height] = size.split("x").map(Number);
  const dark = theme === "dark" || theme === "contrast-dark";
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: dark ? "dark" : "light", locale: lang === "de" ? "de-DE" : "en-GB" });
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  const data = fixtures(theme);
  if (opts.update) data.apk_update_status = opts.update;
  await page.addInitScript(ipcMock(data));
  await page.goto(base);
  await page.waitForSelector(".m-tabbar");
  await page.waitForTimeout(1600); // the splash fades out
  const where = `${size}/${theme}`;
  const settle = () => page.waitForTimeout(300);
  const tap = async (selector) => {
    await page.locator(selector).first().click();
    await settle();
  };
  const check = async (name) => {
    // Touch targets: every visible control at least 44 px high and wide (text links in a note excepted).
    const small = await page.evaluate(() =>
      [...document.querySelectorAll(".m-app button, .m-app [role=checkbox], .m-app input, .m-app select, .m-app textarea")]
        .filter((el) => !el.closest(".m-read") && el.offsetParent !== null)
        .map((el) => ({ el, r: el.getBoundingClientRect() }))
        .filter(({ r }) => r.width > 0 && r.height > 0 && (r.height < 43.5 || r.width < 43.5))
        .map(({ el, r }) => `${el.className || el.tagName} ${Math.round(r.width)}x${Math.round(r.height)} „${(el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 30)}“`),
    );
    for (const s of small) fail(`${name}/${where}`, `small touch target ${s}`);
    // Nothing wider than the screen: the page, the screens and every element in them.
    const wide = await page.evaluate(() => {
      const w = window.innerWidth;
      const found = [];
      if (document.documentElement.scrollWidth > w + 1) found.push(`page ${document.documentElement.scrollWidth}px`);
      for (const s of document.querySelectorAll(".m-scroll, .m-main, .m-tabbar, .m-head")) if (s.scrollWidth > s.clientWidth + 1) found.push(`${s.className} scrolls sideways (${s.scrollWidth}px in ${s.clientWidth}px)`);
      for (const el of document.querySelectorAll(".m-app *")) {
        if (el.closest(".m-read table, .m-read pre, .m-line, .m-chips-scroll")) continue;
        const r = el.getBoundingClientRect();
        if (r.width > 0 && (r.right > w + 1 || r.left < -1) && getComputedStyle(el).position !== "fixed") found.push(`${el.tagName.toLowerCase()}.${el.className} ${Math.round(r.left)}..${Math.round(r.right)}`);
      }
      return found.slice(0, 5);
    });
    for (const s of wide) fail(`${name}/${where}`, `wider than the screen: ${s}`);
  };
  const shot = async (name) => {
    await page.waitForTimeout(250);
    const file = join(out, `${name}-${size}-${theme}.png`);
    await page.screenshot({ path: file });
    shots.push(file);
    await check(name);
  };
  const close = async () => {
    for (const e of errors) fail(where, `console: ${e}`);
    const calls = await page.evaluate(() => window.__calls);
    for (const c of new Set(calls)) {
      if (c.startsWith("plugin:event|") || c.startsWith("plugin:app|") || c.startsWith("plugin:opener|")) continue;
      if (!registered.has(c)) fail(where, `the UI invokes \`${c}\`, which the Android app does not register (src-tauri/src/mobile/mod.rs)`);
    }
    await ctx.close();
  };
  return { page, tap, shot, check, close, where, settle };
}

/** Every main screen, tapped through like a user. */
async function tour(size, theme) {
  const { page, tap, shot, close } = await open(size, theme);
  await shot("01-today");
  await tap(".m-tab:nth-child(2)");
  await shot("02-tasks");
  await tap(".m-tab:nth-child(4)");
  await shot("03-time");
  await tap(".m-tab:nth-child(5)");
  await shot("04-notes");
  await tap(".m-tree-page >> nth=0");
  await shot("05-page");
  await tap(".m-head-actions .m-icon-btn");
  await shot("06-page-edit");
  await tap(".m-head-back");
  await tap(".m-tab:nth-child(1)");
  await tap(".m-row:has(.lucide-notebook-pen)");
  await shot("07-daily");
  await tap(".m-head-back");
  await tap(".m-tab-capture");
  await shot("08-capture-note");
  await tap(".m-seg-opt:nth-child(2)");
  await page.fill(".m-textarea", "Abnahmeprotokoll an Kunde Nord schicken");
  await tap(".m-chip-btn:nth-child(3)");
  await shot("09-capture-task");
  await tap(".m-seg-opt:nth-child(3)");
  await tap(".m-chip-btn >> nth=0");
  await page.fill("#m-zeit-dur", "1,5");
  await page.fill("#m-zeit-text", "Abstimmung Testplan");
  await shot("10-capture-booking");
  await tap(".m-head-back");
  await tap(".m-head-actions .m-icon-btn >> nth=1");
  await shot("11-settings");
  await page.locator(".m-scroll").last().evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await shot("12-settings-end");
  await close();
}

/** Android's back button: edit mode, screen, „Heute“, background; never quits. */
async function backButton() {
  const { page, tap, close, where } = await open("412x915", "light");
  const screen = () => page.evaluate(() => document.querySelector(".m-app").dataset.screen);
  const press = async () => {
    await page.evaluate(() => window.__pressBack());
    await page.waitForTimeout(250);
  };
  await tap(".m-tab:nth-child(5)");
  await tap(".m-tree-page >> nth=0");
  await tap(".m-head-actions .m-icon-btn");
  if (!(await page.locator(".m-editor-text").count())) fail(where, "editing did not start");
  await page.fill(".m-editor-text", "Neu getippt, gleich zurück");
  await press();
  if (await page.locator(".m-editor-text").count()) fail(where, "back did not end editing first");
  if ((await screen()) !== "page") fail(where, `back while editing left the page (${await screen()})`);
  const saved = await page.evaluate(() => window.__calls.filter((c) => c === "page_save").length);
  if (!saved) fail(where, "ending editing with back did not save the text");
  await press();
  if ((await screen()) !== "notes") fail(where, `back on a page did not return to the notes (${await screen()})`);
  await press();
  if ((await screen()) !== "today") fail(where, `back on a tab did not go to Heute (${await screen()})`);
  await press();
  const calls = await page.evaluate(() => window.__calls);
  if (!calls.includes("mobile_to_background")) fail(where, "back on Heute did not send the app to the background");
  if ((await screen()) !== "today") fail(where, "back on Heute changed the screen");
  // A page left while typing (no pause yet) still saves.
  await tap(".m-tab:nth-child(5)");
  await tap(".m-tree-page >> nth=0");
  await tap(".m-head-actions .m-icon-btn");
  await page.fill(".m-editor-text", "Getippt und sofort weg");
  const before = await page.evaluate(() => window.__calls.filter((c) => c === "page_save").length);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  });
  await page.waitForTimeout(200);
  const after = await page.evaluate(() => window.__calls.filter((c) => c === "page_save").length);
  if (after <= before) fail(where, "going to the background while editing did not save");
  // A link in a note opens the linked page.
  await press();
  await page.locator(".m-read a[data-target]").first().click();
  await page.waitForTimeout(300);
  if (!(await page.evaluate(() => window.__calls.includes("page_resolve")))) fail(where, "a link in a note did not resolve its page");
  if ((await screen()) !== "page") fail(where, "a link in a note did not open the page");
  await close();
}

/** The update banner, „Update installieren“ with the permission flow, the update states. */
async function updates() {
  for (const theme of ["light", "dark"]) {
    const { page, tap, shot, close, where } = await open("412x915", theme);
    if (!(await page.locator(".m-upd-card").count())) fail(where, "no update banner on Heute for a ready update");
    await tap(".m-upd-notes-toggle");
    await shot("20-update-banner");
    await tap(".m-upd-card .m-btn-primary");
    if (!(await page.locator(".m-upd-card .m-notice-warning").count())) fail(where, "a refused install did not explain the permission");
    await shot("21-update-permission");
    await tap(".m-upd-card .m-notice .m-btn");
    const calls = await page.evaluate(() => window.__calls.filter((c) => c.startsWith("apk_update_")));
    const want = ["apk_update_install", "apk_update_allow_install", "apk_update_install"];
    if (calls.slice(-3).join() !== want.join()) fail(where, `install flow ran ${calls.join(", ")}`);
    if (await page.locator(".m-upd-card .m-notice-warning").count()) fail(where, "the permission notice stayed after the permission was given");
    // The states of Einstellungen → Updates.
    await tap(".m-head-actions .m-icon-btn >> nth=1");
    const states = [
      ["22-update-downloading", { ...updateStatus("downloading") }],
      ["23-update-wifi", { ...updateStatus("waiting", { metered: true }) }],
      ["24-update-blocked", { ...updateStatus("blocked", { blocked: lang === "de" ? "Diese Version ist mit einem anderen App-Schlüssel signiert als die installierte App. Android installiert sie nur nach einer Deinstallation: synchronisiere zuerst, deinstalliere Arcalo und installiere die neue Version von der Release-Seite." : "This version is signed with another app key than the installed app." }) }],
      ["25-update-current", { ...updateStatus("idle") }],
    ];
    for (const [name, status] of states) {
      await page.evaluate((s) => window.__emit("apkupdate://status", s), status);
      await page.waitForTimeout(150);
      await page.locator(".m-upd-status").scrollIntoViewIfNeeded();
      await shot(name);
    }
    await tap(".m-upd-status ~ .m-form-actions .m-btn:last-child");
    if (!(await page.evaluate(() => window.__calls.includes("apk_update_check")))) fail(where, "„Nach Updates suchen“ did not check");
    await close();
  }
}

/** Text shared from another app opens a capture with it. */
async function shared() {
  const { page, close, where } = await open("412x915", "light");
  await page.evaluate(() => {
    window.__shared = "Artikel lesen\nhttps://example.com/arcalo";
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(400);
  const value = await page.locator(".m-textarea").inputValue().catch(() => "");
  if (!value.includes("https://example.com/arcalo")) fail(where, `shared text did not open a capture (${value})`);
  await close();
}

/** Discarding the running timer asks first (one tap does not lose the time). */
async function timerDiscard() {
  const { page, tap, shot, close, where } = await open("360x800", "light");
  await tap(".m-tab:nth-child(4)");
  const discard = ".m-timer-actions .m-btn:last-child";
  await tap(discard);
  if (await page.evaluate(() => window.__calls.includes("timer_discard"))) fail(where, "one tap on „Verwerfen“ discarded the timer");
  await shot("31-timer-discard-confirm");
  await tap(discard);
  if (!(await page.evaluate(() => window.__calls.includes("timer_discard")))) fail(where, "the confirmed „Verwerfen“ did not discard");
  await close();
}

/** The on-screen keyboard: the WebView shrinks (MainActivity pads it); the field stays visible. */
async function keyboard() {
  const { page, tap, shot, close, where } = await open("360x800", "light");
  await tap(".m-tab-capture");
  await page.setViewportSize({ width: 360, height: 470 });
  await page.waitForTimeout(300);
  const hidden = await page.evaluate(() => {
    const r = document.activeElement?.getBoundingClientRect();
    return !r || r.bottom > window.innerHeight || r.top < 0;
  });
  if (hidden) fail(where, "the focused capture field is under the keyboard");
  await shot("30-keyboard-capture");
  await tap(".m-tab-capture").catch(() => {});
  await close();
}

/** Android's font size at 130 %: the text tokens grow, the layout must hold. */
async function fontScale() {
  const { page, tap, shot, close } = await open("360x800", "light");
  await page.evaluate(() => {
    const css = getComputedStyle(document.documentElement);
    const rules = [];
    for (const sheet of document.styleSheets) {
      let list;
      try {
        list = sheet.cssRules;
      } catch {
        continue;
      }
      for (const r of list) if (r.selectorText === ":root") for (const p of r.style) if (p.startsWith("--fs-")) rules.push(p);
    }
    for (const p of new Set(rules)) {
      const v = parseFloat(css.getPropertyValue(p));
      if (v) document.documentElement.style.setProperty(p, `${(v * 1.3).toFixed(1)}px`);
    }
  });
  await page.waitForTimeout(300);
  await shot("40-font130-today");
  await tap(".m-tab:nth-child(2)");
  await shot("41-font130-tasks");
  await tap(".m-tab:nth-child(4)");
  await shot("42-font130-time");
  await tap(".m-tab:nth-child(1)");
  await tap(".m-head-actions .m-icon-btn >> nth=1");
  await shot("43-font130-settings");
  await close();
}

/** Other phones, landscape and a tablet: every tab and the settings. */
async function layouts(size) {
  const { tap, shot, close } = await open(size, "light");
  await shot("50-today");
  await tap(".m-tab:nth-child(2)");
  await shot("51-tasks");
  await tap(".m-tab:nth-child(4)");
  await shot("52-time");
  await tap(".m-tab:nth-child(5)");
  await shot("53-notes");
  await tap(".m-tab:nth-child(1)");
  await tap(".m-head-actions .m-icon-btn >> nth=1");
  await shot("54-settings");
  await close();
}

for (const size of ["360x800", "412x915"]) for (const theme of ["light", "dark"]) await tour(size, theme);
await backButton();
await updates();
await shared();
await keyboard();
await timerDiscard();
if (!quick) {
  for (const theme of ["contrast-light", "contrast-dark"]) await tour("412x915", theme);
  await fontScale();
  for (const size of ["360x640", "430x932", "800x360", "915x412", "800x1280", "1280x800"]) await layouts(size);
}

await browser.close();
server.close();
console.log(`${shots.length} screenshots in ${out}`);
if (problems.length) {
  console.error([...new Set(problems)].join("\n"));
  process.exit(1);
}
