// The issue view with Jira Server/Data Center, in English: opened from a row of the Issues list
// („Open as window“); Jira's rendered wiki markup with its image and the avatars loaded with the
// personal access token (Bearer) from the site's own addresses; Story Points found by name; the
// summary and the description edited (written as wiki markup, the macros and the image kept); a
// transition with a required resolution; a comment with bold text (wiki markup); work logged and
// booked in the time tracking on the issue's WBS, its worklog posted once by the booking; the
// comments read newest first from a Jira that ignores the order. No German left in the view.
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
before(async () => {
  jira = await startFakeJira({ flavor: "server", token: "pat-123" });
  ({ app, dataDir } = await launchEnglish({ env: { ARCALO_JIRA_DELAY_SECS: "600" } }));
  await app.invoke("jira_site_save", {
    site: { id: "", name: "Corp Jira", color: "", kind: "server", url: jira.url, email: "", enabled: true, log_work: true, allow_writes: false },
    token: "pat-123",
  });
  await app.invoke("jira_sync_now", { site: "corp-jira" });
  await app.invoke("jira_wbs_set", { kind: "project", key: "PROJ", reference: "NP-8801/1020" });
  await app.reload();
});
after(async () => {
  await app?.close();
  await jira?.close();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

const V = (sel = "") => `[data-issue-view="PROJ-123"] ${sel}`.trim();
const issue = () => jira.issues.find((i) => i.key === "PROJ-123");
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
async function loaded() {
  await app.waitFor(V(".iv-summary"), 15000);
  await app.browser.waitUntil(() => app.browser.execute((s) => !document.querySelector(s), V(".iv-refreshing")), { timeout: 15000, timeoutMsg: "still loading" });
}

test("opened as a window from the Issues list, with Jira's rendered wiki markup", async () => {
  await app.click(".ribbon-issues");
  const row = await app.waitFor('[data-issue-row="PROJ-123"]');
  await row.moveTo();
  await app.click('[data-issue-row="PROJ-123"] .issue-open-view');
  await loaded();
  assert.ok(jira.requests.some((r) => r.path === "/rest/api/2/issue/PROJ-123" && /editmeta/.test(r.query.expand ?? "")), "REST v2 with the expands");
  await app.waitText(V(".iv-description h2"), /Steps/);
  assert.match(await app.browser.execute((s) => document.querySelector(s).innerHTML, V(".iv-description")), /<b>SSO<\/b>/);
  await app.browser.waitUntil(() => app.browser.execute((s) => !!document.querySelector(s)?.src.startsWith("data:image/png"), V(".iv-description img")), { timeoutMsg: "image not loaded" });
  const img = jira.requests.find((r) => r.path === "/secure/attachment/10500/screenshot.png");
  assert.equal(img?.headers.authorization, "Bearer pat-123");
  await app.browser.waitUntil(() => app.browser.execute((s) => !!document.querySelector(s)?.src.startsWith("data:image/png"), V('.iv-field[data-field="assignee"] .iv-avatar img')), { timeoutMsg: "avatar not loaded" });
  assert.equal(jira.requests.find((r) => r.path === "/secure/useravatar")?.headers.authorization, "Bearer pat-123");
  const text = await app.text(V());
  for (const part of [/Assignee[\s\S]*Mia Meyer/, /Reporter[\s\S]*Tom/, /Story points[\s\S]*5/, /Environment type[\s\S]*Production/, /Comments/, /Work log/, /History/]) assert.match(text, part);
  assert.deepEqual(await germanLeftovers(app, [/NP-8801|PRJ-2026|Kunde|Jour fixe/]), []);
  await app.dismissToasts();
  await app.shot("147-issue-view-server-en");
});

test("summary and description are written as wiki markup, the macros and the image kept", async () => {
  await app.click(V(".iv-summary-btn"));
  const input = await app.waitFor(V(".iv-summary-input"));
  await input.click();
  await app.keys(["Control", "a"]);
  await app.type("Login fails on SSO (Data Center)");
  await app.keys(["Enter"]);
  await app.waitText(V(".iv-summary"), /Data Center/, 10000);
  assert.equal(issue().summary, "Login fails on SSO (Data Center)");
  await app.click(V('[data-section="description"] [aria-label="Edit description"]'));
  const editor = await app.waitFor(V('[data-section="description"] .iv-rich-content'));
  await editor.click();
  await app.keys(["Control", "End"]);
  await app.keys(["Enter"]);
  await app.type("Root cause: clock drift.");
  await clickText(V('[data-section="description"] button'), /^Save$/);
  await app.waitText(V(".iv-description"), /Root cause: clock drift/, 10000);
  const wiki = issue().descriptionRaw;
  assert.equal(typeof wiki, "string");
  for (const part of ["h2. Steps", "*SSO*", "* Chrome and Edge", "{code:json}", "!screenshot.png!", "Root cause: clock drift."]) assert.ok(wiki.includes(part), `${part} in ${wiki}`);
  const put = jira.requests.filter((r) => r.method === "PUT" && r.path === "/rest/api/2/issue/PROJ-123").at(-1);
  assert.equal(typeof put.body.fields.description, "string", "wiki markup, not ADF");
  await app.dismissToasts();
});

test("a transition with a required resolution and a comment in wiki markup", async () => {
  await app.click(V(".iv-status-btn"));
  await clickText(".menu .menu-item", /Resolve → Resolved/);
  await app.waitFor('.dialog[aria-label="Resolve"]');
  await app.select('.dialog .iv-screen-field[data-field="resolution"] [role="combobox"]', "10001");
  await clickText(".dialog .btn-primary", /^Resolve$/);
  await app.waitText(V(".iv-status-btn"), /Resolved/i, 10000);
  assert.equal(issue().resolution, "Won't Fix");
  await app.dismissToasts();
  // A comment: plain words and bold ones.
  const composer = await app.waitFor(V(".iv-composer .iv-rich-content"));
  await composer.click();
  await app.type("Deployed ");
  await app.keys(["Control", "b"]);
  await app.type("today");
  await app.keys(["Control", "Enter"]);
  await app.browser.waitUntil(() => issue().comments.at(-1).body === "Deployed *today*", { timeout: 10000, timeoutMsg: `comment: ${issue().comments.at(-1).body}` });
  await app.waitText(V(".iv-thread .iv-comment"), /Deployed today/, 10000);
  // Newest first, also from a Server that answers oldest first.
  assert.match(await app.text(V(".iv-thread .iv-comment")), /Mia Meyer[\s\S]*Deployed today/);
  await app.dismissToasts();
});

test("work logged and booked: the booking posts its worklog once", async () => {
  await app.click(V('[data-tab="worklog"]'));
  const dur = await app.waitFor(V('.iv-worklog-form input[aria-label="Time spent"]'));
  await dur.click();
  await app.type("30m");
  const what = await app.$(V('.iv-worklog-form input[aria-label="What was done"]'));
  await what.click();
  await app.type("Clock sync");
  assert.match(await app.text(V(".iv-worklog-form")), /Also book in time tracking \(NP-8801\/1020\)/);
  assert.equal(await app.browser.execute((s) => document.querySelector(s).checked, V(".iv-worklog-form .iv-check input")), true, "booked by default with a WBS");
  await clickText(V(".iv-worklog-form button"), /^Log work$/);
  await app.browser.waitUntil(() => jira.worklogs().length === 1, { timeout: 15000, timeoutMsg: "worklog not posted" });
  const w = jira.worklogs()[0];
  assert.equal(w.timeSpentSeconds, 1800);
  const entries = await app.invoke("time_entries", { from: null, to: null });
  const booked = entries.find((e) => /PROJ-123 Clock sync/.test(e.description));
  assert.ok(booked, "booked in the time tracking");
  await app.browser.waitUntil(async () => (await app.invoke("jira_entry_issues", { entryIds: [booked.id] }))[0]?.worklog_state === "posted", { timeout: 15000, timeoutMsg: "entry not linked to its worklog" });
  await app.browser.pause(1500);
  assert.equal(jira.worklogs().length, 1, "posted once");
  await app.waitText(V(".iv-worklogs"), /Clock sync/, 10000);
  await app.dismissToasts();
  await app.shot("147-issue-view-server-worklog");
  await app.keys(["Escape"]);
});
