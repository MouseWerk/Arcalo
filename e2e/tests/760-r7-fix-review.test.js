// Round 7 review of the round 6 fixes and performance with large data
// (docs/quality/q124/r7-fix-review-performance.md).

import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";
import { startFakeOpenAI } from "../lib/fake-openai.js";

const test = guarded(nodeTest, () => app);
let app, slow;
before(async () => {
  slow = await startFakeOpenAI({ port: 4995, kind: "openai", name: "Langsam", models: ["gpt-4o", "gpt-4o-mini", "o3", "text-embedding-3-small"], modelsDelay: 2500 });
  app = await launch();
});
after(async () => {
  await app?.close();
  await slow?.close();
});

// R7D-1: the soak of main failed e2e 37 three times since R6D-1 with „Anbieter für Lokales
// Modell did not open“. Every provider is checked again after a change; its status line
// („Prüfe…“, then „Verbunden · 4 Modelle“) decided whether the address fitted on the line or
// wrapped below it, so the rows changed height when a check answered and everything below,
// the tier dropdowns too, jumped by a line under the pointer.
test("a provider row keeps its height while its connection is checked again", async () => {
  const view = await app.invoke("settings_get");
  const base = view.settings.providers[0];
  await app.invoke("settings_save", {
    settings: { ...view.settings, providers: [...view.settings.providers, { ...base, id: "langsam", name: "Langsam", kind: "openai", base_url: `${slow.url}/v1`, local: false, enabled: true }] },
  });
  await app.keys(["Control", ","]);
  await app.waitText(".settings-head h1", /KI & Modelle/);
  const measure = () =>
    app.browser.execute(() => {
      const row = document.querySelector('[data-provider="langsam"]');
      const tier = document.querySelector('[role="combobox"][aria-label="Anbieter für Lokales Modell"]');
      return { status: row?.querySelector(".conn")?.textContent ?? "", height: row?.getBoundingClientRect().height ?? 0, tier: tier?.getBoundingClientRect().top ?? 0 };
    });
  for (const width of [1480, 1100, 900]) {
    await app.browser.setWindowSize(width, 920);
    // Checked again: the status is „Prüfe…“ for the 2.5 s the server holds its model list back.
    await app.click('.provider-actions button[aria-label="Verbindungen prüfen"]');
    await app.browser.waitUntil(async () => /Prüfe/.test((await measure()).status), { timeout: 4000, timeoutMsg: `${width} px: no check` });
    const checking = await measure();
    await app.browser.waitUntil(async () => /Verbunden · 4 Modelle/.test((await measure()).status), { timeout: 8000, timeoutMsg: `${width} px: not connected` });
    const done = await measure();
    assert.equal(done.height, checking.height, `${width} px: the row was ${checking.height} px high while checking, ${done.height} px after`);
    assert.equal(done.tier, checking.tier, `${width} px: the tier dropdown moved from ${checking.tier} to ${done.tier}`);
  }
  await app.shot("760-provider-rows-900");
  await app.browser.setWindowSize(1480, 920);
});
