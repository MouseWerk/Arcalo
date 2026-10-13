// 1.20: the full app as Android runs it on a large screen. The desktop build started with
// ARCALO_SIMULATE_ANDROID=1 (debug builds) reports Android's capabilities and refuses the commands
// Android does not register (src-tauri/src/platform.rs), so every entry that would call one of
// them must be gone and nothing may fail in the console: the ribbon, the palette, every settings
// section, the sidebar and its context menu (also by a long press), split panes and the
// splitters. Screenshots of the full app at tablet sizes (800x1280, 1280x800) and in a desktop
// window, light and dark, go to e2e/screenshots/android-*.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";
import { treeHelpers } from "../lib/tree.js";
import { settingsSettled } from "../lib/settings.js";

const test = guarded(nodeTest, () => app);
let app;
const T = treeHelpers(() => app);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
before(async () => (app = await launch({ width: 1280, height: 800, env: { ARCALO_SIMULATE_ANDROID: "1" } })));
after(async () => app?.close());

const errors = async () => (await app.consoleErrors()).filter((e) => !/ResizeObserver loop/.test(String(e)));
/** Opens the settings from the ribbon's gear. */
async function openSettings() {
  await app.browser.execute(() => [...document.querySelectorAll(".ribbon button")].find((b) => /^Einstellungen/.test(b.getAttribute("aria-label") ?? ""))?.click());
  await app.waitFor(".pane.active > .pane-content:not([hidden]) .settings");
}
/** Sends a pointer or mouse event of `type` to the tree row of `title`, looked up at that moment
 *  (rows re-render), at its left part. */
const onRow = (title, type, touch) =>
  app.browser.execute(
    (t, type, touch) => {
      const r = [...document.querySelectorAll(".sidebar .tree-row")].find((x) => x.querySelector(".tree-label")?.textContent === t);
      if (!r) return false;
      const b = r.getBoundingClientRect();
      const at = { bubbles: true, cancelable: true, clientX: b.x + 30, clientY: b.y + 8 };
      r.dispatchEvent(touch ? new PointerEvent(type, { ...at, pointerType: "touch", isPrimary: true }) : new MouseEvent(type, { ...at, button: 2 }));
      return true;
    },
    title,
    type,
    touch,
  );
const menus = () => app.browser.execute(() => document.querySelectorAll(".menu[role='menu']").length);

test("the backend reports Android's capabilities and refuses what Android does not have", async () => {
  const caps = await app.invoke("app_capabilities");
  assert.equal(caps.platform, "android");
  assert.equal(caps.mobile, true);
  assert.equal(caps.simulated, true);
  for (const k of ["tray", "globalShortcuts", "autostart", "commandLine", "desktopUpdater", "popupWindows", "windowFrame", "folders", "voice", "security", "backups"]) assert.equal(caps[k], false, k);
  assert.equal(caps.androidUpdater, true);
  for (const cmd of ["voice_status", "update_status", "desktop_info", "cli_path_info", "capture_open"]) {
    await assert.rejects(app.invoke(cmd), /not found/, cmd);
  }
  // Shared commands still answer.
  assert.ok(Array.isArray(await app.invoke("workspace_tree_compact")));
  assert.equal(await app.browser.execute(() => document.documentElement.classList.contains("platform-android")), true);
  // The desktop's pointer still hovers: hover styles stay for a mouse (lib/hoverMedia.ts).
  assert.equal(await app.browser.execute(() => matchMedia("(hover: hover)").matches), true);
  assert.deepEqual(await errors(), []);
});

test("the ribbon and the palette offer nothing Android does not have", async () => {
  assert.equal(await app.browser.execute(() => !!document.querySelector(".ribbon-voice")), false, "no voice button");
  await app.keys(["Control", "k"]);
  await app.waitFor(".palette input");
  for (const q of ["Sprachnotiz", "Obsidian"]) {
    await app.browser.execute(() => {
      const i = document.querySelector(".palette input");
      i.select();
    });
    await app.type(q);
    await sleep(250);
    const hits = await app.browser.execute(() => [...document.querySelectorAll(".palette [role='option']")].map((o) => o.textContent));
    assert.ok(!hits.some((h) => /Sprachnotiz aufnehmen|Obsidian-Vault importieren/.test(h)), `${q}: ${hits.join(" | ")}`);
  }
  await app.keys(["Escape"]);
  assert.deepEqual(await errors(), []);
});

test("every settings section opens without the desktop-only parts", async () => {
  await openSettings();
  const sections = await app.browser.execute(() => [...document.querySelectorAll(".settings-nav-item")].map((b) => ({ id: b.dataset.section, label: b.textContent.trim() })));
  const ids = sections.map((s) => s.id);
  assert.ok(!ids.includes("voice") && !ids.includes("security"), ids.join(","));
  assert.equal(sections.find((s) => s.id === "desktop")?.label, "Erfassen & Erinnern");
  for (const { id } of sections) {
    await app.browser.execute((s) => document.querySelector(`.settings-nav-item[data-section="${s}"]`).click(), id);
    await app.browser.waitUntil(async () => app.browser.execute((s) => document.querySelector(`.settings-nav-item[data-section="${s}"]`)?.getAttribute("aria-current") === "page", id));
    await sleep(350);
    const text = await app.browser.execute(() => document.querySelector(".settings-body")?.innerText ?? "");
    assert.ok(text.trim().length > 0, `${id} is empty`);
    // Nothing that chooses or opens a local folder, starts with the system or needs a tray.
    for (const gone of ["Ordner wählen", "Datenordner verschieben", "Ordner öffnen", "In den Infobereich schließen", "Mit Windows starten", "Befehlszeile", "Tastenkürzel (global)", "Hintergrundeffekt", "Minimiert starten", "Vault importieren"]) {
      assert.ok(!text.includes(gone), `${id} shows „${gone}“`);
    }
    if (id === "backup") {
      assert.ok(text.includes("Git"), "the Git sync stays");
      assert.ok(!text.includes("Datenbank mitsichern"), "the phone never uploads the database");
    }
    if (id === "appearance") assert.ok(text.includes("Oberfläche auf Android"));
    assert.deepEqual(await errors(), [], `console errors in ${id}`);
  }
  await app.shot("android-settings-backup");
});

async function theme(mode) {
  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", { settings: { ...view.settings, theme: mode } });
  await app.browser.waitUntil(async () => (await app.browser.execute(() => document.documentElement.dataset.theme)) === mode, { timeoutMsg: `${mode} mode` });
  await sleep(300);
}

/** A picture without the last click's focus ring or hover tooltip. */
async function shot(name) {
  await app.browser.execute(() => {
    document.activeElement?.blur?.();
    document.documentElement.dispatchEvent(new PointerEvent("pointerleave"));
  });
  await app.shot(name);
}

test("screenshots of the full app at tablet sizes and in a desktop window, light and dark", async () => {
  await app.keys(["Escape"]);
  for (const [name, w, h] of [
    ["tablet-portrait", 800, 1280],
    ["tablet-landscape", 1280, 800],
    ["desktop-window", 1480, 920],
  ]) {
    await app.browser.setWindowSize(w, h);
    await app.browser.waitUntil(async () => (await app.browser.execute(() => window.innerWidth)) === w, { timeoutMsg: `the window is not ${w} wide` });
    await sleep(500);
    for (const mode of ["light", "dark"]) {
      await theme(mode);
      await (await T.row("Architektur")).click();
      await app.waitText(".pane.active .tab.active .tab-title", /Architektur/);
      await sleep(300);
      await shot(`android-${name}-${mode}-note`);
      // The start page.
      await app.browser.execute(() => document.querySelector(".pane.active .tabbar .tabbar-home")?.click());
      await sleep(600);
      await shot(`android-${name}-${mode}-start`);
      await openSettings();
      await app.browser.execute(() => document.querySelector('.settings-nav-item[data-section="appearance"]').click());
      await sleep(400);
      await shot(`android-${name}-${mode}-settings`);
      // Nothing sticks out sideways at this size.
      const wide = await app.browser.execute(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(wide <= 1, `${name}: ${wide}px wider than the window`);
    }
  }
  // The setting „Oberfläche auf Android“ in Darstellung, at the tablet's width.
  await theme("light");
  await app.browser.setWindowSize(800, 1280);
  await sleep(400);
  await app.browser.execute(() => {
    const row = [...document.querySelectorAll(".settings-body .set-row")].find((r) => r.textContent.includes("Oberfläche auf Android"));
    row?.scrollIntoView({ block: "center" });
  });
  await sleep(300);
  await shot("android-tablet-portrait-light-interface");
  await app.browser.setWindowSize(1280, 800);
  await sleep(300);
  assert.deepEqual(await errors(), []);
});

test("the start page has no quick-capture window, and a task typed there is stored", async () => {
  await app.browser.execute(() => document.querySelector(".pane.active .tabbar .tabbar-home")?.click());
  await app.waitFor(".dw-actions");
  const actions = await app.browser.execute(() => [...document.querySelectorAll(".dw-actions button")].map((b) => b.textContent.trim()));
  assert.ok(actions.includes("Tagesnotiz") && !actions.includes("Schnellerfassung"), actions.join(" | "));
  const field = await app.waitFor(".dw-add");
  await field.click();
  await app.type("Tablet-Aufgabe prüfen");
  await app.keys(["Enter"]);
  await app.browser.waitUntil(async () => (await app.invoke("tasks_list", { filter: {} })).some((x) => x.text.includes("Tablet-Aufgabe prüfen")), { timeoutMsg: "the task was not stored" });
  assert.deepEqual(await errors(), []);
});

test("the sidebar, its context menu by right click and by long press, and split panes work", async () => {
  await (await T.row("Architektur")).click();
  await app.waitText(".pane.active .tab.active .tab-title", /Architektur/);
  // Right click.
  const before = await menus();
  assert.ok(await onRow("Architektur", "contextmenu", false));
  await app.browser.waitUntil(async () => (await menus()) > before, { timeoutMsg: "no menu on right click" });
  await app.keys(["Escape"]);
  await app.browser.waitUntil(async () => (await menus()) === before, { timeoutMsg: "the menu stayed" });
  // A finger resting on the row (lib/longpress.ts): the same menu.
  assert.ok(await onRow("Architektur", "pointerdown", true));
  await app.browser.waitUntil(async () => (await menus()) > before, { timeout: 3000, timeoutMsg: "no menu on a long press" });
  await onRow("Architektur", "pointerup", true);
  await app.keys(["Escape"]);
  await app.browser.waitUntil(async () => (await menus()) === before, { timeoutMsg: "the menu stayed" });
  // Split to the right; the divider has a grip and resizes.
  await app.click('.pane.active .tabbar [aria-label="Rechts teilen"]');
  await app.browser.waitUntil(async () => (await app.$$(".pane")).length === 2);
  const grip = await app.browser.execute(() => {
    const r = document.querySelector(".pane + .resizer");
    return r ? { w: r.getBoundingClientRect().width, touch: getComputedStyle(r).touchAction } : null;
  });
  assert.ok(grip && grip.w >= 7, JSON.stringify(grip));
  assert.equal(grip.touch, "none", "a finger drags the divider, it does not scroll the page");
  assert.deepEqual(await errors(), []);
});

