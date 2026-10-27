// 1.6 chat history and privacy: a chat that touched #privat is marked private, shows a lock,
// and stays on the local model when it goes on (also after reopening it), even for questions
// without the marker. „Chats behalten: Nicht speichern“ saves nothing; „Alle Chats löschen“.

import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";
import { settingsSettled } from "../lib/settings.js";
import { startFakeLiteLLM } from "../lib/fake-litellm.js";
import { startFakeOpenAI } from "../lib/fake-openai.js";

const test = guarded(nodeTest, () => app);
let app, llm, ollama;
before(async () => {
  llm = await startFakeLiteLLM({ port: 4987 });
  ollama = await startFakeOpenAI({ port: 4988, kind: "ollama", name: "Ollama", models: ["gemma4:e2b"] });
  app = await launch();
  const view = await app.invoke("settings_get");
  const provider = (id, name, kind, base_url, local) => ({ id, name, kind, base_url, local, enabled: true, bypass_proxy: true, api_version: "", models: [] });
  await app.invoke("settings_save", {
    settings: {
      ...view.settings,
      providers: [provider("litellm", "LiteLLM", "litellm", llm.url, false), provider("ollama", "Ollama", "ollama", ollama.url, true)],
      auto_route: false,
      router: { ...view.settings.router, local_provider: "ollama", local_model: "gemma4:e2b", standard_provider: "litellm", standard_model: "firma-standard", reasoning_provider: "litellm", reasoning_model: "firma-reasoning" },
      embedding_model: null,
    },
  });
  await app.invoke("provider_key_set", { id: "litellm", key: llm.apiKey });
});
after(async () => {
  await app?.close();
  await llm?.close();
  await ollama?.close();
});

const cloudChats = () => llm.requests.filter((r) => r.url === "/v1/chat/completions").length;
const answers = () => app.$$(".assistant .msg-ai .msg-meta");
const askAndWait = async (text) => {
  const before = (await answers()).length;
  const ta = await app.waitFor(".assistant .composer textarea");
  await ta.setValue(text);
  await app.keys(["Enter"]);
  await app.browser.waitUntil(async () => (await answers()).length === before + 1, { timeout: 10000, timeoutMsg: `no answer to ${text}` });
  await app.browser.pause(300);
};
const list = () => app.invoke("chat_list", { query: "", archived: true });

test("a chat about #privat content is private, locked and stays local", async () => {
  await app.keys(["Control", "j"]);
  // A normal chat first: it goes to the cloud model.
  await askAndWait("Was steht diese Woche an?");
  assert.equal(cloudChats(), 1);
  await app.click('.assistant-head [aria-label="Neuer Chat"]');

  await askAndWait("#privat Wie hoch war meine Gehaltserhöhung?");
  assert.equal(ollama.chats().length, 1, "answered by the local model");
  assert.equal(cloudChats(), 1, "nothing went to the cloud");
  await app.waitFor(".assistant-head .chat-lock");
  await app.waitFor(".assistant-head .chat-private-badge");
  // A question without the marker in the same chat stays local too.
  await askAndWait("Und was heißt das fürs nächste Jahr?");
  assert.equal(ollama.chats().length, 2);
  assert.equal(cloudChats(), 1, "the follow-up stayed local");
  await app.shot("chat-private");

  const saved = await list();
  const priv = saved.find((c) => c.private);
  assert.ok(priv, "marked private");
  assert.equal(saved.filter((c) => c.private).length, 1, "the other chat is not private");
  assert.equal(priv.model, "gemma4:e2b");

  // Listed with a lock; reopened, it still goes to the local model.
  await app.click('.assistant-head [aria-label="Neuer Chat"]');
  await app.click('.assistant-head button[aria-label="Verlauf"]');
  await app.waitFor(".chat-history-row .chat-lock");
  const locked = await app.browser.execute(() => [...document.querySelectorAll(".chat-history-row")].filter((r) => r.querySelector(".chat-lock")).map((r) => r.querySelector(".chat-history-title-text").textContent));
  assert.deepEqual(locked, [priv.title]);
  await app.shot("chat-history-private");
  await app.browser.execute((t) => [...document.querySelectorAll(".chat-history-row")].find((r) => r.textContent.includes(t)).click(), priv.title);
  await app.waitFor(".assistant-head .chat-lock");
  await askAndWait("Noch eine Frage ohne Markierung");
  assert.equal(ollama.chats().length, 3);
  assert.equal(cloudChats(), 1, "a reopened private chat stays local");
  assert.ok(!llm.requests.some((r) => JSON.stringify(r.body ?? "").includes("Gehaltserhöhung")), "the private text never reached the cloud");
  // A page saved from a private chat keeps the marker, so it stays private there too.
  await app.browser.execute(() => document.querySelector('.msg-ai.last [aria-label="Als Seite speichern"]').click());
  await app.browser.waitUntil(async () => (await app.invoke("workspace_tree")).length > 0 && (await app.$$(".pane.active > .pane-content:not([hidden]) .page-title")).length > 0, { timeoutMsg: "no page" });
  const pageTitle = await (await app.$(".pane.active > .pane-content:not([hidden]) .page-title")).getValue();
  const page = await app.invoke("page_resolve", { title: pageTitle, create: false });
  assert.match((await app.invoke("page_get", { id: page.id })).content, /#privat/);
});

test("„Nicht speichern“ saves no chat; „Alle Chats löschen“ empties the history", async () => {
  const before = (await list()).length;
  assert.ok(before >= 2);
  await app.keys(["Control", ","]);
  await app.waitText(".settings-head h1", /KI & Modelle/);
  await app.click(".settings-nav-item[data-section=\"privacy\"]");
  const sel = '[role="combobox"][aria-label="Chats behalten"]';
  await app.waitFor(sel);
  await app.shot("settings-chat-history");
  await app.select(sel, "off");
  await settingsSettled(app);
  await app.waitText(".toast-title", /Einstellung geändert/);
  assert.equal((await app.invoke("settings_get")).settings.ai.chat_history, "off");

  await app.keys(["Control", "j"]);
  await app.click('.assistant-head [aria-label="Neuer Chat"]');
  await askAndWait("Diese Frage wird nicht gespeichert");
  assert.equal((await list()).length, before, "nothing saved");
  assert.match(await app.text(".assistant-head .assistant-title"), /nicht gespeichert/);
  await app.click('.assistant-head button[aria-label="Verlauf"]');
  await app.waitText(".chat-history-note", /nicht gespeichert/);

  // „Alle Chats löschen“ after a confirmation.
  await app.keys(["Control", ","]);
  await app.click(".settings-nav-item[data-section=\"privacy\"]");
  await app.waitText("button", /Alle Chats löschen…/);
  await app.browser.execute(() => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Alle Chats löschen…").click());
  await app.waitFor(".dialog");
  await app.browser.execute(() => document.querySelector(".dialog .btn-danger, .dialog .btn-primary").click());
  await app.waitText(".toast-title", /Chats gelöscht/);
  assert.equal((await list()).length, 0);
});

test("no console errors", async () => {
  assert.deepEqual(await app.consoleErrors(), []);
});
