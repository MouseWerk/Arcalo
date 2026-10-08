// Release 1.10: the structured developer log (level from the settings, span timings, redaction),
// the diagnostics bundle, the credential store state on Linux without a Secret Service and the
// notification buttons (task due: Erledigt / Schlummern / Öffnen, focus end, briefing, update),
// clicked through the debug seam `notify_test` (ARCALO_NOTIFY_TEST).
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { launch, guarded } from "../lib/harness.js";
import { settingsSettled } from "../lib/settings.js";

const test = guarded(nodeTest, () => app);
let app;
const ENV = { ARCALO_NOTIFY_TEST: "1" };
before(async () => (app = await launch({ env: ENV })));
after(async () => app?.close());

const pad = (n) => String(n).padStart(2, "0");
const today = (() => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
})();
const openSection = async (id) => {
  await app.dismissToasts();
  const onSettings = await app.browser.execute(() => !!document.querySelector(".settings-nav"));
  if (!onSettings) await app.keys(["Control", ","]);
  await app.click(`.settings-nav-item[data-section="${id}"]`);
};
/** Settings apply at once: waits until the change is stored. */
const saveIfNeeded = () => settingsSettled(app);
const notify = (op, arg = null) => app.invoke("notify_test", { op, arg });
const logText = () => fs.readFileSync(path.join(app.dataDir, "logs", "arcalo.log"), "utf8");
const zipList = (file) => execFileSync("unzip", ["-Z1", file], { encoding: "utf8" }).split("\n").filter(Boolean);
const zipCat = (file, name) => execFileSync("unzip", ["-p", file, name], { encoding: "utf8" });

test("the log level is set in Settings → Protokoll; spans write their timing, secrets never", async () => {
  assert.equal((await app.invoke("devlog_stats")).level, "INFO");
  // The startup line keeps its text (other tests and support scripts grep for it).
  assert.match(logText(), /INFO \[core\] Arcalo \S+ started/);
  await app.invoke("devlog_write", { level: "DEBUG", source: "ui", message: "E2E debug 1351 vorher" });
  await openSection("logs");
  await app.waitText(".settings-head h1", /Protokoll/);
  await app.select(".devlog-level", "debug");
  await saveIfNeeded();
  await app.browser.waitUntil(async () => (await app.invoke("devlog_stats")).level === "DEBUG", { timeoutMsg: "level not applied" });
  await app.invoke("devlog_write", { level: "DEBUG", source: "ui", message: "E2E debug 1352 nachher" });
  // A backup runs in a span: its timing is written with the elapsed milliseconds.
  await app.invoke("backup_now");
  await app.browser.waitUntil(async () => /\[backup\] backup done elapsed_ms=\d+/.test(logText()), { timeoutMsg: "no backup timing" });
  await app.invoke("devlog_write", { level: "WARN", source: "ui", message: "E2E 1353 Authorization: Bearer abcdef.123 password=hunter22" });
  const text = logText();
  assert.ok(!text.includes("1351 vorher"), "debug lines below the level are dropped");
  assert.match(text, /DEBUG \[ui\] E2E debug 1352 nachher/);
  assert.ok(!text.includes("hunter22") && !text.includes("abcdef.123"), "credentials redacted");
  // The viewer lists the new levels and keeps its filters.
  await app.click('.devlog-actions .btn:first-child');
  await app.waitText(".devlog-message", /E2E debug 1352 nachher/);
  assert.equal(await app.browser.execute(() => !!document.querySelector(".devlog-entry.level-debug")), true);
  await app.shot("settings-devlog-level");
});

test("Diagnosepaket erstellen writes a zip with version, settings without secrets and the logs", async () => {
  await app.invoke("git_token_set", { token: "ghp_e2eSecretToken135" }).catch(() => {});
  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", {
    settings: { ...view.settings, git_sync: { ...view.settings.git_sync, remote_url: "https://bob:pw-e2e-135@git.example.com/notes.git" } },
  });
  await app.invoke("devlog_write", { level: "ERROR", source: "ui", message: "E2E 1354 token=zipSecret999" });
  const file = path.join(app.dataDir, "diagnose-135.zip");
  await openSection("logs");
  await app.waitText(".set-row-label", /Diagnosepaket/);
  await app.browser.execute((p) => window.dispatchEvent(new CustomEvent("arcalo:diagnostics-bundle", { detail: { path: p } })), file);
  await app.waitText(".toast-title", /Diagnosepaket gespeichert/);
  assert.ok(fs.existsSync(file));
  const names = zipList(file);
  for (const n of ["info.json", "settings.json", "README.txt", "logs/arcalo.log"]) assert.ok(names.includes(n), `${n} in ${names}`);
  const info = JSON.parse(zipCat(file, "info.json"));
  assert.equal(info.os, "linux");
  assert.ok(Number.isInteger(info.schema_version) && info.schema_version > 10, `schema ${info.schema_version}`);
  assert.equal(info.credential_store.kind, "file");
  assert.equal(info.log_level, "DEBUG");
  const all = names.map((n) => zipCat(file, n)).join("\n");
  for (const secret of ["ghp_e2eSecretToken135", "pw-e2e-135", "zipSecret999"]) assert.ok(!all.includes(secret), `${secret} in the bundle`);
  assert.match(zipCat(file, "settings.json"), /https:\/\/\*\*\*@git\.example\.com/);
  assert.match(zipCat(file, "logs/arcalo.log"), /E2E 1354 token=\*\*\*/);
});

test("Datenschutz shows the file fallback when no Secret Service runs", async () => {
  const st = await app.invoke("secrets_status");
  assert.equal(st.kind, "file");
  assert.ok(st.reason, "the reason is given");
  await openSection("privacy");
  await app.waitFor('.secret-store[data-kind="file"]');
  await app.waitText(".secret-store-label", /Datei im App-Datenordner/);
  await app.waitText(".secret-store .badge", /^Datei$/);
  await app.waitText(".secret-store-desc", /Kein Schlüsselbund \(Secret Service\) erreichbar/);
  await app.browser.execute(() => document.querySelector(".secret-store")?.scrollIntoView({ block: "center" }));
  await app.shot("settings-privacy-secret-store");
});

test("a task due today: Schlummern, Erledigt and Öffnen from the notification", async () => {
  const page = await app.invoke("page_create", {
    parentId: null,
    title: "Benachrichtigung 135",
    icon: null,
    content: `- [ ] Angebot 135 senden due:${today}\n- [ ] Rückruf 135 due:${today}\n`,
  });
  await notify("due_check");
  const shown = await notify("shown");
  const mine = shown.filter((n) => n.subject.kind === "task" && n.subject.page_id === page.id);
  assert.equal(mine.length, 2, JSON.stringify(shown));
  assert.equal(mine[0].title, "Aufgabe heute fällig");
  assert.match(mine[0].body, /Angebot 135 senden – auf „Benachrichtigung 135“/);
  assert.deepEqual(mine[0].actions.map((a) => a.label), ["Erledigt", "10 Min.", "1 Std.", "Morgen", "Öffnen"]);
  // Once a day only.
  await notify("due_check");
  assert.equal((await notify("shown")).filter((n) => n.subject.page_id === page.id).length, 2);

  // Schlummern 10 Min: stored, and back after ten minutes.
  const snooze = mine[1].actions.find((a) => a.id === "snooze10").url;
  assert.match(await notify("activate", snooze), /snoozed until/);
  let snoozes = await notify("snoozes");
  assert.equal(snoozes.length, 1);
  assert.equal(snoozes[0].note.subject.text, "Rückruf 135");
  await notify("tick", "5");
  assert.equal((await notify("snoozes")).length, 1, "not yet");
  await notify("tick", "11");
  assert.equal((await notify("snoozes")).length, 0);
  assert.equal((await notify("shown")).filter((n) => n.subject.text === "Rückruf 135").length, 2, "shown again");

  // Erledigt: the task is checked in the note.
  await notify("activate", mine[0].actions.find((a) => a.id === "done").url);
  const content = (await app.invoke("page_get", { id: page.id })).content;
  assert.match(content, /- \[x\] Angebot 135 senden/);
  assert.match(content, /- \[ \] Rückruf 135/);

  // Öffnen (and the click on the notification): the note opens in the window.
  await notify("activate", mine[1].click);
  await app.browser.waitUntil(async () => (await (await app.$(".page-title")).getValue().catch(() => "")) === "Benachrichtigung 135", {
    timeoutMsg: "the note did not open",
  });
  assert.match(logText(), /\[notify\] notification action: page \d+ opened/);
});

test("focus end, briefing and update offer their buttons", async () => {
  await app.invoke("focus_start", { start: { reference: "", minutes: 0.05, break_minutes: 0, goal: "E2E 135" } });
  await app.browser.pause(3500);
  await app.invoke("focus_state");
  const focus = (await notify("shown")).filter((n) => n.subject.kind === "focus").at(-1);
  assert.ok(focus, "the break notification");
  assert.deepEqual(focus.actions.map((a) => a.label), ["+5 Min.", "Pause", "Öffnen"]);
  await notify("activate", focus.actions.find((a) => a.id === "extend").url);
  const st = await app.invoke("focus_state");
  assert.equal(st.phase, "work");
  assert.equal(st.session.planned_minutes, 5);
  assert.equal(st.session.goal, "E2E 135");
  await app.invoke("focus_abort", { book: false });

  await notify("show", "briefing");
  const briefing = (await notify("shown")).filter((n) => n.subject.kind === "briefing").at(-1);
  assert.deepEqual(briefing.actions.map((a) => a.label), ["Öffnen"]);
  assert.equal(await notify("activate", briefing.click), "briefing opened");

  await notify("show", "update");
  const update = (await notify("shown")).filter((n) => n.subject.kind === "update").at(-1);
  assert.equal(update.title, "Arcalo 9.9.9 ist bereit");
  assert.deepEqual(update.actions.map((a) => a.label), ["Jetzt neu starten", "Später"]);
  assert.equal(await notify("activate", update.actions.find((a) => a.id === "later").url), "update 9.9.9: later");
  // Unknown or forged addresses are refused.
  await assert.rejects(notify("activate", "arcalo-notify:?a=nuke&k=task"));
});
