// The assistant against a LiteLLM proxy with a vLLM backend, as reported: the inline AI
// answered, the assistant fell back to a small local model. A chat model chosen as embedding
// model made every question send an embeddings request vLLM cannot answer (404); LiteLLM put the
// deployment into cooldown and the chat right after got 429 „No deployments available … Try
// again in 5 seconds“. The fake server emulates that router behaviour exactly (fake-litellm.js).

import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";
import { startFakeLiteLLM } from "../lib/fake-litellm.js";
import { startFakeOpenAI } from "../lib/fake-openai.js";

const test = guarded(nodeTest, () => app);
let app, llm, ollama;
before(async () => {
  llm = await startFakeLiteLLM({ port: 4961, models: ["vllmserver", "firma-embed"], vllm: ["vllmserver"], modes: { "firma-embed": "embedding" }, allowedFails: 0, cooldownSeconds: 5 });
  ollama = await startFakeOpenAI({ port: 4962, kind: "ollama", name: "Ollama", models: ["gemma4:e2b"] });
  app = await launch();
  const view = await app.invoke("settings_get");
  const provider = (id, name, kind, base_url, local) => ({ id, name, kind, base_url, local, enabled: true, bypass_proxy: local, api_version: "", models: [] });
  await app.invoke("settings_save", {
    settings: {
      ...view.settings,
      providers: [provider("litellm", "LiteLLM", "litellm", llm.url, false), provider("ollama", "Ollama", "ollama", ollama.url, true)],
      auto_route: false,
      router: {
        ...view.settings.router,
        local_provider: "ollama",
        local_model: "gemma4:e2b",
        standard_provider: "litellm",
        standard_model: "vllmserver",
        reasoning_provider: "litellm",
        reasoning_model: "vllmserver",
      },
      // The user's setting: the chat model picked as embedding model.
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

const chat = (id, content, useTools = false) => app.invoke("ai_chat", { requestId: id, messages: [{ role: "user", content }], useTools, tier: null, pageId: null, overrideLimit: null });
const embeds = (model) => llm.requests.filter((r) => r.url === "/v1/embeddings" && r.body.model === model);
const chats = (model) => llm.requests.filter((r) => r.url === "/v1/chat/completions" && r.body.model === model);

test("the inline AI answers with vllmserver", async () => {
  const out = await app.invoke("ai_transform", { requestId: "t-1", instruction: "Kürze den Text", text: "Die Middleware verbindet das ERP.", pageId: null, tier: null, overrideLimit: null });
  assert.equal(out.route.model, "vllmserver");
});

test("the assistant answers with vllmserver, not the small local model", async () => {
  for (let i = 0; i < 3; i++) {
    const out = await chat(`c-${i}`, `Wie ist der Stand im Projekt? (${i})`);
    assert.deepEqual([out.route.provider, out.route.model], ["litellm", "vllmserver"], out.route.reasons.join(" | "));
    assert.match(out.completion.content, /Du hast gefragt/);
  }
  assert.equal(embeds("vllmserver").length, 0, "a chat model is never asked for embeddings");
  assert.equal(ollama.chats().length, 0, "no fallback to the local model");
  assert.ok(chats("vllmserver").every((r) => r.body.messages.filter((m) => m.role === "system").length === 1), "one system message, as in the inline AI");
});

test("the embedding picker only offers embedding models", async () => {
  const test = await app.invoke("ai_provider_models", { provider: (await app.invoke("settings_get")).settings.providers[0], key: null });
  assert.deepEqual(test.embedding_models, ["firma-embed"]);
  // The configured chat model is reported as not usable for embeddings.
  const status = await app.invoke("ai_embedding_status");
  assert.equal(status.usable, false);
  assert.match(status.reason, /kein Embedding-Modell/);
});

test("an embedding model that fails is not asked again for every message", async () => {
  // A model whose name looks like an embedding model but whose server has no embeddings.
  const view = await app.invoke("settings_get");
  await llm.close();
  llm = await startFakeLiteLLM({ port: 4961, models: ["vllmserver", "vllm-embed"], vllm: ["vllmserver", "vllm-embed"], allowedFails: 3, cooldownSeconds: 5 });
  await app.invoke("settings_save", { settings: { ...view.settings, embedding_model: "vllm-embed" } });
  for (let i = 0; i < 3; i++) {
    const out = await chat(`e-${i}`, `Frage ${i}`);
    assert.equal(out.route.model, "vllmserver");
    // Mentioned once, on the first answer only.
    assert.equal(out.route.reasons.some((r) => /Stichwortsuche/.test(r)), i === 0, out.route.reasons.join(" | "));
  }
  assert.equal(embeds("vllm-embed").length, 1, "asked once per session");
  const status = await app.invoke("ai_embedding_status");
  assert.equal(status.usable, false);
  assert.match(status.reason, /404/);
});

test("a cooldown of the chat model is waited out on the same model", async () => {
  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", { settings: { ...view.settings, embedding_model: null } });
  // Emulate a cooldown caused by someone else: 3 s left.
  llm.cooledUntil.set("vllmserver", Date.now() + 3000);
  const start = Date.now();
  const out = await chat("w-1", "Noch eine Frage");
  assert.equal(out.route.model, "vllmserver", out.route.reasons.join(" | "));
  assert.ok(Date.now() - start >= 2500, "waited for the cooldown");
  assert.equal(ollama.chats().length, 0);
});

test("no console errors", async () => {
  assert.deepEqual(await app.consoleErrors(), []);
});
