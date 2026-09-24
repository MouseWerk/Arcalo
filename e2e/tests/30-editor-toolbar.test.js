// Editor toolbar and tools: formatting, block type, „Einfügen“, sorting lines, moving a block,
// find and replace, statistics; the assistant's suggestions follow the open page and the data.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";
import { startFakeLiteLLM } from "../lib/fake-litellm.js";

const test = guarded(nodeTest, () => app);
let app, llm;
before(async () => {
  llm = await startFakeLiteLLM({ port: 4991 });
  app = await launch();
});
after(async () => {
  await app?.close();
  await llm?.close();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pageId;
const content = async () => (await app.invoke("page_get", { id: pageId })).content;
const saved = (pred, msg) => app.browser.waitUntil(async () => pred(await content()), { timeout: 6000, timeoutMsg: msg });
const tb = (label) => app.browser.execute((l) => document.querySelector(`.pane.active .editor-toolbar [aria-label^="${l}"]`).click(), label);
const menu = (button, item) =>
  app.browser.execute(
    (b, i) => {
      [...document.querySelectorAll(".pane.active .editor-toolbar .tb-menu")].find((x) => (x.getAttribute("aria-label") ?? x.textContent).includes(b)).click();
      return new Promise((r) => setTimeout(() => ([...document.querySelectorAll(".menu-item, [role=menuitem]")].find((x) => x.textContent.includes(i))?.click(), r()), 80));
    },
    button,
    item,
  );
/** Selects the text of paragraphs/items [from, to] (by index among `sel`). */
const selectBlocks = (sel, from, to) =>
  app.browser.execute(
    (s, a, b) => {
      const els = [...document.querySelectorAll(`.pane.active .ProseMirror ${s}`)];
      const r = document.createRange();
      r.setStart(els[a].firstChild ?? els[a], 0);
      const last = els[b];
      const lastText = last.querySelector("p") ?? last;
      r.setEnd(lastText.firstChild ?? lastText, (lastText.textContent ?? "").length);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
    },
    sel,
    from,
    to,
  );

test("toolbar: formatting, block type, insert menu", async () => {
  pageId = (await app.invoke("page_create", { title: "Werkzeugtest", parentId: null })).id;
  await app.invoke("page_save", { id: pageId, content: "Titelzeile\n\n- Zitrone\n- Apfel\n- Banane\n\nErster Absatz\n\nZweiter Absatz\n" });
  await app.browser.refresh();
  await app.browser.waitUntil(async () => app.browser.execute(() => document.body.classList.contains("ready")));
  for (const r of await app.$$(".sidebar .tree-row")) if ((await app.textOf(r)) === "Werkzeugtest") await r.click();
  await app.waitFor(".pane.active .editor-toolbar");
  await app.shot("editor-toolbar");

  // Heading from the block-type dropdown.
  await selectBlocks("p", 0, 0);
  await app.browser.execute(() => {
    const s = document.querySelector('.pane.active .editor-toolbar select[aria-label="Absatzformat"]');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(s, "h2");
    s.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await saved((c) => c.startsWith("## Titelzeile"), "heading not applied");

  // Bold on a selection.
  await app.browser.execute(() => {
    const p = [...document.querySelectorAll(".pane.active .ProseMirror p")].find((x) => x.textContent === "Erster Absatz");
    const r = document.createRange();
    r.selectNodeContents(p);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(r);
  });
  await tb("Fett");
  await saved((c) => c.includes("**Erster Absatz**"), "bold not applied");

  // „Einfügen“ offers the slash commands: a divider.
  await app.browser.execute(() => {
    const p = [...document.querySelectorAll(".pane.active .ProseMirror p")].find((x) => x.textContent === "Zweiter Absatz");
    const r = document.createRange();
    r.setStart(p.firstChild, p.textContent.length);
    r.collapse(true);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(r);
  });
  await menu("Einfügen", "Trennlinie");
  await saved((c) => /Zweiter Absatz\n\n(---|\*\*\*)/.test(c), "divider not inserted");
});

test("tools: sort lines, move a block, find and replace, statistics", async () => {
  // Sort the list items A–Z.
  await selectBlocks("li", 0, 2);
  await menu("Werkzeuge", "Zeilen sortieren A–Z");
  await saved((c) => c.includes("- Apfel\n- Banane\n- Zitrone"), "not sorted");

  // Alt+↓ moves the item with the cursor down.
  await app.browser.execute(() => {
    const p = document.querySelector(".pane.active .ProseMirror li p");
    const r = document.createRange();
    r.setStart(p.firstChild, 1);
    r.collapse(true);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(r);
  });
  await app.keys(["Alt", "ArrowDown"]);
  await saved((c) => c.includes("- Banane\n- Apfel\n- Zitrone"), "not moved");

  // Ctrl+H: replace all.
  await app.keys(["Control", "h"]);
  await app.waitFor(".find-replace input");
  await (await app.$(".find-bar input")).setValue("Absatz");
  await (await app.$(".find-replace input")).setValue("Abschnitt");
  await app.browser.execute(() => [...document.querySelectorAll(".find-replace button")].find((b) => b.textContent === "Alle").click());
  await saved((c) => c.includes("Erster Abschnitt") && c.includes("Zweiter Abschnitt") && !c.includes("Absatz"), "not replaced");
  await app.keys(["Escape"]);

  // Statistics as a toast.
  await menu("Werkzeuge", "Statistik");
  await app.waitText(".toast-title", /Wörter/);
});

test("the assistant suggests from the open page and the data; follow-ups after an answer", async () => {
  await app.browser.execute(() => {
    if (!document.querySelector(".app > .panel")) document.querySelector(".workspace > .pane:last-child .tabbar > button:last-of-type").click();
  });
  await app.waitText(".ai-suggestion", /„Werkzeugtest“ zusammenfassen/);
  const texts = await app.browser.execute(() => [...document.querySelectorAll(".ai-suggestion")].map((b) => b.textContent));
  assert.ok(!texts.some((t) => /NP-8801\?$/.test(t) && !/\//.test(t)), texts.join(" | "));
  assert.ok(texts.length >= 2 && texts.length <= 5, texts.join(" | "));
  await app.shot("assistant-suggestions");

  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", {
    settings: { ...view.settings, litellm_base_url: llm.url, router: { ...view.settings.router, local_model: "firma-schnell", standard_model: "firma-standard", reasoning_model: "firma-reasoning" } },
  });
  await app.invoke("api_key_set", { key: llm.apiKey });
  await app.browser.execute(() => [...document.querySelectorAll(".ai-suggestion")][0].click());
  await app.waitFor(".follow-ups .follow-up");
  const before = llm.requests.length;
  await app.browser.execute(() => [...document.querySelectorAll(".follow-up")].find((b) => b.textContent === "Kürzer").click());
  await app.browser.waitUntil(async () => llm.requests.slice(before).some((r) => r.url === "/v1/chat/completions" && JSON.stringify(r.body.messages).includes("Kürzer, bitte.")), { timeoutMsg: "follow-up not sent" });
  await sleep(300);
});

test("no console errors", async () => {
  assert.deepEqual(await app.browser.execute(() => window.__annaloErrors ?? []), []);
});
