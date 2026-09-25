// The assistant on a vLLM model behind LiteLLM, in the UI: vLLM started without
// --enable-auto-tool-choice rejects the tools (400), LiteLLM counts that as a failure and pauses
// the model for a few seconds. The assistant repeats without tools, shows the wait, answers
// with the same model and remembers that the model has no tools. Stop ends a wait, a fallback
// to the small local model is said visibly, and the embedding picker offers no chat models.

import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";
import { startFakeLiteLLM } from "../lib/fake-litellm.js";
import { startFakeOpenAI } from "../lib/fake-openai.js";

const test = guarded(nodeTest, () => app);
let app, llm, ollama;
before(async () => {
  llm = await startFakeLiteLLM({ port: 4963, models: ["vllmserver", "firma-embed"], vllm: ["vllmserver"], allowedFails: 0, cooldownSeconds: 3 });
  ollama = await startFakeOpenAI({ port: 4964, kind: "ollama", name: "Ollama", models: ["gemma4:e2b"] });
  app = await launch();
  const view = await app.invoke("settings_get");
  const provider = (id, name, kind, base_url, local) => ({ id, name, kind, base_url, local, enabled: true, bypass_proxy: local, api_version: "", models: [] });
  await app.invoke("settings_save", {
    settings: {
      ...view.settings,
      providers: [provider("litellm", "LiteLLM", "litellm", llm.url, false), provider("ollama", "Ollama", "ollama", ollama.url, true)],
      auto_route: false,
      router: { ...view.settings.router, local_provider: "ollama", local_model: "gemma4:e2b", standard_provider: "litellm", standard_model: "vllmserver", reasoning_provider: "litellm", reasoning_model: "vllmserver" },
      embedding_provider: "litellm",
      embedding_model: "vllmserver",
    },
  });
  await app.invoke("provider_key_set", { id: "litellm", key: llm.apiKey });
});
after(async () => {
  await app?.close();
  await llm?.close();
  await ollama?.close();
});

const chats = () => llm.requests.filter((r) => r.url === "/v1/chat/completions");
const ask = async (text) => {
  const ta = await app.waitFor(".composer textarea");
  await ta.setValue(text);
  await app.keys(["Enter"]);
};
const lastAnswer = () => app.browser.execute(() => [...document.querySelectorAll(".msg-ai")].pop()?.innerText ?? "");

test("tools rejected by vLLM: repeated without, the cooldown is waited out visibly", async () => {
  await app.click(".sidebar .tree-row");
  await app.keys(["Control", "j"]);
  await ask("Wie ist der Stand im Projekt?");
  // 400 for the tools puts the model into a 3 s cooldown; the assistant says so and waits.
  await app.waitText(".msg-waiting", /Server kurz ausgelastet, neuer Versuch in \d s/, 8000);
  await app.shot("assistant-cooldown-wait");
  await app.waitFor(".msg-ai .msg-meta", 15000);
  const text = await lastAnswer();
  assert.match(text, /Du hast gefragt/);
  assert.match(await app.text(".msg-ai .msg-meta"), /vllmserver/);
  assert.match(await app.text(".msg-route-notes"), /unterstützt keine Werkzeuge/);
  assert.equal(ollama.chats().length, 0, "no fallback to the local model");
  await app.shot("assistant-route-notes");

  // The next question goes out without tools at once: no 400, no new cooldown.
  const before = chats().length;
  await ask("Und die nächsten Schritte?");
  await app.browser.waitUntil(async () => (await app.$$(".msg-ai .msg-meta")).length === 2, { timeout: 8000 });
  const sent = chats().slice(before);
  assert.equal(sent.length, 1, "answered on the first request");
  assert.equal(sent[0].body.tools, undefined);
  assert.equal(sent[0].body.model, "vllmserver");
  assert.ok(!llm.requests.some((r) => r.url === "/v1/embeddings" && r.body.model === "vllmserver"), "the chat model is never asked for embeddings");
});

test("Stop ends a wait for the server", async () => {
  llm.cooledUntil.set("vllmserver", Date.now() + 5000);
  const before = chats().length;
  await ask("Eine Frage während der Pause");
  await app.waitFor(".msg-waiting", 8000);
  await app.click('.send-btn.stop[aria-label="Antwort stoppen"]');
  await app.waitText(".msg-ai .faint.small", /Abgebrochen/, 4000);
  await app.browser.pause(5500);
  assert.equal(chats().length, before + 1, "not asked again after Stop");
  assert.equal(ollama.chats().length, 0);
});

test("a fallback to the small local model is said in the answer", async () => {
  // A model group without deployments for a minute: another model answers, visibly.
  llm.cooldown.add("vllmserver");
  await ask("Noch eine Frage");
  await app.browser.waitUntil(async () => (await app.$$(".msg-ai .msg-meta")).length === 4, { timeout: 10000 });
  const notes = await app.browser.execute(() => [...document.querySelectorAll(".msg-route-notes")].pop()?.innerText ?? "");
  assert.match(notes, /Ausweichmodell „gemma4:e2b · Ollama“ ist ein kleineres lokales Modell/);
  assert.equal(ollama.chats().length, 1);
  llm.cooldown.delete("vllmserver");
  await app.shot("assistant-fallback-note");
});

test("the embedding picker offers embedding models only, the chat model is marked", async () => {
  await app.keys(["Control", ","]);
  await app.waitText(".settings-head h1", /KI & Modelle/);
  const sel = '[role="combobox"][aria-label="Embedding-Modell"]';
  await app.waitFor(sel, 10000);
  await app.waitText(".model-picker .warn-note", /Chat-Modell, keine Embeddings/, 10000);
  await app.click(sel);
  const list = await app.browser.execute((s) => document.querySelector(s)?.getAttribute("aria-controls"), sel);
  await app.waitFor(`#${list} [role="option"]`);
  const options = await app.browser.execute((id) => [...document.querySelectorAll(`#${id} [role="option"]`)].map((o) => o.innerText.trim()), list);
  assert.deepEqual(options, ["Keine (nur Stichwortsuche)", "vllmserver (kein Embedding-Modell)", "firma-embed"]);
  await app.keys(["Escape"]);
  // The tier pickers do not offer the embedding model.
  await app.click('[role="combobox"][aria-label="Standardmodell"]');
  const tierList = await app.browser.execute(() => document.querySelector('[role="combobox"][aria-label="Standardmodell"]')?.getAttribute("aria-controls"));
  const tierOptions = await app.browser.execute((id) => [...document.querySelectorAll(`#${id} [role="option"]`)].map((o) => o.innerText.trim()), tierList);
  assert.ok(!tierOptions.includes("firma-embed"), tierOptions.join(", "));
  await app.keys(["Escape"]);
  await app.shot("settings-embedding-picker");
  await app.select(sel, "");
  await app.click(".savebar .btn-primary");
  await app.waitText(".toast-title", /Einstellungen gespeichert/);
  assert.equal((await app.invoke("settings_get")).settings.embedding_model, null);
});

test("no console errors", async () => {
  assert.deepEqual(await app.consoleErrors(), []);
});
