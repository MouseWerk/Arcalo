// Auto-update gating: test builds have no update key, so the updater is off – no network
// access, a clear „nicht eingerichtet“ state in Settings → Über, and no install path.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
before(async () => (app = await launch()));
after(async () => app?.close());

test("builds without an update key report the updater as off", async () => {
  const status = await app.invoke("update_status");
  assert.equal(status.enabled, false);
  assert.equal(status.available, null);
  assert.match(status.current_version, /^\d+\.\d+\.\d+/);
  await assert.rejects(app.invoke("update_check"), /nicht eingerichtet/);
  await assert.rejects(app.invoke("update_install"), /nicht eingerichtet/);
});

test("the automatic check setting defaults to on and is saved", async () => {
  const view = await app.invoke("settings_get");
  assert.equal(view.settings.auto_update_check, true);
  const saved = await app.invoke("settings_save", { settings: { ...view.settings, auto_update_check: false } });
  assert.equal(saved.settings.auto_update_check, false);
  const back = await app.invoke("settings_save", { settings: { ...saved.settings, auto_update_check: true } });
  assert.equal(back.settings.auto_update_check, true);
});

test("Settings → Über shows that updates are not set up", async () => {
  await app.keys(["Control", ","]);
  await app.waitFor(".settings-nav");
  await app.browser.execute(() => [...document.querySelectorAll(".settings-nav-item")].find((b) => b.textContent.includes("Über"))?.click());
  await app.waitText(".settings-head h1", /Annalo/);
  await app.waitText(".update-state", /Automatische Updates sind in diesem Build nicht eingerichtet/);
  const button = await app.browser.execute(() => {
    const b = [...document.querySelectorAll(".settings button")].find((x) => x.textContent.includes("Jetzt nach Updates suchen"));
    return b ? { disabled: b.disabled } : null;
  });
  assert.deepEqual(button, { disabled: true });
  // Without a key there is no automatic-check switch and never an update toast.
  assert.equal(await (await app.$('[role="switch"][aria-label="Automatisch nach Updates suchen"]')).isExisting(), false);
  assert.equal(await (await app.$(".update-toast")).isExisting(), false);
});
