// 1.14 chat view: a plain chatbot as a tab in the main area beside the assistant panel. It
// opens from the ribbon, the palette and Ctrl+Shift+J (focusing an open chat tab), answers as a
// plain chatbot (no notes, no tools) until „Mit meinen Notizen“ is on, streams and stops,
// renders code, tables and diagrams, shares its saved chats with the panel (rename, pin,
// delete with undo; a panel chat opens in the view and both show what either adds), keeps
// #privat questions on the local model and folds its list into a drawer in a narrow window.
// Screenshots light, dark and high contrast, wide and narrow.

import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";
import { startFakeLiteLLM } from "../lib/fake-litellm.js";
import { startFakeOpenAI } from "../lib/fake-openai.js";

const test = guarded(nodeTest, () => app);
let app, llm, ollama;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  llm = await startFakeLiteLLM({ port: 4994 });
  ollama = await startFakeOpenAI({ port: 4995, kind: "ollama", name: "Ollama", models: ["gemma4:e2b"] });
  app = await launch({ width: 1440, height: 900 });
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
  await app.invoke("page_create", {
    parentId: null,
    title: "Zebrafink Projekt",
    icon: null,
    content: "# Zebrafink Projekt\n\nDas Zebrafink-Projekt hat ein Budget von 48.000 Euro. Der Go-Live ist im März.\n",
  });
  await app.invoke("ai_index_pending").catch(() => 0);
  await app.browser.refresh();
  await app.browser.waitUntil(async () => app.browser.execute(() => document.body.classList.contains("ready")), { timeout: 20000 });
});
after(async () => {
  await app?.close();
  await llm?.close();
  await ollama?.close();
});

const V = ".chat-view";
const H = ".chat-view-head";
const P = ".panel .assistant";
const cloudChats = () => llm.requests.filter((r) => r.url === "/v1/chat/completions");
const answers = (root = V) => app.$$(`${root} .msg-ai .msg-meta`);
const chatTabs = () => app.browser.execute(() => [...document.querySelectorAll(".tabbar .tab")].filter((t) => /Chat/.test(t.textContent)).length);
const list = () => app.invoke("chat_list", { query: "", archived: true });
const rows = (root = V) => app.browser.execute((r) => [...document.querySelectorAll(`${r} .chat-history-row .chat-history-title-text`)].map((e) => e.textContent), root);
const askIn = async (root, text) => {
  const before = (await answers(root)).length;
  const ta = await app.waitFor(`${root} .composer textarea`);
  await ta.setValue(text);
  await app.keys(["Enter"]);
  await app.browser.waitUntil(async () => (await answers(root)).length === before + 1, { timeout: 15000, timeoutMsg: `no answer to ${text}` });
  // Saved after the turn.
  await sleep(300);
};
const ask = (text) => askIn(V, text);
const palette = async (query, item) => {
  await app.browser.execute(() => document.querySelector('.ribbon [aria-label^="Befehlspalette"]')?.click());
  const input = await app.waitFor(".palette input");
  await input.setValue(query);
  await app.waitText(".palette .pal-item", item);
  await app.browser.execute((src) => [...document.querySelectorAll(".palette .pal-item")].find((i) => new RegExp(src).test(i.textContent)).click(), item.source);
};
const setLook = async (mode, id = null, width = 1440, height = 900) => {
  await app.browser.setWindowSize(width, height);
  const view = await app.invoke("settings_get");
  const ap = { ...view.settings.appearance };
  if (mode === "light") ap.theme_light = id ?? "arcalo-light";
  else ap.theme_dark = id ?? "arcalo-dark";
  await app.invoke("settings_save", { settings: { ...view.settings, theme: mode, appearance: ap } });
  await app.browser.refresh();
  await app.browser.waitUntil(async () => app.browser.execute(() => document.body.classList.contains("ready")), { timeout: 20000 });
  await app.waitFor(`${V} .composer textarea`);
  await sleep(600);
};
/** Nothing in the view scrolls sideways (code and tables scroll inside their own box). */
const noSideScroll = () =>
  app.browser.execute((v) => {
    const out = [];
    for (const sel of [v, `${v} .chat-view-main`, `${v} .assistant-scroll`, `${v} .chat-log`, `${v} .composer`]) {
      const el = document.querySelector(sel);
      if (el && el.scrollWidth > el.clientWidth + 1) out.push(`${sel}: ${el.scrollWidth} > ${el.clientWidth}`);
    }
    return out;
  }, V);

test("opens from the ribbon, the palette and Ctrl+Shift+J, always the same tab", async () => {
  await app.click(".ribbon .ribbon-chat");
  await app.waitFor(`${V} .chat-greeting`);
  assert.match(await app.text(`${V} .chat-greeting-title`), /Worüber möchtest du sprechen/);
  assert.equal((await app.$$(`${V} .chat-chip-btn`)).length, 4);
  assert.equal(await app.$(`${V} .ai-setup-note`).isExisting(), false, "an AI is set up");
  // The composer has the focus and the plain mode is on.
  await app.browser.waitUntil(() => app.browser.execute((v) => document.activeElement === document.querySelector(`${v} .composer textarea`), V), { timeoutMsg: "composer not focused" });
  assert.equal(await app.browser.execute((v) => document.querySelector(`${v} .notes-chip`).getAttribute("aria-pressed"), V), "false");
  assert.equal(await chatTabs(), 1);

  // From another tab: the palette and the shortcut focus the open chat tab.
  await app.keys(["Control", "t"]);
  await app.browser.waitUntil(async () => !(await app.$(`${V}`).isDisplayed().catch(() => false)), { timeoutMsg: "still on the chat" });
  await palette("Chat öffnen", /Chat öffnen/);
  await app.waitFor(`${V} .chat-greeting`);
  assert.equal(await chatTabs(), 1, "no second chat tab");
  await app.keys(["Control", "t"]);
  await sleep(200);
  await app.keys(["Control", "Shift", "j"]);
  await app.waitFor(`${V} .chat-greeting`);
  assert.equal(await chatTabs(), 1);
  // The extra home tab goes again.
  await app.browser.execute(() => [...document.querySelectorAll(".tabbar .tab")].filter((t) => !/Chat/.test(t.textContent)).forEach((t) => t.querySelector(".tab-close")?.click()));
});

test("a plain chat: no notes, no tools; the answer streams in and is saved", async () => {
  const before = cloudChats().length;
  await ask("Was ist ein Netzplan in der Projektplanung?");
  const sent = cloudChats().slice(before);
  assert.equal(sent.length, 1);
  const body = sent[0].body;
  assert.ok(!body.tools?.length, "no tools in a plain chat");
  const system = body.messages.find((m) => m.role === "system").content;
  assert.doesNotMatch(system, /Arcalo|nummerierte Quellen|Werkzeuge/);
  assert.equal(await app.$(`${V} .sources`).isExisting(), false);
  await app.browser.waitUntil(async () => /Netzplan/.test(await app.text(`${H} .chat-view-title`)), { timeoutMsg: "no title" });
  const saved = await list();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].title, "Was ist ein Netzplan in der Projektplanung?");
  assert.equal(saved[0].messages, 2);
  // The list shows it under „Heute“, as the current chat.
  await app.browser.waitUntil(async () => (await rows()).length === 1, { timeoutMsg: "not listed" });
  assert.match(await app.text(`${V} .chat-history-group-label`), /Heute/i);
  assert.ok(await app.$(`${V} .chat-history-row.current`).isExisting());
});

test("streaming shows Stop; Stop ends the answer", async () => {
  const ta = await app.waitFor(`${V} .composer textarea`);
  await ta.setValue("Bitte langsam und ausführlich antworten");
  await app.keys(["Enter"]);
  await app.waitFor(`${V} .send-btn.stop`);
  await app.browser.waitUntil(async () => (await app.browser.execute((v) => document.querySelector(`${v} .prose-chat.streaming`)?.textContent.length ?? 0, V)) > 20, { timeoutMsg: "no streaming text" });
  await app.click(`${V} .send-btn.stop`);
  await app.waitFor(`${V} .msg-cancelled`);
  await app.browser.waitUntil(async () => !(await app.$(`${V} .send-btn.stop`).isExisting()), { timeoutMsg: "still busy" });
  const text = await app.browser.execute((v) => [...document.querySelectorAll(`${v} .msg-ai .prose-chat`)].at(-1).textContent, V);
  assert.ok(!text.includes("Wort199"), "the answer stopped early");
});

test("code with highlighting and copy, a table, a diagram with its source", async () => {
  await ask("Wie rufe ich die aktiven Projekte typsicher in TypeScript ab, und wie sieht das SQL dazu aus?");
  const last = `${V} .msg-ai.last`;
  const info = await app.browser.execute((l) => {
    const root = document.querySelector(l);
    const boxes = [...root.querySelectorAll(".code-box")];
    return {
      langs: boxes.map((b) => b.querySelector(".code-lang")?.textContent),
      keywords: boxes.map((b) => b.querySelectorAll(".hljs-keyword").length),
      table: !!root.querySelector(".table-scroll > table"),
      th: [...root.querySelectorAll("th")].map((x) => x.textContent),
      heading: root.querySelector("h2")?.textContent,
      nested: !!root.querySelector("ol li ul li"),
      quote: !!root.querySelector("blockquote"),
      preWhite: getComputedStyle(root.querySelector(".code-box pre")).whiteSpace,
      preScroll: getComputedStyle(root.querySelector(".code-box pre")).overflowX,
    };
  }, last);
  assert.deepEqual(info.langs, ["typescript", "sql"]);
  assert.ok(info.keywords.every((n) => n > 0), "both blocks are highlighted");
  assert.ok(info.table && info.th.join("|") === "Feld|Typ|Pflicht");
  assert.equal(info.heading, "Typsicherer Abruf der Projekte");
  assert.ok(info.nested && info.quote);
  assert.equal(info.preWhite, "pre");
  assert.equal(info.preScroll, "auto");
  // „Kopieren“ copies the code and says „Kopiert“ (the test WebView may deny the clipboard).
  await app.browser.execute((l) => {
    navigator.clipboard.writeText = async (t) => void (window.__copied = t);
    document.querySelector(`${l} .code-box [data-code-copy]`).click();
  }, last);
  await app.browser.waitUntil(async () => (await app.browser.execute((l) => document.querySelector(`${l} .code-box .code-copy-text`).textContent, last)) === "Kopiert", { timeoutMsg: "no copy feedback" });
  assert.match(await app.browser.execute(() => window.__copied), /^interface Projekt \{\n  id: number;[\s\S]*\}$/);
  assert.deepEqual(await noSideScroll(), []);
  await app.shot("chat-view-code-light");

  await ask("Zeig mir den Ablauf der Freigabe als Diagramm");
  await app.waitFor(`${V} .msg-ai.last .mermaid-box.drawn .mermaid-view svg`, 15000);
  assert.equal(await app.$(`${V} .msg-ai.last .mermaid-box pre`).isDisplayed(), false, "the source is folded away");
  await app.browser.execute((v) => document.querySelector(`${v} .msg-ai.last [data-mermaid-toggle]`).click(), V);
  await app.waitFor(`${V} .msg-ai.last .mermaid-box.show-source pre`);
  assert.equal(await app.$(`${V} .msg-ai.last .mermaid-view`).isDisplayed(), false);
});

test("„Mit meinen Notizen“ searches the notes and cites them; without it nothing", async () => {
  await app.click(`${V} .chat-view-new`);
  await app.waitFor(`${V} .chat-greeting`);
  let before = cloudChats().length;
  await ask("Zebrafink Budget");
  let body = cloudChats().slice(before)[0].body;
  assert.doesNotMatch(JSON.stringify(body.messages), /48\.000/, "no note content without the switch");
  assert.equal(await app.$(`${V} .msg-ai.last .sources`).isExisting(), false);

  await app.click(`${V} .notes-chip`);
  assert.equal(await app.browser.execute((v) => document.querySelector(`${v} .notes-chip`).getAttribute("aria-pressed"), V), "true");
  before = cloudChats().length;
  await ask("Zebrafink Budget Euro");
  body = cloudChats().slice(before)[0].body;
  const system = body.messages.find((m) => m.role === "system").content;
  assert.match(system, /nummerierte Quellen/);
  assert.match(system, /48\.000 Euro/);
  assert.ok(body.tools?.length > 0, "the assistant's tools are offered");
  await app.waitFor(`${V} .msg-ai.last .sources .source`);
  assert.match(await app.text(`${V} .msg-ai.last .sources`), /Zebrafink/);
  await app.shot("chat-view-notes");
  // Back to the plain chatbot for the rest.
  await app.click(`${V} .notes-chip`);
});

test("„Seite anhängen“ sends that page along, still without tools", async () => {
  await app.click(`${V} .attach-btn`);
  const search = await app.waitFor(`${V} .attach-search`);
  await search.setValue("Zebra");
  await app.waitText(`${V} .attach-row`, /Zebrafink Projekt/);
  await app.keys(["Enter"]);
  await app.waitText(`${V} .attached-chip`, /Zebrafink Projekt/);
  const before = cloudChats().length;
  await ask("Fass die angehängte Seite in einem Satz zusammen");
  const body = cloudChats().slice(before)[0].body;
  assert.match(body.messages.find((m) => m.role === "system").content, /Aktuell geöffnete Seite „Zebrafink Projekt“/);
  assert.ok(!body.tools?.length);
  // Removed again with its chip.
  await app.click(`${V} .attached-chip`);
  await app.waitFor(`${V} .attach-btn`);
});

test("#privat stays on the local model, the chat is locked", async () => {
  await app.click(`${V} .chat-view-new`);
  const cloud = cloudChats().length;
  const local = ollama.chats().length;
  await ask("#privat Wie formuliere ich meine Gehaltsverhandlung?");
  assert.equal(ollama.chats().length, local + 1, "answered locally");
  assert.equal(cloudChats().length, cloud, "nothing went to the cloud");
  await app.waitFor(`${H} .chat-lock`);
  await app.waitFor(`${H} .chat-private-badge`);
  await ask("Und was sage ich als Erstes?");
  assert.equal(ollama.chats().length, local + 2);
  assert.equal(cloudChats().length, cloud, "the follow-up stayed local");
  assert.ok(!llm.requests.some((r) => JSON.stringify(r.body ?? "").includes("Gehaltsverhandlung")));
});

test("the list: groups, search, rename, pin and delete with undo, the same in the panel", async () => {
  await app.browser.waitUntil(async () => (await rows()).length === 3, { timeoutMsg: "three chats" });
  // Search by a word of the messages.
  await app.click(`${V} .chat-history-search input`);
  await app.type("Netzplan");
  await app.browser.waitUntil(async () => (await rows()).length === 1, { timeoutMsg: "not filtered" });
  assert.match(await app.text(`${V} .chat-history-snippet mark`), /Netzplan/i);
  await app.keys(["Escape"]);
  await app.browser.waitUntil(async () => (await rows()).length === 3, { timeoutMsg: "search not cleared" });

  const menuOn = async (root, name, item) => {
    await app.browser.execute(
      (r, n) => {
        const row = [...document.querySelectorAll(`${r} .chat-history-row`)].find((x) => x.querySelector(".chat-history-title-text")?.textContent === n);
        row.querySelector('[aria-label="Weitere Aktionen"]').click();
      },
      root,
      name,
    );
    await app.waitFor(".menu");
    await app.browser.execute((label) => [...document.querySelectorAll(".menu .menu-item")].find((m) => m.textContent.includes(label)).click(), item);
  };
  // Rename in the view: the panel's history shows the new title.
  await menuOn(V, "Was ist ein Netzplan in der Projektplanung?", "Umbenennen");
  await app.waitFor(`${V} .chat-history-rename`);
  await app.type("Netzplan erklärt");
  await app.keys(["Enter"]);
  await app.browser.waitUntil(async () => (await rows()).includes("Netzplan erklärt"), { timeoutMsg: "not renamed" });
  await app.keys(["Control", "j"]);
  await app.click(`${P} .assistant-head button[aria-label="Verlauf"]`);
  await app.browser.waitUntil(async () => (await rows(P)).includes("Netzplan erklärt"), { timeoutMsg: "panel list not updated" });

  // Pin in the view: on top in both lists.
  await app.browser.execute((v) => {
    const row = [...document.querySelectorAll(`${v} .chat-history-row`)].find((r) => r.textContent.includes("Netzplan erklärt"));
    row.querySelector('[aria-label="Anheften"]').click();
  }, V);
  await app.browser.waitUntil(async () => (await rows())[0] === "Netzplan erklärt" && (await rows(P))[0] === "Netzplan erklärt", { timeoutMsg: "not pinned on top in both" });
  assert.match(await app.text(`${V} .chat-history-group-label`), /Angeheftet/i);
  await app.shot("chat-view-list");

  // Delete in the view, undo from the toast: back in both.
  await menuOn(V, "Netzplan erklärt", "Löschen");
  await app.browser.waitUntil(async () => !(await rows()).includes("Netzplan erklärt") && !(await rows(P)).includes("Netzplan erklärt"), { timeoutMsg: "not deleted in both" });
  await app.waitText(".toast-title", /gelöscht/);
  await app.browser.execute(() => [...document.querySelectorAll(".toast button")].find((b) => b.textContent.trim() === "Rückgängig").click());
  await app.browser.waitUntil(async () => (await rows()).includes("Netzplan erklärt") && (await rows(P)).includes("Netzplan erklärt"), { timeoutMsg: "undo did not bring it back in both" });
  await app.dismissToasts();
  await app.click(`${P} .assistant-head button[aria-label="Zurück zum Chat"]`);
});

test("a panel chat opens in the view; a chat open in both shows what either adds", async () => {
  await app.click(`${P} .assistant-head [aria-label="Neuer Chat"]`);
  await askIn(P, "Fass mir die Woche kurz zusammen");
  await app.click(`${P} .assistant-head .chat-expand`);
  await app.browser.waitUntil(async () => (await app.$$(`${V} .msg-user`)).length === 1 && /Woche kurz/.test(await app.text(`${V} .msg-user`)), { timeoutMsg: "not opened in the view" });
  assert.match(await app.text(`${H} .chat-view-title`), /Woche kurz/);
  // Continued in the view: the panel shows the new turn too, and the model got the whole chat.
  const before = cloudChats().length;
  await ask("Und was ist davon am dringendsten?");
  const sent = cloudChats().slice(before)[0].body.messages.filter((m) => m.role !== "system").map((m) => m.role);
  assert.deepEqual(sent, ["user", "assistant", "user"]);
  await app.browser.waitUntil(async () => (await app.$$(`${P} .msg-user`)).length === 2, { timeoutMsg: "the panel did not follow" });
  // And back: asked in the panel, shown in the view.
  await askIn(P, "Danke, noch ein Satz zum Risiko?");
  await app.browser.waitUntil(async () => (await app.$$(`${V} .msg-user`)).length === 3, { timeoutMsg: "the view did not follow" });
  const saved = (await list()).filter((c) => /Woche kurz/.test(c.title));
  assert.equal(saved.length, 1, "one chat, not a copy");
  assert.equal(saved[0].messages, 6);
});

test("screenshots: a short conversation, light and dark at 1440 px, high contrast", async () => {
  // The chat view on its own, the side panel closed.
  await app.browser.execute(() => localStorage.setItem("arcalo.panel", "0"));
  await app.click(`${V} .chat-view-new`);
  await ask("Ich muss morgen den Projektstand Atlas vorstellen. Wie baue ich die fünf Minuten auf?");
  await ask("Wie rufe ich die aktiven Projekte typsicher in TypeScript ab, und wie sieht das SQL dazu aus?");
  // The conversation from its start, and the answer with heading, list, table and code.
  const both = async (name) => {
    await app.browser.execute((v) => document.querySelector(`${v} .assistant-scroll`).scrollTo(0, 0), V);
    await app.shot(name);
    await app.browser.execute((v) => document.querySelector(`${v} .msg-ai.last`).scrollIntoView({ block: "start" }), V);
    await app.shot(`${name}-code`);
  };
  await setLook("light");
  await both("chat-view-light-1440");
  await setLook("dark");
  await both("chat-view-dark-1440");
  await setLook("dark", "contrast-dark");
  await both("chat-view-contrast-dark");
  await setLook("light", "contrast-light");
  await both("chat-view-contrast-light");
  assert.deepEqual(await noSideScroll(), []);
});

test("narrow window: the list is a drawer, nothing scrolls sideways", async () => {
  await setLook("light", null, 900, 760);
  // The side panel may close by itself below 1000 px; the chat keeps its reading column.
  await app.browser.waitUntil(async () => app.browser.execute((v) => document.querySelector(v).classList.contains("narrow"), V), { timeoutMsg: "not narrow" });
  assert.equal(await app.$(`${V} .chat-view-list`).isExisting(), false, "the list is folded away");
  assert.deepEqual(await noSideScroll(), []);
  const column = await app.browser.execute((v) => document.querySelector(`${v} .assistant-content`).getBoundingClientRect().width, V);
  assert.ok(column > 380, `reading column ${column}px`);
  await app.browser.execute((v) => document.querySelector(`${v} .assistant-scroll`).scrollTo(0, 1e6), V);
  await app.shot("chat-view-narrow-900");
  await app.click(`.chat-view-head [aria-controls="chat-view-list"]`);
  await app.waitFor(`${V} .chat-view-list .chat-history-row`);
  await app.shot("chat-view-narrow-drawer");
  // Choosing a chat closes the drawer.
  await app.browser.execute((v) => document.querySelector(`${v} .chat-history-row:not(.current)`).click(), V);
  await app.browser.waitUntil(async () => !(await app.$(`${V} .chat-view-list`).isExisting()), { timeoutMsg: "drawer stayed open" });
  assert.deepEqual(await noSideScroll(), []);
  await app.browser.setWindowSize(1440, 900);
});

test("no console errors", async () => {
  assert.deepEqual(await app.consoleErrors(), []);
});
