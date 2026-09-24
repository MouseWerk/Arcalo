import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";
import { startFakeLiteLLM } from "../lib/fake-litellm.js";

const test = guarded(nodeTest, () => app);
let app, llm;
before(async () => {
  llm = await startFakeLiteLLM({ port: 4999 });
  app = await launch();
});
after(async () => {
  await app?.close();
  await llm?.close();
});

// The LiteLLM server is the provider „LiteLLM“ (Settings → KI & Modelle → KI-Anbieter); its
// address and token are edited in the provider dialog.
const editLiteLLM = async () => {
  await app.click('[data-provider="litellm"] button[aria-label="LiteLLM bearbeiten"]');
  await app.waitFor(".dialog");
};

test("settings: server URL, token and connection test", async () => {
  await app.keys(["Control", ","]);
  await app.waitText(".settings-head h1", /KI & Modelle/);
  await editLiteLLM();
  const url = await app.$('.dialog input[aria-label="Server-URL"]');
  await url.setValue(llm.url);
  await app.click(".dialog .btn-primary");
  await app.waitFor(".savebar");
  await app.click(".savebar .btn-primary");
  await app.waitText(".toast-title", /Einstellungen gespeichert/);

  // Without a token the server refuses.
  await app.click('button[aria-label="Verbindungen prüfen"]');
  await app.waitText('[data-provider="litellm"] .conn', /Keine Verbindung/);

  await editLiteLLM();
  const key = await app.$('.dialog input[aria-label="API-Token"]');
  await key.setValue(llm.apiKey);
  await app.click(".dialog .btn-primary");
  await app.waitText(".toast-title", /API-Token gespeichert/);
  await app.waitText('[data-provider="litellm"] .conn', /Verbunden · 4 Modelle/);
  await app.shot("settings-ai");
  const view = await app.invoke("settings_get");
  assert.equal(view.api_key_set, true);
  assert.equal(view.settings.litellm_base_url, llm.url);
  // The key is never part of the settings payload.
  assert.ok(!JSON.stringify(view).includes(llm.apiKey));
});

test("settings: models are picked from the server list", async () => {
  const selects = await app.$$(".set-row select");
  assert.ok(selects.length >= 3, "model selects appear once connected");
  await app.select('select[aria-label="Lokales Modell"]', "firma-schnell");
  await app.select('select[aria-label="Standardmodell"]', "firma-standard");
  await app.select('select[aria-label="Reasoning-Modell"]', "firma-reasoning");
  await app.select('select[aria-label="Embedding-Modell"]', "firma-embed");
  await app.shot("settings-models");
  await app.click(".savebar .btn-primary");
  await app.waitText(".toast-title", /Einstellungen gespeichert/);
  const view = await app.invoke("settings_get");
  assert.equal(view.settings.router.standard_model, "firma-standard");
  assert.equal(view.settings.embedding_model, "firma-embed");
});

test("semantic index is built through the embedding model", async () => {
  const n = await app.invoke("ai_index_pending");
  assert.ok(n > 5, `indexed ${n} chunks`);
  assert.ok(llm.requests.some((r) => r.url === "/v1/embeddings" && r.body.model === "firma-embed"));
});

test("assistant streams an answer with markdown, links and metrics", async () => {
  await app.click(".sidebar .tree-row");
  await app.keys(["Control", "j"]);
  const ta = await app.waitFor(".composer textarea");
  await ta.setValue("Fasse die Seite zusammen");
  await app.keys(["Enter"]);
  await app.waitFor(".msg-ai .prose h2");
  await app.waitFor(".msg-meta");
  const html = await (await app.$(".msg-ai .prose")).getHTML();
  assert.match(html, /<h2>\s*Zusammenfassung\s*<\/h2>/);
  assert.match(html, /data-wikilink/);
  assert.match(html, /<pre>\s*<code/);
  const meta = await app.text(".msg-meta");
  assert.match(meta, /firma-(schnell|standard|reasoning)/);
  assert.match(meta, /Tokens/);
  assert.match(meta, /0,0012\s\$/);
  const req = llm.requests.filter((r) => r.url === "/v1/chat/completions").pop();
  assert.equal(req.headers.authorization, `Bearer ${llm.apiKey}`);
  assert.equal(req.body.stream, true);
  assert.ok(req.body.messages.some((m) => m.role === "system" && /Aktuell geöffnete Seite/.test(m.content)), "active page is sent");
  await app.shot("assistant-answer");
});

test("links in answers open pages", async () => {
  const link = await app.$('.msg-ai a[data-target="Architektur"]');
  await link.click();
  await app.browser.waitUntil(async () => (await (await app.$(".page-title")).getValue()) === "Architektur");
});

test("assistant books time through a tool call", async () => {
  const before = (await app.invoke("time_entries", { from: null, to: null })).length;
  const ta = await app.$(".composer textarea");
  await ta.setValue("Buche 1,5 h auf NP-8801/1040");
  await app.keys(["Enter"]);
  await app.waitText(".tool-step", /Zeit buchen/);
  await app.waitText(".msg-ai .prose", /Erledigt/);
  const after = await app.invoke("time_entries", { from: null, to: null });
  assert.equal(after.length, before + 1);
  assert.ok(after.some((e) => e.description === "Gebucht vom Assistenten" && e.duration_minutes === 90));
  await app.shot("assistant-tool");
});

test("system tools need approval; rejecting does not run them", async () => {
  // System tools are off by default (Settings → KI → Werkzeuge): allow git first.
  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", { settings: { ...view.settings, ai: { ...view.settings.ai, allowed_tools: [...view.settings.ai.allowed_tools, "git"] } } });
  const ta = await app.$(".composer textarea");
  await ta.setValue("Zeig mir git status");
  await app.keys(["Enter"]);
  await app.waitFor(".tool-approval");
  assert.match(await app.text(".tool-approval-cmd"), /git status --short/);
  await app.shot("assistant-approval");
  await app.click(".tool-approval .btn-ghost");
  await app.waitText(".tool-step", /abgelehnt/);
  const last = llm.requests.filter((r) => r.url === "/v1/chat/completions").pop();
  assert.ok(last.body.messages.some((m) => m.role === "tool" && /abgelehnt/.test(m.content)));
});

test("a running answer can be stopped", async () => {
  const ta = await app.$(".composer textarea");
  await ta.setValue("Antworte bitte langsam");
  await app.keys(["Enter"]);
  await app.waitFor(".send-btn.stop");
  await app.browser.pause(600);
  await app.click(".send-btn.stop");
  await app.waitText(".msg-ai .small", /Abgebrochen/);
  await app.waitFor(".send-btn:not(.stop)");
});

test("status bar shows session tokens and cost", async () => {
  const sb = await app.text(".statusbar");
  assert.match(sb, /Tokens/);
  assert.match(sb, /\$/);
});

test("removing the token disables access", async () => {
  await app.keys(["Control", ","]);
  await editLiteLLM();
  await app.click('.dialog button[aria-label="Token entfernen"]');
  await app.waitText(".toast-title", /API-Token entfernt/);
  await app.click('.dialog button[aria-label="Schließen"]');
  await app.waitText('[data-provider="litellm"] .conn', /Keine Verbindung/);
});

test("no console errors", async () => {
  assert.deepEqual(await app.consoleErrors(), []);
});

// "Verbunden", but "No deployments available for selected model": a tier still names a model the
// server does not have (the defaults are placeholders), or its deployments are cooling down.
test("a model the server does not offer falls back to one it has", async () => {
  await app.invoke("api_key_set", { key: llm.apiKey });
  const view = await app.invoke("settings_get");
  const settings = { ...view.settings, auto_route: true, router: { ...view.settings.router, local_model: "ollama/llama3.2" } };
  await app.invoke("settings_save", { settings });
  const before = llm.requests.length;
  const out = await app.invoke("ai_chat", { requestId: "fallback-1", messages: [{ role: "user", content: "Hallo" }], useTools: false, tier: "local", pageId: null, overrideLimit: null });
  assert.notEqual(out.route.model, "ollama/llama3.2");
  assert.ok(out.route.reasons.some((r) => r.includes("ollama/llama3.2")), out.route.reasons.join(" | "));
  assert.ok(out.completion.content.length > 0);
  const sent = llm.requests.slice(before).filter((r) => r.url === "/v1/chat/completions").map((r) => r.body.model);
  assert.ok(!sent.includes("ollama/llama3.2"), `never sent the missing model: ${sent}`);

  // Listed but cooling down: one retry on another model.
  llm.cooldown.add("firma-standard");
  const out2 = await app.invoke("ai_chat", { requestId: "fallback-2", messages: [{ role: "user", content: "Hallo" }], useTools: false, tier: "standard", pageId: null, overrideLimit: null });
  assert.notEqual(out2.route.model, "firma-standard");
  assert.ok(out2.route.reasons.some((r) => r.includes("ohne erreichbare Instanz")), out2.route.reasons.join(" | "));

  // Private content stays local: a clear message instead of a cloud model.
  const priv = { ...settings, privacy: { ...settings.privacy, local_only: true } };
  await app.invoke("settings_save", { settings: priv });
  await assert.rejects(
    app.invoke("ai_chat", { requestId: "fallback-3", messages: [{ role: "user", content: "Hallo" }], useTools: false, tier: null, pageId: null, overrideLimit: null }),
    /lokale Modell „ollama\/llama3.2“ gibt es auf dem LiteLLM-Server nicht/,
  );
  llm.cooldown.clear();
  await app.invoke("settings_save", { settings: view.settings });
});

// The chat sends tools, the rewrite requests do not: a model that rejects tools (LiteLLM without
// drop_params) or whose backend is down made only the chat fail.
test("the chat works with a model that rejects tools, and past a model whose backend is down", async () => {
  await app.invoke("api_key_set", { key: llm.apiKey });
  const view = await app.invoke("settings_get");
  const settings = { ...view.settings, litellm_base_url: llm.url, router: { ...view.settings.router, local_model: "firma-schnell", standard_model: "firma-standard", reasoning_model: "firma-reasoning" } };
  await app.invoke("settings_save", { settings });
  const chat = (id, tier) => app.invoke("ai_chat", { requestId: id, messages: [{ role: "user", content: "Was steht heute an?" }], useTools: true, tier, pageId: null, overrideLimit: null });

  llm.noTools.add("firma-standard");
  const out = await chat("notools-1", "standard");
  assert.equal(out.route.model, "firma-standard", "same model, without tools");
  assert.ok(out.completion.content.length > 0);
  assert.ok(out.route.reasons.some((r) => r.includes("keine Werkzeuge")), out.route.reasons.join(" | "));
  llm.noTools.clear();

  llm.broken.add("firma-schnell");
  const out2 = await chat("broken-1", "local");
  assert.notEqual(out2.route.model, "firma-schnell");
  assert.ok(out2.completion.content.length > 0);
  llm.broken.clear();

  // A real error (wrong key) is shown as it is, not retried on every model.
  await app.invoke("api_key_set", { key: "sk-wrong" });
  const before = llm.requests.length;
  await assert.rejects(chat("wrongkey-1", "standard"), /Authentication Error/);
  assert.equal(llm.requests.slice(before).filter((r) => r.url === "/v1/chat/completions").length, 1, "tried once");
  await app.invoke("api_key_set", { key: llm.apiKey });
  await app.invoke("settings_save", { settings: view.settings });
});
