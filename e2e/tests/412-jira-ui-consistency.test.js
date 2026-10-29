// The Jira surfaces as one family (q123): „In der Issue-Ansicht öffnen“ has the same label, icon
// and place (first, then „In Jira öffnen“) in the Issues list (row actions, menu, the opened row),
// the hover card of a chip, the briefing's rows and a plan block; the row actions keep their room
// (nothing jumps or hides the status when they show), the hover card above a chip hangs right
// above it, the issue view's „In Arcalo“ values line up with the details, a resolved date does not
// break, a second Enter or Ctrl+Enter while Jira answers writes nothing twice (comment, new
// issue). Screenshots of the list, the card and the view in light, dark and high contrast and at
// 900, 1480 and 1920 px, each checked for clipped or overlapping controls.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";
import { defaultIssues, startFakeJira } from "../lib/fake-jira.js";
import { auditLayout } from "../lib/layout-audit.js";

const test = guarded(nodeTest, () => app);
let app;
let jira;
let pageId;
/** The icon of the issue view button in the list; every other place must show the same. */
let viewIcon = "";
const LONG = "Customer portal: the single sign-on login fails for every user of the new tenant after the certificate rotation on the identity provider";
before(async () => {
  const issues = defaultIssues();
  issues.push({ key: "PROJ-130", summary: LONG, type: "Bug", status: "Waiting for customer", category: "indeterminate", priority: "Highest", assignee: "Mia Meyer", project: "PROJ", projectName: "Portal", due: null, sprint: "Sprint 4", description: "" });
  jira = await startFakeJira({ flavor: "cloud", issues });
  app = await launch({ env: { ARCALO_JIRA_DELAY_SECS: "600" } });
  await app.invoke("jira_site_save", {
    site: { id: "", name: "Acme", color: "", kind: "cloud", url: jira.url, email: "mia@firma.de", enabled: true, log_work: false, allow_writes: false },
    token: "secret-token",
  });
  await app.invoke("jira_sync_now", { site: "acme" });
  const filler = Array.from({ length: 40 }, (_, i) => `Zeile ${i + 1}`).join("\n\n");
  const page = await app.invoke("page_create", { title: "Jira-Familie", parentId: null });
  pageId = page.id;
  await app.invoke("page_save", { id: pageId, content: `Oben PROJ-123 besprechen.\n\n- [ ] Neues Issue aus der Notiz\n\n${filler}\n\nUnten PROJ-124 prüfen.\n` });
  await app.reload();
});
after(async () => {
  await app?.close();
  await jira?.close();
});

const VIEW = "In der Issue-Ansicht öffnen";
const JIRA = "In Jira öffnen";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const count = (sel) => app.browser.execute((s) => document.querySelectorAll(s).length, sel);
const V = (key, sel = "") => `[data-issue-view="${key}"] ${sel}`.trim();
const EDITOR = ".pane.active > .pane-content:not([hidden]) .ProseMirror";
const clickText = async (sel, pattern) => {
  await app.browser.waitUntil(
    () =>
      app.browser.execute(
        (s, src) => {
          const el = [...document.querySelectorAll(s)].find((b) => new RegExp(src).test(b.textContent.trim()) && !b.disabled);
          el?.click();
          return !!el;
        },
        sel,
        pattern.source,
      ),
    { timeoutMsg: `no ${sel} ${pattern}` },
  );
  await app.browser.pause(150);
};
/** The open buttons in `root`: label, icon and size, in their order. */
/** The layout audit of `root`; the time tracking value is several lines on purpose (bar and three rows). */
const audit = async (root) => (await app.browser.execute(auditLayout, root)).filter((p) => !/Zeiterfassung bearbeiten/.test(p));
const openButtons = (root) =>
  app.browser.execute(
    (r) =>
      [...document.querySelectorAll(`${r} .issue-open-buttons > *`)].map((b) => ({
        label: b.getAttribute("aria-label") || b.textContent.trim(),
        icon: (b.querySelector("svg")?.getAttribute("class") ?? "").match(/lucide-[a-z0-9-]+/)?.[0] ?? "",
        w: b.offsetWidth,
        h: b.offsetHeight,
      })),
    root,
  );
async function shown(key) {
  await app.waitFor(V(key, ".iv-summary, .iv-summary-edit"), 15000);
  await app.browser.waitUntil(() => app.browser.execute((s) => !document.querySelector(s), V(key, ".iv-refreshing")), { timeout: 15000, timeoutMsg: `${key} still loading` });
}
async function closeView() {
  await app.keys(["Escape"]);
  await app.browser.waitUntil(async () => (await count(".iv")) === 0, { timeoutMsg: "view still open" });
}
async function openByPalette(key) {
  await app.keys(["Control", "k"]);
  await app.waitFor(".palette input");
  await app.type(key);
  await app.browser.waitUntil(() => app.browser.execute((k) => (document.querySelector(".pal-item.sel")?.textContent ?? "").includes(`Issue ${k} öffnen`), key), { timeoutMsg: "the issue is not the first item" });
  await app.keys(["Enter"]);
  await shown(key);
}
async function setTheme(mode, id = null) {
  const view = await app.invoke("settings_get");
  const ap = { ...view.settings.appearance };
  if (id && mode === "light") ap.theme_light = id;
  if (id && mode === "dark") ap.theme_dark = id;
  await app.invoke("settings_save", { settings: { ...view.settings, theme: mode, appearance: ap } });
  await app.reload();
}
async function openIssues() {
  await app.click(".ribbon-issues");
  await app.waitFor('[data-issue-row="PROJ-130"]', 10000);
}
/** Geometry of a list row: summary, status and the actions. */
const rowGeometry = (key) =>
  app.browser.execute((k) => {
    const row = document.querySelector(`.issues-view [data-issue-row="${k}"]`);
    const r = (el) => {
      const b = el.getBoundingClientRect();
      return { left: Math.round(b.left), right: Math.round(b.right), top: Math.round(b.top), bottom: Math.round(b.bottom), width: Math.round(b.width) };
    };
    return { summary: r(row.querySelector(".issue-summary")), status: r(row.querySelector(".issue-row-main .issue-status")), actions: r(row.querySelector(".issue-actions")), opacity: Number(getComputedStyle(row.querySelector(".issue-actions")).opacity) };
  }, key);
async function openChipCard(key) {
  await app.browser.execute(() => document.querySelector(".issue-preview") && document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
  const chip = await app.waitFor(`${EDITOR} .issue-chip[data-issue="${key}"]`, 10000);
  await chip.moveTo();
  await app.waitFor(".issue-preview .issue-open-buttons", 6000);
}

test("the Issues list: the actions keep their room, the issue view comes first everywhere", async () => {
  await openIssues();
  // Away from the rows: the actions are hidden, their room kept.
  await (await app.$(".issues-view h1")).moveTo();
  await sleep(250);
  const rest = await rowGeometry("PROJ-130");
  assert.equal(rest.opacity, 0);
  await (await app.$('.issues-view [data-issue-row="PROJ-130"] .issue-key')).moveTo();
  await app.browser.waitUntil(async () => (await rowGeometry("PROJ-130")).opacity === 1, { timeoutMsg: "actions not shown on hover" });
  const hover = await rowGeometry("PROJ-130");
  assert.deepEqual(hover.summary, rest.summary, "the summary moved when the actions showed");
  assert.deepEqual(hover.status, rest.status, "the status moved when the actions showed");
  assert.ok(hover.status.right + 6 <= hover.actions.left, `the actions cover the status: ${JSON.stringify(hover)}`);
  assert.ok(hover.summary.bottom - hover.summary.top < 30, `the long summary is not one line: ${JSON.stringify(hover.summary)}`);
  assert.ok(hover.actions.top >= hover.summary.top - 12 && hover.actions.bottom <= hover.summary.bottom + 12, "actions centered on the row");
  const row = await openButtons('.issues-view [data-issue-row="PROJ-130"] .issue-actions');
  assert.deepEqual(row.map((b) => b.label), [VIEW, JIRA]);
  assert.ok(row.every((b) => b.w >= 22 && b.h >= 22), `hit area: ${JSON.stringify(row)}`);
  viewIcon = row[0].icon;
  assert.ok(viewIcon, "the issue view button has an icon");
  assert.deepEqual(
    await app.browser.execute(() => [...document.querySelectorAll('.issues-view [data-issue-row="PROJ-130"] .issue-actions button')].map((b) => b.getAttribute("aria-label"))),
    [VIEW, JIRA, "Mehr zu PROJ-130"],
  );
  // Keyboard: Tab from the row reaches the issue view button, which shows the actions.
  await app.browser.execute(() => document.querySelector('.issues-view [data-issue-row="PROJ-124"] .issue-row-main').focus());
  await app.keys(["Tab"]);
  assert.equal(await app.browser.execute(() => document.activeElement?.getAttribute("aria-label")), VIEW);
  await app.browser.waitUntil(() => app.browser.execute(() => Number(getComputedStyle(document.querySelector('.issues-view [data-issue-row="PROJ-124"] .issue-actions')).opacity) === 1), { timeoutMsg: "the focused actions stay hidden" });
  await app.keys(["Enter"]);
  await shown("PROJ-124");
  await closeView();
  // The menu: the same order and icon.
  const main = await app.$('.issues-view [data-issue-row="PROJ-123"] .issue-row-main');
  await main.click({ button: "right" });
  await app.waitFor(".menu .menu-item");
  const items = await app.browser.execute(() => [...document.querySelectorAll(".menu .menu-item")].slice(0, 4).map((m) => ({ label: m.textContent.trim(), icon: (m.querySelector("svg")?.getAttribute("class") ?? "").match(/lucide-[a-z0-9-]+/)?.[0] ?? "" })));
  assert.deepEqual(items.map((m) => m.label), [VIEW, JIRA, "Notiz öffnen", "Schlüssel kopieren"]);
  assert.equal(items[0].icon, viewIcon, "the same icon in the menu");
  await app.keys(["Escape"]);
  await app.browser.waitUntil(async () => (await count(".menu")) === 0, { timeoutMsg: "menu still open" });
  // The opened row: the primary button says the same.
  await app.browser.execute(() => document.querySelector('.issues-view [data-issue-row="PROJ-123"] .issue-row-main').click());
  await app.waitText('.issues-view [data-issue-row="PROJ-123"] .issue-full-view', new RegExp(`^${VIEW}$`));
  assert.equal(await app.browser.execute(() => (document.querySelector('.issues-view [data-issue-row="PROJ-123"] .issue-full-view svg')?.getAttribute("class") ?? "").match(/lucide-[a-z0-9-]+/)?.[0]), viewIcon);
  const problems = await audit(".issues-view");
  assert.deepEqual(problems, [], "Issues list layout");
});

test("the hover card of a chip: both open buttons in view; above the chip it hangs right above it", async () => {
  await clickText(".sidebar .tree-row", /^Jira-Familie/);
  await openChipCard("PROJ-123");
  const card = await openButtons(".issue-preview");
  assert.deepEqual(card.map((b) => b.label), [VIEW, JIRA]);
  assert.equal(card[0].icon, viewIcon, "the same icon as in the list");
  assert.equal(await app.browser.execute(() => Number(getComputedStyle(document.querySelector(".issue-preview .issue-open-view")).opacity)), 1, "visible without hovering the button");
  const excerpt = await app.text(".issue-preview .issue-preview-desc");
  assert.match(excerpt, /Steps: open login/);
  assert.doesNotMatch(excerpt, /\n\s*\n/, "blank lines between the paragraphs");
  await app.shot("412-chip-card");
  await app.click(".issue-preview .issue-open-view");
  await shown("PROJ-123");
  assert.equal(await count(".issue-preview"), 0, "the card closes");
  await closeView();
  // The chip at the bottom of the window: the card opens above, its bottom right over the chip.
  await app.browser.execute((s) => document.querySelector(`${s} .issue-chip[data-issue="PROJ-124"]`).scrollIntoView({ block: "end" }), EDITOR);
  await sleep(300);
  await openChipCard("PROJ-124");
  const gap = await app.browser.execute((s) => {
    const card = document.querySelector(".issue-preview").getBoundingClientRect();
    const chip = document.querySelector(`${s} .issue-chip[data-issue="PROJ-124"]`).getBoundingClientRect();
    return { above: card.bottom <= chip.top, gap: Math.round(chip.top - card.bottom) };
  }, EDITOR);
  assert.ok(gap.above && gap.gap >= 0 && gap.gap < 12, `card not right above the chip: ${JSON.stringify(gap)}`);
  await app.shot("412-chip-card-above");
  await app.browser.execute(() => document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
});

test("a plan block with an issue: the same two buttons", async () => {
  const start = new Date();
  start.setHours(Math.min(start.getHours() + 1, 20), 0, 0, 0);
  const b = await app.invoke("block_create", { block: { title: "", start: start.toISOString(), end: new Date(start.getTime() + 3600e3).toISOString(), link: { kind: "issue", key: "PROJ-123" } } });
  await app.browser.execute(() => localStorage.setItem("arcalo.calendar.view", "week"));
  await app.click(".ribbon-calendar-view");
  const sel = `.calv-block[data-block="${b.id}"]`;
  await app.waitFor(sel, 10000);
  await app.browser.execute((s) => document.querySelector(s).focus(), sel);
  await app.keys(["Enter"]);
  await app.waitFor(".calv-block-detail .issue-open-buttons");
  const btns = await openButtons(".calv-block-detail");
  assert.deepEqual(btns.map((x) => x.label), [VIEW, JIRA]);
  assert.equal(btns[0].icon, viewIcon, "the same icon as in the list");
  await app.click(".calv-block-detail .issue-open-view");
  await shown("PROJ-123");
  // Esc closes the issue view, not the calendar's block under it (the calendar took the key).
  await closeView();
  assert.equal(await count(".calv-block-detail"), 1, "Esc went to the calendar");
  await app.invoke("block_delete", { id: b.id }).catch(() => {});
});

test("the issue view: header order, „In Arcalo“ lined up with the details, a resolved date in one piece", async () => {
  Object.assign(jira.issues.find((i) => i.key === "PROJ-100"), { resolution: "Won't Fix" });
  await openByPalette("PROJ-100");
  const head = await app.browser.execute((s) => [...document.querySelectorAll(`${s} .iv-head-actions > button`)].map((b) => b.getAttribute("aria-label")), V("PROJ-100"));
  assert.deepEqual(head.slice(-3), [JIRA, "Weitere Aktionen", "Schließen"]);
  const cols = await app.browser.execute((s) => {
    const left = (el) => Math.round(el.getBoundingClientRect().left);
    return { details: left(document.querySelector(`${s} .iv-side > .iv-fields .iv-field > dd`)), arcalo: left(document.querySelector(`${s} .iv-arcalo .iv-field > dd`)) };
  }, V("PROJ-100"));
  assert.equal(cols.arcalo, cols.details, "„In Arcalo“ values in the column of the details");
  const resolved = await app.browser.execute((s) => {
    const row = [...document.querySelectorAll(`${s} .iv-field`)].find((f) => f.querySelector("dt")?.textContent === "Erledigt");
    const time = row?.querySelector("time");
    return { text: row?.querySelector("dd")?.textContent ?? "", lines: time ? time.getClientRects().length : -1 };
  }, V("PROJ-100"));
  assert.match(resolved.text, /Won't Fix/);
  assert.equal(resolved.lines, 1, "the resolved date broke into lines");
  await closeView();
});

test("a second Ctrl+Enter or Enter while Jira answers writes nothing twice", async () => {
  // A comment.
  await openByPalette("PROJ-125");
  await app.keys(["c"]);
  await app.browser.waitUntil(() => app.browser.execute(() => !!document.activeElement?.closest(".iv-composer")), { timeoutMsg: "c did not focus the composer" });
  await app.type("Only once, please.");
  const posts = () => jira.requests.filter((r) => r.method === "POST" && r.path.endsWith("/issue/PROJ-125/comment")).length;
  jira.state.writeDelayMs = 1500;
  await app.keys(["Control", "Enter"]);
  await app.keys(["Control", "Enter"]);
  await app.waitText(V("PROJ-125", ".iv-thread"), /Only once, please/, 10000);
  await sleep(500);
  assert.equal(posts(), 1, "the comment was posted twice");
  jira.state.writeDelayMs = 0;
  await app.dismissToasts();
  await closeView();
  // A new issue from a task.
  await clickText(".sidebar .tree-row", /^Jira-Familie/);
  const task = await app.waitFor(`${EDITOR} li[data-checked]`);
  await task.click({ button: "right" });
  await clickText(".menu [role^='menuitem'], .menu button", /Jira-Issue anlegen/);
  await app.waitFor(".dialog");
  await app.browser.waitUntil(async () => !(await app.browser.execute(() => document.querySelector('.dialog [aria-label="Typ"]')?.getAttribute("aria-disabled") === "true" || document.querySelector('.dialog [aria-label="Typ"]')?.disabled)), { timeoutMsg: "types not loaded" });
  await sleep(300);
  await app.browser.execute(() => document.querySelector('.dialog input[aria-label="Titel"]').focus());
  const creates = () => jira.requests.filter((r) => r.method === "POST" && /\/rest\/api\/\d\/issue$/.test(r.path)).length;
  const before = creates();
  jira.state.writeDelayMs = 1500;
  await app.keys(["Enter"]);
  await app.keys(["Enter"]);
  await app.browser.waitUntil(async () => (await count(".dialog")) === 0, { timeout: 10000, timeoutMsg: "dialog still open" });
  jira.state.writeDelayMs = 0;
  await sleep(500);
  assert.equal(creates() - before, 1, "the issue was created twice");
  await app.dismissToasts();
});

test("screenshots: list, card and view in every theme and at 900, 1480 and 1920 px", async () => {
  for (const [mode, id, name] of [["light", "arcalo-light", "light"], ["dark", null, "dark"], ["dark", "contrast-dark", "contrast-dark"], ["light", "contrast-light", "contrast-light"]]) {
    await setTheme(mode, id);
    await openIssues();
    await (await app.$('.issues-view [data-issue-row="PROJ-130"] .issue-key')).moveTo();
    await sleep(300);
    await app.dismissToasts();
    await app.shot(`412-issues-${name}`);
    await openByPalette("PROJ-123");
    await app.dismissToasts();
    await sleep(300);
    assert.deepEqual(await audit(".iv"), [], `${name}: issue view layout`);
    await app.shot(`412-issue-view-${name}`);
    await closeView();
  }
  await setTheme("light", "arcalo-light");
  for (const [w, h] of [[900, 760], [1920, 1080], [1480, 920]]) {
    await app.browser.setWindowSize(w, h);
    await sleep(400);
    await openIssues();
    await (await app.$('.issues-view [data-issue-row="PROJ-130"] .issue-key')).moveTo();
    await sleep(300);
    const g = await rowGeometry("PROJ-130");
    assert.ok(g.status.right + 6 <= g.actions.left, `${w}px: the actions cover the status`);
    assert.deepEqual(await audit(".issues-view"), [], `${w}px: Issues list layout`);
    await app.shot(`412-issues-${w}`);
    await openByPalette("PROJ-123");
    assert.deepEqual(await audit(".iv"), [], `${w}px: issue view layout`);
    await app.shot(`412-issue-view-${w}`);
    await closeView();
  }
});
