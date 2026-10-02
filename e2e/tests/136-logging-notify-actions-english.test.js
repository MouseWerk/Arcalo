// Release 1.10 in English: log level, diagnostics bundle, the credential store fallback and the
// notification buttons; a snoozed reminder survives a restart.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { launch, guarded } from "../lib/harness.js";
import { settingsSettled } from "../lib/settings.js";
import { launchEnglish, germanLeftovers } from "../lib/english.js";

const test = guarded(nodeTest, () => app);
let app;
let dataDir;
const ENV = { ANNALO_NOTIFY_TEST: "1" };
before(async () => ({ app, dataDir } = await launchEnglish({ env: ENV })));
after(async () => {
  await app?.close();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

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
const saveIfNeeded = () => settingsSettled(app);
const notify = (op, arg = null) => app.invoke("notify_test", { op, arg });

test("Settings → Log: the level, JSON lines and the diagnostics bundle in English", async () => {
  await openSection("logs");
  await app.waitText(".set-row-label", /^Log level$/);
  await app.waitText(".set-row-label", /^Diagnostics bundle$/);
  await app.select(".devlog-level", "trace");
  await app.click('.devlog-section [role="switch"][aria-label="Also as JSON lines"]');
  await saveIfNeeded();
  await app.browser.waitUntil(async () => (await app.invoke("devlog_stats")).level === "TRACE", { timeoutMsg: "level not applied" });
  const view = await app.invoke("settings_get");
  assert.equal(view.settings.dev_log_level, "trace");
  assert.equal(view.settings.dev_log_json, true);
  await app.invoke("devlog_write", { level: "INFO", source: "ui", message: "E2E 1361 json token=jsonSecret1361" });
  const jsonl = path.join(dataDir, "logs", "annalo.jsonl");
  await app.browser.waitUntil(async () => fs.existsSync(jsonl) && fs.readFileSync(jsonl, "utf8").includes("E2E 1361"), { timeoutMsg: "no JSON line" });
  const line = fs.readFileSync(jsonl, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((l) => l.message.includes("1361"));
  assert.equal(line.level, "INFO");
  assert.ok(!JSON.stringify(line).includes("jsonSecret1361"));

  const file = path.join(dataDir, "diagnostics-136.zip");
  await app.browser.execute((p) => window.dispatchEvent(new CustomEvent("annalo:diagnostics-bundle", { detail: { path: p } })), file);
  await app.waitText(".toast-title", /Diagnostics bundle saved/);
  const names = execFileSync("unzip", ["-Z1", file], { encoding: "utf8" });
  assert.match(names, /info\.json/);
  assert.match(names, /logs\/annalo\.jsonl/);
  assert.equal(JSON.parse(execFileSync("unzip", ["-p", file, "info.json"], { encoding: "utf8" })).language, "en");
  const leftovers = await germanLeftovers(app);
  assert.deepEqual(leftovers, []);
  await app.shot("settings-devlog-level-en");
});

test("Privacy shows where credentials are kept", async () => {
  await openSection("privacy");
  await app.waitText(".secret-store-label", /File in the app data folder/);
  await app.waitText(".secret-store .badge", /^File$/);
  await app.waitText(".secret-store-desc", /No keyring \(Secret Service\) available/);
  assert.deepEqual(await germanLeftovers(app), []);
});

test("notification buttons in English; a snooze survives a restart", async () => {
  const page = await app.invoke("page_create", { parentId: null, title: "Notify 136", icon: null, content: `- [ ] Call back 136 due:${today}\n` });
  await notify("due_check");
  const note = (await notify("shown")).find((n) => n.subject.kind === "task" && n.subject.page_id === page.id);
  assert.equal(note.title, "Task due today");
  assert.deepEqual(note.actions.map((a) => a.label), ["Done", "10 min", "1 hr", "Tomorrow", "Open"]);
  assert.match(await notify("activate", note.actions.find((a) => a.id === "snooze60").url), /snoozed until/);

  // Restart on the same data folder: the snooze is still there and comes back after an hour.
  await app.close();
  app = await launch({ dataDir, env: { ANNALO_LOCALE: "en-US", ...ENV } });
  const snoozes = await notify("snoozes");
  assert.equal(snoozes.length, 1);
  assert.equal(snoozes[0].note.subject.text, "Call back 136");
  assert.equal(snoozes[0].note.title, "Task due today");
  await notify("tick", "61");
  assert.equal((await notify("snoozes")).length, 0);
  const back = (await notify("shown")).filter((n) => n.subject.kind === "task" && n.subject.page_id === page.id);
  assert.equal(back.length, 1, "shown again after the restart");
  await notify("activate", back[0].actions.find((a) => a.id === "done").url);
  assert.match((await app.invoke("page_get", { id: page.id })).content, /- \[x\] Call back 136/);

  await app.invoke("focus_start", { start: { reference: "", minutes: 0.05, break_minutes: 0, goal: "E2E 136" } });
  await app.browser.pause(3500);
  await app.invoke("focus_state");
  const focus = (await notify("shown")).filter((n) => n.subject.kind === "focus").at(-1);
  assert.equal(focus.title, "Break");
  assert.deepEqual(focus.actions.map((a) => a.label), ["+5 min", "Break", "Open"]);
  await notify("activate", focus.actions.find((a) => a.id === "pause").url);
  const st = await app.invoke("focus_state");
  assert.equal(st.phase, "break");
  await app.invoke("focus_end_break");
  await notify("show", "update");
  const update = (await notify("shown")).filter((n) => n.subject.kind === "update").at(-1);
  assert.deepEqual(update.actions.map((a) => a.label), ["Restart now", "Later"]);
});
