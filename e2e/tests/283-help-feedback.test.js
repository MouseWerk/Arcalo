// „Hilfe & Doku“ (1.14): the "?" above the settings gear opens a menu with the documentation, the
// shortcuts, the release notes and the two issue forms; the documentation follows the UI language,
// the forms carry only the version and the system. The same entries are palette commands, F1
// opens the documentation, and settings sections link to their page („Mehr in der Doku“).
import { test as nodeTest, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, guarded } from "../lib/harness.js";
import { launchEnglish } from "../lib/english.js";

const test = guarded(nodeTest, () => app);
let app;
const dirs = [];
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "annalo-help-"));
dirs.push(dir);
after(async () => {
  await app?.close();
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const SITE = "https://arcalo.mousewerk.de";
const ISSUES = "https://github.com/MouseWerk/Arcalo/issues/new";

/** The next address handed to the browser (after `before` were already handed over). */
async function nextOpened(before) {
  await app.browser.waitUntil(async () => app.opened().length > before, { timeout: 8000, timeoutMsg: "nothing was opened" });
  return app.opened()[before].replace(/^url\t/, "");
}

const menuLabels = () => app.browser.execute(() => [...document.querySelectorAll(".menu .menu-item .menu-label")].map((e) => e.textContent));

async function openHelpMenu() {
  await app.click(".ribbon .ribbon-help");
  await app.waitFor(".menu .menu-item");
}

async function chooseInMenu(label) {
  await app.browser.execute((l) => [...document.querySelectorAll(".menu .menu-item")].find((b) => b.textContent.includes(l)).click(), label);
  await app.browser.waitUntil(async () => !(await app.browser.execute(() => !!document.querySelector(".menu"))), { timeoutMsg: "menu stayed open" });
}

async function fromPalette(query, title) {
  await app.keys(["Control", "k"]);
  const input = await app.waitFor(".palette input");
  await input.setValue(query);
  await app.waitText(".palette .pal-item", new RegExp(title));
  await app.browser.execute((t) => [...document.querySelectorAll(".palette .pal-item")].find((i) => i.textContent.includes(t)).click(), title);
}

/** The issue form address with exactly template, version and os. */
async function assertIssueUrl(url, template) {
  const info = await app.invoke("app_info");
  const u = new URL(url);
  assert.equal(`${u.origin}${u.pathname}`, ISSUES);
  assert.deepEqual([...u.searchParams.keys()], ["template", "version", "os"], url);
  assert.equal(u.searchParams.get("template"), template);
  assert.equal(u.searchParams.get("version"), info.version);
  assert.equal(u.searchParams.get("os"), info.os_name);
  assert.ok(info.os_name.length > 0);
}

async function setTheme(mode) {
  const v = await app.invoke("settings_get");
  const id = `annalo-${mode}`;
  await app.invoke("settings_save", { settings: { ...v.settings, theme: mode, appearance: { ...v.settings.appearance, theme_light: "annalo-light", theme_dark: "annalo-dark" } } });
  await app.browser.waitUntil(async () => (await app.browser.execute(() => `${document.documentElement.dataset.theme}|${document.documentElement.dataset.themeId}`)) === `${mode}|${id}`, {
    timeoutMsg: `theme ${mode} not applied`,
  });
}

async function openSettingsSection(id) {
  await app.click(".ribbon > .icon-btn:last-child");
  await app.waitFor(".settings");
  // A narrow pane shows the sections as a dropdown instead of the menu.
  const menu = await app.browser.execute(() => getComputedStyle(document.querySelector(".settings > .settings-nav")).display !== "none");
  if (menu) await app.click(`.settings-nav-item[data-section="${id}"]`);
  else await app.select(".settings-section-select", id);
  await app.browser.waitUntil(async () => app.browser.execute((s) => document.querySelector(`.settings-nav-item[data-section="${s}"]`)?.getAttribute("aria-current") === "page", id), {
    timeoutMsg: `section ${id} not open`,
  });
}

test("German: the help menu sits above the settings gear and opens the German documentation", async () => {
  app = await launch({ width: 1280, height: 800, dataDir: path.join(dir, "de") });
  await app.waitFor(".ribbon .ribbon-help");
  const order = await app.browser.execute(() => {
    const help = document.querySelector(".ribbon .ribbon-help");
    return { next: help.nextElementSibling?.getAttribute("aria-label"), last: document.querySelector(".ribbon > .icon-btn:last-child")?.getAttribute("aria-label"), label: help.getAttribute("aria-label") };
  });
  assert.equal(order.label, "Hilfe & Doku");
  assert.match(order.next, /^Einstellungen/);
  assert.match(order.last, /^Einstellungen/);

  await openHelpMenu();
  assert.deepEqual(await menuLabels(), ["Dokumentation", "Tastenkürzel", "Versionshinweise", "Feedback geben", "Fehler melden"]);
  // The menu opens to the right of the ribbon, inside the window.
  const box = await app.browser.execute(() => {
    // Layout box (the pop-in animation scales the bounding rect for a moment).
    const m = document.querySelector(".menu");
    const r = document.querySelector(".ribbon").getBoundingClientRect();
    return { left: m.offsetLeft, ribbon: r.right, bottom: m.offsetTop + m.offsetHeight, height: innerHeight };
  });
  assert.ok(box.left >= box.ribbon, `menu at ${box.left}, ribbon ends at ${box.ribbon}`);
  assert.ok(box.bottom <= box.height);
  // Open is a quiet state: no colored ring or outline on the button.
  const look = await app.browser.execute(() => {
    const st = getComputedStyle(document.querySelector(".ribbon .ribbon-help"));
    return { outline: st.outlineStyle, shadow: st.boxShadow, expanded: document.querySelector(".ribbon .ribbon-help").getAttribute("aria-expanded") };
  });
  assert.equal(look.expanded, "true");
  assert.equal(look.outline, "none");
  assert.equal(look.shadow, "none");
  // A second click on the button closes the menu.
  await app.click(".ribbon .ribbon-help");
  await app.browser.waitUntil(async () => !(await app.browser.execute(() => !!document.querySelector(".menu"))), { timeoutMsg: "menu stayed open" });

  await openHelpMenu();
  const before = app.opened().length;
  await chooseInMenu("Dokumentation");
  assert.equal(await nextOpened(before), `${SITE}/de/docs/`);
});

test("German: „Feedback geben“ and „Fehler melden“ open the issue forms with only version and system", async () => {
  let before = app.opened().length;
  await openHelpMenu();
  await chooseInMenu("Feedback geben");
  await assertIssueUrl(await nextOpened(before), "feedback.yml");

  before = app.opened().length;
  await openHelpMenu();
  await chooseInMenu("Fehler melden");
  await assertIssueUrl(await nextOpened(before), "bug_report.yml");
});

test("German: „Tastenkürzel“ shows Settings → Tastatur, „Versionshinweise“ the notes, F1 the documentation", async () => {
  await openHelpMenu();
  await chooseInMenu("Tastenkürzel");
  await app.browser.waitUntil(async () => app.browser.execute(() => document.querySelector('.settings-nav-item[data-section="keyboard"]')?.getAttribute("aria-current") === "page"), {
    timeoutMsg: "keyboard section not shown",
  });
  // The help command is listed with F1 like every other shortcut.
  assert.match(await app.text(".settings-body"), /Dokumentation öffnen/);

  await openHelpMenu();
  await chooseInMenu("Versionshinweise");
  await app.waitText(".dialog", /Versionshinweise|Arcalo/);
  await app.keys(["Escape"]);
  await app.browser.waitUntil(async () => !(await app.browser.execute(() => !!document.querySelector(".dialog"))), { timeoutMsg: "dialog stayed open" });

  const before = app.opened().length;
  await app.browser.execute(() => document.activeElement?.blur());
  await app.keys(["F1"]);
  assert.equal(await nextOpened(before), `${SITE}/de/docs/`);
});

test("German: the palette has the help commands", async () => {
  let before = app.opened().length;
  await fromPalette("Dokumentation", "Dokumentation öffnen");
  assert.equal(await nextOpened(before), `${SITE}/de/docs/`);

  before = app.opened().length;
  await fromPalette("Feedback", "Feedback geben");
  await assertIssueUrl(await nextOpened(before), "feedback.yml");

  before = app.opened().length;
  await fromPalette("Fehler melden", "Fehler melden");
  await assertIssueUrl(await nextOpened(before), "bug_report.yml");

  await fromPalette("Tastenk", "Tastenkürzel anzeigen");
  await app.browser.waitUntil(async () => app.browser.execute(() => document.querySelector('.settings-nav-item[data-section="keyboard"]')?.getAttribute("aria-current") === "page"));
});

test("German: settings sections link to their documentation page, Über has help and feedback", async () => {
  await openSettingsSection("network");
  const before = app.opened().length;
  await app.click(".settings-head .doc-link");
  assert.equal(await nextOpened(before), `${SITE}/de/docs/data/network/`);
  assert.equal(await app.text(".settings-head .doc-link"), "Mehr in der Doku");

  for (const [section, topic] of [["ai", "aiProviders"], ["backup", "backups"], ["security", "encryption"], ["calendar", "calendars"], ["keyboard", "shortcuts"]]) {
    await openSettingsSection(section);
    await app.waitFor(`.doc-link[data-topic="${topic}"]`);
  }
  await openSettingsSection("backup");
  await app.waitFor('.doc-link[data-topic="gitSync"]');
  const b = app.opened().length;
  await app.click('.doc-link[data-topic="gitSync"]');
  assert.equal(await nextOpened(b), `${SITE}/de/docs/data/git-sync/`);

  await openSettingsSection("about");
  await app.waitFor(".about-help-docs");
  let n = app.opened().length;
  await app.click(".about-help-trouble");
  assert.equal(await nextOpened(n), `${SITE}/de/docs/help/troubleshooting/`);
  n = app.opened().length;
  await app.click(".about-help-bug");
  await assertIssueUrl(await nextOpened(n), "bug_report.yml");
});

test("German: screenshots of the help menu and a section with its doc link, light and dark", async () => {
  for (const mode of ["light", "dark"]) {
    await setTheme(mode);
    await openSettingsSection("network");
    await app.browser.execute(() => document.querySelector(".settings-body")?.scrollIntoView());
    assert.equal(await app.browser.execute(() => document.documentElement.dataset.theme), mode);
    await app.shot(`283-settings-doc-link-${mode}`);
    await openHelpMenu();
    await app.shot(`283-help-menu-${mode}`);
    await app.keys(["Escape"]);
  }
});

test("English: the menu and the documentation are English, and so are the palette commands", async () => {
  await app.close();
  app = null;
  const en = await launchEnglish({ width: 1280, height: 800 });
  app = en.app;
  dirs.push(en.dataDir);
  await app.waitFor(".ribbon .ribbon-help");
  assert.equal(await app.browser.execute(() => document.querySelector(".ribbon .ribbon-help").getAttribute("aria-label")), "Help & docs");
  await openHelpMenu();
  assert.deepEqual(await menuLabels(), ["Documentation", "Keyboard shortcuts", "Release notes", "Give feedback", "Report a bug"]);
  let before = app.opened().length;
  await chooseInMenu("Documentation");
  assert.equal(await nextOpened(before), `${SITE}/docs/`);

  before = app.opened().length;
  await openHelpMenu();
  await chooseInMenu("Give feedback");
  await assertIssueUrl(await nextOpened(before), "feedback.yml");

  before = app.opened().length;
  await fromPalette("Report a bug", "Report a bug");
  await assertIssueUrl(await nextOpened(before), "bug_report.yml");

  before = app.opened().length;
  await fromPalette("documentation", "Open documentation");
  assert.equal(await nextOpened(before), `${SITE}/docs/`);

  await openSettingsSection("ai");
  before = app.opened().length;
  await app.click('.doc-link[data-topic="aiProviders"]');
  assert.equal(await nextOpened(before), `${SITE}/docs/ai/providers/`);
  assert.equal(await app.text('.doc-link[data-topic="aiProviders"]'), "More in the docs");
});
