// 1.6 chat history: every finished turn is saved; after a restart the history lists the chat,
// it opens with its messages and is continued with the model getting the whole conversation.
// The list searches titles and messages, renames (F2), pins, duplicates, saves as a page and
// deletes with undo.

import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, guarded } from "../lib/harness.js";
import { startFakeLiteLLM } from "../lib/fake-litellm.js";

const test = guarded(nodeTest, () => app);
let app, llm;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "annalo-chats-"));
const dataDir = path.join(dir, "data");

const configure = async () => {
  const view = await app.invoke("settings_get");
  const litellm = { id: "litellm", name: "LiteLLM", kind: "litellm", base_url: llm.url, local: false, enabled: true, bypass_proxy: true, api_version: "", models: [] };
  await app.invoke("settings_save", {
    settings: {
      ...view.settings,
      providers: [litellm],
      auto_route: false,
      router: { ...view.settings.router, local_provider: "litellm", local_model: "firma-schnell", standard_provider: "litellm", standard_model: "firma-standard", reasoning_provider: "litellm", reasoning_model: "firma-reasoning" },
      embedding_model: null,
    },
  });
  await app.invoke("provider_key_set", { id: "litellm", key: llm.apiKey });
};

before(async () => {
  llm = await startFakeLiteLLM({ port: 4986 });
  app = await launch({ dataDir });
  await configure();
});
after(async () => {
  await app?.close();
  await llm?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const chats = () => llm.requests.filter((r) => r.url === "/v1/chat/completions");
const answers = () => app.$$(".assistant .msg-ai .msg-meta");
const ask = async (text) => {
  const ta = await app.waitFor(".assistant .composer textarea");
  await ta.setValue(text);
  await app.keys(["Enter"]);
};
const askAndWait = async (text) => {
  const before = (await answers()).length;
  await ask(text);
  await app.browser.waitUntil(async () => (await answers()).length === before + 1, { timeout: 10000, timeoutMsg: `no answer to ${text}` });
  // Saved after the turn.
  await app.browser.pause(300);
};
const list = (query = "") => app.invoke("chat_list", { query, archived: true });
const rows = () => app.browser.execute(() => [...document.querySelectorAll(".chat-history-row .chat-history-title-text")].map((e) => e.textContent));
const openHistory = async () => {
  if (!(await app.$(".chat-history").isExisting())) await app.click('.assistant-head button[aria-label="Verlauf"]');
  await app.waitFor(".chat-history-search input");
};
const title = () => app.text(".assistant-head .assistant-title");

test("a chat is saved turn by turn with an automatic title", async () => {
  await app.click(".sidebar .tree-row");
  await app.keys(["Control", "j"]);
  await askAndWait("Hallo! Wie ist der Stand im Projekt Atlas?");
  await app.browser.waitUntil(async () => /Wie ist der Stand im Projekt Atlas\?/.test(await title()), { timeoutMsg: "no title in the header" });
  await askAndWait("Und die nächsten Schritte?");
  const saved = await list();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].title, "Wie ist der Stand im Projekt Atlas?");
  assert.equal(saved[0].messages, 4);
  assert.equal(saved[0].model, "firma-standard");
  assert.equal(saved[0].private, false);
  assert.ok(saved[0].page_ids.length === 1, "the open page is recorded");
  const doc = await app.invoke("chat_get", { id: saved[0].id });
  assert.deepEqual(doc.messages.map((m) => m.role), ["user", "assistant", "user", "assistant"]);
  assert.ok(doc.messages[1].tokens > 0 && doc.messages[1].cost_usd > 0, "usage is kept");
  assert.equal(doc.messages[1].tier, "standard");
});

test("after a restart the history shows the chat; it opens and continues", async () => {
  await app.close();
  app = await launch({ dataDir });
  await app.click(".sidebar .tree-row");
  await app.keys(["Control", "j"]);
  await app.waitFor(".assistant-empty");
  await openHistory();
  await app.waitFor(".chat-history-row");
  assert.deepEqual(await rows(), ["Wie ist der Stand im Projekt Atlas?"]);
  assert.match(await app.text(".chat-history-group-label"), /Heute/i);
  assert.match(await app.text(".chat-history-row .chat-chip"), /firma-standard/);
  await app.shot("chat-history-list");
  // Enter opens the selected chat.
  await app.keys(["Enter"]);
  await app.waitFor(".assistant .msg-ai .msg-meta");
  assert.equal((await app.$$(".assistant .msg-user")).length, 2);
  assert.equal((await answers()).length, 2);
  assert.match(await title(), /Projekt Atlas/);
  const before = chats().length;
  await askAndWait("Noch eine Frage dazu");
  const sent = chats().slice(before);
  assert.equal(sent.length, 1);
  const roles = sent[0].body.messages.filter((m) => m.role !== "system").map((m) => m.role);
  assert.deepEqual(roles, ["user", "assistant", "user", "assistant", "user"], "the model gets the whole conversation");
  const saved = await list();
  assert.equal(saved.length, 1, "continued, not copied");
  assert.equal(saved[0].messages, 6);
  await app.shot("chat-continued");
});

test("search, rename with F2, pin, duplicate, save as page", async () => {
  await app.click('.assistant-head [aria-label="Neuer Chat"]');
  await askAndWait("Budget für Netzplan Bravo prüfen");
  await openHistory();
  await app.browser.waitUntil(async () => (await rows()).length === 2, { timeoutMsg: "two chats" });
  // Newest first.
  assert.deepEqual(await rows(), ["Budget für Netzplan Bravo prüfen", "Wie ist der Stand im Projekt Atlas?"]);

  // Search by a word of the messages, with the passage.
  await app.type("Schritte");
  await app.browser.waitUntil(async () => (await rows()).length === 1, { timeoutMsg: "not filtered" });
  assert.deepEqual(await rows(), ["Wie ist der Stand im Projekt Atlas?"]);
  assert.match(await app.text(".chat-history-snippet mark"), /Schritte/i);
  await app.shot("chat-history-search");
  await app.keys(["Escape"]);
  await app.browser.waitUntil(async () => (await rows()).length === 2, { timeoutMsg: "search not cleared" });

  // ↓ chooses the second chat, F2 renames it.
  await app.keys(["ArrowDown"]);
  await app.keys(["F2"]);
  await app.waitFor(".chat-history-rename");
  // The title is selected: typing replaces it.
  await app.type("Atlas Stand");
  await app.keys(["Enter"]);
  await app.browser.waitUntil(async () => (await rows()).includes("Atlas Stand"), { timeoutMsg: "not renamed" });
  const renamed = (await list()).find((c) => c.title === "Atlas Stand");
  assert.ok(renamed?.title_custom);

  // Pin: it moves into „Angeheftet“ on top.
  await app.browser.execute(() => {
    const row = [...document.querySelectorAll(".chat-history-row")].find((r) => r.textContent.includes("Atlas Stand"));
    row.querySelector('[aria-label="Anheften"]').click();
  });
  await app.browser.waitUntil(async () => (await rows())[0] === "Atlas Stand", { timeoutMsg: "not pinned on top" });
  assert.match(await app.text(".chat-history-group-label"), /Angeheftet/i);
  assert.equal((await list()).find((c) => c.id === renamed.id).pinned, true);

  // „Duplizieren und weiterführen“ opens a copy.
  const menuOn = async (name, item) => {
    await app.browser.execute((n) => {
      const row = [...document.querySelectorAll(".chat-history-row")].find((r) => r.querySelector(".chat-history-title-text")?.textContent === n);
      row.querySelector('[aria-label="Weitere Aktionen"]').click();
    }, name);
    await app.waitFor(".menu");
    await app.browser.execute((label) => [...document.querySelectorAll(".menu .menu-item")].find((m) => m.textContent.includes(label)).click(), item);
  };
  await menuOn("Budget für Netzplan Bravo prüfen", "Duplizieren");
  await app.waitFor(".assistant .msg-ai .msg-meta");
  await app.browser.waitUntil(async () => /Fortsetzung/.test(await title()), { timeoutMsg: "copy not opened" });
  assert.equal((await list()).length, 3);

  // „Als Seite speichern“ makes a page with the questions as quotes.
  await openHistory();
  await menuOn("Atlas Stand", "Als Seite speichern");
  await app.browser.waitUntil(async () => (await app.invoke("page_resolve", { title: "Atlas Stand", create: false })) !== null, { timeoutMsg: "no page" });
  const page = await app.invoke("page_resolve", { title: "Atlas Stand", create: false });
  const content = (await app.invoke("page_get", { id: page.id })).content;
  assert.match(content, /> Hallo! Wie ist der Stand im Projekt Atlas\?/);
  assert.match(content, /Du hast gefragt/);
});

test("delete with undo, then for good", async () => {
  await app.keys(["Control", "j"]);
  await openHistory();
  await app.browser.waitUntil(async () => (await rows()).length === 3, { timeoutMsg: "three chats" });
  // The list has the focus: Delete deletes the selected chat.
  await app.browser.execute(() => document.querySelector(".chat-history-list").focus());
  await app.keys(["End"]);
  const last = (await rows())[2];
  await app.keys(["Delete"]);
  await app.browser.waitUntil(async () => !(await rows()).includes(last), { timeoutMsg: "not deleted" });
  assert.equal((await list()).length, 2);
  await app.waitText(".toast-title", /gelöscht/);
  await app.shot("chat-history-deleted");
  await app.browser.execute(() => [...document.querySelectorAll(".toast button")].find((b) => b.textContent.trim() === "Rückgängig").click());
  await app.browser.waitUntil(async () => (await rows()).includes(last), { timeoutMsg: "undo did not bring it back" });
  assert.equal((await list()).length, 3);

  await app.dismissToasts();
  await app.browser.execute(() => document.querySelector(".chat-history-list").focus());
  await app.keys(["End"]);
  await app.keys(["Delete"]);
  await app.browser.waitUntil(async () => (await rows()).length === 2, { timeoutMsg: "not deleted again" });
  assert.equal((await list()).length, 2);
});

test("command palette: „Chat-Verlauf durchsuchen“ and „Neuer Chat“", async () => {
  await app.click('.assistant-head button[aria-label="Zurück zum Chat"]');
  const palette = async (query, item) => {
    await app.browser.execute(() => document.querySelector('.ribbon [aria-label^="Befehlspalette"]')?.click());
    const input = await app.waitFor(".palette input");
    await input.setValue(query);
    await app.waitText(".palette .pal-item", item);
    await app.browser.execute((src) => [...document.querySelectorAll(".palette .pal-item")].find((i) => new RegExp(src).test(i.textContent)).click(), item.source);
  };
  await palette("Chat-Verlauf", /Chat-Verlauf durchsuchen/);
  await app.waitFor(".chat-history-search input");
  await app.browser.waitUntil(() => app.browser.execute(() => document.activeElement?.closest(".chat-history-search") !== null), { timeoutMsg: "search not focused" });
  await palette("Neuer Chat", /^Neuer Chat/);
  await app.waitFor(".assistant-empty");
  assert.match(await title(), /Neuer Chat/);
});

test("no console errors", async () => {
  assert.deepEqual(await app.consoleErrors(), []);
});
