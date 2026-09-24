// Startup animation: the mark draws itself, the app shows through once ready, the switch in
// Settings → Darstellung turns it off. (Under WebDriver it is skipped unless forced.)
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
before(async () => (app = await launch()));
after(async () => app?.close());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const splash = () => app.browser.execute(() => !!document.getElementById("splash"));

test("the logo animates while the app starts, then gets out of the way", async () => {
  await app.browser.execute(() => localStorage.setItem("annalo.splash-test", "1"));
  await app.browser.refresh();
  assert.ok(await splash(), "shown at start");
  await sleep(150);
  await app.shot("splash-1-draw");
  await sleep(250);
  await app.shot("splash-2-fill");
  // Never blocks clicks, even while visible.
  assert.equal(await app.browser.execute(() => getComputedStyle(document.getElementById("splash")).pointerEvents), "none");
  await sleep(150);
  await app.shot("splash-3-name");
  await app.browser.waitUntil(async () => !(await splash()), { timeout: 5000, timeoutMsg: "splash stays" });
  await app.waitFor(".home, .pane");
});

test("Settings → Darstellung „Startanimation“ turns it off", async () => {
  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", { settings: { ...view.settings, appearance: { ...view.settings.appearance, startup_animation: false } } });
  // The app remembers the switch for the next start.
  await app.browser.waitUntil(async () => app.browser.execute(() => JSON.parse(localStorage.getItem("annalo.splash") ?? "{}").off === true), {
    timeoutMsg: "switch not remembered",
  });
  await app.browser.refresh();
  const stored = await app.browser.execute(() => localStorage.getItem("annalo.splash"));
  assert.equal(await splash(), false, stored);
  await app.browser.execute(() => localStorage.removeItem("annalo.splash-test"));
  await app.invoke("settings_save", { settings: view.settings });
});

test("no console errors", async () => {
  assert.deepEqual(await app.browser.execute(() => window.__annaloErrors ?? []), []);
});
