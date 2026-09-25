// Link groups after a restart, settings of 1.4 (links without a kind), a long group with
// type-to-filter, the popover in a low window and the dark theme.
import { test as nodeTest, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "annalo-groups-"));
const log = path.join(dir, "opened.txt");
const env = { ANNALO_TEST_OPEN_LOG: log };
after(async () => {
  await app?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const links = async () => (await app.invoke("settings_get")).settings.quick_links;
const ribbon = () => app.browser.execute(() => [...document.querySelectorAll(".ribbon .quick-link")].map((b) => b.getAttribute("aria-label")));
const rows = () => app.browser.execute(() => [...document.querySelectorAll(".link-pop .link-pop-row .link-pop-name")].map((r) => r.textContent));
const tools = Array.from({ length: 12 }, (_, i) => ({ name: `Tool ${i + 1}`, url: `https://tool${i + 1}.firma.de`, icon: "" }));
tools[6] = { name: "Wiki", url: "https://wiki.firma.de", icon: "book-open" };

test("settings of 1.4 load unchanged, groups survive a restart", async () => {
  app = await launch({ dataDir: path.join(dir, "data"), env });
  // As 1.4 stored it: no kind, no items.
  const view = await app.invoke("quick_links_save", { links: [{ name: "Jira", url: "jira.firma.de", icon: "ticket" }] });
  assert.deepEqual(view.settings.quick_links, [{ name: "Jira", url: "jira.firma.de", icon: "ticket" }]);
  await app.invoke("quick_links_save", {
    links: [
      { name: "Jira", url: "jira.firma.de", icon: "ticket" },
      { name: "Alles", url: "", icon: "layers", kind: "group", color: "grün", items: tools },
    ],
  });
  await app.close();

  app = await launch({ dataDir: path.join(dir, "data"), env });
  await app.waitFor(".ribbon .quick-group");
  assert.deepEqual(await ribbon(), ["Jira", "Alles"]);
  assert.equal((await links())[1].items.length, 12);
  assert.equal(await app.text(".ribbon .quick-group .quick-group-count"), "12");
});

test("a long group filters as you type", async () => {
  await (await app.$(".ribbon .quick-group")).click();
  await app.waitFor(".link-pop .link-pop-filter input");
  assert.equal(await app.browser.execute(() => document.activeElement?.closest(".link-pop-filter") !== null), true, "filter has the focus");
  await app.shot("link-group-long");
  await app.type("wik");
  await app.browser.waitUntil(async () => (await rows()).length === 1, { timeoutMsg: "not filtered" });
  assert.deepEqual(await rows(), ["Wiki"]);
  await app.keys(["Enter"]);
  await app.browser.waitUntil(() => fs.existsSync(log) && fs.readFileSync(log, "utf8").includes("wiki.firma.de"), { timeoutMsg: "not opened" });
  // Opening the whole group asks first (more than five links).
  await (await app.$(".ribbon .quick-group")).click();
  await app.waitFor(".link-pop");
  await app.browser.execute(() => document.querySelector(".link-pop .link-pop-openall").click());
  await app.waitFor(".dialog");
  assert.match(await app.text(".dialog"), /12 Links öffnen\?/);
  await app.browser.execute(() => [...document.querySelectorAll(".dialog button")].find((b) => b.textContent.trim() === "Abbrechen").click());
  assert.equal(fs.readFileSync(log, "utf8").trim().split("\n").length, 1, "nothing opened after cancelling");
  await app.keys(["Escape"]);
});

test("in a low window the popover stays inside and scrolls", async () => {
  await app.browser.setWindowSize(1000, 480);
  await app.browser.pause(400);
  await (await app.$(".ribbon .quick-group")).click();
  await app.waitFor(".link-pop");
  const box = await app.browser.execute(() => {
    const p = document.querySelector(".link-pop").getBoundingClientRect();
    const list = document.querySelector(".link-pop-list");
    return { top: p.top, bottom: p.bottom, h: innerHeight, scrolls: list.scrollHeight > list.clientHeight };
  });
  assert.ok(box.top >= 0 && box.bottom <= box.h, `inside: ${JSON.stringify(box)}`);
  assert.ok(box.scrolls, "the list scrolls");
  // The keyboard selection scrolls into view (ArrowUp from the first wraps to the last).
  await app.keys(["ArrowUp"]);
  await app.browser.pause(150);
  const visible = await app.browser.execute(() => {
    const r = document.querySelector(".link-pop-row.sel").getBoundingClientRect();
    const l = document.querySelector(".link-pop-list").getBoundingClientRect();
    return r.bottom <= l.bottom + 1 && r.top >= l.top - 1;
  });
  assert.ok(visible, "selected row visible");
  await app.shot("link-group-low-window");
  await app.keys(["Escape"]);
  await app.browser.setWindowSize(1480, 920);
});

test("dark theme", async () => {
  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", { settings: { ...view.settings, theme: "dark" } });
  await app.browser.refresh();
  await app.browser.waitUntil(async () => app.browser.execute(() => document.body.classList.contains("ready")), { timeout: 20000 });
  await (await app.waitFor(".ribbon .quick-group")).click();
  await app.waitFor(".link-pop");
  await app.keys(["ArrowDown"]);
  await app.shot("link-group-popover-dark");
  await app.keys(["Escape"]);
  // The context menu through its event (WebKit's WebDriver adds a left click to a right click).
  await app.browser.execute(() => {
    const r = document.querySelector(".ribbon .quick-group").getBoundingClientRect();
    document.querySelector(".ribbon .quick-group").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: r.left + 10, clientY: r.top + 10 }));
  });
  await app.browser.execute(() => [...document.querySelectorAll(".menu-item")].find((b) => b.textContent.includes("Gruppe bearbeiten")).click());
  await app.waitFor(".dialog .group-form");
  await app.shot("link-group-dialog-dark");
  await app.browser.execute(() => [...document.querySelectorAll(".dialog button")].find((b) => b.textContent.trim() === "Abbrechen").click());
});

test("no console errors", async () => {
  assert.deepEqual(await app.browser.execute(() => window.__annaloErrors ?? []), []);
});
