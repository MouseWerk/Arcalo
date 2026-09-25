// Quick capture in its own window (pre-created hidden, shown by the shortcut): it opens fast
// with the focus in the field, stores into today's daily note with „Gespeichert in …“ and hides,
// Tab switches to the inbox („Posteingang“ with timestamps), a closed window keeps its draft,
// and the settings offer default target, inbox name, auto-hide and „Auswahl übernehmen“.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";
import { captureVisible, dailyContent, openCapture, pageContent } from "../lib/capture.js";

const test = guarded(nodeTest, () => app);
let app;
before(async () => (app = await launch()));
after(async () => app?.close());

const value = () => app.browser.execute(() => document.querySelector(".capture-input")?.value ?? null);

test("the pre-created window opens within 150 ms with the focus in the field", async () => {
  // Created hidden shortly after start; the shortcut only shows it.
  await app.browser.pause(2500);
  const times = [];
  for (let i = 0; i < 3; i++) {
    const w = await openCapture(app);
    await app.browser.waitUntil(async () => (await app.invoke("desktop_info")).capture_open_ms != null, { timeoutMsg: "no open time" });
    times.push((await app.invoke("desktop_info")).capture_open_ms);
    assert.equal(await captureVisible(app), true);
    await app.keys(["Escape"]);
    await app.browser.waitUntil(async () => (await captureVisible(app)) === false, { timeoutMsg: "Esc did not hide" });
    await w.toMain();
    // A second open measures anew.
    await app.browser.pause(150);
  }
  console.log(`capture open times (ms): ${times.join(", ")}`);
  assert.ok(Math.min(...times) < 150, `open took ${times.join(", ")} ms`);
});

test("a note goes into the daily note, confirmed with a link, then the window hides", async () => {
  await openCapture(app);
  await app.waitText(".capture-chip.target", /Tagesnotiz/);
  await app.type("Idee aus dem Fenster #idee");
  await app.waitText(".capture-hint", /Enter hängt die Notiz an die heutige Tagesnotiz an/);
  await app.shot("68-capture-typing");
  await app.keys(["Enter"]);
  await app.waitText(".capture-foot.done .capture-hint", /Gespeichert in/);
  const link = await app.text(".capture-foot.done .capture-link");
  assert.ok(link.length > 0, "the page is named");
  await app.shot("68-capture-saved");
  assert.equal(await value(), "");
  assert.match(await dailyContent(app), /- Idee aus dem Fenster #idee\n/);
  // Auto-hide after 1.2 s (default).
  await app.browser.waitUntil(async () => (await captureVisible(app)) === false, { timeout: 4000, timeoutMsg: "not hidden after saving" });
});

test("Tab switches to the inbox, which collects captures with a timestamp", async () => {
  await openCapture(app);
  await app.waitText(".capture-chip.target", /Tagesnotiz/);
  await app.keys(["Tab"]);
  await app.waitText(".capture-chip.target", /Posteingang/);
  await app.type("Gedanke für später");
  await app.keys(["Shift", "Enter"]);
  await app.type("todo Nachfassen bis Fr");
  await app.waitFor(".capture-pill");
  assert.match(await app.text(".capture-meta"), /fällig \d{2}\.\d{2}\.\d{4}/);
  await app.shot("68-capture-inbox");
  await app.keys(["Enter"]);
  await app.waitText(".capture-foot.done .capture-link", /Posteingang/);
  const md = await pageContent(app, "Posteingang");
  assert.match(md, /^\*\*\d{2}\.\d{2}\.\d{4}, \d{2}:\d{2}\*\*\n\n- Gedanke für später\n- \[ \] Nachfassen due:\d{4}-\d{2}-\d{2}\n$/);
  const tasks = await app.invoke("tasks_list", { filter: {} });
  const task = tasks.find((t) => t.text === "Nachfassen");
  assert.ok(task?.due, "the due date is indexed");
  assert.equal(new Date(`${task.due}T12:00:00`).getDay(), 5, "a Friday");
  // The next open starts at the default target again.
  await app.browser.waitUntil(async () => (await captureVisible(app)) === false, { timeout: 4000 });
  await openCapture(app);
  await app.waitText(".capture-chip.target", /Tagesnotiz/);
  // The recent captures are listed while the field is empty.
  await app.waitText(".capture-recent-item", /Gedanke für später/);
  await app.shot("68-capture-recent");
});

test("closing without saving keeps the draft and its target", async () => {
  const w = await openCapture(app);
  await app.keys(["Tab"]);
  await app.type("Entwurf, noch nicht fertig");
  await app.keys(["Escape"]);
  await app.browser.waitUntil(async () => (await captureVisible(app)) === false, { timeoutMsg: "Esc did not hide" });
  await w.toMain();
  await openCapture(app);
  assert.equal(await value(), "Entwurf, noch nicht fertig");
  await app.waitText(".capture-chip.target", /Posteingang/);
  // It also survives a reload of the window (a restart of the app).
  await app.browser.execute(() => location.reload());
  await app.browser.waitUntil(async () => (await value()) === "Entwurf, noch nicht fertig", { timeoutMsg: "draft lost on reload" });
  await app.waitText(".capture-chip.target", /Posteingang/);
  await app.browser.execute(() => {
    const el = document.querySelector(".capture-input");
    el.focus();
    el.select();
  });
  await app.keys(["Backspace"]);
  assert.equal(await app.browser.execute(() => localStorage.getItem("annalo.capture.draft")), null, "an empty field clears the draft");
  assert.deepEqual(await app.consoleErrors(), []);
});

test("dark theme and the settings of quick capture", async () => {
  const w = await openCapture(app);
  await w.toMain();
  const view = await app.invoke("settings_get");
  assert.deepEqual(view.settings.capture, { default_target: "daily", inbox_title: "Posteingang", selection_shortcut: "", auto_hide_ms: 1200, meeting_target: true });
  // Ctrl+Alt is AltGr: refused for „Auswahl übernehmen“ as for the other shortcuts; a clash too.
  await assert.rejects(app.invoke("settings_save", { settings: { ...view.settings, capture: { ...view.settings.capture, selection_shortcut: "Ctrl+Shift+Alt+C" } } }), /AltGr/);
  await assert.rejects(
    app.invoke("settings_save", { settings: { ...view.settings, capture: { ...view.settings.capture, selection_shortcut: view.settings.capture_shortcut } } }),
    /Schnellerfassung und Auswahl übernehmen/,
  );
  const saved = await app.invoke("settings_save", {
    settings: { ...view.settings, theme: "dark", capture: { ...view.settings.capture, default_target: "inbox", inbox_title: "  Eingang  ", auto_hide_ms: 99999 } },
  });
  assert.deepEqual([saved.settings.capture.inbox_title, saved.settings.capture.auto_hide_ms], ["Eingang", 10000]);

  // Settings → Desktop shows the group.
  await app.keys(["Control", ","]);
  await app.waitFor(".pane.active .settings");
  await app.browser.execute(() => [...document.querySelectorAll(".settings-nav-item")].find((b) => b.textContent.includes("Desktop"))?.click());
  await app.waitText(".settings-head h1", /Desktop/);
  await app.waitFor('[aria-label="Standardziel der Schnellerfassung"]');
  await app.waitFor('[aria-label="Tastenkürzel Auswahl übernehmen"]');
  await app.browser.execute(() => [...document.querySelectorAll(".set-group-head h2")].find((h) => /Schnellerfassung/.test(h.textContent))?.scrollIntoView({ block: "start" }));
  await app.shot("68-settings-capture");

  // The window follows: dark, and the inbox (with its new name) as default target.
  await openCapture(app);
  await app.waitText(".capture-chip.target", /Eingang/);
  await app.browser.waitUntil(async () => (await app.browser.execute(() => document.documentElement.dataset.theme)) === "dark", { timeoutMsg: "not dark" });
  await app.type("todo Angebot an [[Kunde]] senden bis morgen");
  await app.waitFor(".capture-pill");
  await app.shot("68-capture-dark");
  await app.browser.execute(() => {
    const el = document.querySelector(".capture-input");
    el.select();
  });
  await app.keys(["Backspace"]);
  await app.keys(["Escape"]);
});
