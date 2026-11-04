// q124 R2D-6: a command refused while the app is locked never settled. Locking („Jetzt sperren“,
// the idle time, the computer sleeping) while the assistant answered left the saving of that
// answer waiting for good, and every later answer was queued behind it: nothing more of the
// session reached the chat history. Now a refused command is sent again once the app is
// unlocked: the answer is saved, and so are the next ones.

import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, guarded } from "../lib/harness.js";
import { startFakeOpenAI } from "../lib/fake-openai.js";

const test = guarded(nodeTest, () => app);
let app, ai;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "arcalo-e2e-lock-answer-"));
const PIN = "2468";
const LONG = Array.from({ length: 60 }, (_, i) => `Wort${i}`).join(" ");

before(async () => {
  ai = await startFakeOpenAI({ port: 4993, kind: "openai", name: "Lokal", models: ["lokal-modell"], wordDelay: 50, respond: (q) => (/lang/.test(q) ? LONG : `Kurz: ${q}`) });
  app = await launch({ dataDir, env: { ARCALO_BACKUP_DELAY_SECS: "3600", ARCALO_SECRET_STORE: "file" } });
  const view = await app.invoke("settings_get");
  const provider = { id: "lokal", name: "Lokal", kind: "openai", base_url: `${ai.url}/v1`, local: true, enabled: true, bypass_proxy: true, api_version: "", models: [] };
  await app.invoke("settings_save", {
    settings: {
      ...view.settings,
      providers: [provider],
      router: { ...view.settings.router, local_provider: "lokal", local_model: "lokal-modell", standard_provider: "lokal", standard_model: "lokal-modell", reasoning_provider: "lokal", reasoning_model: "lokal-modell" },
      embedding_model: null,
    },
  });
  const s = await app.invoke("applock_status");
  await app.invoke("applock_configure", { config: { ...s.config, mode: "idle", idle_minutes: 30 }, pin: PIN });
  await app.reload();
});
after(async () => {
  await app?.close();
  await ai?.close();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const ask = async (text) => {
  await app.waitFor(".assistant .composer textarea");
  const ta = await app.$(".assistant .composer textarea");
  await ta.setValue(text);
  await app.keys(["Enter"]);
};
const idle = () => app.browser.waitUntil(async () => (await app.$$(".assistant .send-btn.stop")).length === 0, { timeout: 20000, timeoutMsg: "the panel stays busy" });
const saved = async () => {
  const list = await app.invoke("chat_list", { query: null, archived: null });
  const docs = await Promise.all(list.map((c) => app.invoke("chat_get", { id: c.id })));
  return docs.flatMap((d) => d.messages.map((m) => m.content ?? ""));
};

test("an answer that finished while the app was locked is saved, and so are the next ones", async () => {
  await ask("Bitte eine lange Antwort");
  // Locked while the answer streams; it ends behind the lock screen.
  await app.browser.waitUntil(async () => (await app.$$(".assistant .msg-ai")).length > 0, { timeout: 10000, timeoutMsg: "no answer started" });
  await app.invoke("applock_lock_now");
  await app.waitFor(".lock-screen", 8000);
  await app.browser.waitUntil(async () => ai.finished() === 1, { timeout: 15000, timeoutMsg: "the answer did not end" });
  await app.click(".lock-pin");
  await app.type(PIN);
  await app.keys(["Enter"]);
  await app.browser.waitUntil(() => app.browser.execute(() => !document.querySelector(".lock-screen")), { timeout: 10000, timeoutMsg: "not unlocked" });
  await app.browser.waitUntil(async () => (await saved()).some((c) => c.includes("Wort59")), { timeout: 10000, timeoutMsg: "the answer finished during the lock was not saved" });

  // The next question of the session is saved as well.
  await app.waitFor(".assistant .composer textarea", 10000);
  await idle();
  await ask("Noch eine Frage danach");
  await app.browser.waitUntil(async () => (await saved()).some((c) => c.includes("Kurz: Noch eine Frage danach")), { timeout: 15000, timeoutMsg: "the next answer was not saved" });
  assert.deepEqual(await app.consoleErrors(), []);
});
