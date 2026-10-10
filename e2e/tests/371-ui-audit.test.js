// 1.17 UI audit of the 1.16 views: the start page, time tracking, calendar, the reviews, tasks,
// projects, Settings → Tastatur and a note with tags, a query table and several tabs, in the
// light, dark and both contrast themes, at 900, 1280 and 1920 px and in a split pane, German and
// English. Every view is screenshotted for review (audit-*.png) and checked for clipped labels,
// controls outside their box and sideways scrolling (lib/layout-audit.js).
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { launch, guarded } from "../lib/harness.js";
import { launchEnglish } from "../lib/english.js";
import { auditLayout } from "../lib/layout-audit.js";

const test = guarded(nodeTest, () => app);
let app;
let dataDir = null;
before(async () => (app = await launch({ width: 1280, height: 800 })));
after(async () => {
  await app?.close();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SHOWN = ".pane.active > .pane-content:not([hidden])";
const THEMES = [
  ["light", "arcalo-light"],
  ["dark", "arcalo-dark"],
  ["light", "contrast-light"],
  ["dark", "contrast-dark"],
];
const SIZES = [
  [900, 640],
  [1280, 800],
  [1920, 1080],
];
// The views, with the palette entry that opens them (German, English) and what shows they are ready.
const VIEWS = [
  { id: "home", ready: ".home, .dash" },
  { id: "time", cmd: ["Zeiterfassung öffnen", "Open time tracking"], ready: "h1" },
  { id: "calendar", cmd: ["Kalender", "Calendar"], ready: ".calv" },
  { id: "week", cmd: ["Wochenrückblick", "Weekly review"], ready: ".wr-view" },
  { id: "day", cmd: ["Tagesrückblick", "Daily review"], ready: ".rv-view" },
  { id: "tasks", cmd: ["Aufgaben", "Tasks"], ready: ".tasks-view" },
  { id: "projects", cmd: ["Projekte öffnen", "Open projects"], ready: "h1" },
  { id: "keys", cmd: ["Einstellungen", "Settings"], ready: ".settings", section: "keyboard" },
  { id: "note", ready: ".ProseMirror" },
];

let note = null;
const problems = [];

async function theme(mode, id) {
  const view = await app.invoke("settings_get");
  const ap = { ...view.settings.appearance };
  if (mode === "light") ap.theme_light = id;
  else ap.theme_dark = id;
  await app.invoke("settings_save", { settings: { ...view.settings, theme: mode, appearance: ap } });
  await app.browser.refresh();
  await app.browser.waitUntil(async () => app.browser.execute(() => document.body.classList.contains("ready")), { timeout: 20000, timeoutMsg: "not ready after the reload" });
  await app.browser.waitUntil(async () => (await app.browser.execute(() => document.documentElement.dataset.themeId)) === id, { timeoutMsg: `theme ${id} not applied` });
}

/** Back to one pane (also after a failed run left the split open). */
async function onePane() {
  await app.browser.execute(() => document.querySelectorAll(".pane")[1]?.querySelectorAll(".tab-close").forEach((b) => b.click()));
  await app.browser.waitUntil(async () => (await app.browser.execute(() => document.querySelectorAll(".pane").length)) === 1, { timeoutMsg: "the split did not close" });
}

async function show(v, lang) {
  if (v.id === "home") {
    await app.browser.execute(() => document.querySelector(".pane.active .tabbar-home")?.click());
  } else if (v.id === "note") {
    await app.invoke("search_open", { target: { kind: "page", page_id: note.id, new_tab: false } });
  } else {
    await app.keys(["Control", "k"]);
    const input = await app.waitFor(".palette input");
    const label = v.cmd[lang === "en" ? 1 : 0];
    await input.setValue(label);
    await app.browser.waitUntil(async () => (await app.browser.execute(() => document.querySelector(".pal-item.sel")?.textContent ?? "")).startsWith(label), { timeoutMsg: `no palette entry ${label}` });
    await app.keys(["Enter"]);
  }
  await app.waitFor(`${SHOWN} :is(${v.ready})`, 15000).catch(async (e) => {
    const panes = await app.browser.execute(() =>
      [...document.querySelectorAll(".pane")].map((p) => `${p.className} | ${p.querySelector(".tab.active")?.textContent} | ${[...p.querySelectorAll(":scope > .pane-content")].map((c) => `${c.hidden ? "hidden" : "shown"}:${c.firstElementChild?.className}`).join(", ")}`),
    );
    throw new Error(`${e.message}\n${panes.join("\n")}`);
  });
  if (v.section) {
    await app.browser.execute((s, id) => document.querySelector(`${s} .settings-nav-item[data-section="${id}"]`)?.click(), SHOWN, v.section);
  }
  await sleep(500);
}

// Not glitches: text for screen readers only (a 1 px box), cards that are buttons of several
// lines by design, dropdown values that end in "…" on purpose, the note's toolbar scrolled
// sideways in a narrow pane (it fades out at that edge; what it hides is clipped, not on top of
// the next button) and the page icon that hangs left of a wide page's title.
const INTENDED = [
  / \(\d+>1\)/,
  /^wraps: button\.(dw-bar-col|dw-budget|dw-today-hours|dw-week-sum|wr-day|rv-row)\b/,
  /^select too narrow/,
  /^cut sideways: div\.editor-toolbar\.fade-/,
  /^overlap: button\.tb-/,
  /^overflows header\.page-header .*: button\.page-icon-btn /,
];

async function audit(where) {
  const found = (await app.browser.execute(auditLayout, SHOWN)).filter((p) => !INTENDED.some((re) => re.test(p)));
  const wide = await app.browser.execute(() => {
    const out = [];
    if (document.documentElement.scrollWidth > window.innerWidth + 1) out.push(`page scrolls sideways (${document.documentElement.scrollWidth} > ${window.innerWidth})`);
    for (const el of document.querySelectorAll(".pane-content:not([hidden]) :is(.view-body, .page-scroll, .settings-body, .view-scroll)")) {
      const s = getComputedStyle(el);
      if (/(auto|scroll)/.test(s.overflowX) && el.scrollWidth > el.clientWidth + 2) out.push(`${el.className.split(" ")[0]} scrolls sideways (${el.scrollWidth} > ${el.clientWidth})`);
    }
    return out;
  });
  for (const p of [...found, ...wide]) {
    problems.push(`${where}: ${p}`);
    console.log(`[audit] ${where}: ${p}`);
  }
}

test("setup: a note with tags, a query table and a task", async () => {
  note = await app.invoke("page_create", {
    parentId: null,
    title: "Prüfseite mit einem recht langen Titel für die Tableiste",
    icon: null,
    content: "#projekt #kunde #review\n\n## Aufgaben\n\n- [ ] Angebot schicken due:2026-10-20\n\n```query\ntasks open\n```\n\nText mit **fett** und `code`.\n",
  });
});

for (const [mode, id] of THEMES) {
  test(`${id}: every view at 900, 1280 and 1920 px and in a split pane`, async () => {
    await onePane();
    await theme(mode, id);
    for (const [w, h] of SIZES) {
      await app.browser.setWindowSize(w, h);
      await sleep(300);
      for (const v of VIEWS) {
        await show(v, "de");
        await audit(`${id} ${w}px ${v.id}`);
        await app.shot(`audit-${id}-${w}-${v.id}`);
      }
    }
    // A split pane at 1280 px: the note on the left, each view on the right.
    await app.browser.setWindowSize(1280, 800);
    await show(VIEWS.at(-1), "de");
    await app.click(`.pane.active .tabbar [aria-label="Rechts teilen"]`);
    await app.browser.waitUntil(async () => (await app.browser.execute(() => document.querySelectorAll(".pane").length)) === 2, { timeoutMsg: "no split" });
    for (const v of VIEWS) {
      await show(v, "de");
      await audit(`${id} split ${v.id}`);
      await app.shot(`audit-${id}-split-${v.id}`);
    }
    await onePane();
  });
}

test("English: every view at 1280 px and in a split pane at 900 px", async () => {
  await app.close();
  ({ app, dataDir } = await launchEnglish({ width: 1280, height: 800 }));
  note = await app.invoke("page_create", { parentId: null, title: "Review page with a fairly long title for the tab strip", icon: null, content: "#project #customer\n\n- [ ] Send the offer due:2026-10-20\n\n```query\ntasks open\n```\n" });
  for (const v of VIEWS) {
    await show(v, "en");
    await audit(`en 1280px ${v.id}`);
    await app.shot(`audit-en-1280-${v.id}`);
  }
  await app.browser.setWindowSize(900, 640);
  await show(VIEWS.at(-1), "en");
  await app.click(`.pane.active .tabbar [aria-label="Split right"]`);
  await app.browser.waitUntil(async () => (await app.browser.execute(() => document.querySelectorAll(".pane").length)) === 2, { timeoutMsg: "no split" });
  for (const v of VIEWS) {
    await show(v, "en");
    await audit(`en split 900px ${v.id}`);
    await app.shot(`audit-en-split-900-${v.id}`);
  }
});

test("no layout problems were found", () => {
  assert.deepEqual(problems, []);
});

test("no console errors", async () => {
  assert.deepEqual(await app.consoleErrors(), []);
});
