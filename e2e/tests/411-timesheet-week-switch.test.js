// The timesheet shows a week together with its entries: while the entries of the week asked for are
// still loading, the header, the totals and the list stay on the week before, never mixed. A soak run
// counted the entries of another week under this week's header and booked into a list it misread.
// German time.
process.env.TZ = "Europe/Berlin";

import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
const P = ".pane.active > .pane-content:not([hidden])";
const monday = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));

before(async () => {
  app = await launch({ demo: false, env: { TZ: "Europe/Berlin" } });
  const p = await app.invoke("project_create", { code: "PRJ-411", name: "Wochenwechsel" });
  const np = await app.invoke("netzplan_create", { projectId: p.id, netzplanNr: "NP-4110", wbsElement: "NP-4110-1", description: "Wechsel", plannedHours: 40 });
  // Two entries on Monday of this week, none in the next week.
  const mon = monday(new Date());
  for (const h of [9, 11]) {
    const start = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate(), h).toISOString();
    await app.invoke("time_entry_create", { netzplanId: np.id, vorgangNr: null, leistungsart: null, startTime: start, durationMinutes: 60, description: `Wechsel ${h}` });
  }
});
after(async () => app?.close());

test("switching weeks while the entries load slowly never shows one week's entries under another week", async () => {
  await app.click('.ribbon [aria-label="Zeiterfassung"]');
  const state = () => app.browser.execute((p) => ({ week: document.querySelector(`${p} .view-sub`)?.textContent, entries: document.querySelectorAll(`${p} .entry`).length }), P);
  await app.browser.waitUntil(async () => (await state()).entries === 2, { timeoutMsg: "this week's entries" });
  const thisWeek = (await state()).week;
  await app.click(`${P} [aria-label="Nächste Woche"]`);
  await app.browser.waitUntil(
    async () => {
      const s = await state();
      return s.week !== thisWeek && s.entries === 0;
    },
    { timeoutMsg: "next week, empty" },
  );
  const nextWeek = (await state()).week;

  // From now on the entries take 1.5 s to arrive.
  await app.browser.execute(() => {
    const inv = (window.__e2eInvoke = window.__TAURI_INTERNALS__.invoke);
    window.__TAURI_INTERNALS__.invoke = (c, a, o) => (c === "time_entries" ? new Promise((r) => setTimeout(r, 1500)).then(() => inv(c, a, o)) : inv(c, a, o));
  });
  try {
    // „Diese Woche“, then every state the view shows until the entries are there.
    const seen = await app.browser.executeAsync((p, done) => {
      const out = [];
      const t0 = performance.now();
      const tick = () => {
        out.push(`${document.querySelector(`${p} .view-sub`).textContent} | ${document.querySelectorAll(`${p} .entry`).length}`);
        if (performance.now() - t0 < 2500) setTimeout(tick, 20);
        else done([...new Set(out)]);
      };
      [...document.querySelectorAll(`${p} .week-nav button`)].find((b) => /Diese Woche/.test(b.textContent)).click();
      tick();
    }, P);
    assert.deepEqual(seen, [`${nextWeek} | 0`, `${thisWeek} | 2`]);
  } finally {
    await app.browser.execute(() => (window.__TAURI_INTERNALS__.invoke = window.__e2eInvoke));
  }
});

test("no console errors", async () => {
  const errors = await app.browser.execute(() => window.__arcaloErrors ?? []);
  assert.deepEqual(errors, []);
});
