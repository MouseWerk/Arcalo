// Issues moved to another project and deleted in Jira (q124 round 6, R6C-1 and R6C-2). Notes,
// tasks and bookings keep the key they were written with: after PROJ-124 became NEW-1 the old
// key shows the issue under its new key (chip, hover card, the issue's bookings) and its task is
// ticked once the issue is done. A moved issue a search finds stays in the Issues list. A deleted
// issue no longer holds up the other cached issues: Jira refuses a `key in (…)` naming a key it
// does not know, which used to leave every issue of that request as it was (their tasks never
// ticked).
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";
import { startFakeJira } from "../lib/fake-jira.js";

const test = guarded(nodeTest, () => app);
let app;
let jira;
let pageId;
const mine = { site: "", query: "mine", all: false, limit: null };
before(async () => {
  jira = await startFakeJira({ flavor: "cloud" });
  app = await launch({ env: { ARCALO_JIRA_DELAY_SECS: "600" } });
  await app.invoke("jira_site_save", {
    site: { id: "", name: "Acme", color: "", kind: "cloud", url: jira.url, email: "mia@firma.de", enabled: true, log_work: false, allow_writes: false },
    token: "secret-token",
  });
  await app.invoke("jira_sync_now", { site: "acme" });
  const page = await app.invoke("page_create", { title: "Umzug", parentId: null });
  pageId = page.id;
  await app.invoke("page_save", { id: pageId, content: "Siehe PROJ-124 und PROJ-123.\n\n- [ ] PROJ-124 Mail bauen\n- [ ] PROJ-125 Export prüfen\n- [ ] OPS-7 Backups prüfen\n" });
  await app.reload();
  await app.browser.waitUntil(() => app.browser.execute(() => document.body.classList.contains("ready")), { timeout: 20000 });
});
after(async () => {
  await app?.close();
  await jira?.close();
});

const tasks = async () => Object.fromEntries((await app.invoke("tasks_list", { filter: { status: "all" } })).filter((t) => t.page_id === pageId).map((t) => [t.text, t.done]));

test("moved and deleted issues: the list, the tasks and the old keys", async () => {
  const before = (await app.invoke("jira_issues", { filter: mine })).map((i) => i.key).sort();
  assert.deepEqual(before, ["OPS-7", "PROJ-123", "PROJ-124", "PROJ-125"]);
  // In Jira: PROJ-124 moves to NEW and is done there; PROJ-123 moves too and stays mine;
  // PROJ-125 is deleted; OPS-7 is done.
  const done = jira.move("PROJ-124", "NEW", "Neu");
  Object.assign(jira.issues.find((i) => i.key === done), { status: "Done", category: "done" });
  const moved = jira.move("PROJ-123", "NEW", "Neu");
  assert.deepEqual([done, moved], ["NEW-1", "NEW-2"]);
  jira.remove("PROJ-125");
  Object.assign(jira.issues.find((i) => i.key === "OPS-7"), { status: "Done", category: "done" });
  await app.invoke("jira_sync_now", { site: "acme" });

  const after = (await app.invoke("jira_issues", { filter: mine })).map((i) => i.key).sort();
  assert.deepEqual(after, ["NEW-2"], "the moved issue a search finds stays in the list");
  assert.deepEqual(await tasks(), { "PROJ-124 Mail bauen": true, "PROJ-125 Export prüfen": false, "OPS-7 Backups prüfen": true }, "done issues tick their tasks, also under the old key");
  const view = await app.invoke("jira_issue_view", { key: "PROJ-124" });
  assert.equal(view.issue?.key, "NEW-1", "the old key shows the issue under its new key");
  assert.equal(view.issue?.status_category, "done");
  assert.equal((await app.invoke("jira_issue_view", { key: "PROJ-125" })).issue, null, "the deleted issue is not shown as open");
  const index = await app.invoke("jira_index");
  assert.ok(index.projects.includes("PROJ"), "old keys in notes stay chips");
  assert.deepEqual(index.moved.sort(), [["PROJ-123", "NEW-2"], ["PROJ-124", "NEW-1"]]);

  // The next sync asks for none of them again.
  const seen = jira.requests.length;
  await app.invoke("jira_sync_now", { site: "acme" });
  const asked = jira.requests.slice(seen).filter((r) => /PROJ-12[345]/.test(`${r.path} ${r.query.jql ?? ""}`));
  assert.deepEqual(asked.map((r) => `${r.path} ${r.query.jql ?? ""}`), [], "settled");
});

test("the chip of an old key shows the moved issue", async () => {
  await app.reload();
  await app.browser.waitUntil(() => app.browser.execute(() => document.body.classList.contains("ready")), { timeout: 20000 });
  await app.browser.waitUntil(
    () =>
      app.browser.execute(() => {
        const row = [...document.querySelectorAll(".sidebar .tree-row")].find((r) => /^Umzug/.test(r.textContent.trim()));
        row?.click();
        return !!row;
      }),
    { timeoutMsg: "no page row" },
  );
  const tail = '.pane.active > .pane-content:not([hidden]) .ProseMirror .issue-chip-tail[data-issue="PROJ-124"]';
  await app.waitFor(tail, 10000);
  assert.match(await app.text(tail), /Password reset mail/);
  assert.equal(await app.browser.execute((s) => document.querySelector(`${s} .issue-chip-dot`)?.getAttribute("aria-label"), tail), "Done");
  const chip = await app.waitFor('.pane.active > .pane-content:not([hidden]) .ProseMirror .issue-chip[data-issue="PROJ-124"]');
  await chip.moveTo();
  await app.waitFor(".issue-preview", 6000);
  assert.match(await app.text(".issue-preview"), /NEW-1/);
  await app.shot("682-moved-chip");
});
