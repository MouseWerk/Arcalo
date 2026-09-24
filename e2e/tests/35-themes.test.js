// Color themes (Settings → Darstellung): the picker changes the tokens and the choice persists,
// an accent applies on top, the custom theme editor previews live and saves, and a theme file
// round-trips through export and import (invalid files are refused).
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app, tmp;
before(async () => {
  app = await launch();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "annalo-themes-"));
});
after(async () => app?.close());

const cssVar = (name) => app.browser.execute((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);
const themeId = () => app.browser.execute(() => document.documentElement.dataset.themeId);
const bg = (sel) => app.browser.execute((s) => getComputedStyle(document.querySelector(s)).backgroundColor, sel);
const settings = async () => (await app.invoke("settings_get")).settings;

async function openAppearance() {
  if (!(await app.browser.execute(() => !!document.querySelector(".pane.active .settings")))) await app.keys(["Control", ","]);
  await app.waitFor(".pane.active .settings");
  await app.browser.execute(() => document.querySelector('.settings-nav-item[data-section="appearance"]').click());
  await app.waitText(".settings-head h1", /Darstellung/);
}

test("the picker switches themes: tokens change, the mode follows, the choice persists", async () => {
  await openAppearance();
  const cards = await app.browser.execute(() => [...document.querySelectorAll("[data-theme-card]")].map((c) => c.dataset.themeCard));
  assert.ok(cards.length >= 18, `${cards.length} themes`);
  for (const id of ["nord", "dracula", "catppuccin-latte", "catppuccin-mocha", "solarized-light", "solarized-dark", "gruvbox-dark", "tokyo-night", "github-light", "github-dark", "one-dark", "rose-pine", "rose-pine-dawn", "everforest-dark", "contrast-light", "contrast-dark"]) {
    assert.ok(cards.includes(id), `theme ${id}`);
  }
  // Light and dark themes are grouped: every card sits in the group of its kind.
  const groups = await app.browser.execute(() => [...document.querySelectorAll(".theme-grid")].map((g) => [...g.querySelectorAll("[data-theme-card]")].map((c) => c.dataset.themeCard)));
  assert.ok(groups[0].includes("solarized-light") && !groups[0].includes("nord"));
  assert.ok(groups[1].includes("nord") && !groups[1].includes("github-light"));
  await app.shot("themes-picker");

  // Mode „Dunkel“, then Nord: the whole app takes Nord's colors.
  await app.browser.execute(() => [...document.querySelectorAll('.set-row [role="radio"]')].find((b) => b.textContent === "Dunkel").click());
  await app.browser.waitUntil(async () => (await app.browser.execute(() => document.documentElement.dataset.theme)) === "dark", { timeoutMsg: "dark mode" });
  await app.click('[data-theme-card="nord"]');
  await app.browser.waitUntil(async () => (await themeId()) === "nord", { timeoutMsg: "Nord not applied" });
  assert.equal(await cssVar("--bg-canvas"), "#2e3440");
  assert.equal(await cssVar("--text"), "#eceff4");
  assert.equal(await bg(".main"), "rgb(46, 52, 64)");
  assert.equal(await app.browser.execute(() => document.querySelector('[data-theme-card="nord"]').getAttribute("aria-checked")), "true");
  await app.browser.waitUntil(async () => (await settings()).appearance.theme_dark === "nord", { timeoutMsg: "Nord not saved" });
  assert.equal((await settings()).theme, "dark");
  await app.shot("themes-nord");

  // An accent on top of the theme, then back to the theme's own.
  const own = await cssVar("--accent");
  await app.click('.accent-swatch[data-accent="rose"]');
  await app.browser.waitUntil(async () => (await cssVar("--accent")) !== own, { timeoutMsg: "accent not applied" });
  assert.equal(await cssVar("--bg-canvas"), "#2e3440", "the theme stays");
  await app.click('.accent-swatch[data-accent="theme"]');
  await app.browser.waitUntil(async () => (await cssVar("--accent")) === own, { timeoutMsg: "theme accent not back" });

  // A light card while in dark mode switches to light mode with that theme.
  await app.click('[data-theme-card="solarized-light"]');
  await app.browser.waitUntil(async () => (await themeId()) === "solarized-light", { timeoutMsg: "Solarized not applied" });
  assert.equal(await app.browser.execute(() => document.documentElement.dataset.theme), "light");
  assert.equal(await cssVar("--bg-canvas"), "#fdf6e3");
  await app.browser.waitUntil(async () => {
    const s = await settings();
    return s.theme === "light" && s.appearance.theme_light === "solarized-light" && s.appearance.theme_dark === "nord";
  }, { timeoutMsg: "light choice not saved" });

  // The next start shows the same theme (and the splash remembers its colors).
  await app.browser.refresh();
  await app.browser.waitUntil(async () => app.browser.execute(() => document.body.classList.contains("ready")), { timeout: 20000 });
  await app.browser.waitUntil(async () => (await themeId()) === "solarized-light", { timeoutMsg: "theme not restored" });
  assert.equal(await cssVar("--bg-canvas"), "#fdf6e3");
  const splash = await app.browser.execute(() => JSON.parse(localStorage.getItem("annalo.splash") ?? "{}"));
  assert.equal(splash.dark, false);
  assert.match(splash.bg, /^#[0-9a-f]{6}$/);
  assert.equal(splash.accent, "#268bd2");

  // High contrast keeps its own accent: the swatches are off.
  await openAppearance();
  await app.click('[data-theme-card="contrast-light"]');
  await app.browser.waitUntil(async () => (await themeId()) === "contrast-light");
  assert.equal(await app.browser.execute(() => document.querySelector('.accent-swatch[data-accent="teal"]').disabled), true);
  await app.click('[data-theme-card="annalo-light"]');
  await app.browser.waitUntil(async () => (await themeId()) === "annalo-light");
  // Annalo is tokens.css itself: no theme CSS is injected.
  assert.equal(await app.browser.execute(() => document.getElementById("annalo-theme")?.textContent ?? ""), "");
});

test("the theme editor previews live, warns about contrast and saves a custom theme", async () => {
  await openAppearance();
  await app.browser.execute(() => [...document.querySelectorAll(".set-row button")].find((b) => b.textContent === "Neues Thema").click());
  await app.waitFor(".dialog .theme-editor");
  const setField = (label, value) =>
    app.browser.execute(
      (l, v) => {
        const input = document.querySelector(`.dialog input[aria-label="${l}"]`);
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, v);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      },
      label,
      value,
    );
  await setField("Name", "Papier E2E");
  await setField("Hintergrund", "#fbf7ee");
  // The preview carries the edited tokens: its real controls show the theme.
  await app.browser.waitUntil(async () => (await app.browser.execute(() => document.querySelector(".theme-preview").style.getPropertyValue("--bg-canvas"))) === "#fbf7ee", { timeoutMsg: "preview did not follow" });
  assert.equal(await bg(".theme-preview"), "rgb(251, 247, 238)");
  // Too little contrast is flagged (and raised for text when applied).
  await setField("Text", "#cccccc");
  await app.waitFor('.theme-color[data-color="text"] .theme-color-contrast.low');
  await setField("Text", "#1f1c16");
  await app.browser.waitUntil(async () => app.browser.execute(() => !document.querySelector('.theme-color[data-color="text"] .theme-color-contrast.low')));
  await app.shot("themes-editor");
  await app.browser.execute(() => [...document.querySelectorAll(".dialog button")].find((b) => b.textContent === "Speichern und verwenden").click());
  await app.browser.waitUntil(async () => (await settings()).appearance.custom_themes.length === 1, { timeoutMsg: "custom theme not saved" });
  const s = await settings();
  const mine = s.appearance.custom_themes[0];
  assert.match(mine.id, /^custom-[a-z0-9]+$/);
  assert.deepEqual([mine.name, mine.dark, mine.colors.background, mine.colors.text], ["Papier E2E", false, "#fbf7ee", "#1f1c16"]);
  assert.equal(s.appearance.theme_light, mine.id);
  await app.browser.waitUntil(async () => (await themeId()) === mine.id, { timeoutMsg: "custom theme not shown" });
  assert.equal(await cssVar("--bg-canvas"), "#fbf7ee");
  // It is listed with the light themes and under „Eigene Themen“.
  assert.ok(await app.browser.execute((id) => !!document.querySelector(`.theme-grid [data-theme-card="${id}"]`), mine.id));
  await app.waitText(".set-row-label", /^Papier E2E$/);
});

test("custom themes round-trip through a theme file; invalid files are refused", async () => {
  const mine = (await settings()).appearance.custom_themes[0];
  const file = path.join(tmp, "papier.json");
  await app.invoke("theme_export", { path: file, theme: mine });
  const exported = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(Object.keys(exported).sort(), ["colors", "dark", "format", "name", "version"]);
  assert.equal(exported.format, "annalo-theme");
  assert.deepEqual(exported.colors, mine.colors);

  const back = await app.invoke("theme_file_read", { path: file });
  assert.deepEqual([back.id, back.name, back.dark, back.colors], ["", mine.name, mine.dark, mine.colors]);

  // Refused: other JSON, invalid colors, missing colors, other extensions.
  const bad = (name, content) => {
    const p = path.join(tmp, name);
    fs.writeFileSync(p, typeof content === "string" ? content : JSON.stringify(content));
    return app.invoke("theme_file_read", { path: p });
  };
  await assert.rejects(bad("settings.json", { format: "annalo-settings", version: 1, settings: {} }), /Keine Annalo-Theme-Datei/);
  await assert.rejects(bad("broken.json", "{ kaputt"), /kein gültiges JSON/);
  await assert.rejects(bad("color.json", { ...exported, colors: { ...exported.colors, accent: "blau" } }), /Ungültige Farbe „accent“/);
  const { danger, ...partial } = exported.colors;
  assert.ok(danger);
  await assert.rejects(bad("partial.json", { ...exported, colors: partial }), /unvollständig/);
  await assert.rejects(bad("theme.txt", exported), /json/i);

  // An imported theme (as the import button adds it) gets its own id and shows up in the picker.
  const current = await settings();
  const imported = { ...back, name: "Papier Import" };
  const saved = await app.invoke("settings_save", { settings: { ...current, appearance: { ...current.appearance, custom_themes: [...current.appearance.custom_themes, imported] } } });
  const ids = saved.settings.appearance.custom_themes.map((t) => t.id);
  assert.equal(new Set(ids).size, 2);
  assert.ok(ids.every((id) => /^custom-/.test(id)));
  await app.browser.refresh();
  await app.browser.waitUntil(async () => app.browser.execute(() => document.body.classList.contains("ready")), { timeout: 20000 });
  await openAppearance();
  await app.waitText(".theme-card-name", /^Papier Import$/);
  assert.deepEqual(await app.consoleErrors(), []);
});
