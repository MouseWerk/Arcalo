// Page embeds (1.9): `![[Seite]]`, `![[Seite#Überschrift]]` and `![[Seite#^block]]` render live
// and read-only in a frame with the source as a link, collapse, follow edits of the source in
// another pane, stop at cycles, and show a calm „nicht gefunden“ with „Seite anlegen“. The
// Markdown stays as written, embeds count as backlinks, `![[` completes pages and headings, and
// HTML share and print show the embedded content.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
const ids = {};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "arcalo-e2e-123-"));

const QUELLE = "# Quelle\nEinleitung Quelle\n\n## Ziele\nSchnell liefern.\n\n### Unterpunkt\nDetail zum Ziel.\n\n## Risiken\nZu spät geliefert. ^risk1\n";
const HOST = "[[Quelle]]\n\n![[Quelle]]\n\n![[Quelle#Ziele]]\n\n![[Quelle#^risk1]]\n\n![[Kreis A]]\n\n![[Gibt es nicht]]\n\n![[Quelle#Fehlt]]\n";

const menuClick = (label) =>
  app.browser.execute((l) => {
    const item = [...document.querySelectorAll(".menu-item, [role^=menuitem]")].find((b) => b.textContent.trim().startsWith(l));
    item?.click();
    return !!item;
  }, label);
const content = async (id) => (await app.invoke("page_get", { id })).content;
async function open(id, title) {
  await app.invoke("search_open", { target: { kind: "page", page_id: id, new_tab: false } });
  await app.browser.waitUntil(async () => (await app.browser.execute(() => document.querySelector(".pane.active .page-title")?.value)) === title, { timeoutMsg: `${title} not open` });
  await app.waitFor(".pane.active .ProseMirror");
}
/** The embeds of the active pane's page, top level only: state and text. */
const embeds = (pane = ".pane.active") =>
  app.browser.execute(
    (p) =>
      [...document.querySelectorAll(`${p} .ProseMirror > p > .page-embed`)].map((e) => ({
        state: e.dataset.state,
        title: e.querySelector(":scope > .pe-head .pe-title")?.textContent ?? "",
        text: e.querySelector(":scope > .pe-body")?.innerText ?? "",
      })),
    pane,
  );
async function scrollAll() {
  // Embeds render as they come into view.
  for (let i = 0; i < 8; i++) {
    await app.browser.execute((n) => document.querySelectorAll(".pane.active .ProseMirror > p > .page-embed")[n]?.scrollIntoView({ block: "center" }), i);
    await app.browser.pause(120);
  }
}

before(async () => {
  app = await launch();
  ids.quelle = (await app.invoke("page_create", { parentId: null, title: "Quelle", icon: null, content: QUELLE })).id;
  ids.a = (await app.invoke("page_create", { parentId: null, title: "Kreis A", icon: null, content: "Text A\n\n![[Kreis B]]\n" })).id;
  ids.b = (await app.invoke("page_create", { parentId: null, title: "Kreis B", icon: null, content: "Text B\n\n![[Kreis A]]\n" })).id;
  ids.host = (await app.invoke("page_create", { parentId: null, title: "Einbettungen", icon: null, content: HOST })).id;
});
after(async () => {
  await app?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("page, heading and block embeds render read-only with their source as a link", async () => {
  await open(ids.host, "Einbettungen");
  await scrollAll();
  await app.browser.waitUntil(async () => (await embeds()).filter((e) => e.state === "ready").length >= 4, { timeout: 10000, timeoutMsg: "embeds not rendered" });
  const [page, heading, block, circle, missing, noSection] = await embeds();
  assert.equal(page.title, "Quelle");
  assert.match(page.text, /Einleitung Quelle[\s\S]*Schnell liefern\.[\s\S]*Zu spät geliefert\./);
  assert.doesNotMatch(page.text, /\^risk1/, "block ids are hidden");
  assert.equal(heading.title, "Quelle › Ziele");
  assert.match(heading.text, /Ziele\s+Schnell liefern\.[\s\S]*Unterpunkt\s+Detail zum Ziel\./, "the section with its subheadings");
  assert.doesNotMatch(heading.text, /Risiken|Einleitung/, "up to the next heading of the same level");
  assert.equal(block.title, "Quelle › ^risk1");
  assert.equal(block.text.trim(), "Zu spät geliefert.");
  assert.equal(circle.state, "ready");
  // A embeds B embeds A: the inner one is a notice.
  await app.browser.waitUntil(() => app.browser.execute(() => !!document.querySelector('.pane.active .page-embed .page-embed .page-embed[data-state="cycle"]')), { timeoutMsg: "no cycle notice" });
  assert.match(await app.browser.execute(() => document.querySelector('.pane.active .page-embed[data-state="cycle"] .pe-notice').innerText), /„Kreis A“ wird um diese Einbettung herum schon gezeigt/);
  assert.equal(missing.state, "missing");
  assert.match(missing.text, /Eine Seite „Gibt es nicht“ gibt es noch nicht\.\s*Seite anlegen/);
  assert.equal(noSection.state, "missing");
  assert.match(noSection.text, /„Fehlt“ wurde in „Quelle“ nicht gefunden\./);
  // The editor's text does not swallow the embedded content.
  assert.equal(await content(ids.host), HOST, "the Markdown stays as written");
  await app.shot("123-embeds");
});

test("„Seite anlegen“ creates the missing page in place; collapse; the title opens the source", async () => {
  await app.browser.execute(() => document.querySelector('.pane.active .page-embed[data-state="missing"] .pe-create').click());
  await app.browser.waitUntil(async () => (await app.invoke("page_resolve", { title: "Gibt es nicht", create: false })) !== null, { timeoutMsg: "page not created" });
  await app.browser.waitUntil(async () => (await embeds())[4]?.text.includes("Die Seite ist leer."), { timeout: 8000, timeoutMsg: "created page not shown" });
  assert.equal(await content(ids.host), HOST, "creating the page does not touch the Markdown");

  await app.browser.execute(() => document.querySelector(".pane.active .page-embed .pe-toggle").click());
  assert.ok(await app.browser.execute(() => document.querySelector(".pane.active .page-embed").classList.contains("is-collapsed")));
  assert.equal(await app.browser.execute(() => getComputedStyle(document.querySelector(".pane.active .page-embed .pe-body")).display), "none");
  assert.equal(await app.browser.execute(() => document.querySelector(".pane.active .page-embed .pe-toggle").getAttribute("aria-expanded")), "false");
  await app.browser.execute(() => document.querySelector(".pane.active .page-embed .pe-toggle").click());

  // Embeds are backlinks of their page.
  const doc = await app.invoke("page_get", { id: ids.quelle });
  assert.ok(doc.backlinks.some((b) => b.page_id === ids.host), "the embedding page is a backlink");
});

test("an embed follows edits of its source in another pane", async () => {
  await app.click('.pane.active .page-view [aria-label="Weitere Aktionen"]');
  assert.ok(await menuClick("Rechts daneben öffnen"));
  await app.browser.waitUntil(() => app.browser.execute(() => document.querySelectorAll(".pane").length === 2), { timeoutMsg: "no split" });
  // In the right pane, the embed's title opens the source.
  await app.browser.waitUntil(() => app.browser.execute(() => !!document.querySelector(".pane.active .page-embed .pe-title")));
  await app.browser.execute(() => document.querySelector(".pane.active .page-embed .pe-title").dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 })));
  await app.browser.waitUntil(async () => (await app.browser.execute(() => document.querySelector(".pane.active .page-title")?.value)) === "Quelle", { timeoutMsg: "title did not open the page" });
  await app.waitFor(".pane.active .ProseMirror");
  // Type at the end of „Einleitung Quelle“.
  await app.browser.execute(() => {
    const pm = document.querySelector(".pane.active .ProseMirror");
    pm.focus();
    const p = [...pm.querySelectorAll("p")].find((e) => e.textContent === "Einleitung Quelle");
    const r = document.createRange();
    r.selectNodeContents(p);
    r.collapse(false);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  });
  await app.type(" live");
  await app.browser.waitUntil(async () => /Einleitung Quelle live/.test(await content(ids.quelle)), { timeout: 8000, timeoutMsg: "source not saved" });
  const other = ".pane:not(.active)";
  await app.browser.waitUntil(async () => (await embeds(other))[0]?.text.includes("Einleitung Quelle live"), { timeout: 8000, timeoutMsg: "embed did not update" });
  await app.shot("123-embeds-live");
  // Back to one pane.
  await app.browser.execute(() => document.querySelector(".pane.active .tab.active .tab-close")?.click());
  await app.browser.waitUntil(() => app.browser.execute(() => document.querySelectorAll(".pane").length === 1), { timeoutMsg: "split not closed" });
});

test("`![[` completes pages, then headings after #", async () => {
  ids.neu = (await app.invoke("page_create", { parentId: null, title: "Neu eingebettet", icon: null, content: "Start\n" })).id;
  await open(ids.neu, "Neu eingebettet");
  await app.caretToEnd();
  await app.keys(["Enter"]);
  for (const k of "![[Quel") await app.keys([k]);
  await app.browser.waitUntil(() => app.browser.execute(() => [...document.querySelectorAll(".sugg-item")].some((e) => e.textContent.includes("Quelle"))), { timeoutMsg: "no page suggestion" });
  await app.keys(["Enter"]);
  await app.browser.waitUntil(() => app.browser.execute(() => !!document.querySelector(".pane.active .ProseMirror .page-embed")), { timeoutMsg: "no embed inserted" });
  await app.keys(["Enter"]);
  for (const k of "![[Quelle#Zi") await app.keys([k]);
  await app.browser.waitUntil(() => app.browser.execute(() => [...document.querySelectorAll(".sugg-item")].some((e) => e.textContent.includes("## Ziele"))), { timeoutMsg: "no heading suggestion" });
  await app.keys(["Enter"]);
  await app.browser.waitUntil(async () => /!\[\[Quelle\]\][\s\S]*!\[\[Quelle#Ziele\]\]/.test(await content(ids.neu)), { timeout: 8000, timeoutMsg: `not saved: ${await content(ids.neu)}` });
});

test("HTML share and print contain the embedded content", async () => {
  const file = path.join(tmp, "einbettungen.html");
  await app.browser.execute((id, p) => window.dispatchEvent(new CustomEvent("arcalo:share-html", { detail: { id, path: p } })), ids.host, file);
  await app.browser.waitUntil(() => fs.existsSync(file), { timeout: 10000, timeoutMsg: "HTML file not written" });
  const html = fs.readFileSync(file, "utf8");
  assert.match(html, /<section class="embed"><div class="embed-title"><span>Quelle › Ziele<\/span><\/div><div class="embed-body">/);
  assert.match(html, /Schnell liefern\./);
  assert.match(html, /„Kreis A“ wird um diese Einbettung herum schon gezeigt/);
  assert.match(html, /„Fehlt“ wurde in „Quelle“ nicht gefunden\./);
  assert.doesNotMatch(html, /!\[\[/, "no raw embed syntax");

  // Print: a collapsed embed far down is rendered and shown before the dialog.
  await open(ids.host, "Einbettungen");
  await app.browser.execute(() => {
    window.__printed = null;
    window.print = () => (window.__printed = document.querySelector(".pane.active .ProseMirror").innerText);
  });
  await app.click('.pane.active .page-view [aria-label="Weitere Aktionen"]');
  assert.ok(await menuClick("Drucken / als PDF"));
  await app.browser.waitUntil(() => app.browser.execute(() => window.__printed != null), { timeout: 10000, timeoutMsg: "print not reached" });
  const printed = await app.browser.execute(() => window.__printed);
  assert.match(printed, /Zu spät geliefert\./);
  assert.match(printed, /Text B/, "nested embeds rendered for print");
});
