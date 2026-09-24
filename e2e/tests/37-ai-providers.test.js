// AI providers in the settings: an Ollama on this machine is detected and added, its
// connection test checks every step, a model is downloaded, an OpenAI-compatible provider
// with a key is added, the tiers are split across both, and the price table is shown.

import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";
import { startFakeOpenAI } from "../lib/fake-openai.js";

const test = guarded(nodeTest, () => app);
let app, ollama, openai;
before(async () => {
  // Ollama's default port, so the settings page finds it on its own.
  ollama = await startFakeOpenAI({ port: 11434, kind: "ollama", name: "Ollama", models: ["llama3.2:latest", "nomic-embed-text"] });
  openai = await startFakeOpenAI({ port: 4987, kind: "openai", name: "OpenAI", apiKey: "sk-openai-e2e", models: ["gpt-4o", "gpt-4o-mini", "o3", "text-embedding-3-small"] });
  app = await launch();
});
after(async () => {
  await app?.close();
  await ollama?.close();
  await openai?.close();
});

const clickText = async (sel, re) => {
  await app.browser.waitUntil(
    async () => {
      for (const el of await app.$$(sel)) if (re.test(await app.textOf(el))) return (await el.click(), true);
      return false;
    },
    { timeout: 8000, timeoutMsg: `no ${sel} matching ${re}` },
  );
};

test("a running Ollama is detected and added; the connection test checks every step", async () => {
  await app.keys(["Control", ","]);
  await app.waitText(".settings-head h1", /KI & Modelle/);
  await app.waitText(".provider-found", /Ollama läuft auf diesem Rechner/, 10000);
  assert.match(await app.text(".provider-found"), /2 Modelle/);
  await app.shot("providers-detected");

  await app.click(".provider-found .btn-primary");
  const url = await app.waitFor('.dialog input[aria-label="Server-URL"]');
  assert.equal(await url.getValue(), "http://localhost:11434");
  // No key field for Ollama; local and without proxy by default.
  assert.equal((await app.$$('.dialog input[aria-label="API-Token"]')).length, 0);
  assert.equal(await app.browser.execute(() => document.querySelector('.dialog [aria-label="Lokaler Anbieter"]').getAttribute("aria-checked")), "true");
  assert.equal(await app.browser.execute(() => document.querySelector('.dialog [aria-label="Proxy umgehen"]').getAttribute("aria-checked")), "true");

  await app.click(".dialog .provider-test-btn");
  await app.waitFor('.provider-test li[data-step="embed"].ok', 15000);
  for (const step of ["reach", "auth", "chat", "tools", "embed"]) {
    assert.ok(await (await app.$(`.provider-test li[data-step="${step}"].ok`)).isExisting(), `${step} ok`);
  }
  assert.match(await app.text('.provider-test li[data-step="reach"]'), /Ollama 0\.9\.0/);
  assert.match(await app.text('.provider-test li[data-step="embed"]'), /nomic-embed-text: 8 Dimensionen/);
  // Ollama was asked natively and without a key.
  assert.ok(ollama.requests.some((r) => r.url === "/api/tags"));
  assert.ok(ollama.requests.every((r) => !r.headers.authorization));
  await app.shot("provider-dialog-test");

  // Download a missing model with progress.
  const pull = await app.$('.dialog input[aria-label="Modell laden"]');
  await pull.setValue("qwen2.5:7b");
  await clickText(".dialog .ollama-pull button", /Laden/);
  await app.waitText(".toast-title", /„qwen2.5:7b“ geladen/, 10000);
  assert.ok(ollama.requests.some((r) => r.url === "/api/pull" && r.body.model === "qwen2.5:7b"));

  await clickText(".dialog-foot button", /^Hinzufügen$/);
  await app.waitText('[data-provider="ollama"] .conn', /Verbunden · 3 Modelle/, 10000);
  assert.equal((await app.$$(".provider-found")).length, 0, "the offer disappears once Ollama is configured");
});

test("an OpenAI-compatible provider is added with its key in the credential store", async () => {
  await app.click('.provider-actions button[aria-haspopup="menu"]');
  await clickText(".menu .menu-item", /^OpenAI$/);
  const url = await app.waitFor('.dialog input[aria-label="Server-URL"]');
  assert.equal(await url.getValue(), "https://api.openai.com/v1");
  await url.setValue(`${openai.url}/v1`);
  // Without the key the server refuses: the test says so.
  await app.click(".dialog .provider-test-btn");
  await app.waitFor('.provider-test li[data-step="auth"].fail');
  assert.match(await app.text('.provider-test li[data-step="auth"]'), /Kein API-Schlüssel/);
  const key = await app.$('.dialog input[aria-label="API-Token"]');
  await key.setValue(openai.apiKey);
  await app.click(".dialog .provider-test-btn");
  await app.waitFor('.provider-test li[data-step="chat"].ok', 10000);
  await clickText(".dialog-foot button", /^Hinzufügen$/);
  await app.waitText(".toast-title", /API-Token gespeichert/);
  await app.waitText('[data-provider="openai"] .conn', /Verbunden · 4 Modelle/, 10000);
  assert.ok(openai.requests.some((r) => r.headers.authorization === `Bearer ${openai.apiKey}`));
});

test("tiers are assigned across both providers and saved", async () => {
  await app.select('select[aria-label="Anbieter für Lokales Modell"]', "ollama");
  await app.select('select[aria-label="Lokales Modell"]', "llama3.2:latest");
  await app.select('select[aria-label="Anbieter für Standardmodell"]', "openai");
  await app.select('select[aria-label="Standardmodell"]', "gpt-4o-mini");
  await app.select('select[aria-label="Anbieter für Reasoning-Modell"]', "openai");
  await app.select('select[aria-label="Reasoning-Modell"]', "o3");
  await app.select('select[aria-label="Anbieter für Embedding-Modell"]', "ollama");
  await app.select('select[aria-label="Embedding-Modell"]', "nomic-embed-text");
  // The price of the standard model comes from the built-in table.
  await app.waitText(".model-picker-price", /0,15\s\$ \/ 0,60\s\$ je 1 Mio\. Tokens/);
  await app.waitText(".model-picker-price", /Kostenlos \(lokal\)/);
  await app.click(".savebar .btn-primary");
  await app.waitText(".toast-title", /Einstellungen gespeichert/);

  const view = await app.invoke("settings_get");
  const s = view.settings;
  assert.deepEqual(
    s.providers.map((p) => [p.id, p.kind, p.local, p.bypass_proxy]),
    // The fake OpenAI runs on this machine: an address on localhost is reached without proxy.
    [
      ["litellm", "litellm", false, false],
      ["ollama", "ollama", true, true],
      ["openai", "openai", false, true],
    ],
  );
  assert.equal(s.providers[2].base_url, `${openai.url}/v1`);
  assert.deepEqual([s.router.local_provider, s.router.local_model], ["ollama", "llama3.2:latest"]);
  assert.deepEqual([s.router.standard_provider, s.router.standard_model], ["openai", "gpt-4o-mini"]);
  assert.deepEqual([s.router.reasoning_provider, s.router.reasoning_model], ["openai", "o3"]);
  assert.deepEqual([s.embedding_provider, s.embedding_model], ["ollama", "nomic-embed-text"]);
  assert.deepEqual(view.provider_keys, ["openai"]);
  // Keys never appear in the settings (nor in the export).
  assert.ok(!JSON.stringify(view).includes(openai.apiKey));
  await app.browser.execute(() => document.querySelector(".settings-head").scrollIntoView({ block: "start" }));
  await app.dismissToasts();
  await app.shot("settings-providers");
  await app.browser.execute(() => (document.documentElement.dataset.theme = "dark"));
  await app.shot("settings-providers-dark");
  await app.browser.execute(() => document.querySelector('[data-provider="ollama"] button[aria-label="Ollama bearbeiten"]').click());
  await app.waitFor(".dialog");
  await app.shot("provider-dialog-dark");
  await app.click('.dialog button[aria-label="Schließen"]');
  await app.browser.execute(() => (document.documentElement.dataset.theme = "light"));
});

test("the price table is editable and saved", async () => {
  const rows = await app.$$(".price-table .price-row:not(.price-head)");
  assert.ok(rows.length >= 10, `${rows.length} price rows`);
  await app.browser.execute(() => document.querySelector(".price-table").scrollIntoView({ block: "center" }));
  await clickText(".provider-actions button", /Preis hinzufügen/);
  const n = (await app.$$(".price-table .price-row:not(.price-head)")).length;
  const model = await app.$(`input[aria-label="Modell (Zeile ${n})"]`);
  await model.setValue("mein-modell*");
  const input = await app.$(`input[aria-label="Eingabepreis (Zeile ${n})"]`);
  await input.setValue("1.5");
  await app.keys(["Tab"]);
  await app.select(`select[aria-label="Anbieter (Zeile ${n})"]`, "openai");
  await app.shot("settings-prices");
  await app.click(".savebar .btn-primary");
  await app.waitText(".toast-title", /Einstellungen gespeichert/);
  const { settings } = await app.invoke("settings_get");
  assert.deepEqual(settings.prices.at(-1), { provider: "openai", model: "mein-modell*", input_per_mtok: 1.5, output_per_mtok: 0 });
});

test("the assistant's model menu names the providers", async () => {
  await app.keys(["Control", "j"]);
  await app.waitFor(".composer textarea");
  await app.click(".assistant .model-pill");
  await app.waitText(".menu", /llama3\.2:latest · Ollama/);
  const menu = await app.text(".menu");
  assert.match(menu, /gpt-4o-mini · OpenAI/);
  assert.match(menu, /o3 · OpenAI/);
  await app.shot("assistant-providers-menu");
  await app.keys(["Escape"]);
});

test("no console errors", async () => {
  assert.deepEqual(await app.consoleErrors(), []);
});
