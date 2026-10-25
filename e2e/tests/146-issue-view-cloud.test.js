// The issue view („Issue-Ansicht“) with Jira Cloud: opened from a chip in a note, from the command
// palette (a typed key and „Issue öffnen…“) and from a start page widget; every section as Jira's
// page shows it (rendered description with its image loaded through the site's login, details,
// custom fields, subtasks, links, attachments, remote links, comments, history, watchers and
// votes); editing the summary (`e`, with undo), a custom select and the description (written as
// ADF, the image kept); a transition whose screen needs a resolution; a comment (`c`), edited and
// deleted; a worklog; the conflict when someone changed the issue meanwhile; someone else's issue
// (read only but „Mir zuweisen“); offline read-only with „Stand von …“; 500 comments and 100
// attachments paged; the keyboard (Esc, focus trap, focus back). Screenshots in light, dark and
// high contrast and at 900 px (the phone sheet: 153-issue-view-phone).
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded, budget } from "../lib/harness.js";
import { startFakeJira } from "../lib/fake-jira.js";

const test = guarded(nodeTest, () => app);
let app;
let jira;
let pageId;
before(async () => {
  jira = await startFakeJira({ flavor: "cloud", big: "PROJ-124" });
  app = await launch({ env: { ARCALO_JIRA_DELAY_SECS: "600" } });
  await app.invoke("jira_site_save", {
    site: { id: "", name: "Acme", color: "", kind: "cloud", url: jira.url, email: "mia@firma.de", enabled: true, log_work: false, allow_writes: false },
    token: "secret-token",
  });
  await app.invoke("jira_sync_now", { site: "acme" });
  const page = await app.invoke("page_create", { title: "Login-Störung", parentId: null });
  pageId = page.id;
  await app.invoke("page_save", { id: pageId, content: "Heute PROJ-123 besprechen.\n" });
  await app.reload();
});
after(async () => {
  await app?.close();
  await jira?.close();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const V = (key, sel = "") => `[data-issue-view="${key}"] ${sel}`.trim();
const issue = (key) => jira.issues.find((i) => i.key === key);
const count = (sel) => app.browser.execute((s) => document.querySelectorAll(s).length, sel);
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
/** The view of `key` shown and read from Jira (the subline no longer says it is updating). */
async function shown(key) {
  await app.waitFor(V(key, ".iv-summary, .iv-summary-edit"), 15000);
  await app.browser.waitUntil(() => app.browser.execute((s) => !document.querySelector(s), V(key, ".iv-refreshing")), { timeout: 15000, timeoutMsg: `${key} still loading` });
}
async function closeView() {
  await app.keys(["Escape"]);
  await app.browser.waitUntil(async () => (await count(".iv")) === 0, { timeoutMsg: "view still open" });
}
/** Opens `key` from the command palette by typing it. */
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
/** Text in `root` below `min` contrast against what it is drawn on (WCAG). */
function lowContrast(root, min) {
  const parse = (c) => {
    const m = c.match(/^rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  };
  const lum = ([r, g, b]) => {
    const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
  const over = (top, bot) => [0, 1, 2].map((i) => top[i] * top[3] + bot[i] * (1 - top[3])).concat(1);
  const out = [];
  const box = document.querySelector(root);
  const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    if (!n.textContent.trim() || !el) continue;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    if (r.width < 2 || r.height < 2 || s.visibility === "hidden" || el.closest("[aria-hidden=true], .btn-primary:disabled, .is-editor-empty")) continue;
    const bgs = [];
    for (let p = el; p; p = p.parentElement) {
      const b = parse(getComputedStyle(p).backgroundColor);
      if (b && b[3] > 0) bgs.push(b);
      if (b && b[3] >= 1) break;
    }
    let bg = [255, 255, 255, 1];
    for (const b of bgs.reverse()) bg = over(b, bg);
    const fg = parse(s.color);
    if (!fg) continue;
    const c = ratio(over(fg, bg), bg);
    if (c < min) out.push(`${c.toFixed(2)} ${el.className} ${n.textContent.trim().slice(0, 30)}`);
  }
  return out;
}

test("a click on the chip opens the issue view; Esc closes it and the focus goes back", async () => {
  await clickText(".sidebar .tree-row", /^Login-Störung/);
  const tail = await app.waitFor('.pane.active > .pane-content:not([hidden]) .ProseMirror .issue-chip-tail[data-issue="PROJ-123"]', 10000);
  await tail.click();
  // At once a skeleton or the copy, then Jira's answer.
  await app.waitFor(V("PROJ-123"), 5000);
  await shown("PROJ-123");
  assert.equal(await app.text(V("PROJ-123", ".iv-summary")), "Login fails on SSO");
  const get = jira.requests.find((r) => r.method === "GET" && r.path === "/rest/api/3/issue/PROJ-123" && r.query.expand);
  for (const e of ["renderedFields", "names", "schema", "editmeta", "transitions", "changelog"]) assert.ok(get.query.expand.split(",").includes(e), `expand ${e}: ${get.query.expand}`);
  // The tab did not change: the note stays where it was.
  assert.match(await app.browser.execute(() => document.querySelector(".pane.active .tab.active")?.textContent ?? ""), /Login-Störung/);
  assert.equal(await app.browser.execute(() => document.activeElement?.closest(".iv") != null), true, "focus in the view");
  await closeView();
  assert.ok(await app.browser.execute(() => !!document.activeElement?.closest(".ProseMirror")), "focus back in the note");
});

test("every section as Jira's page shows it", async () => {
  await openByPalette("PROJ-123");
  const text = await app.text(V("PROJ-123"));
  // Header: key, type, breadcrumb, status.
  assert.match(await app.text(V("PROJ-123", ".iv-crumbs")), /Portal[\s\S]*PROJ-123/);
  assert.ok(await (await app.$(V("PROJ-123", ".iv-crumbs .issue-type-bug"))).isExisting(), "bug icon");
  assert.match(await app.text(V("PROJ-123", ".iv-status-btn")), /In Progress/i);
  // Description rendered from Jira's HTML: heading, bold, list, code; the image loaded with the login.
  await app.waitText(V("PROJ-123", ".iv-description h2"), /Steps/);
  assert.match(await app.text(V("PROJ-123", ".iv-description")), /SSO[\s\S]*Chrome and Edge[\s\S]*token_expired[\s\S]*The token has expired/);
  await app.browser.waitUntil(() => app.browser.execute((s) => !!document.querySelector(s)?.src.startsWith("data:image/png"), V("PROJ-123", ".iv-description img")), { timeoutMsg: "inline image not loaded" });
  const img = jira.requests.find((r) => r.path === "/rest/api/3/attachment/content/10500");
  assert.ok(img?.headers.authorization?.startsWith("Basic "), "the image came with the site's login, not in the address");
  assert.ok(!(await app.browser.execute((s) => document.querySelector(s).innerHTML, V("PROJ-123", ".iv-description"))).includes("secret-token"));
  // Details.
  for (const part of [/Bearbeiter[\s\S]*Mia Meyer/, /Autor[\s\S]*Tom/, /Priorität[\s\S]*High/, /Labels[\s\S]*sso[\s\S]*login/, /Sprint[\s\S]*Sprint 4/, /Story Points[\s\S]*5/, /Fällig/, /Customer ref[\s\S]*ACME-7781/, /Environment type[\s\S]*Production/, /Erstellt/, /Geändert/]) assert.match(text, part);
  await app.browser.waitUntil(() => app.browser.execute((s) => !!document.querySelector(s)?.src.startsWith("data:image/png"), V("PROJ-123", '.iv-field[data-field="assignee"] .iv-avatar img')), { timeoutMsg: "avatar not loaded" });
  assert.match(await app.text(V("PROJ-123", ".iv-counts")), /3[\s\S]*1/, "watchers and votes");
  // Content: subtasks, links by type, attachments with thumbnails, remote links.
  assert.match(await app.text(V("PROJ-123", '[data-section="subtasks"]')), /PROJ-125[\s\S]*Audit log export[\s\S]*To Do/i);
  assert.match(await app.text(V("PROJ-123", '[data-section="links"]')), /blocks[\s\S]*OPS-7[\s\S]*relates to[\s\S]*PROJ-124/);
  assert.equal(await count(V("PROJ-123", ".iv-att")), 2);
  await app.browser.waitUntil(() => app.browser.execute((s) => !!document.querySelector(s)?.src.startsWith("data:"), V("PROJ-123", '[data-attachment="10500"] img')), { timeoutMsg: "thumbnail not loaded" });
  assert.match(await app.text(V("PROJ-123", '[data-section="remote"]')), /Fix SSO token refresh/);
  // Activity: comments, history.
  assert.match(await app.text(V("PROJ-123", ".iv-comments")), /Tom[\s\S]*First look at PROJ-123/);
  await app.click(V("PROJ-123", '[data-tab="history"]'));
  await app.waitText(V("PROJ-123", ".iv-history"), /status[\s\S]*To Do[\s\S]*In Progress/);
  await app.click(V("PROJ-123", '[data-tab="comments"]'));
  // Accessible names: the dialog, and every button that shows no text.
  assert.equal(await app.browser.execute((s) => document.querySelector(s).getAttribute("aria-labelledby"), V("PROJ-123")), "iv-title");
  assert.deepEqual(await app.browser.execute((s) => [...document.querySelectorAll(`${s} button`)].filter((b) => !b.textContent.trim() && !b.getAttribute("aria-label")).map((b) => b.className), V("PROJ-123")), []);
  // A link to another issue of the site opens it on top; „Zurück“ returns.
  await clickText(V("PROJ-123", '[data-section="links"] .iv-ref'), /OPS-7/);
  await shown("OPS-7");
  await app.click('[aria-label="Zurück zum vorigen Issue"]');
  await shown("PROJ-123");
  await app.dismissToasts();
  await app.shot("146-issue-view-light");
  assert.deepEqual(await app.browser.execute(lowContrast, ".iv", 4.5), [], "light: readable");
  await app.browser.execute(() => (document.querySelector(".iv-main").scrollTop = 10000));
  await app.shot("146-issue-view-light-activity");
  await closeView();
});

test("the summary (e), a custom select and the description are edited with undo", async () => {
  await openByPalette("PROJ-123");
  // `e` edits the summary; Enter saves.
  await app.keys(["e"]);
  const input = await app.waitFor(V("PROJ-123", ".iv-summary-input"));
  await input.click();
  await app.keys(["Control", "a"]);
  await app.type("Login fails on SSO for EU users");
  await app.keys(["Enter"]);
  await app.waitText(V("PROJ-123", ".iv-summary"), /for EU users/, 10000);
  assert.equal(issue("PROJ-123").summary, "Login fails on SSO for EU users");
  // Undo writes the value before.
  await clickText(".toast button", /^Rückgängig$/);
  await app.browser.waitUntil(() => issue("PROJ-123").summary === "Login fails on SSO", { timeoutMsg: "summary not undone" });
  await app.waitText(V("PROJ-123", ".iv-summary"), /^Login fails on SSO$/, 10000);
  // A custom select from editmeta: Environment type → Staging.
  await app.click(V("PROJ-123", '.iv-field[data-field="customfield_10050"] .iv-value.editable'));
  await app.select(V("PROJ-123", '.iv-field[data-field="customfield_10050"] [role="combobox"]'), "10301");
  await clickText(V("PROJ-123", '.iv-field[data-field="customfield_10050"] button'), /^Speichern$/);
  await app.waitText(V("PROJ-123", '.iv-field[data-field="customfield_10050"]'), /Staging/, 10000);
  assert.deepEqual(issue("PROJ-123").customs.customfield_10050, { id: "10301", value: "Staging" });
  const put = jira.requests.filter((r) => r.method === "PUT" && r.path === "/rest/api/3/issue/PROJ-123").at(-1);
  assert.deepEqual(put.body, { fields: { customfield_10050: { id: "10301" } } });
  // The estimates of the time tracking.
  await app.click(V("PROJ-123", '.iv-field[data-field="timetracking"] .iv-value.editable'));
  const original = await app.waitFor(V("PROJ-123", '.iv-field[data-field="timetracking"] input[aria-label="Schätzung"]'));
  await original.click();
  await app.type("2d");
  const remaining = await app.$(V("PROJ-123", '.iv-field[data-field="timetracking"] input[aria-label="Verbleibend"]'));
  await remaining.click();
  await app.type("1d 4h");
  await app.keys(["Enter"]);
  await app.waitText(V("PROJ-123", '.iv-field[data-field="timetracking"]'), /Verbleibend\s*1d 4h[\s\S]*Schätzung\s*2d/, 10000);
  assert.deepEqual([issue("PROJ-123").estimates.originalEstimate, issue("PROJ-123").estimates.remainingEstimate], ["2d", "1d 4h"]);
  // The description in the rich editor: written back as ADF, with the image and the code kept.
  await app.click(V("PROJ-123", '[data-section="description"] [aria-label="Beschreibung bearbeiten"]'));
  const editor = await app.waitFor(V("PROJ-123", '[data-section="description"] .iv-rich-content'));
  await editor.click();
  await app.keys(["Control", "End"]);
  await app.keys(["Enter"]);
  await app.type("Fixed by rotating the key.");
  await app.shot("146-issue-view-edit-description");
  await app.keys(["Control", "Enter"]);
  await app.waitText(V("PROJ-123", ".iv-description"), /Fixed by rotating the key/, 10000);
  const doc = issue("PROJ-123").descriptionRaw;
  assert.equal(doc.type, "doc");
  const types = doc.content.map((n) => n.type);
  assert.ok(types.includes("codeBlock") && types.includes("mediaSingle") && types.includes("bulletList"), types.join(","));
  assert.equal(doc.content.find((n) => n.type === "mediaSingle").content[0].attrs.alt, "screenshot.png", "the image node comes back unchanged");
  assert.match(JSON.stringify(doc), /Fixed by rotating the key/);
  await app.dismissToasts();
  await closeView();
});

test("a transition whose screen needs a resolution, and its undo", async () => {
  await openByPalette("PROJ-123");
  await app.keys(["t"]);
  await clickText(".menu .menu-item", /Resolve → Resolved/);
  await app.waitFor('.dialog[aria-label="Resolve"]');
  assert.ok(await app.browser.execute(() => [...document.querySelectorAll(".dialog .btn-primary")].some((b) => b.textContent.trim() === "Resolve" && b.disabled)), "required field missing: not yet");
  assert.match(await app.text(".dialog"), /Noch nötig: Resolution/);
  await app.select('.dialog .iv-screen-field[data-field="resolution"] [role="combobox"]', "10000");
  const comment = await app.waitFor(".dialog .iv-rich-content");
  await comment.click();
  await app.type("Rolled out the fix.");
  await app.shot("146-issue-view-transition");
  await clickText(".dialog .btn-primary", /^Resolve$/);
  await app.waitText(V("PROJ-123", ".iv-status-btn"), /Resolved/i, 10000);
  assert.equal(issue("PROJ-123").status, "Resolved");
  assert.equal(issue("PROJ-123").resolution, "Fixed");
  assert.equal(issue("PROJ-123").comments.at(-1).body, "Rolled out the fix.");
  // Undo: the transition back to the status before.
  await clickText(".toast button", /^Rückgängig$/);
  await app.browser.waitUntil(() => issue("PROJ-123").status === "In Progress", { timeoutMsg: "status not undone" });
  await app.waitText(V("PROJ-123", ".iv-status-btn"), /In Progress/i, 10000);
  await app.dismissToasts();
  await closeView();
});

test("comments: written with c, edited and deleted; work logged", async () => {
  await openByPalette("PROJ-123");
  await app.keys(["c"]);
  await app.browser.waitUntil(() => app.browser.execute(() => !!document.activeElement?.closest(".iv-composer")), { timeoutMsg: "c did not focus the composer" });
  await app.type("Looks good on staging.");
  await app.keys(["Control", "Enter"]);
  await app.waitText(V("PROJ-123", ".iv-thread .iv-comment:first-child"), /Mia Meyer[\s\S]*Looks good on staging/, 10000);
  const mine = issue("PROJ-123").comments.at(-1);
  assert.equal(mine.body, "Looks good on staging.");
  // Edit the own comment (Tom's has no actions).
  assert.equal(await count(V("PROJ-123", `[data-comment="${issue("PROJ-123").comments[0].id}"] [aria-label="Kommentar bearbeiten"]`)), 0, "someone else's comment is not editable");
  await app.click(V("PROJ-123", `[data-comment="${mine.id}"] [aria-label="Kommentar bearbeiten"]`));
  const ed = await app.waitFor(V("PROJ-123", `[data-comment="${mine.id}"] .iv-rich-content`));
  await ed.click();
  await app.keys(["Control", "End"]);
  await app.type(" Ship it.");
  await app.keys(["Control", "Enter"]);
  await app.browser.waitUntil(() => issue("PROJ-123").comments.find((c) => c.id === mine.id)?.body === "Looks good on staging. Ship it.", { timeoutMsg: "comment not edited" });
  await app.waitText(V("PROJ-123", `[data-comment="${mine.id}"]`), /Ship it/, 10000);
  // Delete it (asked first).
  await app.click(V("PROJ-123", `[data-comment="${mine.id}"] [aria-label="Kommentar löschen"]`));
  await clickText('.dialog[role="alertdialog"] button', /^Löschen$/);
  await app.browser.waitUntil(() => !issue("PROJ-123").comments.some((c) => c.id === mine.id), { timeoutMsg: "comment not deleted" });
  // Work log: 1h 30m with a comment, not booked.
  await app.click(V("PROJ-123", '[data-tab="worklog"]'));
  const dur = await app.waitFor(V("PROJ-123", '.iv-worklog-form input[aria-label="Aufwand"]'));
  await dur.click();
  await app.type("1h 30m");
  const what = await app.$(V("PROJ-123", '.iv-worklog-form input[aria-label="Was wurde gemacht"]'));
  await what.click();
  await app.type("Pairing on the fix");
  await app.browser.execute((s) => {
    const box = document.querySelector(s);
    if (box?.checked) box.click();
  }, V("PROJ-123", ".iv-worklog-form .iv-check input"));
  await clickText(V("PROJ-123", ".iv-worklog-form button"), /^Arbeit protokollieren$/);
  await app.waitText(V("PROJ-123", ".iv-worklogs .iv-comment"), /Mia Meyer[\s\S]*Pairing on the fix/, 10000);
  const w = jira.worklogs().find((x) => x.key === "PROJ-123");
  assert.equal(w.timeSpentSeconds, 5400);
  assert.equal(w.comment, "Pairing on the fix");
  await app.dismissToasts();
  await closeView();
});

test("someone changed the issue meanwhile: the conflict is shown, nothing is overwritten", async () => {
  await openByPalette("PROJ-123");
  await app.click(V("PROJ-123", '.iv-field[data-field="customfield_10061"] .iv-value.editable'));
  const field = await app.waitFor(V("PROJ-123", '.iv-field[data-field="customfield_10061"] input'));
  // Tom saves the issue in Jira while the field is being edited here.
  jira.edit("PROJ-123", { summary: "Login fails on SSO (Tom)" });
  await field.click();
  await app.keys(["Control", "a"]);
  await app.type("ACME-9000");
  const puts = jira.requests.filter((r) => r.method === "PUT").length;
  await app.keys(["Enter"]);
  await app.waitFor(V("PROJ-123", ".iv-conflict"), 10000);
  assert.match(await app.text(V("PROJ-123", ".iv-conflict")), /Inzwischen in Jira geändert[\s\S]*von Tom[\s\S]*Jetzt in Jira:[\s\S]*ACME-7781/);
  assert.equal(jira.requests.filter((r) => r.method === "PUT").length, puts, "nothing written");
  assert.equal(issue("PROJ-123").customs.customfield_10061, "ACME-7781");
  await app.shot("146-issue-view-conflict");
  // The new state is shown instead.
  await clickText(V("PROJ-123", ".iv-conflict button"), /Neuen Stand zeigen/);
  await app.waitText(V("PROJ-123", ".iv-summary"), /\(Tom\)/, 10000);
  await closeView();
});

test("someone else's issue: read only, but „Mir zuweisen“", async () => {
  await openByPalette("OPS-8");
  assert.equal(await count(V("OPS-8", ".iv-value.editable")), 0, "no editmeta: nothing to edit");
  assert.ok(await app.browser.execute((s) => document.querySelector(s).disabled, V("OPS-8", ".iv-status-btn")), "no transitions");
  await clickText(V("OPS-8", ".iv-assign-me"), /Mir zuweisen/);
  await app.waitText(V("OPS-8", '.iv-field[data-field="assignee"]'), /Mia Meyer/, 10000);
  assert.equal(issue("OPS-8").assignee, "Mia Meyer");
  // Now Mia's: Jira allows editing.
  await app.browser.waitUntil(async () => (await count(V("OPS-8", ".iv-value.editable"))) > 0, { timeoutMsg: "editable once assigned" });
  await clickText(".toast button", /^Rückgängig$/);
  await app.browser.waitUntil(() => issue("OPS-8").assignee === "Tom", { timeoutMsg: "assignment not undone" });
  await app.dismissToasts();
  await closeView();
});

test("„Issue öffnen…“ in the palette and a start page widget", async () => {
  await app.keys(["Control", "k"]);
  await app.waitFor(".palette input");
  await app.type("Issue öffnen");
  await app.waitText(".pal-item.sel", /Issue öffnen…/);
  await app.keys(["Enter"]);
  await app.waitFor('.dialog[aria-label="Issue öffnen"]');
  await app.type("backup");
  await app.waitText(".iv-open-list", /OPS-7[\s\S]*Nightly backup job/);
  await app.keys(["Enter"]);
  await shown("OPS-7");
  await closeView();
  // A widget row: a click opens the view.
  const d = (await app.invoke("settings_get")).settings.dashboard;
  await app.invoke("dashboard_save", { dashboard: { ...d, version: 2, boards: [{ id: "jira", name: "Jira", widgets: [{ id: "jira", kind: "jira", x: 0, y: 0, w: 6, h: 8, title: "", config: { limit: 8, columns: ["status"] } }] }], active: "jira" } });
  await app.reload();
  await app.keys(["Control", "t"]);
  const row = await app.waitFor('.pane.active > .pane-content:not([hidden]) .dw[data-widget="jira"] [data-issue-row="PROJ-124"]', 15000);
  await row.click();
  await shown("PROJ-124");
  await closeView();
});

test("500 comments and 100 attachments stay fast", async () => {
  const t0 = Date.now();
  await openByPalette("PROJ-124");
  const took = Date.now() - t0;
  assert.ok(took < budget(6000), `opened in ${took} ms`);
  assert.equal(await count(V("PROJ-124", ".iv-comments .iv-comment")), 50, "the newest 50 comments");
  assert.match(await app.text(V("PROJ-124", ".iv-comments .iv-comment")), /Comment number 500/);
  assert.equal(await count(V("PROJ-124", ".iv-att")), 24, "24 attachments first");
  await clickText(V("PROJ-124", '[data-section="attachments"] button'), /Alle 100 zeigen/);
  assert.equal(await count(V("PROJ-124", ".iv-att")), 100);
  // Thumbnails load when in view, not all at once.
  await sleep(1500);
  const thumbs = jira.requests.filter((r) => /\/attachment\/thumbnail\/11\d{3}$/.test(r.path)).length;
  assert.ok(thumbs < 100, `${thumbs} thumbnails loaded before scrolling`);
  await clickText(V("PROJ-124", ".iv-comments button"), /450 ältere Kommentare laden/);
  await app.browser.waitUntil(async () => (await count(V("PROJ-124", ".iv-comments .iv-comment"))) === 100, { timeoutMsg: "older page not loaded" });
  assert.match(await app.browser.execute((s) => [...document.querySelectorAll(s)].at(-1).textContent, V("PROJ-124", ".iv-comments .iv-comment")), /Comment number 401/);
  await closeView();
});

test("keyboard: the focus stays in the view", async () => {
  await openByPalette("PROJ-125");
  for (let i = 0; i < 40; i++) await app.keys(["Tab"]);
  assert.ok(await app.browser.execute(() => !!document.activeElement?.closest(".iv")), "Tab left the view");
  for (let i = 0; i < 10; i++) await app.keys(["Shift", "Tab"]);
  assert.ok(await app.browser.execute(() => !!document.activeElement?.closest(".iv")), "Shift+Tab left the view");
  await closeView();
});

test("offline: the last copy, read only, with „Stand von …“", async () => {
  await jira.stop();
  await openByPalette("PROJ-123");
  await app.waitText(V("PROJ-123", ".iv-offline"), /Stand von[\s\S]*nicht erreichbar/, 15000);
  assert.equal(await count(V("PROJ-123", ".iv-value.editable")), 0, "nothing editable offline");
  assert.equal(await count(V("PROJ-123", ".iv-composer")), 0, "no comment box offline");
  assert.ok(await app.browser.execute((s) => document.querySelector(s).disabled, V("PROJ-123", ".iv-status-btn")));
  assert.match(await app.text(V("PROJ-123", ".iv-description")), /The token has expired/);
  await app.dismissToasts();
  await app.shot("146-issue-view-offline");
  await jira.start();
  await clickText(V("PROJ-123", ".iv-offline button"), /Erneut versuchen/);
  await app.browser.waitUntil(async () => (await count(V("PROJ-123", ".iv-offline"))) === 0, { timeout: 15000, timeoutMsg: "still offline" });
  await closeView();
});

test("dark, high contrast and a narrow window", async () => {
  for (const [mode, id, name] of [["dark", null, "dark"], ["dark", "contrast-dark", "contrast-dark"], ["light", "contrast-light", "contrast-light"]]) {
    await setTheme(mode, id);
    await openByPalette("PROJ-123");
    await app.waitText(V("PROJ-123", ".iv-description h2"), /Steps/);
    await app.dismissToasts();
    await sleep(400);
    assert.deepEqual(await app.browser.execute(lowContrast, ".iv", 4.5), [], `${name}: readable`);
    await app.shot(`146-issue-view-${name}`);
    await closeView();
  }
  await setTheme("light", "arcalo-light");
  await app.browser.setWindowSize(1920, 1080);
  await sleep(400);
  await openByPalette("PROJ-123");
  await app.shot("146-issue-view-1920");
  await closeView();
  await app.browser.setWindowSize(900, 760);
  await sleep(400);
  await openByPalette("PROJ-123");
  await app.shot("146-issue-view-900");
  await closeView();
  await app.browser.setWindowSize(1480, 920);
});
