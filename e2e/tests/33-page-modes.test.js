// Next to the star: full width and the Markdown source mode, per page; also by shortcut.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
before(async () => (app = await launch()));
after(async () => app?.close());

const openTree = async (title) => {
  for (const r of await app.$$(".sidebar .tree-row")) if ((await app.textOf(r)) === title) return r.click();
  throw new Error(`no ${title}`);
};
const width = () => app.browser.execute(() => document.querySelector(".pane.active .page").getBoundingClientRect().width);
const content = async (title) => (await app.invoke("page_get", { id: (await app.invoke("page_resolve", { title, create: false })).id })).content;

test("full width: the text uses the whole pane, per page, and comes back", async () => {
  // Without the side panel the pane is wider than the normal text width.
  await app.browser.execute(() => {
    if (document.querySelector(".app > .panel")) document.querySelector(".workspace > .pane:last-child .tabbar > button:last-of-type").click();
  });
  await openTree("Architektur");
  await app.waitFor(".pane.active .ProseMirror h2");
  const normal = await width();
  await app.click('.pane.active .vh [aria-label^="Volle Breite"]');
  await app.browser.waitUntil(async () => (await width()) > normal + 100, { timeoutMsg: "not wider" });
  await app.shot("page-full-width");
  // Another page keeps its own setting.
  await openTree("SAP CATS Leitfaden");
  await app.waitFor(".pane.active .ProseMirror");
  assert.ok(Math.abs((await width()) - normal) < 2, "other page unchanged");
  await openTree("Architektur");
  await app.waitFor(".pane.active .ProseMirror h2");
  assert.ok((await width()) > normal + 100, "remembered");
  await app.keys(["Control", "Shift", "l"]);
  await app.browser.waitUntil(async () => Math.abs((await width()) - normal) < 2, { timeoutMsg: "shortcut did not toggle back" });
});

test("Markdown source: the file as text, edits save, the visual editor shows them", async () => {
  await openTree("Architektur");
  await app.waitFor(".pane.active .ProseMirror h2");
  await app.click('.pane.active .vh [aria-label^="Markdown-Quelltext"]');
  const ta = await app.waitFor(".pane.active .source-text");
  const text = await ta.getValue();
  assert.equal(text, await content("Architektur"), "exactly the stored file");
  assert.match(await app.text(".pane.active .vh-mode"), /Markdown/i);
  // Enter continues a list; the edit is saved.
  await app.browser.execute(() => {
    const t = document.querySelector(".pane.active .source-text");
    t.focus();
    t.setSelectionRange(t.value.length, t.value.length);
  });
  await app.keys(["Enter"]);
  await app.browser.execute(() => {
    const t = document.querySelector(".pane.active .source-text");
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    setter.call(t, t.value + "- Quelltext eins");
    t.dispatchEvent(new Event("input", { bubbles: true }));
    t.setSelectionRange(t.value.length, t.value.length);
  });
  await app.keys(["Enter"]);
  await app.browser.execute(() => {
    const t = document.querySelector(".pane.active .source-text");
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    setter.call(t, t.value + "zwei");
    t.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await app.browser.waitUntil(async () => (await content("Architektur")).includes("- Quelltext eins\n- zwei"), { timeoutMsg: `not saved: ${JSON.stringify((await content("Architektur")).slice(-80))}` });
  await app.shot("page-source-mode");
  await app.keys(["Control", "Shift", "m"]);
  await app.browser.waitUntil(async () => app.browser.execute(() => !!document.querySelector(".pane.active .ProseMirror") && !document.querySelector(".pane.active .source-text")), { timeoutMsg: "no visual editor" });
  await app.waitText(".pane.active .ProseMirror", /Quelltext eins/);
  assert.ok(await app.browser.execute(() => !!document.querySelector(".pane.active .vh .editor-toolbar")), "toolbar back in the header");
});

test("no console errors", async () => {
  assert.deepEqual(await app.browser.execute(() => window.__annaloErrors ?? []), []);
});
