// Zeiterfassung and every settings section at three window sizes, with and without the side
// panel: no clipped labels, no controls outside their box or on top of each other, no content
// cut off at the right edge (see lib/layout-audit.js).
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";
import { auditLayout } from "../lib/layout-audit.js";

const test = guarded(nodeTest, () => app);
let app;
before(async () => (app = await launch()));
after(async () => app?.close());

// Long dropdown values end in "…" on purpose.
const real = (problems) => problems.filter((p) => !p.startsWith("select too narrow"));

test("Zeiterfassung and settings fit at 900, 1100 and 1480 px, with and without the side panel", async () => {
  const found = [];
  await app.keys(["Control", ","]);
  await app.waitFor(".settings-nav-item");
  const sections = await app.browser.execute(() => [...document.querySelectorAll(".settings-nav-item")].map((b) => b.dataset.section));
  for (const panel of [true, false]) {
    await app.browser.execute((open) => {
      if (!!document.querySelector(".app > .panel") !== open) document.querySelector(".workspace > .pane:last-child .tabbar > button:last-of-type").click();
    }, panel);
    for (const [w, h] of [[900, 600], [1100, 760], [1480, 920]]) {
      const where = `${w}px${panel ? " + panel" : ""}`;
      await app.browser.setWindowSize(w, h);
      await new Promise((r) => setTimeout(r, 250));
      await app.click('.ribbon [aria-label="Zeiterfassung"]');
      await app.waitFor(".week-grid");
      for (const p of real(await app.browser.execute(auditLayout, ".pane.active .view-body"))) found.push(`Zeiterfassung ${where}: ${p}`);
      if (w === 900 && panel) await app.shot("narrow-timesheet-panel");
      await app.keys(["Control", ","]);
      // Narrow panes show the section dropdown instead of the menu; the sections switch the same way.
      await app.waitFor(".pane.active .settings");
      for (const s of sections) {
        await app.browser.execute((id) => document.querySelector(`.settings-nav-item[data-section="${id}"]`).click(), s);
        await new Promise((r) => setTimeout(r, 150));
        for (const p of real(await app.browser.execute(auditLayout, ".pane.active .settings"))) found.push(`Einstellungen/${s} ${where}: ${p}`);
      }
      if (w === 900 && panel) await app.shot("narrow-settings-panel");
    }
  }
  await app.browser.setWindowSize(1480, 920);
  assert.deepEqual(found, []);
});
