// Groups of ribbon links: create one with two links and an app in „App / Link hinzufügen“, open
// its popover and an entry (by click, Ctrl-click and keyboard), move links in by dragging and
// with „In Gruppe“, edit and remove entries, reorder, open all, and find it in the palette.
// ANNALO_TEST_OPEN_LOG makes the app write what it would open to a file.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "annalo-open-")), "opened.txt");
before(async () => (app = await launch({ env: { ANNALO_TEST_OPEN_LOG: log } })));
after(async () => {
  await app?.close();
  fs.rmSync(path.dirname(log), { recursive: true, force: true });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const links = async () => (await app.invoke("settings_get")).settings.quick_links;
const opened = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []);
const ribbon = () => app.browser.execute(() => [...document.querySelectorAll(".ribbon .quick-link")].map((b) => b.getAttribute("aria-label")));
const rows = () => app.browser.execute(() => [...document.querySelectorAll(".link-pop .link-pop-row .link-pop-name")].map((r) => r.textContent));
const popOpen = () => app.browser.execute(() => !!document.querySelector(".link-pop"));
/** Clicks the button with this text in the topmost dialog. */
const dialogButton = (text) =>
  app.browser.execute((t) => {
    const ds = document.querySelectorAll(".dialog");
    [...ds[ds.length - 1].querySelectorAll("button")].find((b) => b.textContent.trim() === t).click();
  }, text);
const topInputs = async (sel) => {
  const ds = await app.$$(".dialog");
  return ds[ds.length - 1].$$(sel);
};
// The context menu through its event: WebKit's WebDriver follows a right click with a left click,
// which would open the entry.
const menu = async (el, label) => {
  await app.browser.execute((e) => {
    const r = e.getBoundingClientRect();
    e.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
  }, el);
  await app.browser.waitUntil(async () => app.browser.execute(() => !!document.querySelector(".menu")));
  await app.browser.execute((l) => [...document.querySelectorAll(".menu-item")].find((b) => b.textContent.includes(l)).click(), label);
};
const group = () => app.$(".ribbon .quick-group");
async function addLink(url, name, inGroup) {
  await app.click(".ribbon .quick-link-add");
  await app.waitFor(".dialog .link-form");
  const [u, n] = await topInputs(".link-form input");
  await u.setValue(url);
  await n.setValue(name);
  if (inGroup !== undefined) await app.select(".dialog .link-group-select", inGroup);
  await dialogButton("Speichern");
  await app.browser.waitUntil(async () => !(await app.browser.execute(() => !!document.querySelector(".dialog"))));
}
async function drag(from, to, dy = 0) {
  await app.browser.performActions([
    {
      type: "pointer",
      id: "mouse",
      parameters: { pointerType: "mouse" },
      actions: [
        { type: "pointerMove", origin: from, x: 0, y: 0 },
        { type: "pointerDown", button: 0 },
        { type: "pointerMove", origin: "pointer", x: 0, y: 8, duration: 80 },
        { type: "pointerMove", origin: to, x: 0, y: dy, duration: 200 },
        { type: "pointerMove", origin: to, x: 0, y: dy, duration: 60 },
        { type: "pointerUp", button: 0 },
      ],
    },
  ]);
  await app.browser.releaseActions();
}

test("create a group with two links and an app", async () => {
  await app.waitFor(".ribbon .quick-links");
  assert.equal(await app.browser.execute(() => document.querySelector(".ribbon .quick-link-add").getAttribute("aria-label")), "App / Link hinzufügen");
  await app.click(".ribbon .quick-link-add");
  await app.waitFor(".dialog .link-kind");
  await app.click('.dialog .link-kind [data-kind="group"]');
  await app.waitFor(".dialog .group-form");
  const [name] = await topInputs(".group-form input");
  await name.setValue("Werkzeuge");
  await app.click('.dialog .icon-picker [aria-label="Werkzeug"]');
  await app.click('.dialog .link-color[aria-label="Blau"]');

  const add = async (button, url, label) => {
    await app.browser.execute((b) => [...document.querySelectorAll(".dialog .group-items-actions button")].find((x) => x.textContent.trim() === b).click(), button);
    await app.browser.waitUntil(async () => (await app.$$(".dialog")).length === 2);
    const [u, n] = await topInputs(".item-form input");
    await u.setValue(url);
    await n.setValue(label);
    await dialogButton("Speichern");
    await app.browser.waitUntil(async () => (await app.$$(".dialog")).length === 1);
  };
  await add("Link hinzufügen", "https://jira.firma.de", "Jira");
  await add("Link hinzufügen", "confluence.firma.de/wiki", "Wiki");
  await add("App hinzufügen", "/usr/bin/true", "Rechner");
  assert.equal((await app.$$(".dialog .group-item")).length, 3);
  await app.shot("link-group-dialog");
  await dialogButton("Speichern");
  await app.browser.waitUntil(async () => (await links()).length === 1, { timeoutMsg: "group not saved" });
  assert.deepEqual(await links(), [
    {
      name: "Werkzeuge",
      url: "",
      icon: "wrench",
      kind: "group",
      color: "blau",
      items: [
        { name: "Jira", url: "https://jira.firma.de", icon: "ticket" },
        { name: "Wiki", url: "confluence.firma.de/wiki", icon: "book-open" },
        { name: "Rechner", url: "/usr/bin/true", icon: "app-window", kind: "app" },
      ],
    },
  ]);
  await app.waitFor(".ribbon .quick-group");
  assert.equal(await app.text(".ribbon .quick-group .quick-group-count"), "3");
  assert.match(await (await group()).getAttribute("data-tooltip"), /^Werkzeuge/);
});

test("the popover lists the entries next to the icon and opens them", async () => {
  await (await group()).click();
  await app.waitFor(".link-pop");
  assert.deepEqual(await rows(), ["Jira", "Wiki", "Rechner"]);
  const box = await app.browser.execute(() => {
    const p = document.querySelector(".link-pop").getBoundingClientRect();
    const g = document.querySelector(".ribbon .quick-group").getBoundingClientRect();
    return { left: p.left, gRight: g.right, bottom: p.bottom, h: innerHeight };
  });
  assert.ok(box.left >= box.gRight && box.left - box.gRight < 20, "anchored right of the icon");
  assert.ok(box.bottom <= box.h, "inside the window");
  assert.equal(await app.text(".link-pop .link-pop-row:nth-child(2) .link-pop-url"), "confluence.firma.de/wiki");
  await app.shot("link-group-popover");

  // A click opens the entry and closes the list.
  await (await app.$$(".link-pop .link-pop-row"))[0].click();
  await app.browser.waitUntil(async () => opened().length === 1, { timeoutMsg: "nothing opened" });
  assert.deepEqual(opened(), ["url\thttps://jira.firma.de"]);
  assert.equal(await popOpen(), false);

  // Ctrl-click keeps it open.
  await (await group()).click();
  await app.waitFor(".link-pop");
  await app.browser.execute(() => document.querySelectorAll(".link-pop .link-pop-row")[1].dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true })));
  await app.browser.waitUntil(async () => opened().length === 2);
  assert.equal(opened()[1], "url\thttps://confluence.firma.de/wiki");
  assert.equal(await popOpen(), true, "stays open after Ctrl-click");
  // Escape closes it and gives the focus back to the group.
  await app.keys(["Escape"]);
  await app.browser.waitUntil(async () => !(await popOpen()));
  assert.equal(await app.browser.execute(() => document.activeElement?.classList.contains("quick-group")), true);
});

test("keyboard: Enter opens the list, arrows choose, Enter starts the app", async () => {
  await app.browser.execute(() => document.querySelector(".ribbon .quick-group").focus());
  await app.keys(["Enter"]);
  await app.waitFor(".link-pop");
  await app.browser.waitUntil(async () => (await app.text(".link-pop .link-pop-row.sel .link-pop-name")) === "Jira");
  await app.keys(["ArrowDown"]);
  await app.keys(["ArrowDown"]);
  assert.equal(await app.text(".link-pop .link-pop-row.sel .link-pop-name"), "Rechner");
  await app.keys(["ArrowDown"]);
  assert.equal(await app.text(".link-pop .link-pop-row.sel .link-pop-name"), "Jira", "wraps around");
  await app.keys(["ArrowUp"]);
  await app.keys(["Enter"]);
  await app.browser.waitUntil(async () => opened().length === 3);
  assert.equal(opened()[2], "app\t/usr/bin/true");
  assert.equal(await popOpen(), false);
});

test("move a link into the group by dragging it onto the icon", async () => {
  await addLink("https://grafana.firma.de", "Grafana");
  assert.deepEqual(await ribbon(), ["Werkzeuge", "Grafana"]);
  await drag(await app.$('.ribbon .quick-link[aria-label="Grafana"]'), await group());
  await app.browser.waitUntil(async () => (await links()).length === 1, { timeoutMsg: "not moved into the group" });
  assert.deepEqual((await links())[0].items.map((i) => i.name), ["Jira", "Wiki", "Rechner", "Grafana"]);
  assert.equal(await app.text(".ribbon .quick-group .quick-group-count"), "4");
  assert.equal(opened().length, 3, "dropping does not open the link");
});

test("„In Gruppe“ puts a new link into the group; editing moves it out again", async () => {
  await addLink("https://teams.microsoft.com", "Teams", "0");
  assert.deepEqual((await links())[0].items.map((i) => i.name), ["Jira", "Wiki", "Rechner", "Grafana", "Teams"]);
  // Edit it from the popover: rename and take it out of the group.
  await (await group()).click();
  await app.waitFor(".link-pop");
  await menu((await app.$$(".link-pop .link-pop-row"))[4], "Bearbeiten");
  await app.waitFor(".dialog .link-form");
  const [, name] = await topInputs(".link-form input");
  await name.setValue("Teams Chat");
  await app.select(".dialog .link-group-select", "");
  await dialogButton("Speichern");
  await app.browser.waitUntil(async () => (await links()).length === 2, { timeoutMsg: "not moved out" });
  assert.deepEqual(await ribbon(), ["Werkzeuge", "Teams Chat"]);
  assert.equal((await links())[0].items.length, 4);
});

test("reorder in the ribbon by dragging, also the group", async () => {
  // Drop the group below the link (on the lower edge of the last icon).
  const teams = await app.$('.ribbon .quick-link[aria-label="Teams Chat"]');
  await drag(await group(), teams, 14);
  await app.browser.waitUntil(async () => (await ribbon())[0] === "Teams Chat", { timeoutMsg: `not reordered: ${await ribbon()}` });
  assert.equal((await links())[1].kind, "group");
  // And back with the keyboard.
  await app.browser.execute(() => document.querySelector(".ribbon .quick-group").focus());
  await app.keys(["Alt", "ArrowUp"]);
  await app.browser.waitUntil(async () => (await ribbon())[0] === "Werkzeuge", { timeoutMsg: "Alt+ArrowUp did not move it" });
});

test("edit, reorder and remove entries in the group dialog and the popover", async () => {
  await menu(await group(), "Gruppe bearbeiten");
  await app.waitFor(".dialog .group-form");
  // Alt+ArrowDown moves „Jira“ below „Wiki“; dragging „Grafana“ to the top.
  await app.browser.execute(() => document.querySelector('.dialog .group-item[data-row="0"]').focus());
  await app.keys(["Alt", "ArrowDown"]);
  await app.browser.waitUntil(async () => (await app.text('.dialog .group-item[data-row="0"] .group-item-name')) === "Wiki");
  await drag(await app.$('.dialog .group-item[data-row="3"] .group-item-grip'), await app.$('.dialog .group-item[data-row="0"]'), -8);
  await app.browser.waitUntil(async () => (await app.text('.dialog .group-item[data-row="0"] .group-item-name')) === "Grafana", { timeoutMsg: "not dragged" });
  await dialogButton("Speichern");
  await app.browser.waitUntil(async () => (await links())[0].items.map((i) => i.name).join() === "Grafana,Wiki,Jira,Rechner", { timeoutMsg: `order: ${(await links())[0].items.map((i) => i.name)}` });

  // Remove from the popover's context menu.
  await (await group()).click();
  await app.waitFor(".link-pop");
  await menu((await app.$$(".link-pop .link-pop-row"))[0], "Entfernen");
  await app.browser.waitUntil(async () => (await links())[0].items.length === 3);
  assert.deepEqual(await rows(), ["Wiki", "Jira", "Rechner"], "the open list follows");
  await app.keys(["Escape"]);
});

test("„Alle Links öffnen“ opens the web links of the group", async () => {
  const before = opened().length;
  await menu(await group(), "Alle Links öffnen (2)");
  await app.browser.waitUntil(async () => opened().length === before + 2, { timeoutMsg: "not all opened" });
  assert.deepEqual(opened().slice(before), ["url\thttps://confluence.firma.de/wiki", "url\thttps://jira.firma.de"]);
});

test("the command palette finds the group and its links", async () => {
  await app.browser.execute(() => document.querySelector('.ribbon [aria-label^="Befehlspalette"]')?.click());
  const input = await app.waitFor(".palette input");
  await input.setValue("Werkzeuge");
  await app.waitText(".palette .pal-item", /Gruppe öffnen: Werkzeuge/);
  await app.shot("link-group-palette");
  await app.browser.execute(() => [...document.querySelectorAll(".palette .pal-item")].find((i) => i.textContent.includes("Gruppe öffnen: Werkzeuge")).click());
  await app.waitFor(".link-pop");
  await app.keys(["Escape"]);
  await app.browser.waitUntil(async () => !(await popOpen()));
  // A link inside the group by its name.
  await app.browser.execute(() => document.querySelector('.ribbon [aria-label^="Befehlspalette"]')?.click());
  const again = await app.waitFor(".palette input");
  await again.setValue("Rechner");
  await app.waitText(".palette .pal-item", /Rechner/);
  const before = opened().length;
  await app.browser.execute(() => [...document.querySelectorAll(".palette .pal-item")].find((i) => i.textContent.includes("Werkzeuge ·")).click());
  await app.browser.waitUntil(async () => opened().length === before + 1);
  assert.equal(opened().at(-1), "app\t/usr/bin/true");
});

test("removing a group with entries asks first", async () => {
  await menu(await group(), "Gruppe entfernen");
  await app.waitFor(".dialog");
  await dialogButton("Entfernen");
  await app.browser.waitUntil(async () => (await links()).length === 1);
  assert.deepEqual(await ribbon(), ["Teams Chat"]);
  await sleep(100);
});

test("no console errors", async () => {
  assert.deepEqual(await app.browser.execute(() => window.__annaloErrors ?? []), []);
});
