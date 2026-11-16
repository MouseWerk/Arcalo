// Round 7 review of the round 6 fixes and performance with large data
// (docs/quality/q124/r7-fix-review-performance.md).

import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
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

/** Runs a command of the palette (Strg+K) by its title. */
async function palette(command) {
  await app.keys(["Control", "k"]);
  const input = await app.waitFor(".palette input");
  await input.setValue(command);
  await app.waitText(".pal-item", new RegExp(`^${command}`));
  await app.browser.execute((c) => [...document.querySelectorAll(".pal-item")].find((el) => el.innerText.trim().startsWith(c))?.click(), command);
}

// R7D-4: a vault with an image next to each note (R7D-2) leaves thousands of files in the
// attachments folder. „Anhänge verwalten“ drew a table row for every one of them.
test("the attachments view opens quickly with 10,000 files", async () => {
  const dir = path.join(app.dataDir, "attachments");
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 10000; i++) fs.writeFileSync(path.join(dir, `image ${i + 2}.png`), `png ${i}`);
  const t0 = Date.now();
  await palette("Anhänge verwalten");
  await app.waitFor(".pane.active .att-table .att-row:not(.att-head)", 60000);
  // Painted: two frames after the rows are there.
  await app.browser.executeAsync((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  const ms = Date.now() - t0;
  const rows = await app.browser.execute(() => document.querySelectorAll(".pane.active .att-table .att-row:not(.att-head)").length);
  const nodes = await app.browser.execute(() => document.getElementsByTagName("*").length);
  console.log(`attachments view with 10,000 files: ${ms} ms, ${rows} rows, ${nodes} elements`);
  assert.ok(ms < 3000, `the view took ${ms} ms (${rows} rows, ${nodes} elements)`);
  // Scrolling to the end shows the last file.
  await app.browser.execute(() => {
    const s = document.querySelector(".pane.active .att-table").closest(".att-scroll, .pane-content, [class*=scroll]");
    s.scrollTop = s.scrollHeight;
  });
  await app.waitText(".pane.active .att-table", /image 9999\.png/);
  await app.shot("760-attachments-end");
});
