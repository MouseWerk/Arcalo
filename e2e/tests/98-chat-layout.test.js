// 1.6 assistant layout: nothing in an answer widens the panel. At 320 px a long URL, an
// unbroken word of 300 characters, a path, a wide code block and a table of twelve columns
// stay inside: the panel and the messages do not scroll sideways, the code and the table
// scroll in their own box. A chat of 120 turns opens quickly, the view follows an answer only
// at the end („Zum Ende“ otherwise), and screenshots narrow and wide, light and dark.

import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";
import { startFakeLiteLLM } from "../lib/fake-litellm.js";

const test = guarded(nodeTest, () => app);
let app, llm;
before(async () => {
  llm = await startFakeLiteLLM({ port: 4989 });
  app = await launch({ width: 1480, height: 920 });
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
});
after(async () => {
  await app?.close();
  await llm?.close();
});

const reload = async () => {
  await app.browser.execute(() => location.reload());
  await app.browser.waitUntil(async () => (await app.browser.execute(() => document.body.classList.contains("ready"))) === true, { timeout: 15000 });
  await app.browser.pause(400);
};
const setPanelWidth = async (w) => {
  await app.browser.execute((px) => {
    localStorage.setItem("annalo.panel-w", String(px));
    localStorage.setItem("annalo.panel", "true");
  }, w);
  await reload();
  await app.keys(["Control", "j"]);
  await app.waitFor(".assistant .composer textarea");
};
const setTheme = async (theme) => {
  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", { settings: { ...view.settings, theme } });
  await app.browser.execute((t) => (document.documentElement.dataset.theme = t), theme);
};
const answers = () => app.$$(".assistant .msg-ai .msg-meta");
/** Puts `text` into the composer at once (typing hundreds of characters through WebDriver takes minutes). */
const fill = async (text) => {
  await app.waitFor(".assistant .composer textarea");
  await app.browser.execute((t) => {
    const ta = document.querySelector(".assistant .composer textarea");
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(ta, t);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    ta.focus();
  }, text);
};
const askAndWait = async (text) => {
  const before = (await answers()).length;
  await fill(text);
  await app.keys(["Enter"]);
  await app.browser.waitUntil(async () => (await answers()).length === before + 1, { timeout: 15000, timeoutMsg: `no answer to ${text.slice(0, 40)}` });
};

/** Widths of the panel and the messages; what sticks out of the panel; the inner scroll boxes. */
const measure = () =>
  app.browser.execute(() => {
    const panel = document.querySelector(".app > .panel");
    const right = panel.getBoundingClientRect().right;
    const wide = (sel) => [...document.querySelectorAll(sel)].map((e) => ({ sel, sw: e.scrollWidth, cw: e.clientWidth })).filter((x) => x.sw > x.cw + 1);
    // Every element right of the panel's edge, except the content of the boxes that scroll.
    const out = [...panel.querySelectorAll(".assistant *")]
      .filter((e) => !e.closest(".code-box pre, .table-scroll"))
      .filter((e) => e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().right > right + 1)
      .map((e) => `${e.tagName.toLowerCase()}.${[...e.classList].join(".")}`);
    const pre = document.querySelector(".msg-ai .code-box pre");
    const table = document.querySelector(".msg-ai .table-scroll");
    return {
      panelWidth: panel.getBoundingClientRect().width,
      tooWide: [...wide(".app > .panel"), ...wide(".panel-body"), ...wide(".assistant"), ...wide(".assistant-scroll"), ...wide(".chat-log"), ...wide(".msg-ai"), ...wide(".msg-user"), ...wide(".prose-chat"), ...wide(".composer")],
      out,
      pre: pre && { sw: pre.scrollWidth, cw: pre.clientWidth, overflowX: getComputedStyle(pre).overflowX },
      table: table && { sw: table.scrollWidth, cw: table.clientWidth, overflowX: getComputedStyle(table).overflowX },
    };
  });

test("at 320 px nothing in an answer widens the panel; code and table scroll inside", async () => {
  await setTheme("dark");
  await setPanelWidth(320);
  await askAndWait(`Bitte Überlauf testen ${"B".repeat(300)} https://example.com/${"x/".repeat(80)}`);
  await app.browser.pause(300);
  const m = await measure();
  assert.ok(Math.abs(m.panelWidth - 320) < 2, `panel ${m.panelWidth} px`);
  assert.deepEqual(m.tooWide, [], JSON.stringify(m.tooWide));
  assert.deepEqual(m.out, [], `outside the panel: ${m.out.slice(0, 8).join(", ")}`);
  assert.ok(m.pre && m.pre.sw > m.pre.cw && m.pre.overflowX === "auto", `code box: ${JSON.stringify(m.pre)}`);
  assert.ok(m.table && m.table.sw > m.table.cw && m.table.overflowX === "auto", `table: ${JSON.stringify(m.table)}`);
  // The language label and the copy button of the code box.
  assert.equal(await app.text(".msg-ai .code-box .code-lang"), "bash");
  assert.ok(await app.$(".msg-ai .code-box [data-code-copy]").isExisting());
  await app.shot("chat-overflow-320-dark");
  await setTheme("light");
  await app.shot("chat-overflow-320-light");
  // The composer with a long unbroken text grows up to its limit and scrolls; the panel stays.
  await fill("C".repeat(4000));
  const box = await app.browser.execute(() => {
    const t = document.querySelector(".assistant .composer textarea");
    return { h: t.clientHeight, sh: t.scrollHeight, sw: t.scrollWidth, cw: t.clientWidth };
  });
  assert.ok(box.h <= 202 && box.sh > box.h, `textarea ${JSON.stringify(box)}`);
  assert.ok(box.sw <= box.cw + 1, "the textarea wraps");
  assert.deepEqual((await measure()).tooWide, []);
  await fill("");
});

test("the history list at 320 px: long titles and chips stay inside", async () => {
  // A conversation with a very long title.
  const conv = await app.invoke("chat_create", { title: `Ein sehr langer Titel ${"ohneLeerzeichen".repeat(12)}` });
  await app.invoke("chat_append", { id: conv.id, messages: [{ role: "user", content: "Frage" }, { role: "assistant", content: "Antwort", model: "firma-reasoning-mit-sehr-langem-namen-v2", provider: "litellm", tier: "reasoning" }], pageId: null, private: false });
  await app.click('.assistant-head button[aria-label="Verlauf"]');
  await app.waitFor(".chat-history-row");
  const over = await app.browser.execute(() => {
    const panel = document.querySelector(".app > .panel").getBoundingClientRect().right;
    const list = document.querySelector(".chat-history-list");
    return { list: list.scrollWidth - list.clientWidth, out: [...document.querySelectorAll(".chat-history *")].filter((e) => e.getBoundingClientRect().right > panel + 1).length };
  });
  assert.deepEqual(over, { list: 0, out: 0 });
  await app.shot("chat-history-320-light");
  await setTheme("dark");
  await app.shot("chat-history-320-dark");
  await app.click('.assistant-head button[aria-label="Zurück zum Chat"]');
});

test("wide panel, light and dark", async () => {
  // The panel is at most 28 % of the window wide.
  await app.browser.setWindowSize(1600, 1000);
  await setPanelWidth(640);
  await app.click('.assistant-head [aria-label="Neuer Chat"]');
  await app.shot("chat-empty-wide-dark");
  await app.click(".sidebar .tree-row");
  await askAndWait("Fasse die Seite zusammen");
  await askAndWait("Bitte Überlauf testen");
  const m = await measure();
  assert.deepEqual(m.tooWide, []);
  assert.deepEqual(m.out, []);
  await app.shot("chat-wide-dark");
  await setTheme("light");
  await app.shot("chat-wide-light");
  await app.click('.assistant-head button[aria-label="Verlauf"]');
  await app.waitFor(".chat-history-row");
  await app.shot("chat-history-wide-light");
  await app.click('.assistant-head button[aria-label="Zurück zum Chat"]');
  await setTheme("dark");
});

test("a chat of 120 turns opens quickly; the view follows only at the end", async () => {
  const conv = await app.invoke("chat_create", { title: "Langer Verlauf" });
  const messages = [];
  for (let i = 0; i < 60; i++) {
    messages.push({ role: "user", content: `Frage ${i}: Wie sieht es mit Punkt ${i} aus?` });
    messages.push({ role: "assistant", content: `## Antwort ${i}\n\n- Punkt **${i}** ist erledigt\n- Siehe [[Architektur]]\n\n\`\`\`ts\nconst x${i} = ${i};\n\`\`\`\n\n| a | b |\n| --- | --- |\n| ${i} | ${i * 2} |`, model: "firma-standard", provider: "litellm", tier: "standard", tokens: 100, cost_usd: 0.001 });
  }
  await app.invoke("chat_append", { id: conv.id, messages, pageId: null, private: false });
  await app.click('.assistant-head button[aria-label="Verlauf"]');
  await app.waitFor(".chat-history-row");
  const ms = await app.browser.executeAsync((done) => {
    const row = [...document.querySelectorAll(".chat-history-row")].find((r) => r.textContent.includes("Langer Verlauf"));
    const t0 = performance.now();
    row.click();
    const check = () => (document.querySelectorAll(".assistant .msg-ai").length === 60 ? requestAnimationFrame(() => done(performance.now() - t0)) : setTimeout(check, 10));
    check();
  });
  assert.ok(ms < 2500, `opened in ${Math.round(ms)} ms`);
  // Opened at the end.
  const atEnd = await app.browser.execute(() => {
    const s = document.querySelector(".assistant-scroll");
    return s.scrollHeight - s.scrollTop - s.clientHeight < 40;
  });
  assert.ok(atEnd, "not at the end");

  // Scrolled up while an answer streams: the view stays where it is, „Zum Ende“ appears.
  const ta = await app.$(".assistant .composer textarea");
  await ta.setValue("Antworte bitte langsam");
  await app.keys(["Enter"]);
  await app.browser.waitUntil(async () => app.browser.execute(() => !!document.querySelector(".msg-ai .prose-chat.streaming")), { timeoutMsg: "not streaming" });
  const top = await app.browser.execute(() => {
    const s = document.querySelector(".assistant-scroll");
    s.scrollTop = 400;
    s.dispatchEvent(new Event("scroll"));
    return s.scrollTop;
  });
  await app.waitFor(".assistant .scroll-end");
  await app.browser.pause(1200);
  const still = await app.browser.execute(() => document.querySelector(".assistant-scroll").scrollTop);
  assert.equal(still, top, "the view jumped while scrolled up");
  await app.shot("chat-scroll-end-button");
  await app.click(".assistant .scroll-end");
  await app.browser.waitUntil(async () => !(await app.$(".assistant .scroll-end").isExisting()), { timeoutMsg: "„Zum Ende“ stays" });
  await app.browser.waitUntil(async () => app.browser.execute(() => !document.querySelector(".msg-ai .prose-chat.streaming")), { timeout: 20000, timeoutMsg: "answer did not finish" });
  // Following again: at the end after the answer finished.
  const end = await app.browser.execute(() => {
    const s = document.querySelector(".assistant-scroll");
    return s.scrollHeight - s.scrollTop - s.clientHeight < 40;
  });
  assert.ok(end, "does not follow after „Zum Ende“");
});

test("closing the panel keeps the chat and a running answer", async () => {
  const turns = (await app.$$(".assistant .msg-ai")).length;
  const ta = await app.$(".assistant .composer textarea");
  await ta.setValue("Antworte bitte langsam noch einmal");
  await app.keys(["Enter"]);
  await app.browser.waitUntil(async () => app.browser.execute(() => !!document.querySelector(".msg-ai .prose-chat.streaming")), { timeoutMsg: "not streaming" });
  // Close the side panel while it streams, open it again.
  await app.keys(["Control", "Shift", "\\"]);
  await app.browser.waitUntil(async () => !(await app.$(".app > .panel").isExisting()), { timeoutMsg: "panel not closed" });
  await app.browser.pause(300);
  await app.keys(["Control", "j"]);
  await app.waitFor(".assistant .composer textarea");
  await app.browser.waitUntil(async () => (await app.$$(".assistant .msg-ai")).length === turns + 1, { timeout: 20000, timeoutMsg: "chat lost" });
  await app.browser.waitUntil(async () => app.browser.execute(() => !document.querySelector(".msg-ai .prose-chat.streaming")), { timeout: 20000, timeoutMsg: "answer lost" });
  assert.match(await app.browser.execute(() => [...document.querySelectorAll(".msg-ai")].pop().innerText), /Wort199/);
});

test("no console errors", async () => {
  assert.deepEqual(await app.consoleErrors(), []);
});
