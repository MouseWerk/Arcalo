// Desktop integration: quick capture into the daily note, capture window UI, Desktop settings.
// Tray, notifications and global shortcuts need a real desktop session; under Xvfb they
// must simply not break the app.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
before(async () => (app = await launch()));
after(async () => app?.close());

const daily = async () => {
  const page = await app.invoke("daily_note", { date: null });
  return (await app.invoke("page_get", { id: page.id })).content;
};

test("capture_submit appends notes and tasks to today's daily note", async () => {
  const out = await app.invoke("capture_submit", { text: "Idee aus der Schnellerfassung\ntodo E2E-Aufgabe anlegen" });
  assert.equal(out.bookings.length, 0);
  assert.deepEqual([out.appended.tasks, out.appended.notes], [1, 1]);
  const md = await daily();
  assert.match(md, /^- Idee aus der Schnellerfassung\n- \[ \] E2E-Aufgabe anlegen\n$/m);
  const tasks = await app.invoke("tasks_list", { filter: null });
  assert.ok(tasks.some((t) => t.text.includes("E2E-Aufgabe anlegen")), "captured task is indexed");
});

test("capture_submit books /zeit lines and rejects bad ones without side effects", async () => {
  const out = await app.invoke("capture_submit", { text: "/zeit NP-8801/1020 0.5h #DEV 'Aus der Schnellerfassung'" });
  assert.equal(out.appended, null);
  assert.equal(out.bookings[0].entry.duration_minutes, 30);
  const before = await daily();
  await assert.rejects(app.invoke("capture_submit", { text: "/zeit NP-0000 1h\nsollte nicht landen" }), /NP-0000/);
  assert.equal(await daily(), before);
  await assert.rejects(app.invoke("capture_submit", { text: "   " }), /Nichts zu erfassen/);
});

test("settings validate the reminder time and keep desktop fields", async () => {
  const view = await app.invoke("settings_get");
  assert.equal(view.settings.reminder_time, "17:30");
  assert.equal(view.settings.capture_shortcut, "Ctrl+Shift+Space");
  await assert.rejects(app.invoke("settings_save", { settings: { ...view.settings, reminder_time: "abends" } }), /HH:MM/);
  await assert.rejects(app.invoke("settings_save", { settings: { ...view.settings, capture_shortcut: "Ctrl+Nix" } }), /ungültig/);
  const saved = await app.invoke("settings_save", { settings: { ...view.settings, reminder_time: "9:05" } });
  assert.equal(saved.settings.reminder_time, "09:05");
  const off = await app.invoke("settings_save", { settings: { ...view.settings, reminder_time: null } });
  assert.equal(off.settings.reminder_time, null);
  const info = await app.invoke("desktop_info");
  assert.equal(typeof info.tray, "boolean");
});

test("Desktop settings section shows the switches", async () => {
  await app.keys(["Control", ","]);
  await app.waitFor(".settings-nav");
  await app.browser.execute(() => [...document.querySelectorAll(".settings-nav-item")].find((b) => b.textContent.includes("Desktop"))?.click());
  await app.waitText(".settings-head h1", /Desktop/);
  assert.ok(await (await app.$('[role="switch"][aria-label="In den Infobereich schließen"]')).isExisting());
  assert.ok(await (await app.$('[role="switch"][aria-label="Mit Windows starten"]')).isExisting());
  const sc = await app.$('input[aria-label="Tastenkürzel für die Schnellerfassung"]');
  assert.equal(await sc.getValue(), "Ctrl+Shift+Space");
  // The field records the pressed keys.
  await sc.click();
  await app.keys(["Control", "Shift", "k"]);
  await app.browser.waitUntil(async () => (await sc.getValue()) === "Ctrl+Shift+K", { timeoutMsg: "shortcut not recorded" });
  await app.shot("settings-desktop");
});

test("the capture UI (#capture) submits with Enter", async () => {
  // Load the capture view in this window: the separate window needs a global shortcut.
  await app.browser.execute(() => {
    location.hash = "#capture";
    location.reload();
  });
  const input = await app.waitFor('textarea[aria-label="Schnellerfassung"]');
  await app.browser.waitUntil(() => app.browser.execute(() => document.activeElement?.getAttribute("aria-label") === "Schnellerfassung"), {
    timeoutMsg: "capture input not focused",
  });
  await app.type("todo Aus dem Fenster");
  await app.waitText(".capture-hint", /Aufgabe/);
  await app.shot("capture-window");
  await app.keys(["Enter"]);
  await app.browser.waitUntil(async () => (await daily()).includes("- [ ] Aus dem Fenster\n"), { timeoutMsg: "capture not stored" });
  assert.equal(await input.getValue(), "");

  // Several lines (Shift+Enter or pasted) stay separate captures.
  await app.type("Erste Zeile");
  await app.keys(["Shift", "Enter"]);
  await app.type("todo Zweite Zeile");
  await app.waitText(".capture-hint", /2 Zeilen/);
  assert.equal(await input.getValue(), "Erste Zeile\ntodo Zweite Zeile");
  await app.keys(["Enter"]);
  await app.browser.waitUntil(async () => /Erste Zeile\n[\s\S]*- \[ \] Zweite Zeile\n/.test(await daily()), { timeoutMsg: "multi-line capture not stored" });
  assert.equal(await input.getValue(), "");

  // /zeit suggests references under the field; Enter picks, Esc closes the list first.
  await app.type("/zeit NP-8801/10");
  await app.waitText(".capture-sugg .sugg-item.sel", /NP-8801\/10/);
  await app.keys(["Enter"]);
  await app.browser.waitUntil(async () => /^\/zeit NP-8801\/10\d0 $/.test(await input.getValue()), { timeoutMsg: "suggestion not inserted" });
  assert.equal(await (await app.$(".capture-sugg")).isExisting(), false);
  await app.type("#");
  await app.waitFor(".capture-sugg .sugg-item");
  await app.keys(["Escape"]);
  await app.browser.waitUntil(async () => !(await (await app.$(".capture-sugg")).isExisting()));
  assert.match(await app.text(".capture-hint"), /Esc schließt/);
  assert.deepEqual(await app.consoleErrors(), []);
});
