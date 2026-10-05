// Pinned tabs (1.13): pin and unpin from the tab menu, the palette and a shortcut set in Settings →
// Tastatur; pinned tabs sit left in pin order, compact with a pin, named „…, angeheftet“; „Andere
// Tabs schließen“, „Alle Tabs schließen“ and a middle click leave them open; navigating from a
// pinned tab opens a new tab; they keep their state in a split pane and after a restart.
import { test as nodeTest, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "annalo-pins-"));
after(async () => {
  await app?.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** The tabs of a pane in order: title, pinned, has a close button. */
const tabs = (pane = 0) =>
  app.browser.execute(
    (i) =>
      [...(document.querySelectorAll(".pane")[i]?.querySelectorAll(".tab") ?? [])].map((t) => ({
        title: t.querySelector(".tab-title").textContent,
        pinned: t.classList.contains("pinned"),
        label: t.getAttribute("aria-label"),
        close: !!t.querySelector(".tab-close"),
        pin: !!t.querySelector(".tab-pin"),
      })),
    pane,
  );
const titles = async (pane = 0) => (await tabs(pane)).map((t) => `${t.title}${t.pinned ? "*" : ""}`);
const tabEl = async (title, pane = 0) => {
  const i = await app.browser.execute((t, p) => [...(document.querySelectorAll(".pane")[p]?.querySelectorAll(".tab") ?? [])].findIndex((x) => x.querySelector(".tab-title").textContent === t), title, pane);
  if (i < 0) throw new Error(`no tab ${title}`);
  return (await (await app.$$(".pane"))[pane].$$(".tab"))[i];
};
const menuPick = async (label) => {
  await app.waitFor(".menu");
  const ok = await app.browser.execute(
    (l) => {
      const item = [...document.querySelectorAll(".menu [role^=menuitem]")].find((m) => m.textContent.trim().startsWith(l));
      if (!item || item.getAttribute("aria-disabled") === "true") return false;
      item.click();
      return true;
    },
    label,
  );
  assert.ok(ok, `menu item „${label}“`);
  await sleep(250);
};
const tabMenu = async (title, label, pane = 0) => {
  await (await tabEl(title, pane)).click({ button: "right" });
  await menuPick(label);
};
let ids;

test("the tab menu and the palette pin tabs: left, in pin order, compact, named „angeheftet“", async () => {
  app = await launch({ width: 1280, height: 800, dataDir: path.join(dir, "data") });
  ids = [];
  for (const title of ["Pin Alpha", "Pin Beta", "Pin Gamma", "Pin Delta"]) ids.push((await app.invoke("page_create", { parentId: null, title, icon: null, content: "x\n" })).id);
  await app.invoke("search_open", { target: { kind: "page", page_id: ids[0], new_tab: false } });
  for (const id of ids.slice(1)) await app.invoke("search_open", { target: { kind: "page", page_id: id, new_tab: true } });
  await app.waitText(".pane.active .tab.active", /Pin Delta/);
  const before = await titles();
  assert.deepEqual(before.slice(-4), ["Pin Alpha", "Pin Beta", "Pin Gamma", "Pin Delta"]);

  await tabMenu("Pin Gamma", "Tab anheften");
  assert.equal((await titles())[0], "Pin Gamma*");
  // The palette pins the active tab.
  await (await tabEl("Pin Beta")).click();
  await app.keys(["Control", "k"]);
  await app.waitFor(".palette input");
  await app.type("Tab anheften");
  await app.browser.waitUntil(async () => /Tab anheften/.test(await app.browser.execute(() => document.querySelector(".pal-item.sel .pal-title")?.textContent ?? "")));
  await app.keys("Enter");
  await sleep(300);
  const list = await tabs();
  assert.deepEqual((await titles()).slice(0, 2), ["Pin Gamma*", "Pin Beta*"], "pin order");
  const beta = list.find((t) => t.title === "Pin Beta");
  assert.equal(beta.label, "Pin Beta, angeheftet");
  assert.equal(beta.close, false, "a pinned tab shows a pin instead of the close button");
  assert.equal(beta.pin, true);
  const widths = await app.browser.execute(() => [...document.querySelectorAll(".pane.active .tab")].map((t) => [t.classList.contains("pinned"), Math.round(t.getBoundingClientRect().width)]));
  const pinnedW = widths.filter(([p]) => p).map(([, w]) => w);
  assert.ok(Math.max(...pinnedW) <= 120, `pinned tabs are compact: ${JSON.stringify(widths)}`);
  // Their title is short: a longer one ends in an ellipsis.
  assert.ok(await app.browser.execute(() => [...document.querySelectorAll(".pane.active .tab.pinned .tab-title")].some((t) => t.scrollWidth > t.clientWidth)));
  await app.shot("280-pinned-tabs");
});

test("„Andere“, „Alle Tabs schließen“ and a middle click leave pinned tabs open; navigating opens a new tab", async () => {
  await tabMenu("Pin Delta", "Andere Tabs schließen");
  assert.deepEqual(await titles(), ["Pin Gamma*", "Pin Beta*", "Pin Delta"]);
  await app.invoke("search_open", { target: { kind: "page", page_id: ids[0], new_tab: true } });
  await app.waitText(".pane.active .tab.active", /Pin Alpha/);
  await tabMenu("Pin Alpha", "Alle Tabs schließen");
  assert.deepEqual(await titles(), ["Pin Gamma*", "Pin Beta*"]);
  // A middle click does not close a pinned tab.
  await app.browser.execute(() => document.querySelector(".pane.active .tab.pinned").dispatchEvent(new MouseEvent("auxclick", { bubbles: true, button: 1 })));
  await sleep(200);
  assert.deepEqual(await titles(), ["Pin Gamma*", "Pin Beta*"]);
  // Opening a page from the tree while a pinned tab is active keeps the pinned tab where it is.
  await (await tabEl("Pin Beta")).click();
  await app.click(`.sidebar .tree-row[data-id="${ids[0]}"]`);
  await app.waitText(".pane.active .tab.active", /Pin Alpha/);
  assert.deepEqual(await titles(), ["Pin Gamma*", "Pin Beta*", "Pin Alpha"]);
  await app.invoke("search_open", { target: { kind: "page", page_id: ids[3], new_tab: true } });
  await app.waitText(".pane.active .tab.active", /Pin Delta/);
  assert.deepEqual(await titles(), ["Pin Gamma*", "Pin Beta*", "Pin Alpha", "Pin Delta"]);
});

test("pinned tabs are reachable by keyboard and unpin from the menu opened with Shift+F10", async () => {
  await (await tabEl("Pin Gamma")).click();
  await app.browser.execute(() => document.querySelector(".pane.active .tab.active").focus());
  await app.keys("End");
  await app.keys("Home");
  assert.equal(await app.browser.execute(() => document.activeElement?.getAttribute("aria-label")), "Pin Gamma, angeheftet");
  await app.keys(["Shift", "F10"]);
  await menuPick("Nicht mehr anheften");
  // Unpinned, it comes first after the pinned ones.
  assert.deepEqual(await titles(), ["Pin Beta*", "Pin Gamma", "Pin Alpha", "Pin Delta"]);
  await tabMenu("Pin Gamma", "Tab anheften");
  assert.deepEqual(await titles(), ["Pin Beta*", "Pin Gamma*", "Pin Alpha", "Pin Delta"]);
});

test("a shortcut set in Settings → Tastatur pins the active tab", async () => {
  const v = await app.invoke("settings_get");
  await app.invoke("settings_save", { settings: { ...v.settings, keymap: { ...v.settings.keymap, pin_tab: "Ctrl+Shift+N" } } });
  await app.browser.refresh();
  await app.browser.waitUntil(async () => app.browser.execute(() => document.body.classList.contains("ready")), { timeout: 20000 });
  await sleep(600);
  // The reload kept the pins (the layout is read back).
  assert.deepEqual(await titles(), ["Pin Beta*", "Pin Gamma*", "Pin Alpha", "Pin Delta"]);
  await (await tabEl("Pin Delta")).click();
  await app.keys(["Control", "Shift", "n"]);
  await sleep(300);
  assert.deepEqual(await titles(), ["Pin Beta*", "Pin Gamma*", "Pin Delta*", "Pin Alpha"]);
  await app.keys(["Control", "Shift", "n"]);
  await sleep(300);
  assert.deepEqual(await titles(), ["Pin Beta*", "Pin Gamma*", "Pin Delta", "Pin Alpha"]);
});

test("pinned tabs keep their state in a split pane and after a restart", async () => {
  await tabMenu("Pin Delta", "Rechts daneben öffnen");
  await app.browser.waitUntil(async () => (await app.browser.execute(() => document.querySelectorAll(".pane").length)) === 2);
  await tabMenu("Pin Beta", "In den anderen Bereich", 0);
  await sleep(300);
  assert.deepEqual(await titles(0), ["Pin Gamma*", "Pin Delta", "Pin Alpha"]);
  assert.deepEqual(await titles(1), ["Pin Beta*", "Pin Delta"]);
  await app.browser.setWindowSize(1000, 800);
  await sleep(500);
  // A narrow pane shows pinned tabs as their icon (the title stays their name for assistive technology).
  const narrow = await app.browser.execute(() =>
    [...document.querySelectorAll(".pane .tab.pinned")].map((t) => ({ hidden: getComputedStyle(t.querySelector(".tab-title")).display === "none", pane: Math.round(t.closest(".tabbar").getBoundingClientRect().width) })),
  );
  for (const n of narrow) if (n.pane <= 560) assert.ok(n.hidden, `icon only in a ${n.pane} px tab bar`);
  await app.shot("280-pinned-split");
  await app.browser.setWindowSize(1280, 800);
  // Give WebKit a moment to write the layout before the app is stopped.
  await sleep(1500);
  await app.close();
  app = await launch({ width: 1280, height: 800, dataDir: path.join(dir, "data") });
  await app.browser.waitUntil(async () => (await app.browser.execute(() => document.querySelectorAll(".pane").length)) === 2, { timeoutMsg: "the split was not restored" });
  assert.deepEqual(await titles(0), ["Pin Gamma*", "Pin Delta", "Pin Alpha"]);
  assert.deepEqual(await titles(1), ["Pin Beta*", "Pin Delta"]);
});
