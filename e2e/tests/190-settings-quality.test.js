// Settings quality pass (1.12): the menu is one Tab stop with arrow keys inside, Tab leaves a
// shortcut recorder, a PIN the app lock refuses keeps its dialog open (no success note), the
// language row names the system's language, „Verwaltung“ resets every section that has its own
// reset, and „Über“ lists Arcalo's license and the open-source libraries.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { launch, guarded } from "../lib/harness.js";

let app;
const test = guarded(nodeTest, () => app);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  app = await launch({ demo: true, env: { ARCALO_SECRET_STORE: "file", ARCALO_LOCALE: "en-US" } });
  // German interface on an English system.
  const view = await app.invoke("settings_get");
  if (view.settings.locale.language !== "de") await app.invoke("settings_save", { settings: { ...view.settings, locale: { ...view.settings.locale, language: "de" } } });
  await app.keys(["Control", ","]);
  await app.waitFor(".settings-nav");
});
after(async () => app?.close());

const openSection = async (id) => {
  await app.click(`.settings-nav-item[data-section="${id}"]`);
  await app.browser.waitUntil(() => app.browser.execute((s) => document.querySelector(`.settings-nav-item[data-section="${s}"]`)?.getAttribute("aria-current") === "page", id), { timeoutMsg: `${id} not open` });
  await sleep(200);
};
const focused = () => app.browser.execute(() => document.activeElement?.dataset.section ?? document.activeElement?.className ?? "");

test("the settings menu is one Tab stop; arrow keys, Home and End move inside it", async () => {
  await openSection("security");
  const stops = await app.browser.execute(() => [...document.querySelectorAll(".settings-nav button")].filter((b) => b.tabIndex >= 0).map((b) => b.dataset.section ?? b.className));
  assert.deepEqual(stops, ["security"], "only the open section is in the Tab order");
  await app.browser.execute(() => document.querySelector(".settings-nav .settings-search input").focus());
  await app.keys(["Tab"]);
  assert.equal(await focused(), "security");
  await app.keys(["ArrowDown"]);
  assert.equal(await focused(), "network");
  await app.keys(["ArrowUp"]);
  await app.keys(["ArrowUp"]);
  assert.equal(await focused(), "privacy");
  await app.keys(["Home"]);
  assert.match(await focused(), /settings-nav-group-label/);
  await app.keys(["End"]);
  assert.equal(await focused(), "about");
  await app.keys(["Enter"]);
  await app.browser.waitUntil(() => app.browser.execute(() => document.querySelector('.settings-nav-item[data-section="about"]').getAttribute("aria-current") === "page"), { timeoutMsg: "Enter did not open the section" });
  // The next Tab goes on to the section's content, not through the rest of the menu.
  await app.keys(["Tab"]);
  assert.equal(await app.browser.execute(() => !!document.activeElement?.closest(".settings-main")), true);
});

test("Tab ends recording a shortcut and moves on", async () => {
  await openSection("keyboard");
  const before = (await app.invoke("settings_get")).settings.keymap ?? {};
  await app.click(".key-recorder");
  await app.waitFor(".key-recorder.recording");
  await app.keys(["Tab"]);
  await app.browser.waitUntil(() => app.browser.execute(() => !document.querySelector(".key-recorder.recording")), { timeoutMsg: "still recording" });
  assert.equal(await app.browser.execute(() => document.activeElement === document.querySelector(".key-recorder")), false, "the focus moved on");
  assert.deepEqual((await app.invoke("settings_get")).settings.keymap ?? {}, before, "nothing was bound");
});

test("a PIN the app lock refuses keeps the dialog open and says so", async () => {
  await openSection("security");
  // The credential store cannot be written (a folder where its file belongs): the command fails.
  const store = path.join(app.dataDir, "secrets.json");
  const kept = fs.existsSync(store) ? fs.readFileSync(store) : null;
  fs.rmSync(store, { force: true });
  fs.mkdirSync(path.join(store, "blocked"), { recursive: true });
  // „Beim Start“ asks for the PIN first (the choice shows once it is saved).
  await app.click(".sec-lock-mode");
  const list = await app.browser.waitUntil(() => app.browser.execute(() => document.querySelector(".sec-lock-mode")?.getAttribute("aria-controls")), { timeoutMsg: "mode list not open" });
  await app.click(`#${list} [role="option"][data-value="start"]`);
  await app.waitFor(".dialog .sec-pin-1");
  await app.click(".dialog .sec-pin-1");
  await app.type("2468");
  await app.click(".dialog .sec-pin-2");
  await app.type("2468");
  await app.click(".dialog .sec-pin-save");
  await app.waitText(".toast", /App-Sperre nicht geändert/);
  await sleep(300);
  assert.equal(await app.browser.execute(() => !!document.querySelector(".dialog .sec-pin-1")), true, "the dialog stays open");
  const toasts = await app.browser.execute(() => [...document.querySelectorAll(".toast")].map((t) => t.innerText).join(" | "));
  assert.doesNotMatch(toasts, /App-Sperre eingerichtet/);
  // Linux without encryption: no way to reset a forgotten PIN in the app, said before it is set.
  assert.match(await app.text(".dialog .sec-pin-noreset"), /vergessene PIN nicht in Arcalo zurücksetzen/);
  fs.rmSync(store, { recursive: true, force: true });
  if (kept) fs.writeFileSync(store, kept);
  // Now it works: saved, the dialog closes with the note.
  await app.click(".dialog .sec-pin-save");
  await app.waitText(".toast", /App-Sperre eingerichtet/);
  await app.browser.waitUntil(() => app.browser.execute(() => !document.querySelector(".dialog .sec-pin-1")), { timeoutMsg: "dialog still open" });
  assert.equal((await app.invoke("applock_status")).config.mode, "start");
  // „PIN vergessen?“ there: the command that removes the lock by hand, ready to copy.
  await app.invoke("applock_lock_now");
  await app.waitFor(".lock-screen", 6000);
  await app.click(".lock-link");
  await app.waitText(".lock-forgot", /führe im Datenordner von Arcalo diesen Befehl aus/);
  assert.equal(await app.text(".lock-cmd"), `sqlite3 workspace.db "DELETE FROM settings WHERE key LIKE 'meta.applock%'"`);
  await app.shot("190-lock-forgot");
  await app.click(".lock-pin");
  await app.type("2468");
  await app.keys(["Enter"]);
  await app.browser.waitUntil(() => app.browser.execute(() => !document.querySelector(".lock-screen") && !!document.querySelector(".sidebar, .side-tabs")), { timeout: 10000, timeoutMsg: "not unlocked" });
  if (!(await app.browser.execute(() => !!document.querySelector(".pane.active > .pane-content:not([hidden]) .settings-nav")))) await app.keys(["Control", ","]);
  await app.waitFor(".settings-nav");
  await app.invoke("applock_configure", { config: { ...(await app.invoke("applock_status")).config, mode: "off" }, pin: null });
  await app.dismissToasts();
});

test("the language row names the system's language", async () => {
  await openSection("locale");
  await app.waitText(".set-row", /Sprache des Systems: English/);
});

test("Verwaltung resets every section that has its own reset", async () => {
  await openSection("admin");
  const sel = ".settings-body .set-row .select";
  await app.click(sel);
  const values = await app.browser.waitUntil(
    () =>
      app.browser.execute((s) => {
        const id = document.querySelector(s)?.getAttribute("aria-controls");
        const list = id && document.getElementById(id);
        return list ? [...list.querySelectorAll('[role="option"]')].map((o) => o.dataset.value) : null;
      }, sel),
    { timeoutMsg: "list not open" },
  );
  await app.keys(["Escape"]);
  for (const id of ["filing", "jira", "briefing", "voice", "keyboard", "network"]) assert.ok(values.includes(id), `${id} missing in ${values}`);
  // Each one resets in the backend.
  for (const id of values) await app.invoke("settings_defaults", { section: id });
});

test("Über lists Arcalo's license and the open-source libraries", async () => {
  await openSection("about");
  await app.waitText(".set-row", /MIT-Lizenz · © 20\d\d /);
  await app.click(".lic-app");
  await app.waitText(".dialog .lic-text", /^MIT License/);
  await app.shot("190-license");
  await app.keys(["Escape"]);
  await app.click(".lic-libs");
  await app.waitFor(".dialog .lic-row");
  const count = () => app.browser.execute(() => document.querySelectorAll(".dialog .lic-row").length);
  const all = await count();
  assert.ok(all > 40, `libraries listed: ${all}`);
  const names = await app.browser.execute(() => [...document.querySelectorAll(".dialog .lic-name")].map((n) => n.textContent));
  for (const n of ["react", "tauri", "rusqlite"]) assert.ok(names.includes(n), `${n} listed`);
  // Every library has its license.
  assert.equal(await app.browser.execute(() => [...document.querySelectorAll(".dialog .lic-license")].filter((l) => l.textContent === "Siehe Bibliothek").length), 0);
  await app.shot("190-libraries");
  await app.click(".dialog .lic-search input");
  await app.type("apache");
  await app.browser.waitUntil(async () => (await count()) > 0 && (await count()) < all, { timeoutMsg: "search did not filter" });
  await app.type("zzz");
  await app.waitText(".dialog .lic-none", /Keine Bibliothek passt zu „apachezzz“/);
  await app.keys(["Escape"]);
});

test("Mod+F goes to the visible search field in a narrow pane too", async () => {
  await app.browser.setWindowSize(900, 800);
  try {
    await app.browser.waitUntil(() => app.browser.execute(() => getComputedStyle(document.querySelector(".pane-content:not([hidden]) .settings-nav")).display === "none"), { timeoutMsg: "menu still shown" });
    await app.browser.execute(() => document.querySelector(".settings-body button")?.focus());
    await app.keys(["Control", "f"]);
    await app.browser.waitUntil(() => app.browser.execute(() => !!document.activeElement?.closest(".settings-topbar .settings-search")), { timeoutMsg: "search not focused" });
    await app.type("Proxy");
    await app.browser.waitUntil(() => app.browser.execute(() => document.querySelector(".settings")?.classList.contains("searching")), { timeoutMsg: "search did not run" });
    await app.keys(["Escape"]);
  } finally {
    await app.browser.setWindowSize(1480, 920);
  }
});
