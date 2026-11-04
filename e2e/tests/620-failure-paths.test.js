// Failure paths of the integrations (q124 round 4): a settings save from an older copy keeps
// what the core stored meanwhile (the calendar discovery's write that switched Outlook off again
// in 84), also when both run at once; a comment Jira took while the issue cannot be read again
// afterwards is shown as done (the last copy, „Stand von …“), never as failed, so it is not
// written twice.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";
import { startFakeJira } from "../lib/fake-jira.js";

const test = guarded(nodeTest, () => app);
let app;
let jira;
before(async () => {
  jira = await startFakeJira({ flavor: "cloud" });
  app = await launch({ env: { ARCALO_JIRA_DELAY_SECS: "600" } });
  await app.invoke("jira_site_save", {
    site: { id: "", name: "Acme", color: "", kind: "cloud", url: jira.url, email: "mia@firma.de", enabled: true, log_work: false, allow_writes: false },
    token: "secret-token",
  });
  await app.invoke("jira_sync_now", { site: "acme" });
  await app.reload();
});
after(async () => {
  await app?.close();
  await jira?.close();
});

const V = (key, sel = "") => `[data-issue-view="${key}"] ${sel}`.trim();
const count = (sel) => app.browser.execute((s) => document.querySelectorAll(s).length, sel);
const stored = async () => (await app.invoke("settings_get")).settings;

test("a settings save from an older copy keeps what the core stored meanwhile", async () => {
  const copy = await stored();
  assert.equal(copy.calendar.entries_outlook, false);
  // The core stores a change of its own (as a calendar discovery or the Kalender's offer do).
  await app.invoke("calendar_entries_enable", { on: true });
  // A window saves its change, made on the copy it had before.
  const next = structuredClone(copy);
  next.calendar.past_days = copy.calendar.past_days + 5;
  await app.invoke("settings_save", { settings: next, base: copy });
  const now = await stored();
  assert.equal(now.calendar.past_days, copy.calendar.past_days + 5, "the window's change");
  assert.equal(now.calendar.entries_outlook, true, "the core's change stays");
  // Both at once, many times: neither takes back the other.
  for (let round = 0; round < 10; round++) {
    const base = await stored();
    const mine = structuredClone(base);
    mine.calendar.future_days = 60 + round;
    await Promise.all([
      app.invoke("settings_save", { settings: mine, base }),
      app.invoke("calendar_entries_enable", { on: round % 2 === 0 }),
    ]);
    const after = await stored();
    assert.equal(after.calendar.future_days, 60 + round, `round ${round}: the window's change`);
    assert.equal(after.calendar.entries_outlook, round % 2 === 0, `round ${round}: the core's change`);
  }
});

test("a comment Jira took is not reported as failed when the issue cannot be read again", async () => {
  await app.keys(["Control", "k"]);
  await app.waitFor(".palette input");
  await app.type("PROJ-123");
  await app.browser.waitUntil(() => app.browser.execute(() => (document.querySelector(".pal-item.sel")?.textContent ?? "").includes("Issue PROJ-123 öffnen")), { timeoutMsg: "the issue is not the first item" });
  await app.keys(["Enter"]);
  await app.waitFor(V("PROJ-123", ".iv-summary, .iv-summary-edit"), 15000);
  await app.browser.waitUntil(() => app.browser.execute((s) => !document.querySelector(s), V("PROJ-123", ".iv-refreshing")), { timeout: 15000, timeoutMsg: "still loading" });
  const before = jira.issues.find((i) => i.key === "PROJ-123").comments.length;
  // The gateway gives up on every read after the comment (502, not retried).
  jira.state.failReadsAfterWrite = { status: 502, times: 50 };
  await app.keys(["c"]);
  await app.browser.waitUntil(() => app.browser.execute(() => !!document.activeElement?.closest(".iv-composer")), { timeoutMsg: "c did not focus the composer" });
  await app.type("Deployed to staging.");
  await app.keys(["Control", "Enter"]);
  await app.browser.waitUntil(() => jira.issues.find((i) => i.key === "PROJ-123").comments.length === before + 1, { timeoutMsg: "comment not posted" });
  // Shown as done: the last copy with what went wrong, no „Kommentar nicht gespeichert“ that
  // invites sending it again.
  await app.waitText(V("PROJ-123", ".iv-offline"), /Stand von[\s\S]*502/, 15000);
  const toasts = await app.browser.execute(() => [...document.querySelectorAll(".toast")].map((t) => t.textContent).join(" | "));
  assert.doesNotMatch(toasts, /Kommentar nicht gespeichert/);
  assert.match(toasts, /Kommentar hinzugefügt/);
  assert.equal(await count(V("PROJ-123", ".iv-composer")), 0, "no comment box on the last copy");
  // Jira answers again: the comment is there once.
  jira.state.failReads = null;
  await app.dismissToasts();
  await app.browser.execute((s) => [...document.querySelectorAll(s)].find((b) => /Erneut versuchen/.test(b.textContent))?.click(), V("PROJ-123", ".iv-offline button"));
  await app.browser.waitUntil(async () => (await count(V("PROJ-123", ".iv-offline"))) === 0, { timeout: 15000, timeoutMsg: "still the last copy" });
  await app.waitText(V("PROJ-123", ".iv-thread"), /Deployed to staging/, 10000);
  assert.equal(jira.issues.find((i) => i.key === "PROJ-123").comments.filter((c) => c.body === "Deployed to staging.").length, 1);
});
