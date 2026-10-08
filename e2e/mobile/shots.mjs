// Browser check of the Android companion app's UI (ui/src/mobile): the built UI (`ui/dist`) in a
// 390x844 phone viewport with Tauri's IPC mocked by fixtures. Every screen is opened by tapping
// through the app in light and dark; the check fails on console errors and on touch targets
// smaller than 44 px, and writes a screenshot per screen and theme.
//
//   npm --prefix ui run build
//   node e2e/mobile/shots.mjs [--out <folder>] [--lang de|en]
//
// Playwright is not a dependency of the repository: the script takes the `playwright` package
// from `e2e/node_modules`, `ui/node_modules` or the global npm folder, and its Chromium from
// PLAYWRIGHT_BROWSERS_PATH (or an installed Chrome with ARCALO_CHROME=<path>).

import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(here, "../..");
const dist = join(root, "ui/dist");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const out = resolve(arg("--out", join(root, "e2e/screenshots/mobile")));
const lang = arg("--lang", "de");

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
const plus = (n) => {
  const d = new Date(now);
  d.setDate(d.getDate() + n);
  return day(d);
};

function fixtures(theme) {
  const settings = structuredClone(settingsBase);
  settings.theme = theme;
  settings.locale.language = lang;
  settings.git_sync = { ...settings.git_sync, enabled: true, remote_url: "https://github.com/maurice/notizen.git", author_name: "Maurice", author_email: "maurice@example.com" };
  const page = (id, title, extra = {}) => ({ id, parent_id: null, title, icon: "file-text", position: id, updated_at: at(id % 5, 9 + (id % 6)), favorite: false, daily_date: null, deleted_at: null, ...extra });
  const node = (p, children = []) => ({ ...p, children });
  const daily = page(40, lang === "de" ? "Donnerstag, 8. Oktober" : "Thursday, 8 October", { daily_date: today, icon: "calendar" });
  const task = (id, text, due, page_title, extra = {}) => ({ page_id: id, page_title, page_icon: null, ordinal: 0, line: 3, text, done: false, due, priority: 0, tags: [], ...extra });
  const tasks = [
    task(11, "Angebot für die Schnittstelle an [[Kunde Nord]] senden", plus(-2), "Projekt Rollout", { priority: 2 }),
    task(12, "Testplan mit dem Team abstimmen #qa", today, "Projekt Rollout"),
    task(13, "Wochenbericht schreiben", today, "Journal", { recur: { unit: "week", interval: 1, weekdays: [4], until: null } }),
    task(14, "Zugänge für neue Kollegin beantragen", plus(1), "Posteingang"),
    task(15, "Abnahmeprotokoll prüfen", plus(3), "Projekt Rollout"),
    task(16, "Reisekosten einreichen", plus(16), "Posteingang"),
    task(17, "Ideen für den Workshop sammeln", null, "Workshop"),
  ];
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
  const content = `## Ziel\n\nDie Schnittstelle zu [[Kunde Nord]] geht Ende Oktober live. Offene Punkte stehen unten, Buchungen auf **NP-8801/1020**.\n\n## Aufgaben\n\n- [ ] Angebot für die Schnittstelle senden due:${plus(-2)}\n- [x] Testdaten anfordern\n- [ ] Abnahmeprotokoll prüfen due:${plus(3)}\n\n## Notizen\n\nGebucht <time-entry id="3" hours="2,25" target="NP-8801/1020" la="DEV" date="${today}">Code-Review und Tests</time-entry>\n\n> Rückmeldung vom Kunden bis Freitag abwarten.\n\n| Meilenstein | Datum |\n|---|---|\n| Testlauf | 14.10. |\n| Go-live | 30.10. |\n\n![[Architektur.excalidraw]]\n`;
  const dailyContent = `## Fokus\n\n- [ ] Testplan mit dem Team abstimmen\n- [ ] Wochenbericht schreiben\n\n## Notizen\n\nStand-up: Import läuft stabil, Abnahme nächste Woche.\n\n<time-entry id="1" hours="1,50" target="NP-8801/1020" la="DEV" date="${today}">Schnittstelle Kunde Nord</time-entry>\n`;
  const tree = [
    node(page(10, "Projekt Rollout"), [node(page(11, "Kunde Nord")), node(page(12, "Testplan")), node(page(13, "Abnahme"))]),
    node(page(20, "Journal", { icon: "folder" }), [node(page(21, "2026"), [node(page(22, "10 – Oktober"), [node(daily)])])]),
    node(page(30, "Besprechungen"), [node(page(31, "Review Sprint 41"))]),
    node(page(35, "Posteingang", { icon: "inbox" })),
    node(page(36, "Workshop")),
  ];
  const conflict = { page_id: 12, title: "Testplan", path: "Projekt Rollout/Testplan.md", at: at(0, 9) };
  return {
    mobile_settings_get: { settings, api_key_set: false, api_key_storage: lang === "de" ? "Android-Schlüsselspeicher (Keystore)" : "Android Keystore", provider_keys: [], data_dir: "/data/user/0/de.mousewerk.arcalo", backup_dir: "", version: "1.15.0", system_language: lang },
    mobile_today: {
      date: today,
      booked_minutes: 285,
      target_minutes: 480,
      week_minutes: 1125,
      timer: { entry: { id: 9, netzplan_id: 1, vorgang_nr: "1020", leistungsart: "DEV", start_time: at(0, 13, 35), end_time: null, duration_minutes: null, description: "Code-Review", status_flag: "running", source: "timer" }, reference: "NP-8801/1020", worked_minutes: 45, paused_since: null, paused_seconds: 0 },
      tasks: tasks.filter((t) => t.due && t.due <= today),
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
    timer_status: { entry: { id: 9, netzplan_id: 1, vorgang_nr: "1020", leistungsart: "DEV", start_time: at(0, 13, 35), end_time: null, duration_minutes: null, description: "Code-Review", status_flag: "running", source: "timer" }, idle_minutes: 0, is_idle: false, paused_since: null, paused_seconds: 0 },
    tasks_list: tasks,
    time_entries: entries,
    wbs_tree: [{ id: 1, project_code: "PRJ-2026-X", name: "Rollout Kunde Nord", created_at: at(30, 9), netzplaene: [{ id: 1, project_id: 1, netzplan_nr: "NP-8801", wbs_element: "NP-8801-1020", description: "Integration", planned_hours: 320, vorgaenge: [{ id: 1, netzplan_id: 1, vorgang_nr: "1010", description: "Konzept", duration_days: 5, planned_hours: 40, remaining_hours: null, predecessors: [] }, { id: 2, netzplan_id: 1, vorgang_nr: "1020", description: "Systemintegration", duration_days: 20, planned_hours: 200, remaining_hours: null, predecessors: [] }] }] }],
    leistungsarten_list: [["DEV", "Entwicklung"], ["PM", "Projektmanagement"], ["TEST", "Test & Qualitätssicherung"], ["CONSULTING", "Beratung"]],
    workspace_tree: tree,
    recent_pages: [page(10, "Projekt Rollout"), daily, page(11, "Kunde Nord"), page(31, "Review Sprint 41")],
    pages: { 40: { ...daily, content: dailyContent, tags: [], backlinks: [], unresolved_links: [] }, default: { ...page(10, "Projekt Rollout"), content, tags: [], backlinks: [], unresolved_links: [] } },
    search_workspace: [{ kind: "page", page_id: 10, title: "Projekt Rollout", icon: null, score: 1 }, { kind: "note", page_id: 11, title: "Kunde Nord", icon: null, snippet: "… die <mark>Schnittstelle</mark> zu Kunde Nord geht Ende Oktober live …", score: 0.8 }],
    git_sync_status: { enabled: true, repo_path: "", last_at: at(0, 14, 12), last_commit: "a1b2c3d", last_branch: "main", last_error: null, pending_changes: 2, token_set: true, blocked_deletions: null, after_restore: null },
    git_conflicts: [conflict],
    git_conflict_get: { page_id: 12, title: "Testplan", at: conflict.at, base: "", mine: "", theirs: "", merge: { chunks: [{ kind: "stable", text: "# Testplan\n" }, { kind: "conflict", base: "a", mine: "b", theirs: "c" }, { kind: "conflict", base: "d", mine: "e", theirs: "f" }], conflicts: 2 } },
    mobile_sync: { commit: "a1b2c3d", committed: true, changed_files: 3, branch: "main", fallback: false, message: "3 Dateien geändert", reference: { projects: 1, netzplaene: 2, vorgaenge: 6, leistungsarten: 4, events: 12, skipped: null } },
  };
}

// The IPC as the page sees it: `window.__TAURI_INTERNALS__.invoke` answers from the fixtures.
const ipcMock = (data) => `
  (() => {
    const data = ${JSON.stringify(data)};
    let next = 1;
    const callbacks = new Map();
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
      transformCallback(cb) { const id = next++; callbacks.set(id, cb); return id; },
      unregisterCallback(id) { callbacks.delete(id); },
      convertFileSrc: (p) => p,
      async invoke(cmd, args) {
        window.__calls = (window.__calls || []).concat(cmd);
        if (cmd.startsWith("plugin:event|")) return next++;
        if (cmd === "page_get") return structuredClone(data.pages[args.id] ?? { ...data.pages.default, id: args.id });
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
const problems = [];
const shots = [];

for (const theme of ["light", "dark"]) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: theme, locale: lang === "de" ? "de-DE" : "en-GB" });
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.addInitScript(ipcMock(fixtures(theme)));
  await page.goto(base);
  await page.waitForSelector(".m-tabbar");
  await page.waitForTimeout(1600); // the splash fades out

  const tap = async (selector) => {
    await page.locator(selector).first().click();
    await page.waitForTimeout(350);
  };
  const shot = async (name) => {
    await page.waitForTimeout(250);
    const file = join(out, `${name}-${theme}.png`);
    await page.screenshot({ path: file });
    shots.push(file);
    // Touch targets: every visible control at least 44 px high and wide (text links in a note excepted).
    const small = await page.evaluate(() =>
      [...document.querySelectorAll(".m-app button, .m-app [role=checkbox], .m-app input, .m-app select, .m-app textarea")]
        .filter((el) => !el.closest(".m-read") && el.offsetParent !== null)
        .map((el) => ({ el, r: el.getBoundingClientRect() }))
        .filter(({ r }) => r.width > 0 && r.height > 0 && (r.height < 43.5 || r.width < 43.5))
        .map(({ el, r }) => `${el.className || el.tagName} ${Math.round(r.width)}x${Math.round(r.height)} „${(el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 30)}“`),
    );
    for (const s of small) problems.push(`${name}/${theme}: small touch target ${s}`);
  };

  await shot("01-today");
  await tap(".m-tab:nth-child(2)");
  await shot("02-tasks");
  await tap(".m-tab:nth-child(4)");
  await shot("03-time");
  await tap(".m-tab:nth-child(5)");
  await shot("04-notes");
  await tap(".m-tree-page >> nth=0");
  await shot("05-page");
  await tap(".m-head-back");
  await tap(".m-tab:nth-child(1)");
  await tap(".m-row:has(.lucide-notebook-pen)");
  await shot("06-daily");
  await page.goBack();
  await page.waitForTimeout(300);
  await tap(".m-tab-capture");
  await shot("07-capture-note");
  await tap(".m-seg-opt:nth-child(2)");
  await page.fill(".m-textarea", "Abnahmeprotokoll an Kunde Nord schicken");
  await tap(".m-chip-btn:nth-child(3)");
  await shot("08-capture-task");
  await tap(".m-seg-opt:nth-child(3)");
  await tap(".m-chip-btn >> nth=0");
  await page.fill("#m-zeit-dur", "1,5");
  await page.fill("#m-zeit-text", "Abstimmung Testplan");
  await shot("09-capture-booking");
  await tap(".m-head-back");
  await tap(".m-head-actions .m-icon-btn >> nth=1");
  await shot("10-settings");
  await page.locator(".m-scroll").last().evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await shot("11-settings-end");

  if (errors.length) problems.push(...errors.map((e) => `${theme}: console: ${e}`));
  await ctx.close();
}

await browser.close();
server.close();
console.log(`${shots.length} screenshots in ${out}`);
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
