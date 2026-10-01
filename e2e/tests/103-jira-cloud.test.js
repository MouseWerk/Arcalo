// Jira Cloud (1.7): connecting a site in Settings → Jira (wrong token, „Verbindung testen“ with
// the account's name, tokens only in the credential store), the background sync (paged search,
// a 429 answered after Retry-After), a saved JQL search, the Issues page with its groups,
// filters, search and the opened issue, and the three Jira widgets of the start page. Light and
// dark screenshots of the page and the widgets.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { launch, guarded } from "../lib/harness.js";
import { startFakeJira } from "../lib/fake-jira.js";

const test = guarded(nodeTest, () => app);
let app;
let jira;
before(async () => {
  jira = await startFakeJira({ flavor: "cloud", rateLimitOnce: true });
  app = await launch({ env: { ANNALO_JIRA_DELAY_SECS: "1" } });
});
after(async () => {
  await app?.close();
  await jira?.close();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const count = (sel) => app.browser.execute((s) => document.querySelectorAll(s).length, sel);
const texts = (sel) => app.browser.execute((s) => [...document.querySelectorAll(s)].map((e) => e.textContent.trim()), sel);
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
/** Types into an input like a user (React sees every key). */
async function fill(sel, value) {
  const el = await app.waitFor(sel);
  await el.click();
  await app.browser.execute((s) => document.querySelector(s).select?.(), sel);
  await app.keys(["Control", "a"]);
  await app.keys(["Backspace"]);
  await app.type(value);
}
const reload = async () => {
  await app.browser.execute(() => location.reload());
  await app.browser.pause(300);
  await app.browser.waitUntil(() => app.browser.execute(() => document.body.classList.contains("ready")), { timeout: 20000, timeoutMsg: "not ready after reload" });
};
async function setTheme(mode) {
  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", { settings: { ...view.settings, theme: mode } });
  await reload();
}

test("connect a Jira Cloud site in Settings → Jira", async () => {
  await app.keys(["Control", ","]);
  await app.waitFor(".settings-nav");
  await app.click('.settings-nav-item[data-section="jira"]');
  await app.waitText(".settings-head h1", /Jira/);
  await clickText(".calset-add button", /Jira-Site verbinden/);
  await app.waitFor(".dialog");
  await fill('.dialog input[aria-label="Adresse"]', jira.url);
  // 127.0.0.1 looks like a company server; the user picks Cloud.
  await clickText(".dialog .segmented button", /^Cloud$/);
  await fill('.dialog input[aria-label="E-Mail"]', "mia@firma.de");
  await fill('.dialog input[aria-label="API-Token"]', "wrong-token");
  await fill('.dialog input[aria-label="Name"]', "Acme Cloud");
  await clickText(".dialog button", /Verbindung testen/);
  await app.waitText(".jira-test-result.bad", /401/);
  await fill('.dialog input[aria-label="API-Token"]', "secret-token");
  await clickText(".dialog button", /Verbindung testen/);
  await app.waitText(".jira-test-result.ok", /Verbunden als Mia Meyer/);
  assert.match(await app.text(".jira-test-result.ok"), /Cloud/, "the server said it is Cloud");
  await clickText(".dialog button", /^Speichern$/);
  await app.waitText('.calset-item[data-site="acme-cloud"]', /Acme Cloud/);
  // The sync runs at once: a 429 first (retried after Retry-After), then two issues per page.
  await app.waitText('.calset-item[data-site="acme-cloud"]', /4 Issues/, 20000);
  const searches = jira.requests.filter((r) => r.path === "/rest/api/3/search/jql");
  assert.ok(searches.length >= 3, `paged: ${searches.length} search requests`);
  assert.ok(searches.some((r) => r.query.nextPageToken), "second page asked by token");
  assert.ok(jira.requests.some((r) => r.path === "/rest/api/3/myself" && r.headers.authorization?.startsWith("Basic ")), "Basic auth with e-mail and token");
  // The token is a secret: not in the settings.
  const s = (await app.invoke("settings_get")).settings;
  assert.equal(s.jira.sites[0].kind, "cloud");
  assert.ok(!JSON.stringify(s).includes("secret-token"), "no token in the settings");
  const secrets = path.join(app.dataDir, "secrets.json");
  assert.ok(fs.readFileSync(secrets, "utf8").includes("jira_acme_cloud"), "token in the credential store (file fallback on Linux)");
});

test("a saved JQL search syncs its issues", async () => {
  await fill('input[aria-label="Name"].jira-query-name-input', "Operations");
  await fill('input[aria-label="JQL"]', "project = OPS");
  await clickText(".jira-query-add button", /Hinzufügen/);
  await app.waitText(".jira-query", /Operations[\s\S]*project = OPS/);
  await app.browser.waitUntil(async () => (await app.invoke("jira_issues", { filter: { site: "", query: "q1", all: false, limit: null } })).length === 2, { timeout: 15000, timeoutMsg: "query not synced" });
});

test("the Issues page: groups, search, filters and an opened issue", async () => {
  await app.click(".ribbon-issues");
  await app.waitFor("[data-issue-row]");
  assert.deepEqual((await texts(".issues-group-title span:first-child")).filter(Boolean), ["OPS · Operations", "PROJ · Portal"]);
  assert.equal(await count("[data-issue-row]"), 4, "my four open issues");
  assert.match(await app.text('[data-issue-row="PROJ-123"]'), /Login fails on SSO[\s\S]*In Progress/i);
  // Search by every word.
  await fill('.issues-search input', "backup");
  await app.browser.waitUntil(async () => (await count("[data-issue-row]")) === 1, { timeoutMsg: "search did not filter" });
  await fill('.issues-search input', "");
  // The saved search instead of mine; grouped by status.
  await app.select('.view-actions [aria-label="Suche"]', "q1");
  await app.browser.waitUntil(async () => (await count("[data-issue-row]")) === 2, { timeoutMsg: "saved search not shown" });
  await app.select('.view-actions [aria-label="Suche"]', "mine");
  await app.select('.view-actions [aria-label="Gruppieren nach"]', "status");
  await app.browser.waitUntil(async () => (await texts(".issues-group-title span:first-child")).join("|") === "In Progress|In Review|To Do", { timeoutMsg: "status groups" });
  await app.select('.issues-toolbar [aria-label="Priorität"]', "Highest");
  await app.browser.waitUntil(async () => (await count("[data-issue-row]")) === 1, { timeoutMsg: "priority filter" });
  await clickText(".issues-toolbar button", /Filter zurücksetzen/);
  await app.select('.view-actions [aria-label="Gruppieren nach"]', "project");
  // Open an issue: description, comments, actions.
  await app.click('[data-issue-row="PROJ-123"] .issue-row-main');
  await app.waitText('[data-issue-row="PROJ-123"] .issue-detail', /The token has expired[\s\S]*First look at PROJ-123/);
  await app.waitText('[data-issue-row="PROJ-123"] .issue-detail-side', /Notiz für PROJ-123 anlegen/);
  await app.dismissToasts();
  await app.shot("103-issues-light");
  await setTheme("dark");
  await app.click(".ribbon-issues");
  await app.waitFor("[data-issue-row]");
  await app.click('[data-issue-row="PROJ-123"] .issue-row-main');
  await app.waitFor('[data-issue-row="PROJ-123"] .issue-detail');
  await app.shot("103-issues-dark");
  await setTheme("light");
});

test("the Jira widgets on the start page", async () => {
  const d = (await app.invoke("settings_get")).settings.dashboard;
  const W = (id, kind, x, y, w, h, config = {}) => ({ id, kind, x, y, w, h, title: "", config });
  const boards = [
    {
      id: "jira",
      name: "Jira",
      widgets: [W("jira", "jira", 0, 0, 6, 8, { limit: 8, columns: ["status", "due"] }), W("jira_query", "jira_query", 6, 0, 6, 8, { query: "q1", columns: ["status", "assignee"], limit: 5 }), W("jira_sprint", "jira_sprint", 0, 8, 6, 11)],
    },
  ];
  await app.invoke("dashboard_save", { dashboard: { ...d, version: 2, boards, active: "jira" } });
  await reload();
  // A new tab shows the start page.
  await app.keys(["Control", "t"]);
  await app.waitFor('.pane.active .dw[data-widget="jira"] .dwj-row', 15000);
  assert.equal(await count('.pane.active .dw[data-widget="jira"] .dwj-row'), 4);
  assert.match(await app.text('.pane.active .dw[data-widget="jira_query"]'), /OPS-8[\s\S]*Rotate certificates[\s\S]*Tom/);
  await app.waitText('.pane.active .dw[data-widget="jira_sprint"]', /Sprint 4[\s\S]*0 von 3 erledigt/, 15000);
  assert.ok(await (await app.$('.pane.active .dw[data-widget="jira_sprint"] path.dwj-actual')).isExisting(), "burndown drawn");
  await app.dismissToasts();
  await app.shot("103-widgets-light");
  await setTheme("dark");
  await app.waitFor('.pane.active .dw[data-widget="jira_sprint"] path.dwj-actual', 15000);
  await sleep(300);
  await app.shot("103-widgets-dark");
  await setTheme("light");
  // A click on a row opens the issue's note.
  await app.click('.pane.active .dw[data-widget="jira"] [data-issue-row="OPS-7"]');
  await app.browser.waitUntil(async () => (await app.browser.execute(() => document.querySelector(".pane.active .tab.active")?.textContent ?? "")).includes("OPS-7 Nightly backup job"), { timeout: 10000, timeoutMsg: "note not opened" });
});
