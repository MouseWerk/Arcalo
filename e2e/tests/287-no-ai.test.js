// „Ohne KI“ (1.15): Arcalo for people who do not want AI. A fresh install with a chat server and a
// local embedding model already configured (fake servers that count every request) chooses
// „Ohne KI“ in the setup. Then nothing about AI shows in the main views, the palette, the editor,
// the start page or the settings, and using the app (pages, search, tasks, calendar, reviews)
// sends no request to either server; the backend refuses AI commands. Switching „KI verwenden“
// back on brings the same providers back and the server is asked again. An organization's policy
// (`AllowAi = 0` in policy.json next to the executable) forces it off and locks the switch.

import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, guarded } from "../lib/harness.js";
import { startFakeOpenAI } from "../lib/fake-openai.js";
import { meaningVector } from "../lib/fake-embeddings.js";

const test = guarded(nodeTest, () => app);
let app, chat, ollama;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "annalo-e2e-noai-"));
const dataDir = path.join(root, "data");
const exeDir = path.join(root, "exe");
const env = { ANNALO_SEMANTIC_DELAY_SECS: "1" };
const provider = (id, name, kind, base_url, local) => ({ id, name, kind, base_url, local, enabled: true, bypass_proxy: local, api_version: "", models: [] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  chat = await startFakeOpenAI({ port: 4961, kind: "openai", name: "Firma", apiKey: "sk-noai-e2e", models: ["firma-chat"], embed: meaningVector });
  ollama = await startFakeOpenAI({ port: 4962, kind: "ollama", name: "Ollama", models: ["llama3.2", "nomic-embed-text"], embed: meaningVector });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(exeDir, { recursive: true });
  app = await launch({ demo: false, onboarding: true, dataDir, env, width: 1440, height: 900 });
});
after(async () => {
  await app?.close();
  await chat?.close();
  await ollama?.close();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const settings = async () => (await app.invoke("settings_get")).settings;
const aiRequests = () => chat.requests.length + ollama.requests.length;
const ribbonLabels = () => app.browser.execute(() => [...document.querySelectorAll(".ribbon [aria-label]")].map((b) => b.getAttribute("aria-label")));
/** Text of the window, without the visible intro or setup. */
const shown = () => app.browser.execute(() => document.body.innerText);
const AI_WORDS = /\bKI\b|Assistent|KI einrichten|Zusammenfassen|Chat|Suche nach Bedeutung/;

/** The palette's titles for a query (Escape closes it again). */
async function palette(q) {
  await app.keys(["Control", "k"]);
  await app.waitFor(".palette input");
  await app.type(q);
  await app.browser.pause(300);
  const out = await app.browser.execute(() => [...document.querySelectorAll(".palette .pal-title")].map((x) => x.firstChild?.textContent ?? x.textContent));
  await app.keys(["Escape"]);
  await app.browser.pause(150);
  return out;
}

test("the setup offers „Mit KI“ and „Ohne KI“; „Ohne KI“ keeps the providers", async () => {
  // Providers set up before (as an admin's default settings would): a company server and Ollama
  // with the embedding model and search by meaning on.
  const s = await settings();
  await app.invoke("settings_save", {
    settings: {
      ...s,
      providers: [provider("firma", "Firma", "openai", `${chat.url}/v1`, false), provider("ollama", "Ollama", "ollama", ollama.url, true)],
      router: { ...s.router, standard_provider: "firma", standard_model: "firma-chat", reasoning_provider: "firma", reasoning_model: "firma-chat", local_provider: "ollama", local_model: "llama3.2" },
      embedding_provider: "ollama",
      embedding_model: "nomic-embed-text",
      search: { semantic: true },
    },
  });
  await app.invoke("provider_key_set", { id: "firma", key: chat.apiKey });
  await app.waitFor(".fr-intro", 10000);
  await app.keys(["Escape"]);
  await app.waitFor(".fr-intake");
  await app.click('.fr-rail-item[data-step="ai"]');
  await app.waitFor(".fr-step-ai");
  // Two honest choices, each with one sentence.
  const choices = await app.browser.execute(() => [...document.querySelectorAll('.fr-step-ai [data-choice="with"], .fr-step-ai [data-choice="without"]')].map((c) => [c.dataset.choice, c.querySelector(".fr-choice-sub").textContent]));
  assert.deepEqual(choices.map((c) => c[0]), ["with", "without"]);
  assert.match(choices[1][1], /Kein Assistent/);
  await app.shot("287-setup-ai-choice");
  const before = (await settings()).providers;
  await app.click('[data-choice="without"]');
  await app.browser.waitUntil(async () => (await settings()).ai.enabled === false, { timeoutMsg: "AI not switched off" });
  assert.deepEqual((await settings()).providers, before, "providers untouched");
  // No model to choose any more.
  assert.equal(await app.browser.execute(() => !!document.querySelector('.fr-step-ai [data-choice="local"]')), false);
  await app.shot("287-setup-without-ai");
  await app.click('.fr-rail-item[data-step="workspace"]');
  await app.click('[data-choice="samples"]');
  await app.browser.waitUntil(async () => (await app.invoke("onboarding_needed")) === false, { timeoutMsg: "samples not created" });
  await app.click('.fr-rail-item[data-step="done"]');
  assert.equal(await app.text('[data-sum="ai"] dd'), "Ohne KI");
  await app.click(".fr-next");
  await app.browser.waitUntil(async () => !(await app.browser.execute(() => !!document.querySelector(".fr-overlay"))), { timeoutMsg: "setup open" });
});

test("nothing about AI shows: ribbon, panel, status bar, start page, palette", async () => {
  const labels = await ribbonLabels();
  assert.ok(labels.some((l) => /Einstellungen/.test(l)), labels.join(" | "));
  assert.ok(!labels.some((l) => /Assistent|Chat/.test(l)), labels.join(" | "));
  assert.equal(await app.browser.execute(() => !!document.querySelector(".statusbar .sb-ai")), false);
  // The side panel has no assistant tab; Ctrl+J and Ctrl+Shift+J do nothing.
  await app.keys(["Control", "Shift", "\\"]);
  await app.waitFor(".panel");
  const tabs = await app.browser.execute(() => [...document.querySelectorAll(".panel-tab")].map((b) => b.id));
  assert.ok(!tabs.includes("panel-tab-assistant"), tabs.join());
  assert.equal(await app.browser.execute(() => !!document.querySelector(".assistant")), false);
  await app.keys(["Control", "Shift", "\\"]);
  await app.keys(["Control", "j"]);
  await app.keys(["Control", "Shift", "j"]);
  await app.browser.pause(400);
  assert.equal(await app.browser.execute(() => !!document.querySelector(".assistant, .chat-view, .tab[data-kind='chat']")), false);
  // The start page: no AI widget, no „KI einrichten“.
  await app.click(".pane.active .tabbar-home");
  await app.waitFor(".pane.active .dash-grid");
  await app.browser.pause(500);
  assert.equal(await app.browser.execute(() => !!document.querySelector(".dw-suggest, .dw-bf-ai")), false);
  assert.doesNotMatch(await app.text(".pane.active .home"), /KI einrichten|Assistent/);
  await app.shot("287-start-page");
  // The palette: no assistant, chat or index commands, and „?“ asks nothing.
  // (Creating a page of that name is offered, as for any word.)
  for (const q of ["Assistent", "Chat", "Index", "Wochenbericht"]) assert.deepEqual(await palette(q).then((t) => t.filter((x) => /Assistent|Chat|Index|Wochenbericht per/.test(x) && !/anlegen/.test(x))), [], q);
  assert.deepEqual((await palette("?wie geht es")).filter((x) => !/anlegen/.test(x)), []);
  assert.doesNotMatch(await app.browser.execute(() => document.querySelector(".palette input")?.placeholder ?? ""), /fragen/);
});

test("the editor has no inline AI and the slash menu no AI commands", async () => {
  const page = await app.invoke("page_create", { parentId: null, title: "Notiz ohne KI", icon: null, content: "Ein Absatz über das Angebot für den Kunden.\n" });
  await app.invoke("search_open", { target: { kind: "page", page_id: page.id, new_tab: false } });
  await app.waitFor(".pane.active .ProseMirror");
  assert.equal(await app.browser.execute(() => !!document.querySelector(".pane.active .tb-ai")), false, "toolbar AI");
  // A selection: the bubble has no AI button; Ctrl+J opens no inline bar.
  await app.browser.execute(() => {
    const p = document.querySelector(".pane.active .ProseMirror p");
    const r = document.createRange();
    r.selectNodeContents(p);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  });
  await app.browser.pause(400);
  assert.equal(await app.browser.execute(() => !!document.querySelector(".bubble-ai")), false);
  await app.keys(["Control", "j"]);
  await app.browser.pause(300);
  assert.equal(await app.browser.execute(() => !!document.querySelector(".ai-bar")), false);
  // The slash menu: everything but the AI commands.
  await app.caretToEnd();
  await app.keys(["Enter"]);
  await app.type("/");
  await app.waitFor(".sugg-item");
  const items = await app.browser.execute(() => [...document.querySelectorAll(".sugg-item")].map((x) => x.innerText).join(" | "));
  assert.match(items, /Überschrift|Tabelle/);
  assert.doesNotMatch(items, /\bKI\b|zusammenfassen/i);
  await app.keys(["Escape"]);
  await app.shot("287-editor");
});

test("Settings: „KI verwenden“ alone in KI & Modelle; search, privacy and voice without AI parts", async () => {
  await app.keys(["Control", ","]);
  await app.waitFor(".settings-head h1");
  // Without AI the settings open on Darstellung.
  assert.doesNotMatch(await app.text(".settings-head h1"), /KI/);
  await app.click('.settings-nav-item[data-section="ai"]');
  await app.waitText(".settings-head h1", /KI/);
  const body = await app.text(".settings-main");
  assert.match(body, /KI verwenden/);
  assert.doesNotMatch(body, /Anbieter hinzufügen|Embedding-Modell|Werkzeuge/);
  assert.equal(await app.browser.execute(() => document.querySelector('.settings-main [aria-label="KI verwenden"]').getAttribute("aria-checked")), "false");
  await app.shot("287-settings-ai-off");
  await app.click('.settings-nav-item[data-section="search"]');
  await app.waitText(".settings-head h1", /Suche/);
  assert.match(await app.text(".settings-main"), /braucht KI/);
  await app.click('.settings-nav-item[data-section="privacy"]');
  await app.waitText(".settings-head h1", /Datenschutz/);
  assert.doesNotMatch(await app.text(".settings-main"), /Assistent|Chatverlauf/);
});

test("using the app sends nothing to the AI or embedding servers; AI commands are refused", async () => {
  // Pages, search (semantic is on in the settings, the switch is off), tasks, calendar, reviews.
  await app.invoke("page_create", { parentId: null, title: "Kostenvoranschlag", icon: null, content: "Kostenvoranschlag für Kunde Müller.\n- [ ] nachfassen\n" });
  await palette("Angebot Müller");
  await app.keys(["Control", "Shift", "a"]);
  await app.waitFor(".pane.active .task-list, .pane.active .empty");
  await app.keys(["Control", "Shift", "e"]);
  await app.browser.pause(800);
  await app.invoke("day_review", { date: null });
  await app.invoke("briefing", { hidden: [] });
  assert.equal((await app.invoke("semantic_status")).inactive, "ai_off");
  await sleep(3500); // the background indexer's ticks pass by
  // The backend refuses every AI command with a clear error.
  const refused = async (cmd, args) => {
    const e = await app.invoke(cmd, args).then(() => null, (err) => String(err));
    assert.match(e ?? "", /KI ist ausgeschaltet|AI is switched off/, `${cmd}: ${e}`);
  };
  await refused("ai_chat", { requestId: "noai-1", messages: [{ role: "user", content: "Hallo" }], useTools: false, tier: null, pageId: null });
  await refused("ai_transform", { requestId: "noai-2", instruction: "Kürzen", text: "Ein langer Text.", pageId: null });
  await refused("ollama_detect", { baseUrl: ollama.url });
  await refused("ai_index_pending", {});
  await refused("ai_provider_test", { provider: provider("firma", "Firma", "openai", `${chat.url}/v1`, false), key: chat.apiKey, model: null });
  const r = await app.invoke("search_semantic", { query: "Angebot Müller", limit: 10 });
  assert.ok(r, "the search still answers (exact words only)");
  assert.equal(aiRequests(), 0, `requests reached the AI servers: ${JSON.stringify([...chat.requests, ...ollama.requests].map((x) => x.url))}`);
  assert.deepEqual(await app.consoleErrors(), []);
});

test("switching „KI verwenden“ back on restores the providers unchanged and asks the server again", async () => {
  const before = await settings();
  await app.invoke("settings_save", { settings: { ...before, ai: { ...before.ai, enabled: true } } });
  const after = await settings();
  assert.deepEqual(after.providers, before.providers);
  assert.deepEqual(after.router, before.router);
  assert.equal(after.embedding_model, "nomic-embed-text");
  await app.browser.waitUntil(async () => (await ribbonLabels()).some((l) => /Assistent/.test(l)), { timeoutMsg: "assistant not back in the ribbon" });
  assert.ok((await ribbonLabels()).some((l) => /Chat/.test(l)));
  const count = aiRequests();
  const out = await app.invoke("ai_chat", { requestId: "ai-back", messages: [{ role: "user", content: "Hallo" }], useTools: false, tier: null, pageId: null, notes: false });
  assert.ok(out.completion, "an answer");
  assert.ok(aiRequests() > count, "the servers are asked again");
  await app.shot("287-ai-back-on");
});

test("a policy (AllowAi = 0) forces AI off and locks the switch", async () => {
  await app.close();
  fs.writeFileSync(path.join(exeDir, "policy.json"), JSON.stringify({ AllowAi: 0 }));
  const count = aiRequests();
  app = await launch({ dataDir, env: { ...env, ANNALO_EXE_DIR: exeDir }, width: 1440, height: 900 });
  const view = await app.invoke("settings_get");
  assert.equal(view.ai_policy_off, true);
  assert.equal(view.settings.ai.enabled, true, "the user's own choice is kept");
  assert.ok(!(await ribbonLabels()).some((l) => /Assistent|Chat/.test(l)));
  const e = await app.invoke("ai_chat", { requestId: "policy", messages: [{ role: "user", content: "Hallo" }], useTools: false, tier: null, pageId: null }).then(() => null, (err) => String(err));
  assert.match(e ?? "", /Organisation|organization/);
  await app.keys(["Control", ","]);
  await app.waitFor(".settings-head h1");
  await app.click('.settings-nav-item[data-section="ai"]');
  await app.waitText(".settings-head h1", /KI/);
  assert.equal(await app.browser.execute(() => document.querySelector('.settings-main [aria-label="KI verwenden"]').disabled), true);
  assert.match(await app.text(".settings-main"), /Von deiner Organisation ausgeschaltet/);
  await app.shot("287-policy");
  // The setup offers „Mit KI“ disabled.
  await app.keys(["Control", "k"]);
  await app.waitFor(".palette input");
  await app.type("Einführung erneut");
  await app.browser.pause(200);
  await app.keys(["Enter"]);
  await app.waitFor(".fr-intro");
  await app.click(".fr-setup");
  await app.click('.fr-rail-item[data-step="ai"]');
  await app.waitFor(".fr-step-ai");
  assert.equal(await app.browser.execute(() => document.querySelector('[data-choice="with"]').disabled), true);
  assert.equal(await app.browser.execute(() => document.querySelector('[data-choice="without"]').getAttribute("aria-checked")), "true");
  await app.click(".fr-close");
  await sleep(2500);
  assert.equal(aiRequests(), count, "a request went out under the policy");
  assert.deepEqual(await app.consoleErrors(), []);
});
