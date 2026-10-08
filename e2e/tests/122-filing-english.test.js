// Folders & filing (1.9), English, dark: the smart folders (recently edited, favorites, without
// folder, orphans, by tag, by Jira project, by network) expand to their pages and can be hidden;
// Shift-click selects a range, Ctrl-click adds to it, „Move to…“ moves all at once with a fuzzy
// folder picker and Undo; the tree filter keeps ancestors; keyboard selection; no German left in
// the new UI.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { guarded } from "../lib/harness.js";
import { launchEnglish, germanLeftovers } from "../lib/english.js";

const test = guarded(nodeTest, () => app);
let app, dataDir;
const ids = {};

const flat = (nodes) => nodes.flatMap((n) => [n, ...flat(n.children ?? [])]);
async function pathOf(id) {
  const pages = flat(await app.invoke("workspace_tree"));
  const byId = new Map(pages.map((p) => [p.id, p]));
  const parts = [];
  let p = byId.get(byId.get(id)?.parent_id);
  while (p) {
    parts.unshift(p.title);
    p = byId.get(p.parent_id);
  }
  return parts.join(" / ");
}
async function reload() {
  await app.browser.execute(() => location.reload());
  await app.browser.pause(300);
  await app.browser.waitUntil(() => app.browser.execute(() => document.body.classList.contains("ready")), { timeout: 20000, timeoutMsg: "not ready after reload" });
}
const rowIndex = (title) => app.browser.execute((t) => [...document.querySelectorAll(".sidebar .tree-row")].findIndex((r) => r.querySelector(".tree-label")?.textContent === t), title);
async function row(title) {
  await app.browser.waitUntil(async () => (await rowIndex(title)) >= 0, { timeout: 8000, timeoutMsg: `no tree row ${title}` });
  return (await app.$$(".sidebar .tree-row"))[await rowIndex(title)];
}
async function expand(title) {
  const r = await row(title);
  if ((await r.getAttribute("aria-expanded")) === "false") await (await r.$(".tree-twisty")).click();
}
/** Clicks a row with modifier keys held (WebDriver key actions). */
async function clickWith(title, key) {
  const r = await row(title);
  await app.browser.performActions([{ type: "key", id: "k", actions: [{ type: "keyDown", value: key }] }]);
  await r.click();
  await app.browser.releaseActions();
}
const visibleRows = () => app.browser.execute(() => [...document.querySelectorAll(".sidebar .tree-row .tree-label")].map((e) => e.textContent));
const selectedRows = () => app.browser.execute(() => [...document.querySelectorAll(".sidebar .tree-row.selected .tree-label")].map((e) => e.textContent));
const smartClick = (label) =>
  app.browser.execute((l) => {
    const b = [...document.querySelectorAll(".smart-row")].find((x) => x.querySelector(".tree-label")?.textContent === l);
    b?.click();
    return !!b;
  }, label);
const smartTexts = () => app.browser.execute(() => [...document.querySelectorAll(".smart-folders .tree-label")].map((e) => e.textContent));
const menuClick = (label) =>
  app.browser.execute((l) => {
    const item = [...document.querySelectorAll(".menu-item, [role^=menuitem]")].find((b) => b.textContent.trim().startsWith(l));
    item?.click();
    return !!item;
  }, label);

before(async () => {
  ({ app, dataDir } = await launchEnglish());
  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", { settings: { ...view.settings, theme: "dark" } });
  const make = async (title, parentId = null, content) => (ids[title] = (await app.invoke("page_create", { title, parentId, content: content ?? null })).id);
  await make("Clients");
  for (const t of ["Alpha", "Beta", "Gamma"]) await make(t, ids.Clients, `Notes on ${t}`);
  await make("Archive");
  await make("Old stuff", ids.Archive, "Kept");
  await make("Lonely", null, "Nobody links here");
  await make("Tagged", null, "About #client-x");
  await make("Ticket note", null, "---\njira: XYZ-7\n---\n");
  await app.invoke("page_set_favorite", { id: ids.Tagged, favorite: true }).catch(() => {});
  await reload();
});
after(async () => {
  await app?.close();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

test("smart folders expand to their lists and can be hidden", async () => {
  await app.waitFor(".smart-head");
  if ((await (await app.$(".smart-head")).getAttribute("aria-expanded")) === "false") await app.click(".smart-head");
  await app.waitFor(".smart-kind");
  const kinds = await app.browser.execute(() => [...document.querySelectorAll(".smart-folder > .smart-kind .tree-label")].map((e) => e.textContent));
  assert.deepEqual(kinds, ["Recently edited", "Favorites", "Without folder", "Orphaned pages", "By tag", "By Jira project", "By network"]);
  assert.ok(await smartClick("Without folder"));
  await app.browser.waitUntil(async () => (await smartTexts()).includes("Lonely"), { timeoutMsg: "Lonely not listed" });
  assert.ok(!(await smartTexts()).includes("Alpha"), "a page in a folder is not without folder");
  assert.ok(await smartClick("Orphaned pages"));
  assert.ok(await smartClick("By tag"));
  await app.browser.waitUntil(async () => (await smartTexts()).includes("#client-x"), { timeoutMsg: "no tag group" });
  assert.ok(await smartClick("#client-x"));
  assert.ok(await smartClick("By Jira project"));
  await app.browser.waitUntil(async () => (await smartTexts()).includes("XYZ"), { timeoutMsg: "no Jira group" });
  assert.ok(await smartClick("XYZ"));
  await app.browser.waitUntil(async () => (await smartTexts()).includes("Ticket note"), { timeoutMsg: "no Jira page" });
  await app.shot("122-smart-folders-dark");
  // A page opens from the list.
  await app.browser.execute(() => [...document.querySelectorAll(".smart-page")].find((b) => b.textContent === "Lonely")?.click());
  await app.waitText(".tab.active", /Lonely/);
  // Counts come from the core.
  const counts = await app.invoke("smart_counts");
  assert.ok(counts.unfiled >= 3 && counts.tags >= 1 && counts.jira === 1, JSON.stringify(counts));

  // Hidden from the tree options, and back.
  await app.click(".side-toolbar .tree-options");
  assert.ok(await menuClick("Hide smart folders"));
  await app.browser.waitUntil(async () => (await app.$$(".smart-folders")).length === 0, { timeoutMsg: "not hidden" });
  await app.click(".side-toolbar .tree-options");
  assert.ok(await menuClick("Show smart folders"));
  await app.waitFor(".smart-folders");
  // Collapsed again for the next tests.
  await app.click(".smart-head");
});

test("multi-select with Shift and Ctrl, move to a folder, undo", async () => {
  await expand("Clients");
  await (await row("Alpha")).click();
  await clickWith("Gamma", ""); // Shift
  assert.deepEqual(await selectedRows(), ["Alpha", "Beta", "Gamma"]);
  await app.waitText(".tree-selection", /3 selected/);
  // The bar fits the sidebar: its clear button is not cut off at the edge.
  const fit = await app.browser.execute(() => {
    const bar = document.querySelector(".tree-selection").getBoundingClientRect();
    const x = document.querySelector(".tree-selection > .icon-btn").getBoundingClientRect();
    return { bar: Math.round(bar.right), x: Math.round(x.right), rows: Math.round(bar.height) };
  });
  assert.ok(fit.x <= fit.bar, `clear button at ${fit.x}, bar ends at ${fit.bar}`);
  await clickWith("Beta", ""); // Ctrl: out of the selection
  assert.deepEqual(await selectedRows(), ["Alpha", "Gamma"]);
  await app.shot("122-multiselect-dark");
  await app.browser.execute(() => [...document.querySelectorAll(".tree-selection button")].find((b) => b.textContent.trim() === "Move to…")?.click());
  await app.waitText(".dialog-title", /Move to/);
  await app.waitText(".dialog-desc", /2 pages and their subpages/);
  await app.type("arch");
  await app.browser.waitUntil(async () => /Archive/.test(await app.text(".move-opt.cursor")), { timeoutMsg: "Archive not first" });
  await app.keys(["Enter"]);
  await app.waitText(".toast-title", /2 pages moved/);
  assert.equal(await pathOf(ids.Alpha), "Archive");
  assert.equal(await pathOf(ids.Gamma), "Archive");
  assert.equal(await pathOf(ids.Beta), "Clients");
  await app.browser.execute(() => [...document.querySelectorAll(".toast button")].find((b) => b.textContent.trim() === "Undo")?.click());
  await app.waitText(".toast-title", /2 pages moved back/);
  assert.equal(await pathOf(ids.Alpha), "Clients");

  // One page from the context menu, picked with the mouse.
  await (await row("Beta")).click({ button: "right" });
  assert.ok(await menuClick("Move"));
  assert.ok(await menuClick("Move to…"));
  await app.waitText(".dialog-desc", /“Beta” and its subpages/);
  await app.browser.execute(() => [...document.querySelectorAll(".move-opt")].find((o) => o.querySelector(".move-title")?.textContent === "Top level")?.click());
  await app.waitText(".toast-title", /1 page moved/);
  assert.equal(await pathOf(ids.Beta), "");
});

test("filter keeps ancestors, keyboard selection, Escape clears", async () => {
  const input = await app.$(".tree-filter input");
  await input.click();
  await app.type("gam");
  await app.browser.waitUntil(async () => (await visibleRows()).length === 2, { timeoutMsg: "not filtered" });
  assert.deepEqual(await visibleRows(), ["Clients", "Gamma"]);
  await app.shot("122-filter-dark");
  await app.keys(["Escape"]);
  await app.browser.waitUntil(async () => (await visibleRows()).length > 2, { timeoutMsg: "filter not cleared" });
  await input.click();
  await app.type("zzqq");
  await app.waitText(".tree-filter-empty", /No page matches “zzqq”/);
  await app.keys(["Escape"]);

  // Keyboard: Shift+Down extends the selection, Escape clears it.
  await expand("Clients");
  const alpha = await row("Alpha");
  await app.browser.execute((el) => el.focus(), alpha);
  await app.keys(["Shift", "ArrowDown"]);
  await app.keys(["Shift"]);
  assert.deepEqual(await selectedRows(), ["Alpha", "Gamma"]);
  await app.keys(["Escape"]);
  assert.deepEqual(await selectedRows(), []);
});

test("English settings and tidy-up have no German left", async () => {
  await app.keys(["Control", ","]);
  await app.waitFor(".settings-body");
  await app.click('.settings-nav-item[data-section="filing"]');
  await app.waitText(".set-group-head h2", /Where new pages go/);
  await app.waitText(".set-row-desc", /Example: Voice notes \/ \d{4} \/ \d\d – [A-Z][a-z]+/);
  const left = await germanLeftovers(app, [/Arcalo/]);
  assert.deepEqual(left.filter((l) => /filing|folder|rule|Subfolders|Journal|Meetings|Voice|Jira|Bookmarks|Inbox|Rule|Test/i.test(l)), []);
  await app.shot("122-filing-settings-dark");
  await app.keys(["Control", "k"]);
  await app.waitFor(".palette input");
  await app.type("Tidy up");
  await app.browser.pause(250);
  await app.keys(["Enter"]);
  await app.waitText(".dialog-title", /Tidy up/);
  await app.browser.waitUntil(async () => (await app.$$(".tidy-loading")).length === 0, { timeoutMsg: "plan not loaded" });
  const dialogText = await app.text(".dialog");
  assert.ok(!/[äöüß„]|Seite|Aufräumen|verschieben/.test(dialogText), dialogText);
  await app.keys(["Escape"]);
});
