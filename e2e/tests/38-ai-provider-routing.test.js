// Requests across two providers: a stopped Ollama hands the chat over to the OpenAI-compatible
// provider, private content never goes there (checked on the fake server's recorded
// requests), and costs of a provider without a cost header come from the price table.

import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";
import { startFakeOpenAI } from "../lib/fake-openai.js";

const test = guarded(nodeTest, () => app);
let app, ollama, openai;
before(async () => {
  ollama = await startFakeOpenAI({ port: 4986, kind: "ollama", name: "Ollama", models: ["llama3.2:latest", "nomic-embed-text"] });
  openai = await startFakeOpenAI({ port: 4985, kind: "openai", name: "OpenAI", apiKey: "sk-openai-e2e", models: ["gpt-4o", "gpt-4o-mini", "o3"] });
  app = await launch();
  const view = await app.invoke("settings_get");
  const provider = (id, name, kind, base_url, local) => ({ id, name, kind, base_url, local, enabled: true, bypass_proxy: local, api_version: "", models: [] });
  await app.invoke("settings_save", {
    settings: {
      ...view.settings,
      // Ollama first: it is the provider asked first.
      providers: [provider("ollama", "Ollama", "ollama", ollama.url, true), provider("openai", "OpenAI", "openai", `${openai.url}/v1`, false)],
      router: {
        ...view.settings.router,
        local_provider: "ollama",
        local_model: "llama3.2:latest",
        standard_provider: "openai",
        standard_model: "gpt-4o-mini",
        reasoning_provider: "openai",
        reasoning_model: "o3",
      },
      embedding_provider: "ollama",
      embedding_model: null,
    },
  });
  await app.invoke("provider_key_set", { id: "openai", key: openai.apiKey });
});
after(async () => {
  await app?.close();
  await ollama?.close();
  await openai?.close();
});

const chat = (id, content, tier = null, useTools = false) => app.invoke("ai_chat", { requestId: id, messages: [{ role: "user", content }], useTools, tier, pageId: null, overrideLimit: null });
const sentTo = (server, needle) => server.chats().filter((r) => JSON.stringify(r.body.messages).includes(needle));

test("each tier goes to its provider", async () => {
  const local = await chat("route-1", "Übersetze Hallo", "local");
  assert.deepEqual([local.route.provider, local.route.model], ["ollama", "llama3.2:latest"]);
  assert.match(local.completion.content, /Antwort von Ollama/);
  assert.equal(local.completion.usage.cost_usd, 0, "local providers are free");
  const std = await chat("route-2", "Wie ist der Stand?", "standard", true);
  assert.deepEqual([std.route.provider, std.route.model], ["openai", "gpt-4o-mini"]);
  assert.match(std.completion.content, /Antwort von OpenAI/);
  const req = openai.chats().at(-1);
  assert.equal(req.headers.authorization, `Bearer ${openai.apiKey}`);
  assert.ok(req.body.tools?.length, "tools are offered");
  assert.ok(
    ollama.requests.every((r) => !r.headers.authorization),
    "Ollama gets no key",
  );
});

test("costs come from the price table when the provider reports none", async () => {
  const out = await chat("cost-1", "Kosten bitte", "standard");
  // 1000 prompt tokens at 0.15 $ + 500 completion tokens at 0.60 $ per million (gpt-4o-mini*).
  const expected = (1000 * 0.15 + 500 * 0.6) / 1e6;
  assert.ok(Math.abs(out.completion.usage.cost_usd - expected) < 1e-12, `${out.completion.usage.cost_usd}`);
  // An edited price applies after saving.
  const view = await app.invoke("settings_get");
  const prices = view.settings.prices.map((p) => (p.model === "gpt-4o-mini*" ? { ...p, input_per_mtok: 1, output_per_mtok: 2 } : p));
  await app.invoke("settings_save", { settings: { ...view.settings, prices } });
  const again = await chat("cost-2", "Noch einmal", "standard");
  assert.ok(Math.abs(again.completion.usage.cost_usd - (1000 * 1 + 500 * 2) / 1e6) < 1e-12);
  // The assistant shows the cost next to the provider.
  await app.click(".sidebar .tree-row");
  await app.keys(["Control", "j"]);
  const ta = await app.waitFor(".composer textarea");
  await app.click(".assistant .model-pill");
  await app.browser.waitUntil(async () => {
    for (const el of await app.$$(".menu .menu-item")) if (/^Standard · gpt-4o-mini · OpenAI$/.test(await app.textOf(el))) return (await el.click(), true);
    return false;
  });
  await ta.setValue("Was kostet das?");
  await app.keys(["Enter"]);
  await app.waitFor(".msg-meta");
  const meta = await app.text(".msg-meta");
  assert.match(meta, /gpt-4o-mini · OpenAI/);
  assert.match(meta, /0,0020\s\$/);
  await app.shot("assistant-provider-cost");
});

test("a chat is answered by the next provider when the first is down", async () => {
  await ollama.stop();
  const before = openai.chats().length;
  const out = await chat("down-1", "Kurze Frage", "local");
  assert.deepEqual([out.route.provider, out.route.model], ["openai", "gpt-4o-mini"]);
  assert.ok(
    out.route.reasons.some((r) => /Ollama nicht erreichbar/.test(r)),
    out.route.reasons.join(" | "),
  );
  assert.match(out.completion.content, /Antwort von OpenAI/);
  assert.equal(openai.chats().length, before + 1);
});

test("private content never goes to the provider that is not local", async () => {
  // Ollama is still down: a #privat question is refused instead of going to OpenAI.
  const before = openai.chats().length;
  await assert.rejects(chat("private-1", "Fasse meine #privat Notizen zu Gehältern zusammen"), /lokal/);
  // A manual override does not change that.
  await assert.rejects(chat("private-2", "Analysiere #privat die Gehälter", "reasoning"), /lokal/);
  // Settings → Datenschutz „Nur lokal“: nothing leaves the local provider either.
  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", { settings: { ...view.settings, privacy: { ...view.settings.privacy, local_only: true } } });
  await assert.rejects(chat("private-3", "Ganz normale Frage"), /lokal/);
  assert.equal(openai.chats().length, before, "OpenAI received nothing");

  // Ollama back: private content is answered there.
  await ollama.start();
  const out = await chat("private-4", "Fasse meine #privat Notizen zu Gehältern zusammen");
  assert.deepEqual([out.route.provider, out.route.tier], ["ollama", "local"]);
  assert.match(out.completion.content, /Antwort von Ollama/);
  await app.invoke("settings_save", { settings: view.settings });

  // A page tagged #privat as context stays local too, and on every provider's recorded
  // requests the private texts only ever reached Ollama.
  const page = await app.invoke("page_create", { parentId: null, title: "Gehälter 2026", icon: null, content: "#privat\n\nGehaltsband Entwicklung: vertraulich." });
  const ctx = await app.invoke("ai_chat", {
    requestId: "private-5",
    messages: [{ role: "user", content: "Was steht auf der Seite?" }],
    useTools: false,
    tier: "standard",
    pageId: page.id,
    overrideLimit: null,
  });
  assert.equal(ctx.route.provider, "ollama");
  assert.equal(sentTo(openai, "#privat").length, 0);
  assert.equal(sentTo(openai, "Gehaltsband").length, 0);
  assert.ok(sentTo(ollama, "#privat").length >= 2);
});

test("embeddings of private pages stay with local providers", async () => {
  const view = await app.invoke("settings_get");
  // Embeddings on the cloud provider: private pages are left out of the index.
  await app.invoke("settings_save", { settings: { ...view.settings, embedding_provider: "openai", embedding_model: "gpt-4o" } });
  const before = openai.requests.filter((r) => r.url === "/v1/embeddings").length;
  const n = await app.invoke("ai_index_pending");
  assert.ok(n > 3, `indexed ${n}`);
  const sent = openai.requests
    .filter((r) => r.url === "/v1/embeddings")
    .slice(before)
    .flatMap((r) => r.body.input);
  assert.ok(sent.length >= n);
  assert.ok(!sent.some((t) => /Gehaltsband|#privat/i.test(t)), "no private page in the cloud index");
  // On the local provider the rest follows.
  await app.invoke("settings_save", { settings: { ...view.settings, embedding_provider: "ollama", embedding_model: "nomic-embed-text" } });
  const m = await app.invoke("ai_index_pending");
  assert.ok(m >= 1, `private chunks indexed locally: ${m}`);
  assert.ok(ollama.requests.some((r) => r.url === "/v1/embeddings" && r.body.input.some((t) => /Gehaltsband/.test(t))));
  await app.invoke("settings_save", { settings: view.settings });
});

test("no console errors", async () => {
  assert.deepEqual(await app.consoleErrors(), []);
});
