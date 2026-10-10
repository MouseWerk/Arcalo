// Closing the main window outside macOS follows „close to tray“ (macOS always hides; that part is
// unit-tested in arcalo_core::desktop and checked by hand, docs/testing/macos.md): without it the
// shell reports „quit“, with it the window is hidden (or minimized without a tray icon) and the
// app keeps running with the edits. Key presses that belong to an input method composition
// (WebKit sends the committing Enter with keyCode 229) do not store a quick capture.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";
import { captureVisible, dailyContent, openCapture } from "../lib/capture.js";

const test = guarded(nodeTest, () => app);
let app;
before(async () => (app = await launch()));
after(async () => app?.close());

const windowState = (cmd) =>
  app.browser.executeAsync((c, done) => window.__TAURI_INTERNALS__.invoke(`plugin:window|${c}`, { label: "main" }).then(done, () => done(null)), cmd);

test("closing quits by default and hides (or minimizes) with close to tray", async () => {
  const view = await app.invoke("settings_get");
  assert.equal(view.settings.close_to_tray, false, "off by default outside Windows");
  assert.equal(await app.invoke("window_close_action"), "quit");
  await app.invoke("settings_save", { settings: { ...view.settings, close_to_tray: true } });
  const tray = (await app.invoke("desktop_info")).tray;
  assert.equal(await app.invoke("window_close_action"), tray ? "hide" : "minimize");
});

test("the close button keeps the app running, the window comes back with the edit", async () => {
  const page = await app.invoke("page_create", { parentId: null, title: "Schließen-Test", icon: null, content: "Anfang\n" });
  await app.invoke("search_open", { target: { kind: "page", page_id: page.id, new_tab: false } });
  await app.browser.waitUntil(async () => (await app.browser.execute(() => document.querySelector(".pane.active > .pane-content:not([hidden]) .page-title")?.value)) === page.title, {
    timeoutMsg: "page not open",
  });
  await app.browser.pause(400);
  await app.caretToEnd();
  await app.type("Vor dem Schließen");
  const tray = (await app.invoke("desktop_info")).tray;
  // What the title bar's close button sends (closing it for real needs a window manager click):
  // the UI stores the editors, then hides or minimizes.
  await app.browser.execute(() => void window.__TAURI__.event.emitTo("main", "tauri://close-requested", null));
  await app.browser.waitUntil(async () => (tray ? (await windowState("is_visible")) === false : (await windowState("is_minimized")) === true), {
    timeout: 8000,
    timeoutMsg: "the window neither hid nor minimized",
  });
  // Still running: commands answer, and the edit was stored before the window went away.
  assert.match((await app.invoke("page_get", { id: page.id })).content, /Vor dem Schließen/);
  // Back to the front (as the tray's „Öffnen“ does).
  await app.invoke("search_open", { target: { kind: "timesheet" } });
  await app.browser.waitUntil(async () => (await windowState("is_visible")) === true && (await windowState("is_minimized")) === false, {
    timeout: 8000,
    timeoutMsg: "the window did not come back",
  });
  await app.waitFor(".tab");
  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", { settings: { ...view.settings, close_to_tray: false } });
});

test("Enter while an input method composes does not store the capture", async () => {
  const w = await openCapture(app);
  await app.type("Ärger über Grüße");
  // The Enter that commits a composition: flagged, or (WebKit on macOS) keyCode 229 only.
  const sent = await app.browser.execute(() => {
    const el = document.querySelector(".capture-input");
    const fire = (init) => el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true, ...init }));
    fire({ isComposing: true });
    const legacy = new KeyboardEvent("keydown", { keyCode: 229 }).keyCode === 229;
    if (legacy) fire({ keyCode: 229 });
    fire({ key: "Escape", code: "Escape", isComposing: true });
    return legacy;
  });
  console.log(`keyCode 229 via KeyboardEventInit: ${sent ? "sent" : "not supported here"}`);
  await app.browser.pause(400);
  assert.equal(await captureVisible(app), true, "Esc during a composition keeps the window");
  assert.equal(await app.browser.execute(() => document.querySelector(".capture-input").value), "Ärger über Grüße");
  assert.equal(await app.browser.execute(() => !!document.querySelector(".capture-foot.done")), false, "nothing stored yet");
  await app.keys(["Enter"]);
  await app.waitText(".capture-foot.done .capture-hint", /Gespeichert in/);
  await w.toMain();
  assert.match(await dailyContent(app), /- Ärger über Grüße\n/);
});

test("no console errors", async () => {
  assert.deepEqual(await app.browser.execute(() => window.__arcaloErrors), []);
});
