// A screenshot tour of the desktop app: every view, panel, menu, context menu, dialog, popover and
// settings page, in German and English, in light, dark and the contrast themes, at 900x700,
// 1480x920 and 1920x1080 (not every combination: each theme, size and language at least once).
// Each stop is photographed for the visual review and checked by the layout audit (clipped text,
// controls out of their box, overlaps, sideways scrolling); the English runs also for German words.
// A stop that cannot be reached (a control that does nothing, a menu that does not open) is a
// finding as well. All findings are asserted at the end, so one run shows them all.
import { test as nodeTest, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { launch, guarded, EDITOR } from "../lib/harness.js";
import { launchEnglish, germanLeftovers } from "../lib/english.js";
import { auditLayout } from "../lib/layout-audit.js";
import { translator } from "../lib/catalog.js";

const test = guarded(nodeTest, () => app);
let app;
let enDir = null;
after(async () => {
  await app?.close();
  if (enDir) fs.rmSync(enDir, { recursive: true, force: true });
});

const ENV = { ARCALO_SECRET_STORE: "file", ARCALO_BACKUP_DELAY_SECS: "3600" };
const PANE = ".pane.active > .pane-content:not([hidden])";
const PIN = "8642";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let lang = "de";
let t = translator("de");
let combo = "";
let n = 0;
const findings = [];
const note = (where, what) => findings.push(`${combo} ${where}: ${what}`);

/** The theme `id` in `mode` ("light" or "dark") at `width` x `height`. */
async function look(mode, id, width, height) {
  await app.browser.setWindowSize(width, height);
  const view = await app.invoke("settings_get");
  const ap = { ...view.settings.appearance, [mode === "light" ? "theme_light" : "theme_dark"]: id };
  await app.invoke("settings_save", { settings: { ...view.settings, theme: mode, appearance: ap } });
  await app.reload();
  await app.browser.waitUntil(async () => (await app.browser.execute(() => document.documentElement.dataset.theme)) === mode, { timeoutMsg: `${mode} not applied` });
  await sleep(400);
}

/** What is open on top: a menu, a popover or a dialog (the last one), else the active pane. */
const ROOTS = ".menu, [role=dialog], [role=listbox].suggest, .popover, .overlay > *, .modal";
async function topRoot() {
  return app.browser.execute((sel) => {
    const shown = [...document.querySelectorAll(sel)].filter((e) => e.getClientRects().length && getComputedStyle(e).visibility !== "hidden");
    const el = shown[shown.length - 1];
    if (!el) return null;
    if (!el.id) el.id = `tour-root-${Math.random().toString(36).slice(2, 8)}`;
    return `#${CSS.escape(el.id)}`;
  }, ROOTS);
}

/**
 * What the layout audit reports by design on this tour, each with its reason. The audit is made
 * for forms; the tour also shows cards, boards and the editor.
 */
const AUDIT_OK = [
  // Multi-line buttons: cards (budget, week bars, review rows, query rows) are buttons on purpose.
  /^wraps: /,
  // The scroll outline's marks and the query block's checkboxes are small on purpose (larger hit areas).
  /^tiny: button\.(so-mark|qb-check)/,
  // The page icon sits left of the title column.
  /^overflows header\.page-header .*button\.page-icon-btn/,
  // Containers that scroll sideways: the board, wide tables, code, the toolbar of a narrow pane.
  /^cut sideways: (div\.board|div\.coll-table-wrap|pre|div\.editor-toolbar)\b/,
  // Buttons of the toolbar of a narrow pane scrolled out of it (the audit clips only vertically).
  /^overlap: button\.tb-/,
  // The CATS column order is a long list, shortened with an ellipsis (the full value is the tooltip).
  /^select too narrow: button\.input\.select "(CATS-Spalten|CATS columns)"/,
];

/** Photographs the window and audits `root` (default: what is on top, else the active pane). */
async function shot(name, root) {
  await sleep(350);
  const file = `sweep-${combo}-${String(++n).padStart(3, "0")}-${name}`;
  await app.shot(file);
  const where = root ?? (await topRoot()) ?? PANE;
  const problems = await app.browser.execute(auditLayout, where).catch((e) => [`audit failed: ${e.message}`]);
  for (const p of problems) if (!/^root .* not found$/.test(p) && !AUDIT_OK.some((re) => re.test(p))) note(file, p);
  // Nothing may stick out of the window sideways.
  const wide = await app.browser.execute(() => document.documentElement.scrollWidth - window.innerWidth);
  if (wide > 1) note(file, `the page scrolls sideways by ${wide}px`);
  if (lang === "en") for (const h of await germanLeftovers(app, [/Arcalo/, /Sprint|Quartal|Tour/])) note(file, `German: ${h}`);
}

/** Runs one stop; a stop that fails is a finding, the tour goes on. */
async function stop(name, fn) {
  try {
    await fn();
  } catch (e) {
    note(name, `failed: ${String(e.message ?? e).split("\n")[0]}`);
    await app.browser.saveScreenshot(`${process.env.ARCALO_SHOTS ?? "screenshots"}/sweep-${combo}-FAILSTOP-${name}.png`).catch(() => {});
  }
  await closeAll();
}

/** Closes menus, popovers and dialogs (Escape until nothing is on top any more). */
async function closeAll() {
  for (let i = 0; i < 4; i++) {
    if (!(await topRoot())) return;
    await app.keys(["Escape"]);
    await sleep(150);
  }
}

const ribbon = async (key) => {
  await app.dismissToasts();
  await app.click(`.ribbon [aria-label^="${t(key)}"]`);
  await sleep(600);
};

/** Runs the palette command titled `t(key)`. */
async function command(key, vars) {
  const title = t(key, vars);
  await app.keys(["Control", "k"]);
  const input = await app.waitFor(".palette input");
  await app.browser.execute((el, v) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, input, title);
  await app.browser.waitUntil(
    async () =>
      app.browser.execute((want) => {
        const item = [...document.querySelectorAll(".palette .pal-item")].find((i) => i.querySelector(".pal-title")?.firstChild?.textContent?.trim() === want);
        item?.click();
        return !!item;
      }, title),
    { timeout: 4000, timeoutMsg: `no command "${title}"` },
  );
  await sleep(600);
}

/** Opens the context menu of `sel` (the first match), as a right-click on its middle does. */
async function rightClick(sel) {
  const el = await app.waitFor(sel);
  await app.browser.execute((e) => {
    const r = e.getBoundingClientRect();
    e.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
  }, el);
  await app.waitFor(".menu");
}

/** Whether a tooltip is shown over the open menu (it hid the menu's first items). */
async function tooltipOverMenu() {
  return app.browser.execute(() => {
    const tip = document.querySelector(".tooltip.on")?.getBoundingClientRect();
    const menu = document.querySelector('[role="menu"]')?.getBoundingClientRect();
    return !!tip && !!menu && tip.left < menu.right && tip.right > menu.left && tip.top < menu.bottom && tip.bottom > menu.top;
  });
}

/** Opens a menu with a real click on `sel` and checks after the tooltip delay that no tooltip covers it. */
async function openMenu(sel, name) {
  await app.click(sel);
  await app.waitFor(".menu");
  // The tooltip delay is 450 ms; the pointer rests on the button as a user's would.
  await sleep(700);
  if (await tooltipOverMenu()) note(name, "a tooltip covers the menu");
}

/** Shots of a scrolling view, a window height at a time (at most `max`). */
async function scrolled(name, scroller, max = 6) {
  const pages = await app.browser.execute((s) => {
    const el = document.querySelector(s);
    if (!el) return 0;
    el.scrollTop = 0;
    return Math.ceil(el.scrollHeight / Math.max(el.clientHeight, 1));
  }, scroller);
  await shot(`${name}-1`, PANE);
  for (let i = 1; i < Math.min(pages, max); i++) {
    await app.browser.execute((s, k) => {
      const el = document.querySelector(s);
      el.scrollTop = el.clientHeight * k * 0.9;
    }, scroller, i);
    await shot(`${name}-${i + 1}`, PANE);
  }
}

const BLOCKS = (de) => `# ${de ? "Tour durch alle Blöcke" : "Tour of every block"}

[TOC]

## ${de ? "Text" : "Text"}

${de ? "Ein Absatz mit **fett**, *kursiv*, ~~durchgestrichen~~, `Code`, ==markiert==, einem [Link](https://example.com), einem [[Wikilink]] und #projekt." : "A paragraph with **bold**, *italic*, ~~strikethrough~~, `code`, ==highlighted==, a [link](https://example.com), a [[wikilink]] and #project."}[^1]

### ${de ? "Listen" : "Lists"}

- ${de ? "Punkt eins" : "Item one"}
  - ${de ? "Eingerückt" : "Nested"}
- ${de ? "Punkt zwei" : "Item two"}

1. ${de ? "Erstens" : "First"}
2. ${de ? "Zweitens" : "Second"}

- [ ] ${de ? "Offene Aufgabe" : "Open task"} due:2026-12-01
- [x] ${de ? "Erledigte Aufgabe" : "Done task"}
- [ ] ${de ? "Wichtige Aufgabe mit einem sehr langen Titel, der in einem schmalen Fenster umbrechen muss, ohne etwas abzuschneiden" : "Important task with a very long title that has to wrap in a narrow window without cutting anything off"} !!

## ${de ? "Blöcke" : "Blocks"}

> ${de ? "Ein Zitat." : "A quote."}

> [!note] ${de ? "Hinweis" : "Note"}
> ${de ? "Ein Hinweis mit Text." : "A note with text."}

> [!warning] ${de ? "Warnung" : "Warning"}
> ${de ? "Eine Warnung." : "A warning."}

> [!tip]+ ${de ? "Aufklappbar" : "Foldable"}
> ${de ? "Inhalt zum Aufklappen." : "Content to fold."}

<!-- ${de ? "spalten" : "columns"} -->

${de ? "Linke Spalte" : "Left column"}

<!-- ${de ? "spalte" : "column"} -->

${de ? "Rechte Spalte" : "Right column"}

<!-- /${de ? "spalten" : "columns"} -->

\`\`\`ts
const answer: number = 42;
console.log(\`the answer is \${answer}\`);
\`\`\`

| ${de ? "Name" : "Name"} | ${de ? "Status" : "Status"} | ${de ? "Stunden" : "Hours"} |
| --- | --- | ---: |
| Alpha | ${de ? "Offen" : "Open"} | 2,5 |
| Beta | ${de ? "Erledigt" : "Done"} | 10 |

---

\`\`\`query
${de ? "aus: aufgaben\nanzeige: liste\nstatus: offen" : "from: tasks\nshow: list\nstatus: open"}
\`\`\`

[^1]: ${de ? "Eine Fußnote." : "A footnote."}
`;

/** Pages for the tour: every block type, a table and a board of child pages. */
async function seed() {
  const de = lang === "de";
  const blocks = await app.invoke("page_create", { parentId: null, title: de ? "Tour durch alle Blöcke" : "Tour of every block", icon: null, content: BLOCKS(de) });
  const schema = de
    ? "---\neigenschaften:\n  status: {typ: auswahl, optionen: {Offen: blau, In Arbeit: orange, Erledigt: grün}}\n  aufwand: zahl\n  fällig: datum\nansicht: VIEW\n---\n"
    : "---\nproperties:\n  status: {type: select, options: {Open: blue, In progress: orange, Done: green}}\n  effort: number\n  due: date\nview: VIEW\n---\n";
  const [effort, due] = de ? ["aufwand", "fällig"] : ["effort", "due"];
  const kids = de
    ? [["Login", "Offen", 3, "2026-11-02"], ["Export", "In Arbeit", 5, "2026-11-04"], ["Suche", "Erledigt", 1, "2026-11-06"]]
    : [["Login", "Open", 3, "2026-11-02"], ["Export", "In progress", 5, "2026-11-04"], ["Search", "Done", 1, "2026-11-06"]];
  const ids = {};
  for (const [view, title, tag] of [["tabelle", de ? "Sprint Tabelle" : "Sprint table", "T"], ["board", de ? "Sprint Board" : "Sprint board", "B"]]) {
    const p = await app.invoke("page_create", { parentId: null, title, icon: null, content: schema.replace("VIEW", view) });
    // Page titles are unique: the board's children get a letter of their own.
    for (const [k, s, a, d] of kids) await app.invoke("page_create", { parentId: p.id, title: `${k} ${tag}`, icon: null, content: `---\nstatus: ${s}\n${effort}: ${a}\n${due}: ${d}\n---\n` });
    ids[view] = p.id;
  }
  return { blocks: blocks.id, ...ids };
}

async function openPage(id) {
  await app.invoke("search_open", { target: { kind: "page", page_id: id, new_tab: false } });
  await app.waitFor(`${PANE} ${EDITOR}`);
  await sleep(500);
}

/** The whole tour in the current language, theme and size. */
async function tour(pages, { full = true } = {}) {
  await stop("home", async () => {
    await app.click(".pane.active .tabbar-home");
    await shot("home");
  });
  await stop("sidebar-new-menu", async () => {
    await openMenu(".sidebar .side-new-menu", "sidebar-new-menu");
    await shot("sidebar-new-menu");
  });
  await stop("tree-options", async () => {
    await openMenu(".sidebar .tree-options", "tree-options");
    await shot("tree-options");
  });
  await stop("tree-context", async () => {
    const before = await app.browser.execute(() => document.querySelector(".pane.active .tab.active")?.innerText);
    await rightClick('.tree[role="tree"] .tree-row');
    await shot("tree-context");
    // A right-click opens the menu only; the page stays where it is.
    const after = await app.browser.execute(() => document.querySelector(".pane.active .tab.active")?.innerText);
    if (after !== before) note("tree-context", `the right-click opened the page (${before} -> ${after})`);
  });
  for (const tab of ["search", "bookmarks", "tags"]) {
    await stop(`sidebar-${tab}`, async () => {
      await app.click(`.side-tabs [aria-label^="${t(`sidebar.${tab}`)}"]`);
      await shot(`sidebar-${tab}`, ".sidebar");
    });
  }
  await stop("sidebar-files", async () => app.click(`.side-tabs [aria-label^="${t("sidebar.files")}"]`));

  // The editor with every block type.
  await stop("blocks", async () => {
    await openPage(pages.blocks);
    await scrolled("blocks", `${PANE} .page-scroll, ${PANE} .view-scroll`, full ? 6 : 2);
    // The footnotes heading belongs right above the footnotes, after the query block's result
    // (both are widgets at the same position; the heading once came first).
    const order = await app.browser.execute((sel) => {
      const head = document.querySelector(`${sel} .footnotes-head`);
      return { next: head?.nextElementSibling?.className ?? "", prev: head?.previousElementSibling?.className ?? "" };
    }, `${PANE} ${EDITOR}`);
    if (!/\bis-first\b/.test(order.next) || !/\brich-preview\b/.test(order.prev)) note("blocks", `the footnotes heading is not between the query result and the footnotes (${JSON.stringify(order)})`);
  });
  await stop("page-menu", async () => {
    await openMenu(`${PANE} [aria-label="${t("pv.more")}"]`, "page-menu");
    await shot("page-menu");
  });
  await stop("slash-menu", async () => {
    await app.caretToEnd();
    await app.keys(["/"]);
    await app.waitFor(".suggest, .slash-menu, [role=listbox]");
    await shot("slash-menu");
    await app.keys(["Escape"]);
    await app.keys(["Backspace"]);
  });
  await stop("table-toolbar", async () => {
    const cell = await app.waitFor(`${PANE} ${EDITOR} td`);
    await cell.click();
    await app.waitFor(".table-toolbar");
    await shot("table-toolbar", PANE);
    // The toolbar stands over the table's own end, not at the far end of the note.
    const r = await app.browser.execute((sel) => {
      const bar = document.querySelector(".table-toolbar").getBoundingClientRect();
      const table = document.querySelector(`${sel} table`).getBoundingClientRect();
      return { bar: Math.round(bar.right), table: Math.round(table.right) };
    }, `${PANE} ${EDITOR}`);
    if (Math.abs(r.bar - r.table) > 2) note("table-toolbar", `the toolbar ends at ${r.bar}, the table at ${r.table}`);
  });
  await stop("tab-context", async () => {
    await rightClick(".pane.active .tab.active");
    await shot("tab-context");
  });
  await stop("split", async () => {
    await command("cmd.split");
    await app.browser.waitUntil(async () => (await app.browser.execute(() => document.querySelectorAll(".pane").length)) > 1, { timeoutMsg: "no second pane" });
    await shot("split", ".workspace");
    await app.keys(["Control", "w"]);
    await sleep(400);
  });
  if (full) {
    await stop("collection-table", async () => {
      await openPage(pages.tabelle);
      await shot("collection-table");
    });
    await stop("collection-board", async () => {
      await openPage(pages.board);
      await shot("collection-board");
    });
  }

  // Search.
  await stop("palette", async () => {
    await app.keys(["Control", "k"]);
    await app.waitFor(".palette input");
    await shot("palette");
    await app.type(lang === "de" ? "Sprint" : "Sprint");
    await sleep(500);
    await shot("palette-query");
  });
  await stop("quick-switcher", async () => {
    await app.keys(["Control", "o"]);
    await app.waitFor(".palette input");
    await shot("quick-switcher");
    // Ctrl+O only opens pages: no hints for booking, asking or tags.
    if (await app.browser.execute(() => !!document.querySelector(".palette .pal-foot-hints"))) note("quick-switcher", "the footer offers /zeit, ? and # which the quick switcher does not do");
  });
  await stop("palette-nothing", async () => {
    await app.keys(["Control", "k"]);
    await app.waitFor(".palette input");
    await app.type("qqxxzz");
    await sleep(500);
    await shot("palette-nothing");
  });
  await stop("sidebar-search", async () => {
    await app.keys(["Control", "Shift", "f"]);
    await sleep(300);
    await app.type("Sprint");
    await sleep(600);
    await shot("sidebar-search", ".sidebar");
    await app.click(`.side-tabs [aria-label^="${t("sidebar.files")}"]`);
  });

  // The ribbon's views.
  await stop("calendar", async () => {
    await ribbon("ribbon.calendarView");
    await app.waitFor(`${PANE} .calv-actions`);
    const ends = new Set();
    for (const [i, v] of ["day", "workweek", "week", "month", "agenda"].entries()) {
      if (!full && i !== 2) continue;
      const seg = await app.browser.execute((s, k) => {
        const b = document.querySelector(`${s} .calv-views .segmented button:nth-child(${k})`);
        if (b && b.offsetParent) b.click();
        return !!(b && b.offsetParent);
      }, PANE, i + 1);
      if (!seg) await app.select(`${PANE} .calv-view-select`, v);
      await shot(`calendar-${v}`);
      // The tools stay at the right edge in every view (they jumped left when a long day title wrapped them).
      ends.add(await app.browser.execute((s) => Math.round(document.querySelector(`${s} .calv-actions`).getBoundingClientRect().right), PANE));
    }
    if (ends.size > 1) note("calendar", `the calendar tools move between views: ${[...ends].join(", ")}`);
  });
  await stop("daily-picker", async () => {
    await app.dismissToasts();
    await app.keys(["Control", "Shift", "c"]);
    await app.waitFor(".calendar");
    await shot("daily-picker");
  });
  await stop("timesheet", async () => {
    await ribbon("ribbon.timesheet");
    await scrolled("timesheet", `${PANE} .page-scroll, ${PANE} .view-scroll`, full ? 3 : 1);
  });
  await stop("timesheet-export", async () => {
    await app.click(`${PANE} [aria-label="${t("time.export")}"]`);
    await app.waitFor("[role=dialog]");
    await shot("timesheet-export");
  });
  for (const [key, name] of [
    ["ribbon.projects", "projects"],
    ["ribbon.tasks", "tasks"],
    ["ribbon.graph", "graph"],
    ["ribbon.activity", "activity"],
    ["ribbon.briefing", "briefing"],
    ["ribbon.review", "review"],
    ["ribbon.chat", "chat"],
  ]) {
    if (!full && !["tasks", "projects"].includes(name)) continue;
    await stop(name, async () => {
      await ribbon(key);
      await shot(name);
    });
  }
  await stop("assistant", async () => {
    await ribbon("ribbon.assistant");
    await shot("assistant", "body");
  });
  await stop("focus", async () => {
    await ribbon("ribbon.focus");
    await app.waitFor(".focus-form");
    await shot("focus");
  });
  await stop("help-menu", async () => {
    await openMenu(".ribbon .ribbon-help", "help-menu");
    await shot("help-menu");
  });

  // Palette commands: dialogs and the views without a ribbon button.
  const commands = full
    ? [
        ["cmd.trash", "trash"],
        ["cmd.attachments", "attachments"],
        ["cmd.weekReview", "week-review"],
        ["cmd.fromTemplate", "templates"],
        ["cmd.shortcuts", "shortcuts"],
        ["cmd.releaseNotes", "release-notes"],
        ["cmd.duplicates", "duplicates"],
        ["mw.cmd.report", "status-report"],
        ["mw.cmd.prep", "meeting-prep"],
        ["fl.tidy", "tidy-up"],
        ["cmd.bookmarksImport", "bookmarks-import"],
        ["cmd.mailDialog", "mail-dialog"],
        ["cmd.localGraph", "local-graph"],
        ["cmd.chatHistory", "chat-history"],
        ["cmd.activityDay", "activity-day"],
      ]
    : [["cmd.trash", "trash"], ["cmd.shortcuts", "shortcuts"]];
  for (const [key, name] of commands) {
    await stop(name, async () => {
      await command(key);
      await shot(name);
      // Where a dialog puts the focus (for the review of the first field).
      const focus = await app.browser.execute(() => {
        const a = document.activeElement;
        return a?.closest("[role=dialog]") ? `${a.tagName.toLowerCase()}.${[...a.classList].join(".")} ${a.getAttribute("aria-label") ?? ""}` : null;
      });
      if (focus) console.log(`[tour] ${combo} ${name}: focus on ${focus}`);
    });
  }

  // Settings, every section from top to bottom.
  let sections = [];
  // A narrow window shows the sections in a dropdown instead of the list.
  const listed = () => app.browser.execute((p) => [...document.querySelectorAll(`${p} .settings-nav-item`)].filter((b) => b.offsetParent).map((b) => b.dataset.section), PANE);
  await stop("settings", async () => {
    await ribbon("ribbon.settings");
    await app.waitFor(`${PANE} .settings-nav-item, ${PANE} .settings-section-select`);
    sections = await listed();
    if (!sections.length) {
      await app.click(`${PANE} .settings-section-select`);
      const list = await app.browser.execute((p) => document.querySelector(`${p} .settings-section-select`).getAttribute("aria-controls"), PANE);
      sections = await app.browser.execute((id) => [...document.querySelectorAll(`#${id} [role="option"]`)].map((o) => o.dataset.value), list);
      await app.keys(["Escape"]);
    }
  });
  for (const s of sections) {
    if (!full && !["appearance", "time", "ai", "about"].includes(s)) continue;
    await stop(`settings-${s}`, async () => {
      if ((await listed()).length) await app.browser.execute((p, sec) => document.querySelector(`${p} .settings-nav-item[data-section="${sec}"]`).click(), PANE, s);
      else await app.select(`${PANE} .settings-section-select`, s);
      await sleep(400);
      if (s === "appearance" && combo === "de-light-1480") {
        // A short label stays beside its three-way switch (the editor font row wrapped).
        const r = await app.browser.execute((p) => {
          const row = [...document.querySelectorAll(`${p} .set-row`)].find((x) => x.querySelector(".set-row-label")?.textContent === "Editor");
          return row ? Math.abs(row.querySelector(".set-row-label").getBoundingClientRect().top - row.querySelector(".set-row-control").getBoundingClientRect().top) : -1;
        }, PANE);
        if (r < 0 || r > 12) note("settings-appearance", `the editor font switch sits below its label (${r})`);
      }
      const scroller = await app.browser.execute((p) => {
        const nav = document.querySelector(`${p} .settings-nav`);
        const all = [...document.querySelectorAll(`${p} *`)].filter((e) => e !== nav && !nav?.contains(e) && /(auto|scroll)/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 4);
        const el = all.sort((a, b) => b.clientHeight - a.clientHeight)[0];
        if (!el) return null;
        el.id ||= "tour-settings-scroller";
        return `#${el.id}`;
      }, PANE);
      if (scroller) await scrolled(`settings-${s}`, scroller, full ? 5 : 2);
      else await shot(`settings-${s}`);
    });
  }
}

/** The capture window and the lock screen (in the same window, reloaded). */
async function windows() {
  await stop("capture", async () => {
    await app.reload("#capture");
    await app.waitFor(".capture");
    await shot("capture", ".capture");
  });
  await app.reload("");
  await stop("lock", async () => {
    const s = await app.invoke("applock_status");
    await app.invoke("applock_configure", { config: { ...s.config, mode: "start" }, pin: PIN });
    await app.invoke("applock_lock_now");
    await app.waitFor(".lock-card", 10000);
    await shot("lock", ".lock-card");
    const pin = await app.waitFor(".lock-pin");
    await pin.setValue(PIN);
    await app.keys(["Enter"]);
    await app.browser.waitUntil(async () => app.browser.execute(() => !!document.querySelector(".sidebar")), { timeout: 10000, timeoutMsg: "not unlocked" });
    await app.invoke("applock_configure", { config: { ...s.config, mode: "off" }, pin: null });
  });
}

let pages;
test("German, light, 1480x920", { timeout: 900000 }, async () => {
  app = await launch({ demo: true, env: ENV });
  pages = await seed();
  combo = "de-light-1480";
  await look("light", "arcalo-light", 1480, 920);
  await tour(pages);
  await windows();
});

test("German, dark, 900x700", { timeout: 900000 }, async () => {
  combo = "de-dark-900";
  await look("dark", "arcalo-dark", 900, 700);
  await tour(pages);
});

test("German, high contrast dark, 1920x1080", { timeout: 900000 }, async () => {
  combo = "de-hcdark-1920";
  await look("dark", "contrast-dark", 1920, 1080);
  await tour(pages, { full: false });
  await app.close();
  app = null;
});

test("English, high contrast light, 1480x920", { timeout: 900000 }, async () => {
  lang = "en";
  t = translator("en");
  ({ app, dataDir: enDir } = await launchEnglish({ env: { ...ENV, ARCALO_LOCALE: "en-US" } }));
  pages = await seed();
  combo = "en-hclight-1480";
  await look("light", "contrast-light", 1480, 920);
  await tour(pages);
  await windows();
});

test("English, dark, 900x700", { timeout: 900000 }, async () => {
  combo = "en-dark-900";
  await look("dark", "arcalo-dark", 900, 700);
  await tour(pages, { full: false });
});

test("English, light, 1920x1080", { timeout: 900000 }, async () => {
  combo = "en-light-1920";
  await look("light", "arcalo-light", 1920, 1080);
  await tour(pages, { full: false });
});

test("no findings on the tour", () => {
  assert.deepEqual(findings, []);
});
