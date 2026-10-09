// Every switch, option group and dropdown in every settings section reacts and can be undone;
// the time-tracking view's buttons work end to end (week navigation, new entry, release, bulk
// actions, export dialog, quick booking).
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";
import { clickUndo, settingsSettled } from "../lib/settings.js";

const test = guarded(nodeTest, () => app);
let app;
before(async () => (app = await launch()));
after(async () => app?.close());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Operates the controls of the open settings section in the page; returns what did not react. */
function sweepSection(done) {
  const body = document.querySelector(".pane.active .settings-body");
  const out = { problems: [], switches: 0, radios: 0, selects: 0 };
  const label = (el) => el.getAttribute("aria-label") || el.closest(".set-row")?.querySelector(".set-row-label")?.textContent || el.textContent;
  const wait = () => new Promise((r) => setTimeout(r, 60));
  // Polls a condition for up to a second (React renders later under load).
  const until = async (cond) => {
    for (let i = 0; i < 20 && !cond(); i++) await new Promise((r) => setTimeout(r, 50));
    return cond();
  };
  (async () => {
    for (const sw of body.querySelectorAll('[role="switch"]:not([disabled])')) {
      const before = sw.getAttribute("aria-checked");
      sw.click();
      await wait();
      // Some switches ask first (a dialog) or apply only after a confirmation.
      const dialog = document.querySelector(".dialog, .confirm");
      if (dialog) {
        dialog.querySelector(".btn-ghost, .btn-secondary, [aria-label='Schließen']")?.click();
        await wait();
        continue;
      }
      if (!sw.isConnected) {
        // The switch rebuilt its section (time tracking off): switch it back through its new element.
        const same = [...body.querySelectorAll('[role="switch"]')].find((x) => x.getAttribute("aria-label") === sw.getAttribute("aria-label"));
        if (same && same.getAttribute("aria-checked") !== before) {
          same.click();
          await wait();
        }
        out.switches++;
        continue;
      }
      if (!(await until(() => sw.getAttribute("aria-checked") !== before))) out.problems.push(`switch did not toggle: ${label(sw)}`);
      else {
        sw.click();
        await wait();
      }
      out.switches++;
    }
    for (const group of body.querySelectorAll('[role="radiogroup"]')) {
      const radios = [...group.querySelectorAll('[role="radio"]:not([disabled])')];
      const current = radios.find((r) => r.getAttribute("aria-checked") === "true");
      const other = radios.find((r) => r !== current);
      if (!other) continue;
      other.click();
      await wait();
      if (!other.isConnected) continue;
      if (!(await until(() => other.getAttribute("aria-checked") === "true"))) out.problems.push(`option not selected: ${label(group)} → ${other.textContent}`);
      current?.click();
      await wait();
      out.radios++;
    }
    // Dropdowns (components/Select.tsx): open the list, choose another option, then the old one again.
    const choose = async (sel, pick) => {
      sel.click();
      await wait();
      const list = document.getElementById(sel.getAttribute("aria-controls") ?? "");
      if (!list) return null;
      const option = pick([...list.querySelectorAll('[role="option"]:not([aria-disabled])')]);
      if (!option) {
        sel.click();
        await wait();
        return undefined;
      }
      const value = option.dataset.value;
      option.click();
      await wait();
      return value;
    };
    for (const sel of body.querySelectorAll('[role="combobox"]:not([disabled])')) {
      const before = sel.dataset.value;
      const value = await choose(sel, (options) => options.find((o) => o.dataset.value !== before));
      if (value === null) out.problems.push(`dropdown did not open: ${label(sel)}`);
      if (value == null || !sel.isConnected) continue;
      // Some choices ask first (the app lock wants a PIN): cancel, the value stays.
      const dialog = document.querySelector(".dialog, .confirm");
      if (dialog) {
        dialog.querySelector(".btn-ghost, .btn-secondary, [aria-label='Schließen']")?.click();
        await wait();
        if (sel.dataset.value !== before) out.problems.push(`select changed although its dialog was cancelled: ${label(sel)}`);
        out.selects++;
        continue;
      }
      if (!(await until(() => sel.dataset.value === value))) out.problems.push(`select did not change: ${label(sel)}`);
      // A change can resize the window (Skalierung zooms the webview), and a resize closes an open
      // list: when it closed before the choice, open it again.
      for (let i = 0; i < 3 && sel.dataset.value !== before; i++) {
        await choose(sel, (options) => options.find((o) => o.dataset.value === before));
        await until(() => sel.dataset.value === before);
      }
      if (!(await until(() => sel.dataset.value === before))) out.problems.push(`select did not change back: ${label(sel)}`);
      out.selects++;
    }
    return out;
  })().then(done, (e) => done({ problems: [String(e)], switches: 0, radios: 0, selects: 0 }));
}

test("settings: every switch, option and dropdown reacts and applies at once; undo and „Abschnitt zurücksetzen“ restore", async () => {
  await app.keys(["Control", ","]);
  await app.waitFor(".settings-nav-item");
  const saved = JSON.stringify((await app.invoke("settings_get")).settings);
  const sections = await app.browser.execute(() => [...document.querySelectorAll(".settings-nav-item")].map((b) => b.dataset.section));
  const totals = { switches: 0, radios: 0, selects: 0 };
  for (const s of sections) {
    await app.browser.execute((id) => document.querySelector(`.settings-nav-item[data-section="${id}"]`).click(), s);
    await sleep(200);
    const r = await app.browser.executeAsync(sweepSection);
    assert.deepEqual(r.problems, [], `section ${s}`);
    for (const k of Object.keys(totals)) totals[k] += r[k];
    // Every change was saved at once; there is no save bar to confirm or discard.
    await settingsSettled(app, 15000);
    assert.equal(await app.browser.execute(() => !!document.querySelector(".savebar")), false, `save bar in ${s}`);
    await app.dismissToasts();
  }
  assert.ok(totals.switches > 20 && totals.radios > 10 && totals.selects > 5, JSON.stringify(totals));
  // Every control was switched back: what is stored is what was there before.
  const now = (await app.invoke("settings_get")).settings;
  for (const k of ["appearance", "editor", "notes", "time", "ai", "notifications", "privacy", "start", "locale", "network"]) {
    assert.deepEqual(now[k], JSON.parse(saved)[k], `settings.${k} changed`);
  }
  // „Rückgängig“ in the toast restores the state before one change.
  await app.browser.execute(() => document.querySelector('.settings-nav-item[data-section="notifications"]').click());
  const sw = await app.waitFor('.pane.active .settings-body button[role="switch"]');
  const label = await sw.getAttribute("aria-label");
  await sw.click();
  await settingsSettled(app);
  assert.notDeepEqual((await app.invoke("settings_get")).settings.notifications, JSON.parse(saved).notifications, `${label} applied`);
  await clickUndo(app);
  await settingsSettled(app);
  assert.deepEqual((await app.invoke("settings_get")).settings.notifications, JSON.parse(saved).notifications, `${label} undone`);
  await app.dismissToasts();
  // „Abschnitt zurücksetzen“ brings the defaults back, and its undo the state before.
  await sw.click();
  await settingsSettled(app);
  await app.dismissToasts();
  const changed = (await app.invoke("settings_get")).settings.notifications;
  await app.click(".pane.active .settings-reset");
  await settingsSettled(app);
  await app.waitText(".toast-title", /Abschnitt zurückgesetzt/);
  assert.deepEqual((await app.invoke("settings_get")).settings.notifications, JSON.parse(saved).notifications, "defaults again");
  await clickUndo(app);
  await settingsSettled(app);
  assert.deepEqual((await app.invoke("settings_get")).settings.notifications, changed, "reset undone");
  await sw.click();
  await settingsSettled(app);
  await app.dismissToasts();
});

test("time tracking: week navigation, new entry, release, bulk actions, export, quick booking", async () => {
  await app.click('.ribbon [aria-label="Zeiterfassung"]');
  // The week overview only shows with bookings or gaps (none on a Monday morning); the navigation always.
  await app.waitFor(".pane.active .week-nav");
  const week = () => app.browser.execute(() => document.querySelector(".pane.active .view-sub").textContent);
  const kw = await week();
  await app.click('.pane.active [aria-label="Vorherige Woche"]');
  await app.browser.waitUntil(async () => (await week()) !== kw, { timeoutMsg: "previous week" });
  await app.click('.pane.active [aria-label="Nächste Woche"]');
  await app.click('.pane.active [aria-label="Nächste Woche"]');
  await app.browser.execute(() => [...document.querySelectorAll(".pane.active .week-nav button")].find((b) => /Diese Woche/.test(b.textContent)).click());
  await app.browser.waitUntil(async () => (await week()) === kw, { timeoutMsg: "back to this week" });

  // New entry through the dialog.
  const count = () => app.browser.execute(() => document.querySelectorAll(".pane.active .entry").length);
  const n0 = await count();
  await app.browser.execute(() => [...document.querySelectorAll(".pane.active .view-actions button")].find((b) => /Eintrag/.test(b.textContent)).click());
  await app.waitFor(".dialog");
  // The first dropdown (Netzplan): open it and choose the first real option.
  const netzplan = '.dialog [role="combobox"]';
  await app.click(netzplan);
  const list = await app.browser.waitUntil(() => app.browser.execute((s) => document.querySelector(s).getAttribute("aria-controls"), netzplan), { timeoutMsg: "Netzplan list" });
  await app.click(`#${list} [role="option"]:not([data-value=""])`);
  await app.browser.waitUntil(() => app.browser.execute((s) => !!document.querySelector(s).dataset.value, netzplan), { timeoutMsg: "Netzplan chosen" });
  await app.browser.execute(() => {
    const d = document.querySelector(".dialog");
    const setIn = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    const desc = [...d.querySelectorAll("input")].find((i) => /Was hast du gemacht/.test(i.placeholder));
    setIn.call(desc, "Kontrolltest Buchung");
    desc.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await app.browser.execute(() => [...document.querySelectorAll(".dialog button")].find((b) => /Buchen|Speichern/.test(b.textContent)).click());
  await app.browser.waitUntil(async () => (await count()) === n0 + 1, { timeoutMsg: "entry added" });
  assert.ok(await app.browser.execute(() => [...document.querySelectorAll(".pane.active .entry-desc")].some((e) => /Kontrolltest Buchung/.test(e.textContent))));

  // Release through the row menu, then back to draft.
  const row = () => app.browser.execute(() => [...document.querySelectorAll(".pane.active .entry")].findIndex((e) => /Kontrolltest Buchung/.test(e.textContent)));
  const status = async () => app.browser.execute((i) => document.querySelectorAll(".pane.active .entry")[i].querySelector(".badge:not(.entry-la .badge)")?.textContent, await row());
  await app.browser.execute((i) => document.querySelectorAll(".pane.active .entry")[i].querySelector('[aria-label^="Aktionen"]').click(), await row());
  await app.browser.execute(() => [...document.querySelectorAll(".menu-item, [role^=menuitem]")].find((b) => /Freigeben/.test(b.textContent)).click());
  await app.browser.waitUntil(async () => /Freigegeben/.test((await status()) ?? ""), { timeoutMsg: "released" });

  // Bulk: select it, back to draft.
  await app.browser.execute((i) => document.querySelectorAll(".pane.active .entry")[i].querySelector("input.check").click(), await row());
  await app.waitText(".pane.active .bulk", /1 ausgewählt/);
  await app.browser.execute(() => [...document.querySelectorAll(".pane.active .bulk button")].find((b) => /Entwurf/.test(b.textContent)).click());
  await app.browser.waitUntil(async () => /Entwurf/.test((await status()) ?? ""), { timeoutMsg: "bulk draft" });

  // Export dialog: every format shows its preview; the switches toggle.
  await app.browser.execute(() => [...document.querySelectorAll(".pane.active .view-actions button")].find((b) => /Export/.test(b.textContent)).click());
  await app.waitFor(".dialog .segmented");
  for (const f of ["Jira", "CSV", "JSON", "SAP CATS"]) {
    await app.browser.execute((f) => [...document.querySelectorAll(".dialog .segmented button")].find((b) => b.textContent === f).click(), f);
    await app.browser.waitUntil(async () => app.browser.execute((f) => document.querySelector(".dialog .segmented .on")?.textContent === f, f));
  }
  const sw = await app.browser.execute(() => {
    const s = document.querySelector('.dialog [role="switch"]');
    const before = s.getAttribute("aria-checked");
    s.click();
    return before;
  });
  await app.browser.waitUntil(async () => (await app.browser.execute(() => document.querySelector('.dialog [role="switch"]').getAttribute("aria-checked"))) !== sw);
  await app.keys(["Escape"]);
  await app.browser.waitUntil(async () => !(await app.browser.execute(() => !!document.querySelector(".dialog"))));

  // Quick booking in the timer card.
  const n1 = await count();
  const quick = await app.$(".pane.active .quick-book input");
  await quick.setValue("NP-8801/1020 0.5h #DEV Schnellbuchung Kontrolle");
  await app.keys(["Enter"]);
  await app.browser.waitUntil(async () => (await count()) === n1 + 1, { timeoutMsg: "quick booking" });
});

test("no console errors", async () => {
  const errors = await app.browser.execute(() => window.__arcaloErrors ?? []);
  assert.deepEqual(errors, []);
});
