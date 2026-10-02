// Settings 1.10: every change applies at once with an undo toast (typing once it pauses,
// validated fields on blur or Enter with an inline error), destructive changes keep their undo
// longer, „Abschnitt zurücksetzen“ per section, and the grouped, collapsible menu at 760 and
// 920 px (never over the search, scrolls inside, remembered, the search still finds all).
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";
import { clickUndo, settingsSettled, storedSettings } from "../lib/settings.js";

const test = guarded(nodeTest, () => app);
let app;
before(async () => {
  app = await launch();
});
after(async () => app?.close());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function openSection(id) {
  if (!(await app.browser.execute(() => !!document.querySelector(".pane.active .settings")))) await app.keys(["Control", ","]);
  await app.waitFor(".pane.active .settings");
  await app.browser.execute((s) => document.querySelector(`.pane.active .settings-nav-item[data-section="${s}"]`).click(), id);
  await app.waitFor(`.pane.active .settings-nav-item.active[data-section="${id}"]`);
}
const toastTitles = () => app.browser.execute(() => [...document.querySelectorAll(".toast-title")].map((t) => t.textContent));

test("a switch applies at once, without a save bar, and „Rückgängig“ takes it back", async () => {
  await openSection("editor");
  const sw = '.pane.active button[role="switch"][aria-label="Typografische Anführungszeichen"]';
  const before = (await storedSettings(app)).editor.smart_quotes;
  await app.click(sw);
  await settingsSettled(app);
  assert.equal((await storedSettings(app)).editor.smart_quotes, !before, "stored without a save button");
  assert.equal(await app.browser.execute(() => !!document.querySelector(".savebar")), false, "no save bar anywhere");
  await app.waitText(".toast-title", /Einstellung geändert/);
  assert.match(await app.text(".toast .toast-detail"), /Editor/);
  await clickUndo(app);
  await settingsSettled(app);
  assert.equal((await storedSettings(app)).editor.smart_quotes, before, "undone");
  assert.equal(await app.browser.execute((s) => document.querySelector(s).getAttribute("aria-checked"), sw), String(before));
  await app.waitText(".toast-title", /rückgängig gemacht/);
  await app.dismissToasts();
});

test("typing is one change: saved once it pauses, one undo restores the text before", async () => {
  await openSection("ai");
  const area = await app.waitFor(".pane.active textarea");
  await area.click();
  await app.type("Antworte kurz.");
  await sleep(1200);
  assert.equal((await storedSettings(app)).assistant_instructions, "Antworte kurz.", "saved after the pause");
  const undoToasts = await app.browser.execute(() => document.querySelectorAll(".toast").length);
  assert.equal(undoToasts, 1, `one toast for the whole text: ${await toastTitles()}`);
  await clickUndo(app);
  await settingsSettled(app);
  assert.equal((await storedSettings(app)).assistant_instructions, "");
  await app.dismissToasts();
});

test("an address applies on Enter, an invalid one stays with an inline error", async () => {
  // The fields of the default profile („Standard“, selected when the section opens).
  const mode = (await storedSettings(app)).network.profiles[0].mode;
  await openSection("network");
  // „Manuell“ waits for an address before it is stored (a manual proxy needs one).
  await app.browser.execute(() => [...document.querySelectorAll('.pane.active [role="radiogroup"][aria-label="Proxy-Modus"] [role="radio"]')].find((b) => b.textContent.trim() === "Manuell").click());
  await settingsSettled(app);
  assert.equal((await storedSettings(app)).network.profiles[0].mode, mode, "not stored without an address");
  const field = '.pane.active input[aria-label="HTTP-Proxy"]';
  const el = await app.waitFor(field);
  await el.click();
  await app.type("proxy firma");
  await app.keys(["Enter"]);
  await app.waitText(".pane.active .field-error", /Ungültige Adresse/);
  assert.equal(await app.browser.execute((f) => document.querySelector(f).getAttribute("aria-invalid"), field), "true");
  await settingsSettled(app);
  assert.equal((await storedSettings(app)).network.profiles[0].http_proxy, "", "not stored");
  await app.browser.execute((f) => {
    const i = document.querySelector(f);
    i.focus();
    i.select();
  }, field);
  await app.type("proxy.firma.de:8080");
  await app.keys(["Enter"]);
  await settingsSettled(app);
  const net = (await storedSettings(app)).network.profiles[0];
  assert.deepEqual([net.mode, net.http_proxy], ["manual", "http://proxy.firma.de:8080"], "mode and address stored together (normalized)");
  assert.equal(await app.browser.execute(() => !!document.querySelector(".pane.active .field-error")), false);
  await app.shot("133-network-inline");
  const back = await storedSettings(app);
  await app.invoke("settings_save", { settings: { ...back, network: { ...back.network, profiles: back.network.profiles.map((p, i) => (i ? p : { ...p, mode, http_proxy: "" })) } } });
  await app.dismissToasts();
});

test("switching time tracking off applies at once and keeps its undo longer", async () => {
  await openSection("time");
  await app.click('.pane.active button[role="switch"][aria-label="Zeiterfassung verwenden"]');
  await settingsSettled(app);
  assert.equal((await storedSettings(app)).time.enabled, false);
  await app.waitText(".toast-title", /Einstellung geändert/);
  // An ordinary change's toast is gone after 7 s; this one is still there.
  await sleep(8500);
  assert.ok((await toastTitles()).some((t) => /Einstellung geändert/.test(t)), "undo still offered");
  await clickUndo(app);
  await settingsSettled(app);
  assert.equal((await storedSettings(app)).time.enabled, true);
  await app.dismissToasts();
});

test("„Abschnitt zurücksetzen“ restores the defaults of the section, with undo", async () => {
  await openSection("editor");
  const field = '.pane.active input[aria-label="Automatisch speichern nach"]';
  await app.browser.execute((f) => {
    const i = document.querySelector(f);
    i.focus();
    i.select();
  }, field);
  await app.type("1200");
  await app.keys(["Enter"]);
  await settingsSettled(app);
  assert.equal((await storedSettings(app)).editor.autosave_ms, 1200);
  await app.dismissToasts();
  await app.click(".pane.active .settings-reset");
  await settingsSettled(app);
  const reset = await storedSettings(app);
  assert.notEqual(reset.editor.autosave_ms, 1200, "back to the default");
  await app.waitText(".toast-title", /Abschnitt zurückgesetzt/);
  await clickUndo(app);
  await settingsSettled(app);
  assert.equal((await storedSettings(app)).editor.autosave_ms, 1200, "reset undone");
  await app.dismissToasts();
});

test("the grouped menu: collapsible, remembered, never over the search, scrolls inside at 760 and 920 px", async () => {
  await openSection("appearance");
  const groups = await app.browser.execute(() => [...document.querySelectorAll(".pane.active .settings-nav-group-label")].map((g) => g.textContent.trim()));
  assert.deepEqual(groups, ["Allgemein", "Arbeiten", "KI & Sprache", "Daten & Sicherheit", "System"]);
  const count = await app.browser.execute(() => document.querySelectorAll(".pane.active .settings-nav-item").length);
  assert.equal(count, 22, "21 sections and „Sicherheit“ (1.10)");
  // Collapse „Arbeiten“: its items hide, the state survives a reload.
  await app.browser.execute(() => document.querySelector('.pane.active .settings-nav-group[data-group="work"] .settings-nav-group-label').click());
  const hidden = () => app.browser.execute(() => document.querySelector('.pane.active .settings-nav-group[data-group="work"] .settings-nav-items').hidden);
  assert.equal(await hidden(), true);
  await app.browser.execute(() => location.reload());
  await app.browser.waitUntil(async () => app.browser.execute(() => document.body.classList.contains("ready")), { timeout: 20000 });
  await openSection("appearance");
  assert.equal(await hidden(), true, "remembered");
  // The search still finds a section of the collapsed group.
  await app.browser.execute(() => document.querySelector(".pane.active .settings-nav .settings-search input").focus());
  await app.type("Jira");
  await app.waitFor('.pane.active .settings-hit-section[data-section="jira"]:not([hidden])');
  await app.keys(["Escape"]);
  // Opening a section of a collapsed group shows the group.
  await openSection("jira");
  assert.equal(await hidden(), false, "the open section's group shows");
  await openSection("appearance");
  for (const [w, h] of [[1480, 760], [1480, 920], [1100, 640]]) {
    await app.browser.setWindowSize(w, h);
    await sleep(350);
    const m = await app.browser.execute(() => {
      const nav = document.querySelector(".pane.active .settings-nav");
      if (!nav || nav.offsetParent === null) return { shown: false };
      const search = nav.querySelector(".settings-search").getBoundingClientRect();
      const list = nav.querySelector(".settings-nav-list");
      const lb = list.getBoundingClientRect();
      const items = [...list.querySelectorAll(".settings-nav-item")].filter((i) => i.offsetParent !== null);
      list.scrollTop = list.scrollHeight;
      const last = items[items.length - 1].getBoundingClientRect();
      const lastIn = last.bottom <= lb.bottom + 0.5 && last.top >= lb.top - 0.5;
      list.scrollTop = 0;
      const first = items[0].getBoundingClientRect();
      return { shown: true, clear: lb.top >= search.bottom - 0.5 && first.top >= search.bottom, lastIn, inside: lb.bottom <= innerHeight + 0.5, overflow: getComputedStyle(list).overflowY };
    });
    if (!m.shown) continue;
    assert.deepEqual(m, { shown: true, clear: true, lastIn: true, inside: true, overflow: "auto" }, `${w}x${h}`);
  }
  await app.browser.setWindowSize(1480, 920);
  await sleep(300);
  await app.shot("133-settings-grouped-920");
  // Expanded again for the next runs.
  await app.browser.execute(() => document.querySelector('.pane.active .settings-nav-group[data-group="work"] .settings-nav-group-label').click());
  assert.equal(await hidden(), false);
});
