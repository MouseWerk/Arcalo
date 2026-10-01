// Jira in notes (1.7): an issue key of a synced project becomes a live chip (type, key, status,
// title; `ISO-9001` stays text), hovering shows the issue's card, a click opens the issue's note
// („PROJ-123 Summary“ with `jira: PROJ-123`) and the issue lists the pages naming it. A task
// becomes a Jira issue from its context menu (the key is appended); „Als Aufgabe übernehmen“
// puts an issue into the daily note, and that task is ticked once the issue is done in Jira.
// With Jira stopped, the Issues page and the chips keep showing the cached issues.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";
import { startFakeJira } from "../lib/fake-jira.js";

const test = guarded(nodeTest, () => app);
let app;
let jira;
let pageId;
before(async () => {
  jira = await startFakeJira({ flavor: "cloud" });
  app = await launch({ env: { ANNALO_JIRA_DELAY_SECS: "600" } });
  await app.invoke("jira_site_save", {
    site: { id: "", name: "Acme", color: "", kind: "cloud", url: jira.url, email: "mia@firma.de", enabled: true, log_work: false, allow_writes: false },
    token: "secret-token",
  });
  await app.invoke("jira_sync_now", { site: "acme" });
  const page = await app.invoke("page_create", { title: "Sprint-Planung", parentId: null });
  pageId = page.id;
  await app.invoke("page_save", { id: pageId, content: "Heute PROJ-123 besprechen, nicht ISO-9001 und nicht UTF-8.\n\n- [ ] Fix SSO für Kunde\n" });
  await reload();
});
after(async () => {
  await app?.close();
  await jira?.close();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const count = (sel) => app.browser.execute((s) => document.querySelectorAll(s).length, sel);
async function reload() {
  await app.browser.execute(() => location.reload());
  await app.browser.pause(300);
  await app.browser.waitUntil(() => app.browser.execute(() => document.body.classList.contains("ready")), { timeout: 20000, timeoutMsg: "not ready after reload" });
}
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
async function setTheme(mode) {
  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", { settings: { ...view.settings, theme: mode } });
  await reload();
}
async function hoverChip(key) {
  await app.browser.execute(() => document.querySelector(".issue-preview") && document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
  const chip = await app.waitFor(`.pane.active .ProseMirror .issue-chip[data-issue="${key}"]`);
  await chip.moveTo();
  await app.waitFor(".issue-preview", 6000);
}

test("an issue key becomes a live chip with a hover card", async () => {
  await clickText(".sidebar .tree-row", /^Sprint-Planung/);
  await app.waitFor('.pane.active .ProseMirror .issue-chip[data-issue="PROJ-123"]', 10000);
  assert.equal(await count(".pane.active .ProseMirror .issue-chip"), 1, "ISO-9001 and UTF-8 stay text");
  assert.match(await app.text('.pane.active .ProseMirror .issue-chip-tail[data-issue="PROJ-123"]'), /In Progress[\s\S]*Login fails on SSO/i);
  assert.ok(await (await app.$('.pane.active .ProseMirror .issue-chip-head.issue-type-bug')).isExisting(), "bug icon");
  // The Markdown keeps the plain key.
  assert.match((await app.invoke("page_get", { id: pageId })).content, /^Heute PROJ-123 besprechen/);
  await hoverChip("PROJ-123");
  const card = await app.text(".issue-preview");
  assert.match(card, /PROJ-123[\s\S]*Login fails on SSO[\s\S]*Mia Meyer[\s\S]*Steps: open login/i);
  await app.shot("104-chip-light");
  await setTheme("dark");
  await clickText(".sidebar .tree-row", /^Sprint-Planung/);
  await hoverChip("PROJ-123");
  await app.shot("104-chip-dark");
  await setTheme("light");
});

test("a click on the chip opens the issue's note; the issue lists the pages naming it", async () => {
  await clickText(".sidebar .tree-row", /^Sprint-Planung/);
  const chip = await app.waitFor('.pane.active .ProseMirror .issue-chip-tail[data-issue="PROJ-123"]');
  await chip.click();
  await app.browser.waitUntil(async () => (await app.browser.execute(() => document.querySelector(".pane.active .tab.active")?.textContent ?? "")).includes("PROJ-123 Login fails on SSO"), { timeout: 10000, timeoutMsg: "issue note not opened" });
  const view = await app.invoke("jira_issue_view", { key: "PROJ-123" });
  assert.ok(view.note_page_id, "note page created");
  assert.match((await app.invoke("page_get", { id: view.note_page_id })).content, /^---\njira: PROJ-123\n---/);
  assert.deepEqual(view.backlinks.map((b) => [b.title, b.note]), [["PROJ-123 Login fails on SSO", true], ["Sprint-Planung", false]]);
  // A second click opens the same note.
  const again = await app.invoke("jira_issue_note", { key: "PROJ-123" });
  assert.equal(again.created, false);
  assert.equal(again.page.id, view.note_page_id);
});

test("a task becomes a Jira issue from its context menu", async () => {
  await clickText(".sidebar .tree-row", /^Sprint-Planung/);
  const task = await app.waitFor(".pane.active .ProseMirror li[data-checked]");
  await task.click({ button: "right" });
  await clickText(".menu [role='menuitem'], .menu button", /Jira-Issue anlegen/);
  await app.waitFor(".dialog");
  assert.equal(await app.browser.execute(() => document.querySelector('.dialog input[aria-label="Titel"]').value), "Fix SSO für Kunde");
  await app.browser.waitUntil(async () => !(await app.browser.execute(() => document.querySelector('.dialog [aria-label="Typ"]')?.getAttribute("aria-disabled") === "true" || document.querySelector('.dialog [aria-label="Typ"]')?.disabled)), { timeoutMsg: "types not loaded" });
  await sleep(300);
  await clickText(".dialog button", /Issue anlegen/);
  await app.waitFor('.pane.active .ProseMirror .issue-chip[data-issue="PROJ-126"]', 10000);
  const created = jira.issues.find((i) => i.key === "PROJ-126");
  assert.equal(created.summary, "Fix SSO für Kunde");
  assert.match(created.description, /Angelegt aus der Notiz „Sprint-Planung“ in Arcalo/);
  await sleep(1200);
  assert.match((await app.invoke("page_get", { id: pageId })).content, /- \[ \] Fix SSO für Kunde PROJ-126/);
});

test("„Als Aufgabe übernehmen“ and ticking it when the issue is done", async () => {
  await app.click(".ribbon-issues");
  await app.click('[data-issue-row="OPS-7"] .issue-row-main');
  await clickText('[data-issue-row="OPS-7"] .issue-detail-side button', /Als Aufgabe übernehmen/);
  await app.browser.waitUntil(async () => (await app.invoke("tasks_list", { filter: { status: "open" } })).some((t) => t.text === "OPS-7 Nightly backup job"), { timeoutMsg: "task not added" });
  // Done in Jira: the next sync ticks the task.
  Object.assign(jira.issues.find((i) => i.key === "OPS-7"), { status: "Done", category: "done" });
  await app.invoke("jira_sync_now", { site: "acme" });
  const tasks = await app.invoke("tasks_list", { filter: { status: "all" } });
  assert.equal(tasks.find((t) => t.text === "OPS-7 Nightly backup job")?.done, true, "ticked");
});

test("offline: the cached issues stay readable", async () => {
  await jira.stop();
  await assert.rejects(app.invoke("jira_sync_now", { site: "acme" }), /nicht erreichbar/);
  await app.click(".ribbon-issues");
  await app.waitText(".issues-banner", /nicht erreichbar/);
  assert.ok((await count("[data-issue-row]")) >= 3, "issues still listed");
  await app.dismissToasts();
  await app.shot("104-issues-offline");
  await clickText(".sidebar .tree-row", /^Sprint-Planung/);
  await hoverChip("PROJ-123");
  assert.match(await app.text(".issue-preview"), /Login fails on SSO/);
  await jira.start();
});
