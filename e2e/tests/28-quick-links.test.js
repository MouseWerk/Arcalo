// Ribbon links: add one through the dialog (icon guessed from the address, or picked), it is
// saved on its own, edited and removed through the context menu.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
before(async () => (app = await launch()));
after(async () => app?.close());

const links = async () => (await app.invoke("settings_get")).settings.quick_links;
const rows = () => app.browser.execute(() => [...document.querySelectorAll(".ribbon .quick-link")].map((b) => b.getAttribute("aria-label")));

test("add, edit and remove a link in the ribbon", async () => {
  await app.waitFor(".ribbon .quick-links");
  assert.equal(await app.browser.execute(() => !!document.querySelector(".sidebar .quick-links")), false, "not in the file sidebar");
  await app.click('.ribbon .quick-link-add');
  await app.waitFor(".dialog .link-form");
  const [url, name] = await app.$$(".dialog .link-form input");
  await url.setValue("jira.firma.de/browse/AET");
  await name.setValue("Jira");
  // The icon follows the address until one is picked.
  await app.browser.waitUntil(async () => app.browser.execute(() => document.querySelector('.dialog .icon-picker [aria-selected="true"]')?.getAttribute("aria-label") === "Ticket"));
  await app.shot("quick-link-dialog");
  await app.browser.execute(() => [...document.querySelectorAll(".dialog button")].find((b) => b.textContent === "Speichern").click());
  await app.browser.waitUntil(async () => (await rows()).includes("Jira"), { timeoutMsg: "link not shown" });
  assert.deepEqual(await links(), [{ name: "Jira", url: "jira.firma.de/browse/AET", icon: "ticket" }]);

  // A second one with a picked icon, then reorder and edit through the context menu.
  await app.click('.ribbon .quick-link-add');
  await app.waitFor(".dialog .link-form");
  const [url2] = await app.$$(".dialog .link-form input");
  await url2.setValue("/home/user/Projekte");
  await app.browser.execute(() => document.querySelector('.dialog .icon-picker [aria-label="Rakete"]').click());
  await app.browser.execute(() => [...document.querySelectorAll(".dialog button")].find((b) => b.textContent === "Speichern").click());
  await app.browser.waitUntil(async () => (await rows()).length === 2);
  assert.equal((await links())[1].icon, "rocket");
  assert.equal((await links())[1].name, "/home/user/Projekte");
  await app.shot("quick-links");

  const menu = async (i, label) => {
    await (await app.$$(".ribbon .quick-link"))[i].click({ button: "right" });
    await app.browser.execute((l) => [...document.querySelectorAll(".menu-item, [role=menuitem]")].find((b) => b.textContent.includes(l)).click(), label);
  };
  const stale = (await app.invoke("settings_get")).settings;
  await menu(1, "Nach oben");
  await app.browser.waitUntil(async () => (await links())[0].icon === "rocket", { timeoutMsg: "not moved" });
  await menu(1, "Entfernen");
  await app.browser.waitUntil(async () => (await links()).length === 1);
  assert.deepEqual(await rows(), ["/home/user/Projekte"]);

  // A settings draft opened while there were two links does not bring the removed one back.
  await app.invoke("settings_save", { settings: stale });
  assert.equal((await links()).length, 1);
});

test("no console errors", async () => {
  assert.deepEqual(await app.browser.execute(() => window.__annaloErrors ?? []), []);
});
