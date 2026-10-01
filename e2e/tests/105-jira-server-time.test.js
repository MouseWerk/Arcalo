// Jira Server/Data Center in English (1.7): Bearer personal access token, REST v2 with `startAt`
// paging, the clear errors (401, an account locked behind a CAPTCHA), `/time` with an issue key
// (no WBS yet: a clear error; the first booking with a reference teaches it; then the key alone
// books there), the optional worklog (a failed post is retried after looking for it on the
// issue, an entry is never posted twice), the Sprint widget without Jira Agile, the assistant's
// read tools and the confirmed comment, and Settings → Jira and the Issues page in English.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { guarded } from "../lib/harness.js";
import { launchEnglish, germanLeftovers } from "../lib/english.js";
import { startFakeJira } from "../lib/fake-jira.js";

const test = guarded(nodeTest, () => app);
let app;
let dataDir;
let jira;
const site = (p = {}) => ({ id: "corp", name: "Corp Jira", color: "", kind: "server", url: "", email: "", enabled: true, log_work: true, allow_writes: false, ...p });
before(async () => {
  jira = await startFakeJira({ flavor: "server", token: "pat-123", failWorklogs: 1 });
  ({ app, dataDir } = await launchEnglish({ env: { ANNALO_JIRA_DELAY_SECS: "600" } }));
});
after(async () => {
  await app?.close();
  await jira?.close();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reload = async () => {
  await app.browser.execute(() => location.reload());
  await app.browser.pause(300);
  await app.browser.waitUntil(() => app.browser.execute(() => document.body.classList.contains("ready")), { timeout: 20000, timeoutMsg: "not ready after reload" });
};
const entries = () => app.invoke("time_entries", { from: null, to: null });

test("clear errors, then a Server site with a personal access token", async () => {
  await assert.rejects(app.invoke("jira_test", { site: site({ url: jira.url }), token: "wrong" }), /refused the login \(401\)/);
  jira.state.captcha = true;
  await assert.rejects(app.invoke("jira_test", { site: site({ url: jira.url }), token: "pat-123" }), /CAPTCHA[\s\S]*browser/);
  jira.state.captcha = false;
  const ok = await app.invoke("jira_test", { site: site({ url: jira.url }), token: "pat-123" });
  assert.deepEqual([ok.display_name, ok.detected, ok.kind], ["Mia Meyer", "server", "server"]);
  await app.invoke("jira_site_save", { site: site({ id: "", url: jira.url }), token: "pat-123" });
  await app.invoke("jira_sync_now", { site: "corp-jira" });
  const issues = await app.invoke("jira_issues", { filter: { site: "", query: "mine", all: false, limit: null } });
  assert.equal(issues.length, 4);
  assert.equal(issues.find((i) => i.key === "PROJ-123").sprint, "Sprint 4", "sprint parsed from the Server string");
  assert.ok(jira.requests.some((r) => r.path === "/rest/api/2/search" && r.query.startAt === "2"), "paged by startAt");
  assert.ok(jira.requests.filter((r) => r.path === "/rest/api/2/myself").every((r) => !r.headers.authorization || r.headers.authorization.startsWith("Bearer ")), "Bearer token");
});

test("/time with an issue key books on the mapped WBS", async () => {
  await assert.rejects(app.invoke("log_time", { line: "/time 1h PROJ-123 fix login", pageId: null }), /PROJ-123 has no network\/activity yet/);
  // The first booking with a reference, typed in a note.
  const page = await app.invoke("page_create", { title: "Login work", parentId: null });
  await reload();
  await app.browser.waitUntil(
    () => app.browser.execute(() => {
      const row = [...document.querySelectorAll(".sidebar .tree-row")].find((r) => /Login work/.test(r.textContent));
      row?.click();
      return !!row;
    }),
    { timeoutMsg: "page not in the tree" },
  );
  await app.caretToEnd();
  await app.type("/time NP-8801/1020 30m PROJ-123 analysis");
  await app.keys(["Escape"]);
  await app.keys(["Enter"]);
  await app.waitFor(".pane.active .ProseMirror .time-chip", 10000);
  assert.ok(page.id);
  // Now the key alone books there.
  const out = await app.invoke("log_time", { line: "/time 1h PROJ-123 fix login", pageId: null });
  assert.deepEqual([out.reference, out.issue], ["NP-8801/1020", "PROJ-123"]);
  const status = await app.invoke("jira_status");
  assert.deepEqual(status.mappings.map((m) => [m.kind, m.key, m.reference, m.learned]), [["project", "PROJ", "NP-8801/1020", true], ["issue", "PROJ-123", "NP-8801/1020", true]]);
  // Settings → Jira shows the mapping, in English.
  await app.keys(["Control", ","]);
  await app.waitFor(".settings-nav");
  await app.click('.settings-nav-item[data-section="jira"]');
  await app.waitText(".jira-mappings", /PROJ-123[\s\S]*NP-8801\/1020[\s\S]*learned/);
  await app.waitText('.calset-item[data-site="corp-jira"]', /Server \/ Data Center[\s\S]*4 issues/);
  assert.deepEqual(await germanLeftovers(app, [/NP-8801|PRJ-2026|Kunde|Jour fixe/]), []);
  await app.dismissToasts();
  await app.shot("105-settings-en");
});

test("worklogs: a failed post is retried and never posted twice", async () => {
  const list = await entries();
  const first = list.find((e) => e.description === "PROJ-123 analysis");
  const second = list.find((e) => e.description === "PROJ-123 fix login");
  assert.ok(first && second);
  // The first post failed (500), the second went through.
  await app.browser.waitUntil(async () => {
    const st = await app.invoke("jira_entry_issues", { entryIds: [first.id, second.id] });
    return st.find((s) => s.entry_id === first.id)?.worklog_state === "failed" && st.find((s) => s.entry_id === second.id)?.worklog_state === "posted";
  }, { timeout: 15000, timeoutMsg: "worklogs not posted" });
  assert.equal(jira.worklogs().length, 1);
  await app.invoke("jira_worklog_retry", { entryId: first.id });
  await app.invoke("jira_worklog_retry", { entryId: first.id });
  await app.invoke("jira_worklog_retry", { entryId: second.id });
  const logs = jira.worklogs();
  assert.deepEqual(logs.map((w) => [w.key, w.timeSpentSeconds, w.comment]).sort(), [["PROJ-123", 1800, "PROJ-123 analysis"], ["PROJ-123", 3600, "PROJ-123 fix login"]]);
  const st = await app.invoke("jira_entry_issues", { entryIds: [first.id, second.id] });
  assert.ok(st.every((s) => s.worklog_state === "posted" && s.worklog_id), JSON.stringify(st));
  assert.ok(jira.requests.some((r) => r.method === "GET" && r.path === "/rest/api/2/issue/PROJ-123/worklog"), "the retry looked for an earlier post first");
});

test("no Agile: the Sprint widget says so quietly", async () => {
  const view = await app.invoke("jira_sprint", { site: null, project: null });
  assert.deepEqual([view.available, view.sprint, view.project], [false, null, "PROJ"]);
  const d = (await app.invoke("settings_get")).settings.dashboard;
  const W = (id, kind, x, y, w, h, config = {}) => ({ id, kind, x, y, w, h, title: "", config });
  await app.invoke("dashboard_save", { dashboard: { ...d, version: 2, boards: [{ id: "j", name: "Jira", widgets: [W("jira_sprint", "jira_sprint", 0, 0, 5, 8), W("jira", "jira", 5, 0, 7, 8)] }], active: "j" } });
  await reload();
  await app.keys(["Control", "t"]);
  await app.waitText('.pane.active .dw[data-widget="jira_sprint"]', /No sprint board for PROJ \(Jira Agile is not available\)/, 15000);
  await app.waitText('.pane.active .dw[data-widget="jira"]', /PROJ-123/);
});

test("the assistant's Jira tools: read, and comment only when allowed and confirmed", async () => {
  const found = JSON.parse(await app.invoke("jira_tool", { name: "jira_search", arguments: JSON.stringify({ query: "backup" }) }));
  assert.deepEqual(found.issues.map((i) => i.key), ["OPS-7"]);
  const one = JSON.parse(await app.invoke("jira_tool", { name: "jira_issue", arguments: JSON.stringify({ key: "PROJ-123" }) }));
  assert.match(one.description, /token has expired/);
  assert.equal(one.comments[0].body, "First look at PROJ-123");
  const mine = JSON.parse(await app.invoke("jira_tool", { name: "jira_my_issues", arguments: "{}" }));
  assert.equal(mine.sites[0].my_open_issues.length, 4);
  // Writing is off by default.
  await assert.rejects(app.invoke("ai_plan_tool", { name: "jira_comment", arguments: JSON.stringify({ key: "PROJ-123", body: "Fixed" }) }), /not allowed/);
  await app.invoke("jira_site_save", { site: { ...site({ id: "corp-jira", url: jira.url }), allow_writes: true }, token: null });
  const plan = await app.invoke("ai_plan_tool", { name: "jira_comment", arguments: JSON.stringify({ key: "PROJ-123", body: "Fixed in build 42" }) });
  assert.equal(plan.risk, "requires_approval");
  assert.match(plan.summary, /Comment on PROJ-123:\nFixed in build 42/);
  assert.match(await app.invoke("ai_run_system_tool", { call: plan.call }), /Comment on PROJ-123 saved/);
  assert.equal(jira.issues.find((i) => i.key === "PROJ-123").comments.at(-1).body, "Fixed in build 42");
});

test("the Issues page in English; time tracking off refuses bookings", async () => {
  await app.click(".ribbon-issues");
  await app.waitFor('[data-issue-row="PROJ-123"]');
  await app.click('[data-issue-row="PROJ-123"] .issue-row-main');
  await app.waitText('[data-issue-row="PROJ-123"] .issue-detail', /Books on[\s\S]*NP-8801\/1020[\s\S]*Booked/);
  assert.deepEqual(await germanLeftovers(app, [/NP-8801|PRJ-2026|Kunde|Jour fixe|Login work/]), []);
  await app.dismissToasts();
  await app.shot("105-issues-en");
  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", { settings: { ...view.settings, time: { ...view.settings.time, enabled: false } } });
  await assert.rejects(app.invoke("log_time", { line: "/time 1h PROJ-123 more", pageId: null }), /switched off/);
  await sleep(100);
});
