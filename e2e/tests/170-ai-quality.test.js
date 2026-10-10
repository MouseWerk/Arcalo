// 1.12 AI quality: without a connected AI every AI surface says how to set one up (inline AI bar,
// meeting summary, assistant, tag suggestions) instead of failing; failed requests explain the
// cause and lead to the settings; Stop ends a request at once even while the server is still
// listing its models (nothing is sent afterwards).

import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";
import { startFakeOpenAI } from "../lib/fake-openai.js";

const test = guarded(nodeTest, () => app);
let app, fake;
before(async () => {
  fake = await startFakeOpenAI({ port: 41701, kind: "openai", name: "Firma", apiKey: "sk-e2e-170", models: ["gpt-4o", "gpt-4o-mini"] });
  app = await launch();
});
after(async () => {
  await app?.close();
  await fake?.close();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pageId = async (title) => (await app.invoke("page_resolve", { title, create: false })).id;
const openFromTree = async (title) => {
  for (const r of await app.$$(".sidebar .tree-row")) if ((await app.textOf(r)) === title) return r.click();
  throw new Error(`tree row ${title} not found`);
};
const focused = () => app.browser.execute(() => document.activeElement?.textContent?.trim() || document.activeElement?.getAttribute("aria-label"));
const exists = (sel) => app.browser.execute((s) => !!document.querySelector(s), sel);
/** Selects the first longer paragraph of the open note, as a mouse drag would. */
const selectParagraph = () =>
  app.browser.execute(() => {
    const root = document.querySelector(".pane.active > .pane-content:not([hidden]) .ProseMirror");
    const p = [...root.querySelectorAll("p")].find((x) => x.textContent.length > 30);
    root.focus();
    const range = document.createRange();
    range.selectNodeContents(p);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
  });
const openInlineBar = async () => {
  await openFromTree("Architektur");
  await app.waitFor(".pane.active > .pane-content:not([hidden]) .ProseMirror p");
  await selectParagraph();
  await sleep(250);
  await app.keys(["Control", "j"]);
  await app.waitFor(".ai-bar");
};
const openAssistant = async () => {
  if (!(await exists(".assistant textarea"))) await app.browser.execute(() => document.querySelector(".statusbar .sb-item:last-child").click());
  await app.waitFor(".assistant textarea");
};
/** A provider of the fake server under `id` (a new id has no cached model list). */
const useProvider = async (id, key) => {
  const v = await app.invoke("settings_get");
  const p = { ...v.settings.providers[0], id, name: "Firma", kind: "openai", base_url: `${fake.url}/v1`, enabled: true, local: false };
  const router = { ...v.settings.router, local_provider: id, standard_provider: id, reasoning_provider: id, local_model: "gpt-4o-mini", standard_model: "gpt-4o", reasoning_model: "gpt-4o" };
  await app.invoke("settings_save", { settings: { ...v.settings, providers: [p], router } });
  await app.invoke("provider_key_set", { id, key });
  await sleep(300);
};

test("without an AI the inline bar shows the way to the settings instead of actions that fail", async () => {
  await openInlineBar();
  await app.waitText(".ai-bar .ai-setup-note", /Keine KI verbunden/);
  assert.equal(await exists(".ai-bar .ai-chip"), false, "no presets that can only fail");
  assert.equal(await app.browser.execute(() => document.querySelector(".ai-bar input").disabled), true);
  // The keyboard lands on „KI einrichten“; Esc still closes the bar.
  await app.browser.waitUntil(async () => (await focused()) === "KI einrichten", { timeoutMsg: "setup button focused" });
  await app.shot("170-inline-no-ai");
  await app.keys(["Escape"]);
  await app.browser.waitUntil(async () => !(await exists(".ai-bar")), { timeoutMsg: "bar closed" });
  // A provider without its key is no AI either: no „Tags mit KI vorschlagen“.
  assert.equal(await exists(".tag-suggest-ai"), false, "no AI tag button without a usable provider");
  assert.equal(fake.chats().length, 0);

  await openInlineBar();
  await app.click(".ai-bar .ai-setup-note button");
  await app.waitText(".settings-head h1", /KI & Modelle/);
});

test("without an AI the meeting summary and the assistant say how to set one up", async () => {
  await openFromTree("Architektur");
  await app.waitFor(".pane.active > .pane-content:not([hidden]) .ProseMirror p");
  const id = await pageId("Architektur");
  // As „/Zusammenfassung“ does: from the shown editor of the page (a kept page elsewhere stays out).
  await app.browser.execute(
    (id) =>
      document
        .querySelector(".pane.active > .pane-content:not([hidden]) .ProseMirror")
        .dispatchEvent(new CustomEvent("arcalo:meeting-summary", { bubbles: true, detail: { id } })),
    id,
  );
  await app.waitText(".dialog .ai-setup-note", /Besprechung braucht Arcalo einen KI-Anbieter/);
  assert.equal(await exists(".dialog .thinking"), false, "no request is started");
  await app.shot("170-summary-no-ai");
  await app.keys(["Escape"]);

  await openAssistant();
  await app.waitText(".assistant-empty .ai-setup-note", /Keine KI verbunden/);
  await app.click(".assistant textarea");
  await app.type("Was steht an?");
  await app.keys(["Enter"]);
  await app.waitText(".assistant .msg-error-head", /Keine KI verbunden/);
  assert.match(await app.text(".assistant .msg-error-hint"), /KI & Modelle/);
  await app.shot("170-assistant-no-ai");
  // „Verbindung prüfen“ opens the AI section, also when the settings are open elsewhere.
  await app.keys(["Control", ","]);
  await app.browser.execute(() => document.querySelector('.settings-nav-item[data-section="voice"]').click());
  await app.waitText(".settings-head h1", /Sprachnotizen/);
  await app.browser.execute(() => [...document.querySelectorAll(".assistant .msg-error-actions button")].find((b) => /Verbindung prüfen/.test(b.textContent)).click());
  await app.waitText(".settings-head h1", /KI & Modelle/);
  assert.equal(fake.chats().length, 0);
});

test("a rejected key: the inline bar explains it, the provider row says so", async () => {
  await useProvider("firma-falsch", "sk-wrong");
  await openInlineBar();
  await app.browser.execute(() => document.querySelector(".ai-bar .ai-chip").click());
  await app.waitText(".ai-bar .msg-error-head", /Zugang abgelehnt/, 10000);
  assert.match(await app.text(".ai-bar .msg-error-hint"), /API-Token/);
  assert.ok(await exists(".ai-bar .msg-error-actions button"), "a way to the settings");
  await app.shot("170-inline-denied");
  await app.keys(["Escape"]);
  await app.keys(["Control", ","]);
  await app.browser.execute(() => document.querySelector('.settings-nav-item[data-section="ai"]').click());
  await app.waitText('.provider-row[data-provider="firma-falsch"] .conn', /Zugang abgelehnt/, 10000);
});

test("Stop ends a chat at once while the server still lists its models; nothing is sent", async () => {
  fake.set({ modelsDelay: 6000 });
  await useProvider("firma-langsam", "sk-e2e-170");
  const before = fake.chats().length;
  await openAssistant();
  await app.browser.execute(() => document.querySelector(".assistant-head button[aria-label='Neuer Chat']")?.click());
  await app.click(".assistant textarea");
  await app.type("Fasse die Woche zusammen");
  await app.keys(["Enter"]);
  await app.waitFor(".assistant .send-btn.stop");
  await sleep(800);
  await app.click(".assistant .send-btn.stop");
  const stopped = Date.now();
  await app.browser.waitUntil(async () => !(await exists(".assistant .send-btn.stop")), { timeout: 3000, timeoutMsg: "Stop did not end the request" });
  assert.ok(Date.now() - stopped < 3000);
  // The model list arrives later; the chat is not sent anyway.
  await sleep(6500);
  assert.equal(fake.chats().length, before, "no chat request after Stop");

  // The next question works normally (the model list is cached now).
  fake.set({ modelsDelay: 0 });
  await app.click(".assistant textarea");
  await app.type("Und jetzt?");
  await app.keys(["Enter"]);
  await app.waitText(".assistant .msg-ai", /Antwort von Firma/, 15000);
});
