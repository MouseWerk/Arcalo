import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
before(async () => (app = await launch()));
after(async () => app?.close());

const pageId = async (title) => (await app.invoke("page_resolve", { title, create: false })).id;
const content = async (title) => (await app.invoke("page_get", { id: await pageId(title) })).content;
const openFromTree = async (title) => {
  const rows = await app.$$(".sidebar .tree-row");
  for (const r of rows) if ((await app.textOf(r)) === title) return r.click();
  throw new Error(`tree row ${title} not found`);
};
const editorEnd = async () => {
  await app.caretToEnd();
};

test("opens a page from the tree and renders markdown", async () => {
  await openFromTree("Architektur");
  await app.waitFor(".ProseMirror h2");
  assert.equal(await (await app.$(".page-title")).getValue(), "Architektur");
  const html = await (await app.$(".ProseMirror")).getHTML();
  assert.match(html, /<strong>Inbound<\/strong>/);
  assert.match(html, /<blockquote/);
  assert.match(html, /<pre/);
  await app.shot("notes-architektur");
});

test("typing is saved as markdown", async () => {
  await editorEnd();
  await app.keys(["Enter"]);
  await app.type("Neuer Absatz mit **fett**");
  await app.browser.pause(900);
  assert.match(await content("Architektur"), /Neuer Absatz mit \*\*fett\*\*/);
});

test("slash menu turns a line into a heading", async () => {
  await editorEnd();
  await app.keys(["Enter"]);
  await app.type("/ueber");
  await app.waitFor(".sugg");
  await app.shot("notes-slash-menu");
  await app.waitText(".sugg-item.sel", /Überschrift/);
  await app.keys(["Escape"]);
  for (let i = 0; i < 6; i++) await app.keys(["Backspace"]);
  await app.type("/h2");
  await app.waitText(".sugg-item.sel", /Überschrift 2/);
  await app.keys(["Enter"]);
  await app.type("Offene Punkte");
  await app.browser.pause(900);
  assert.match(await content("Architektur"), /^## Offene Punkte$/m);
});

test("[[ autocomplete inserts a wiki link that navigates", async () => {
  await editorEnd();
  await app.keys(["Enter"]);
  await app.type("Siehe [[Jour fi");
  await app.waitText(".sugg-item.sel", /Jour fixe 22\.09\./);
  await app.shot("notes-link-suggest");
  await app.keys(["Enter"]);
  await app.browser.waitUntil(async () => /Siehe \[\[Jour fixe 22\.09\.\]\]/.test(await content("Architektur")), { timeout: 4000 });
  const links = await app.$$(".ProseMirror a.wikilink");
  const last = links[links.length - 1];
  assert.equal(await app.textOf(last), "Jour fixe 22.09.");
  await last.click();
  await app.browser.waitUntil(async () => (await (await app.$(".page-title")).getValue()) === "Jour fixe 22.09.");
});

test("backlinks list the linking pages", async () => {
  await app.waitText(".backlink-title", /Architektur/);
  await app.waitText(".backlink-title", /PRJ-2026-X Rollout/);
});

test("renaming a page rewrites links in other pages", async () => {
  const title = await app.$(".page-title");
  await title.click();
  await app.keys(["Control", "a"]);
  await app.type("Jour fixe KW39");
  await app.keys(["Enter"]);
  await app.waitText(".toast-title", /Umbenannt/);
  assert.match(await content("Architektur"), /\[\[Jour fixe KW39\]\]/);
  assert.match(await content("PRJ-2026-X Rollout"), /\[\[Jour fixe KW39\]\]/);
  await app.waitText(".sidebar .tree-row", /Jour fixe KW39/);
});

test("clicking an unresolved link creates the page", async () => {
  await openFromTree("Willkommen");
  await editorEnd();
  await app.keys(["Enter"]);
  await app.type("Neu: [[Lessons Learned");
  await app.waitText(".sugg-item", /neu verlinken/);
  await app.keys(["Enter"]);
  const link = await app.waitFor(".ProseMirror a.wikilink.unresolved");
  await link.click();
  await app.browser.waitUntil(async () => (await (await app.$(".page-title")).getValue()) === "Lessons Learned");
  await app.waitText(".backlink-title", /Willkommen/);
});

test("tags are highlighted and open a tag view", async () => {
  await openFromTree("SAP CATS Leitfaden");
  const tag = await app.waitFor('.ProseMirror .tag[data-tag="sap"]');
  await tag.click();
  await app.waitText(".tag-heading", /sap/);
  await app.waitText(".page-list-item", /SAP CATS Leitfaden/);
});

test("command palette searches titles and content", async () => {
  await app.keys(["Control", "k"]);
  await app.waitFor(".palette");
  await app.type("middleware");
  await app.waitText(".pal-item", /Architektur/);
  await app.shot("palette-search");
  await app.keys(["Escape"]);
  await app.keys(["Control", "o"]);
  await app.type("cats");
  await app.waitText(".pal-item.sel", /SAP CATS Leitfaden/);
  await app.keys(["Enter"]);
  await app.browser.waitUntil(async () => (await (await app.$(".page-title")).getValue()) === "SAP CATS Leitfaden");
});

test("new page via Ctrl+N, then delete with confirmation", async () => {
  await app.keys(["Control", "n"]);
  await app.browser.waitUntil(async () => (await (await app.$(".page-title")).getValue()) === "Unbenannt");
  await app.browser.waitUntil(() => app.browser.execute(() => document.activeElement?.classList.contains("page-title") && document.activeElement.selectionEnd > 0));
  await app.type("Wegwerfseite");
  await app.keys(["Enter"]);
  await app.type("Inhalt");
  await app.browser.pause(700);
  const rows = await app.$$(".sidebar .tree-row");
  let row;
  for (const r of rows) if ((await app.textOf(r)) === "Wegwerfseite") row = r;
  assert.ok(row, "new page in tree");
  await row.click({ button: "right" });
  await app.waitFor(".menu");
  await app.shot("tree-context-menu");
  await app.click(".menu-item.danger");
  await app.waitText(".toast-title", /Seite gelöscht/);
  assert.equal(await app.invoke("page_resolve", { title: "Wegwerfseite", create: false }), null);
});

test("daily note opens from the sidebar with the template", async () => {
  await app.click(".ribbon [aria-label^=\"Heutige\"]");
  await app.waitText(".page-subtitle", /\d{4}/);
  const html = await (await app.$(".ProseMirror")).getHTML();
  assert.match(html, /Fokus/);
  assert.match(html, /data-type="taskList"/);
  await app.shot("daily-note");
});

test("tabs: „In neuem Tab öffnen“ opens a new tab, Ctrl+W closes it; Ctrl+click selects", async () => {
  const before = (await app.$$(".tab")).length;
  const row = async (title) => {
    for (const r of await app.$$(".sidebar .tree-row")) if ((await app.textOf(r)) === title) return r;
    throw new Error(`no row ${title}`);
  };
  await app.browser.performActions([{ type: "key", id: "k", actions: [{ type: "keyDown", value: "\uE009" }] }]);
  await (await row("Architektur")).click();
  await app.browser.releaseActions();
  await app.browser.waitUntil(async () => (await app.$$(".sidebar .tree-row.selected")).length >= 1, { timeoutMsg: "Ctrl+click did not select" });
  assert.equal((await app.$$(".tab")).length, before, "Ctrl+click opens no tab");
  // Escape on the tree ends the selection.
  await app.browser.execute(() => document.querySelector(".sidebar .tree-row.selected")?.focus());
  await app.keys(["Escape"]);
  await app.browser.waitUntil(async () => (await app.$$(".sidebar .tree-row.selected")).length === 0, { timeoutMsg: "selection kept" });
  // A page that is not open yet (an open page is focused, not opened twice).
  const open = await app.browser.execute(() => [...document.querySelectorAll(".tab")].map((t) => t.textContent.trim()));
  const target = (await app.browser.execute(() => [...document.querySelectorAll(".sidebar .tree-row .tree-label")].map((e) => e.textContent))).find((t) => t && !open.includes(t) && t !== "Journal");
  await (await row(target)).click({ button: "right" });
  await app.waitFor(".menu");
  await app.browser.execute(() => [...document.querySelectorAll(".menu .menu-item")].find((b) => b.textContent.includes("In neuem Tab öffnen"))?.click());
  const tabTitles = () => app.browser.execute(() => [...document.querySelectorAll(".tab")].map((t) => t.textContent.trim()));
  await app.browser.waitUntil(async () => (await tabTitles()).includes(target), { timeoutMsg: "not opened in a tab" });
  const n = (await tabTitles()).length;
  await app.keys(["Control", "w"]);
  await app.browser.waitUntil(async () => (await tabTitles()).length === n - 1 || !(await tabTitles()).includes(target), { timeoutMsg: "Ctrl+W did not close" });
});

test("Ctrl+F finds and steps through matches", async () => {
  await openFromTree("Architektur");
  await app.waitFor(".ProseMirror");
  await (await app.$(".ProseMirror")).click();
  await app.keys(["Control", "f"]);
  const input = await app.waitFor(".find-bar input");
  await input.setValue("architektur");
  await app.browser.waitUntil(async () => (await app.$$(".find-hit")).length >= 1);
  await app.keys(["Enter"]);
  await app.waitFor(".find-hit.current");
  await app.shot("find-in-page");
  await app.keys(["Escape"]);
  await app.browser.waitUntil(async () => (await app.$$(".find-bar")).length === 0);
});

test("code blocks are syntax highlighted and saved with language", async () => {
  await openFromTree("SAP CATS Leitfaden");
  await editorEnd();
  await app.keys(["Enter"]);
  await app.type("```ts ");
  await app.type("const x = 42;");
  await app.browser.pause(900);
  const html = await (await app.$(".ProseMirror")).getHTML();
  assert.match(html, /hljs-keyword/);
  assert.match(await content("SAP CATS Leitfaden"), /```ts\nconst x = 42;\n```/);
});

test("no console errors", async () => {
  assert.deepEqual(await app.consoleErrors(), []);
});
