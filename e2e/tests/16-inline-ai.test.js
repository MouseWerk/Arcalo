// Inline AI in the editor (Ctrl+J on a selection, preview, replace, undo) and the meeting summary.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";
import { startFakeLiteLLM } from "../lib/fake-litellm.js";

const test = guarded(nodeTest, () => app);
let app, llm;
before(async () => {
  llm = await startFakeLiteLLM({ port: 4997 });
  app = await launch();
  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", {
    settings: { ...view.settings, litellm_base_url: llm.url, router: { ...view.settings.router, local_model: "firma-schnell", standard_model: "firma-standard", reasoning_model: "firma-reasoning" } },
  });
  await app.invoke("api_key_set", { key: llm.apiKey });
});
after(async () => {
  await app?.close();
  await llm?.close();
});

const pageId = async (title) => (await app.invoke("page_resolve", { title, create: false })).id;
const content = async (title) => (await app.invoke("page_get", { id: await pageId(title) })).content;
const openFromTree = async (title) => {
  for (const r of await app.$$(".sidebar .tree-row")) if ((await app.textOf(r)) === title) return r.click();
  throw new Error(`tree row ${title} not found`);
};
const clickText = async (sel, pattern) => {
  for (const el of await app.$$(sel)) if (pattern.test(await app.textOf(el))) return el.click();
  throw new Error(`no ${sel} matching ${pattern}`);
};
const transforms = () => llm.requests.filter((r) => r.url === "/v1/chat/completions" && r.body.messages.some((m) => m.role === "system" && /Du bearbeitest Texte/.test(m.content)));
/** Selects `text` inside the open note (one text node) through the DOM, as a mouse drag would. */
const selectText = async (text) => {
  const ok = await app.browser.execute((t) => {
    const root = document.querySelector(".pane.active .ProseMirror");
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = n.data.indexOf(t);
      if (i < 0) continue;
      root.focus();
      const range = document.createRange();
      range.setStart(n, i);
      range.setEnd(n, i + t.length);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      return true;
    }
    return false;
  }, text);
  assert.ok(ok, `text ${text} found`);
  await app.browser.pause(250);
};
const focused = () => app.browser.execute(() => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.tagName);

test("Ctrl+J on a selection opens the inline AI bar, „Kürzen“ streams a preview", async () => {
  await openFromTree("Architektur");
  await app.waitFor(".ProseMirror h2");
  await selectText("Die Middleware verbindet das ERP über IDocs mit dem Auftragsportal.");
  await app.keys(["Control", "j"]);
  await app.waitFor(".ai-bar");
  assert.equal(await focused(), "Anweisung an die KI", "the bar takes the focus, not the assistant");
  await app.waitText(".ai-chip", /Rechtschreibung korrigieren/);
  await app.shot("inline-ai-bar");
  await clickText(".ai-chip", /^Kürzen$/);
  await app.waitText(".ai-bar-preview .prose", /Kurz:/);
  await app.waitText(".ai-bar-actions .btn", /Ersetzen/);
  // Rendered Markdown: bold and the wiki link.
  const html = await (await app.$(".ai-bar-preview .prose")).getHTML();
  assert.match(html, /<strong>Kurz:<\/strong>/);
  assert.match(html, /data-wikilink/);
  assert.match(await app.text(".ai-bar-foot"), /firma-(schnell|standard|reasoning)/);
  assert.match(await app.text(".ai-bar-foot"), /0,0012\s\$/);
  await app.shot("inline-ai-preview");

  const req = transforms().pop();
  assert.ok(req, "an ai_transform request was sent");
  const user = req.body.messages.find((m) => m.role === "user").content;
  assert.match(user, /Anweisung: Kürze den Text/);
  assert.match(user, /<text>\nDie Middleware verbindet das ERP über IDocs mit dem Auftragsportal\.\n<\/text>/);
  assert.equal(req.body.tools, undefined, "no tools for transformations");
});

test("„Ersetzen“ puts the Markdown into the note, one undo restores the text", async () => {
  await clickText(".ai-bar-actions .btn", /Ersetzen/);
  await app.browser.waitUntil(async () => !(await (await app.$(".ai-bar")).isExisting()), { timeoutMsg: "bar closed" });
  await app.browser.waitUntil(async () => /\*\*Kurz:\*\* Die Middleware verbindet \[\[Architektur\]\]/.test(await content("Architektur")), {
    timeout: 5000,
    timeoutMsg: "replacement saved",
  });
  const md = await content("Architektur");
  assert.doesNotMatch(md, /Auftragsportal/);
  assert.match(md, /#architektur/, "text outside the selection stays");
  assert.match(md, /^## Komponenten$/m);

  await app.keys(["Control", "z"]);
  await app.browser.waitUntil(async () => /Die Middleware verbindet das ERP über IDocs mit dem Auftragsportal\. #architektur/.test(await content("Architektur")), {
    timeout: 5000,
    timeoutMsg: "undo restored the original in one step",
  });
});

test("Esc discards the bar; the bubble menu offers „KI“", async () => {
  await selectText("persistente Verarbeitung mit Retry");
  await app.waitFor(".bubble-ai");
  await app.click(".bubble-ai");
  await app.waitFor(".ai-bar");
  await app.keys(["Escape"]);
  await app.browser.waitUntil(async () => !(await (await app.$(".ai-bar")).isExisting()), { timeoutMsg: "Esc closes the bar" });
  assert.match(await content("Architektur"), /persistente Verarbeitung mit Retry/);
});

test("Ctrl+J without a selection still opens the assistant", async () => {
  await app.caretToEnd();
  await app.keys(["Control", "j"]);
  await app.browser.waitUntil(async () => (await focused()) === "Nachricht an den Assistenten", { timeoutMsg: "assistant composer focused" });
  assert.equal(await (await app.$(".ai-bar")).isExisting(), false);
});

test("KI in the toolbar on an empty line writes new text there, with the page as context", async () => {
  await openFromTree("Architektur");
  await app.waitFor(".ProseMirror h2");
  // Cursor into a new empty paragraph after the first one.
  await app.browser.execute(() => {
    const p = document.querySelector(".pane.active .ProseMirror p");
    const r = document.createRange();
    r.selectNodeContents(p);
    r.collapse(false);
    document.querySelector(".pane.active .ProseMirror").focus();
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  });
  await app.keys(["End", "Enter"]);
  await app.browser.pause(200);
  await app.click(".pane.active .vh .tb-ai");
  await app.waitFor(".ai-bar");
  await app.waitText(".ai-chip", /Weiterschreiben/);
  await clickText(".ai-chip", /^Weiterschreiben$/);
  await app.waitText(".ai-bar-preview", /Neuer Abschnitt/);
  const sent = transforms().at(-1).body.messages.at(-1).content;
  assert.match(sent, /Middleware verbindet/, "the page goes along as context");
  await clickText(".ai-bar-actions button", /^Einfügen$/);
  await app.browser.waitUntil(async () => (await content("Architektur")).includes("Neuer Abschnitt: Testplan mit dem Fachbereich abstimmen."), { timeoutMsg: "not inserted" });
  const c = await content("Architektur");
  assert.ok(c.indexOf("Neuer Abschnitt") > c.indexOf("Middleware"), "below the first paragraph, which stays");
});

test("near the bottom of the window the bar opens above the selection and stays in view", async () => {
  const size = await app.browser.getWindowSize();
  await app.browser.setWindowSize(size.width, 620);
  await openFromTree("Architektur");
  await app.waitFor(".ProseMirror h2");
  await app.browser.execute(() => {
    const s = document.querySelector(".pane.active .page-scroll");
    s.scrollTop = s.scrollHeight;
  });
  await selectText("Restart-Service");
  await app.keys(["Control", "j"]);
  const bar = await app.waitFor(".ai-bar");
  await app.browser.pause(400);
  const r = await app.browser.execute(() => {
    const b = document.querySelector(".ai-bar").getBoundingClientRect();
    const s = document.querySelector(".pane.active .page-scroll").getBoundingClientRect();
    return { top: b.top, bottom: b.bottom, viewTop: s.top, viewBottom: s.bottom };
  });
  assert.ok(r.top >= r.viewTop - 1 && r.bottom <= r.viewBottom + 1, JSON.stringify(r));
  await app.shot("inline-ai-bottom");
  await app.keys(["Escape"]);
  await app.browser.setWindowSize(size.width, size.height);
  void bar;
});

test("page menu „Besprechung zusammenfassen“ streams a summary and inserts it at the end", async () => {
  await openFromTree("Jour fixe 22.09.");
  await app.browser.waitUntil(async () => (await (await app.$(".pane.active .page-title")).getValue()) === "Jour fixe 22.09.");
  await app.waitFor(".pane.active .ProseMirror h2");
  await app.click('.pane.active [aria-label="Weitere Aktionen"]');
  await app.waitFor(".menu");
  await clickText(".menu-item", /Besprechung zusammenfassen/);
  await app.waitFor('[role="dialog"][aria-label="Besprechung zusammenfassen"]');
  await app.waitText(".summary-preview h2", /Entscheidungen/);
  await app.waitText(".dialog-foot .btn", /Am Seitenende einfügen/);
  const html = await (await app.$(".summary-preview .prose")).getHTML();
  assert.match(html, /Offene Punkte/);
  await app.shot("meeting-summary");

  const user = transforms().pop().body.messages.find((m) => m.role === "user").content;
  assert.match(user, /Seite: „Jour fixe 22\.09\.“/);
  assert.match(user, /## Aufgaben/);
  assert.match(user, /Schulungstermine 2010 fixieren/, "the page body is sent");

  await clickText(".dialog-foot .btn", /Am Seitenende einfügen/);
  await app.waitText(".toast-title", /Zusammenfassung eingefügt/);
  await app.browser.waitUntil(async () => /## Zusammenfassung\n\nIm Jour fixe/.test(await content("Jour fixe 22.09.")), { timeout: 5000, timeoutMsg: "summary saved" });
  const md = await content("Jour fixe 22.09.");
  assert.match(md, /^- \[ \] Testplan an \[\[Architektur\]\] anpassen @Max due:2026-09-30 !!$/m);
  assert.ok(md.indexOf("## Zusammenfassung") > md.indexOf("Schulungstermine 2010 fixieren"), "appended after the notes");
  // The new task is picked up like any other.
  const tasks = await app.invoke("tasks_list", { filter: null });
  assert.ok(tasks.some((t) => /Testplan/.test(t.text) && t.due === "2026-09-30" && t.priority === 2), JSON.stringify(tasks));
});

test("/Zusammenfassung opens the summary; „Als neue Seite“ links back", async () => {
  await app.caretToEnd();
  await app.keys(["Enter"]);
  await app.type("/zusammenf");
  await app.waitText(".sugg-item.sel", /Zusammenfassung/);
  await app.keys(["Enter"]);
  await app.waitFor('[role="dialog"][aria-label="Besprechung zusammenfassen"]');
  await app.waitText(".dialog-foot .btn", /Als neue Seite/);
  await clickText(".dialog-foot .btn", /Als neue Seite/);
  await app.browser.waitUntil(async () => (await (await app.$(".pane.active .page-title")).getValue()) === "Jour fixe 22.09. – Zusammenfassung", {
    timeoutMsg: "summary page opened",
  });
  const md = await content("Jour fixe 22.09. – Zusammenfassung");
  assert.match(md, /^Zusammenfassung von \[\[Jour fixe 22\.09\.\]\]/);
  assert.match(md, /## Offene Punkte/);
});

test("no console errors", async () => {
  assert.deepEqual(await app.consoleErrors(), []);
});
