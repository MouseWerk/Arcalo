// App-Sperre (1.10 quality round): a lock by idle time saves what was just typed. The lock screen
// unmounts the editor and refuses the app's commands once locked, so every lock first asks the
// main window to save its editors.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, guarded } from "../lib/harness.js";

let app;
const test = guarded(nodeTest, () => app);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "annalo-e2e-lock-save-"));
const ENV = { ANNALO_BACKUP_DELAY_SECS: "3600", ANNALO_SECRET_STORE: "file" };
const PIN = "1357";
const TYPED = "Kurz vor der Sperre getippt";

before(async () => {
  app = await launch({ demo: true, dataDir, env: ENV });
});
after(async () => {
  await app?.close();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

test("the idle lock saves the text typed right before it", async () => {
  const s = await app.invoke("applock_status");
  await app.invoke("applock_configure", { config: { ...s.config, mode: "idle", idle_minutes: 5 }, pin: PIN });
  const page = await app.invoke("page_create", { title: "Sperrnotiz", parentId: null, content: "Erste Zeile" });
  await app.invoke("search_open", { target: { kind: "page", page_id: page.id, new_tab: false } });
  await app.browser.waitUntil(async () => (await app.browser.execute(() => document.querySelector(".pane.active .page-title")?.value)) === "Sperrnotiz", { timeoutMsg: "page not open" });
  await app.caretToEnd();
  await app.keys(["Enter"]);
  await app.type(TYPED);
  // Locked by idle time at once, before the editor's own save would run.
  await app.invoke("applock_test_idle", { seconds: 400 });
  await app.waitFor(".lock-screen", 8000);
  await assert.rejects(app.invoke("page_get", { id: page.id }), /app-locked/);
  await app.click(".lock-pin");
  await app.type(PIN);
  await app.keys(["Enter"]);
  await app.browser.waitUntil(() => app.browser.execute(() => !!document.querySelector(".sidebar, .side-tabs")), { timeout: 10000, timeoutMsg: "not unlocked" });
  const { content } = await app.invoke("page_get", { id: page.id });
  assert.match(content, new RegExp(TYPED), `the typed text was saved before the lock: ${JSON.stringify(content)}`);
  assert.deepEqual(await app.consoleErrors(), []);
});
