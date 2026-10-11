// Visual regressions of 1.16 (q116 regress walk): the running timer on the start page keeps its
// buttons off the clock and the budget card does not scroll sideways in a narrow widget; the tab
// strip of a split pane starts at a tab (no empty slot) and keeps the active title readable;
// booked-time strips too narrow for a reference show the hatch only; today's calendar head keeps
// its chips on one row; „Zusammenfassen“ stays on the row of the review actions; one shortcut
// notation („Strg+Umschalt+D“) in tooltips and hint texts.

import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { launch, guarded } from "../lib/harness.js";
import { outlookEnv, serveTeam, writeFixtures, writeMeetingNow } from "../lib/calendar-fixtures.js";

const test = guarded(nodeTest, () => app);
let app;
let team;
let fx;
let now;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LIVE = ".pane.active > .pane-content:not([hidden])";

before(async () => {
  fx = writeFixtures();
  now = writeMeetingNow("Jour fixe Kunde X");
  team = await serveTeam();
  app = await launch({ env: outlookEnv(fx.outlook), width: 1280, height: 800 });
  await app.invoke("calendar_source_add", { name: "Team", url: team.url, path: null });
  await app.invoke("calendar_source_add", { name: "Heute", url: null, path: now.file });
  await app.invoke("calendar_sync_now", { source: null }).catch(() => {});
});
after(async () => {
  await app?.invoke("timer_stop", { subtractIdle: false }).catch(() => {});
  await app?.close();
  team?.server.close();
  for (const f of [fx, now]) if (f) fs.rmSync(f.dir, { recursive: true, force: true });
});

const ribbon = async (label) => {
  await app.dismissToasts();
  await app.click(`.ribbon [aria-label^="${label}"]`);
  await sleep(800);
};
const home = async () => {
  await app.click(".pane.active .tabbar-home");
  await sleep(800);
};
/** Whether two boxes overlap by more than a pixel. */
const overlap = (a, b) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;

test("the running timer on the start page keeps pause and stop off the clock", async () => {
  const [np] = (await app.invoke("wbs_tree")).flatMap((p) => p.netzplaene);
  await app.invoke("timer_start", { netzplanId: np.id, vorgangNr: null, leistungsart: null, description: "Konzept schreiben" });
  for (const [w, h] of [[1280, 800], [900, 700], [1920, 1080]]) {
    await app.browser.setWindowSize(w, h);
    await home();
    await app.waitFor(`${LIVE} [data-widget="today"] .dw-timer.running`, 10000);
    await sleep(400);
    const r = await app.browser.execute((live) => {
      const t = document.querySelector(`${live} [data-widget="today"] .dw-timer.running`);
      const box = (e) => { const b = e.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom }; };
      // The clock's text as drawn (it may run out of its own box).
      const range = document.createRange();
      range.selectNodeContents(t.querySelector(".dw-big"));
      return { clock: box(range), buttons: [...t.querySelectorAll("button")].map(box), card: box(t) };
    }, LIVE);
    assert.ok(r.buttons.length >= 2, `${w}px: pause and stop`);
    for (const b of r.buttons) {
      assert.ok(!overlap(r.clock, b), `a button lies on the clock at ${w}px: ${JSON.stringify(r)}`);
      assert.ok(b.right <= r.card.right + 1, `a button runs out of the timer at ${w}px`);
    }
  }
  await app.invoke("timer_stop", { subtractIdle: false });
  await app.browser.setWindowSize(1280, 800);
});

test("the budget widget does not scroll sideways next to the side panel", async () => {
  // An overspent budget: the longest status, „Überschritten“.
  const pad = (n) => String(n).padStart(2, "0");
  for (let i = 2; i <= 6; i++) {
    const d = new Date(Date.now() - i * 86400000);
    await app.invoke("log_time", { line: `/zeit NP-8801/1020 12h #DEV Überbucht @${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} @07:00` });
  }
  for (const [w, h] of [[1280, 800], [1180, 800], [1080, 760]]) {
    await app.browser.setWindowSize(w, h);
    await home();
    await app.waitFor(`${LIVE} .dw[data-widget="budget"] .dw-budget`, 10000);
    await app.waitText(`${LIVE} .dw[data-widget="budget"]`, /Überschritten/, 10000);
    const r = await app.browser.execute((live) => {
      const w = document.querySelector(`${live} .dw[data-widget="budget"]`);
      const body = w.querySelector(".dw-body");
      const out = [...w.querySelectorAll(".dw-budget")].flatMap((row) => {
        const rb = row.getBoundingClientRect();
        return [...row.querySelectorAll(".badge, .mono")].filter((x) => x.getBoundingClientRect().right > rb.right + 1).map((x) => x.textContent);
      });
      return { sideways: body.scrollWidth - body.clientWidth, out, width: Math.round(w.getBoundingClientRect().width), rows: [...w.querySelectorAll(".dw-budget-head")].map((x) => x.textContent) };
    }, LIVE);
    assert.deepEqual({ sideways: r.sideways, out: r.out }, { sideways: 0, out: [] }, `${w}px: ${JSON.stringify(r)}`);
  }
  await app.browser.setWindowSize(1280, 800);
});

test("a split pane's tab strip starts at a tab and keeps the active title readable", async () => {
  const ids = [];
  for (const t of ["Sehr lange Seitenüberschrift für die Tableiste 360", "SAP CATS Leitfaden 360", "Dachsanierung 360", "Rahmenvertrag 360"]) {
    ids.push((await app.invoke("page_create", { parentId: null, title: t, icon: null, content: "Text" })).id);
  }
  await app.invoke("search_open", { target: { kind: "page", page_id: ids[1], new_tab: false } });
  await app.waitFor(".pane.active > .pane-content:not([hidden]) .ProseMirror");
  await app.click('.pane.active .tabbar [aria-label="Rechts teilen"]');
  await sleep(600);
  for (const id of [ids[2], ids[3], ids[1], ids[0]]) {
    await app.invoke("search_open", { target: { kind: "page", page_id: id, new_tab: true } });
    await sleep(300);
  }
  for (const [w, h] of [[1280, 800], [900, 700]]) {
    await app.browser.setWindowSize(w, h);
    await sleep(900);
    const r = await app.browser.execute(() => {
      const strip = document.querySelector(".pane.active .tabs");
      const sb = strip.getBoundingClientRect();
      const shown = [...strip.querySelectorAll(".tab")].filter((t) => getComputedStyle(t).visibility !== "hidden" && t.getBoundingClientRect().right > sb.left + 1);
      const active = strip.querySelector(".tab.active");
      const title = active.querySelector(".tab-title");
      return {
        scrolled: strip.scrollLeft > 1,
        // Where the first tab that is shown starts, from the strip's left edge.
        gap: Math.round(shown[0].getBoundingClientRect().left - sb.left),
        activeWidth: Math.round(active.getBoundingClientRect().width),
        titleShown: title.clientWidth,
        stripWidth: Math.round(sb.width),
      };
    });
    if (r.scrolled) assert.ok(r.gap <= 2, `empty slot of ${r.gap} px at the left of the strip at ${w}px`);
    // About two words of the title, unless the strip itself is narrower.
    assert.ok(r.activeWidth >= Math.min(160, r.stripWidth - 4), `active tab ${r.activeWidth} px in a ${r.stripWidth} px strip at ${w}px`);
    assert.ok(r.titleShown >= 60 || r.stripWidth < 160, `active title ${r.titleShown} px at ${w}px`);
  }
  await app.browser.setWindowSize(1280, 800);
  await app.browser.execute(() => document.querySelectorAll(".pane")[1]?.querySelectorAll(".tab-close").forEach((b) => b.click()));
  await sleep(500);
});

test("booked-time strips without room for a reference show the hatch only; today's head keeps one row", async () => {
  // Three bookings at the same time: three strips side by side in today's lane. Over before 9:00,
  // the time the harness runs every file at (bookings may not end in the future).
  for (const [ref, at] of [["NP-8801/1020", "06:00"], ["NP-8801/1030", "06:15"], ["NP-8802/2010", "06:30"]]) {
    await app.invoke("log_time", { line: `/zeit ${ref} 2h #DEV Parallel ${at} @${at}` });
  }
  // Today's head with its note and a task due today.
  const daily = await app.invoke("daily_note", { date: null });
  await app.invoke("page_save", { id: daily.id, content: "# Heute\n\n- [ ] Heute fällig 360" });
  // A work week of six days with today in it, every day of the week (on a Saturday the usual
  // Monday to Friday shows six columns too, with today the sixth; its head wrapped there).
  const today = ((new Date().getDay() + 6) % 7) + 1;
  const six = [...new Set([1, 2, 3, 4, 5, today <= 5 ? 6 : today])].sort();
  const view = await app.invoke("settings_get");
  const before = view.settings.workdays;
  await app.invoke("settings_save", { settings: { ...view.settings, workdays: six } });
  await app.browser.refresh();
  await app.browser.waitUntil(async () => app.browser.execute(() => document.body.classList.contains("ready")), { timeout: 20000, timeoutMsg: "not ready after the reload" });
  for (const [w, h] of [[1920, 1080], [1280, 800], [900, 700]]) {
    await app.browser.setWindowSize(w, h);
    await ribbon("Kalender");
    await app.waitFor(`${LIVE} .calv-dayhead`, 10000);
    await app.browser.execute(() => document.activeElement?.blur());
    await app.keys(["a"]);
    await sleep(1000);
    const r = await app.browser.execute((live) => {
      const strips = [...document.querySelectorAll(`${live} .calv-entry`)].map((e) => {
        const span = e.querySelector("span");
        const shown = !!span && getComputedStyle(span).display !== "none";
        return { w: Math.round(e.getBoundingClientRect().width), shown, text: shown ? span.textContent : "", room: shown ? span.clientWidth : 0 };
      });
      const heads = [...document.querySelectorAll(`${live} .calv-dayhead-info`)].filter((x) => getComputedStyle(x).display !== "none").map((info) => {
        const tops = [...info.children].filter((c) => c.getClientRects().length && getComputedStyle(c).position !== "absolute").map((c) => Math.round(c.getBoundingClientRect().top));
        return { date: info.closest(".calv-dayhead").dataset.date, rows: new Set(tops).size };
      });
      return { strips, heads };
    }, LIVE);
    assert.ok(r.strips.length >= 3, `${w}px: ${r.strips.length} strips`);
    // A shown reference has room for more than a letter or two.
    const unreadable = r.strips.filter((s) => s.shown && s.room < 40);
    assert.deepEqual(unreadable, [], `${w}px`);
    const wrapped = r.heads.filter((x) => x.rows > 1);
    assert.deepEqual(wrapped, [], `${w}px: day head chips on more than one row`);
    assert.ok(w === 900 || r.heads.length === 6, `${w}px: ${r.heads.length} day heads instead of six`);
  }
  const after = await app.invoke("settings_get");
  await app.invoke("settings_save", { settings: { ...after.settings, workdays: before } });
  await app.browser.setWindowSize(1280, 800);
});

test("„Zusammenfassen“ stays on the row of the review actions next to the side panel and at 900 px", async () => {
  for (const [w, h] of [[1280, 800], [900, 700]]) {
    await app.browser.setWindowSize(w, h);
    for (const [view, primary, other] of [["Tagesrückblick", ".rv-summarize", ".rv-insert"], ["Wochenrückblick", ".wr-summarize", ".wr-save"]]) {
      if (view === "Tagesrückblick") await ribbon("Tagesrückblick");
      else {
        await app.keys(["Control", "k"]);
        await app.waitFor(".palette input");
        await app.type("Wochenrückblick");
        await app.waitText(".pal-item.sel", /^Wochenrückblick/);
        await app.keys(["Enter"]);
        await app.waitFor(`${LIVE} .wr-view .rv-stats`, 15000);
      }
      await app.waitFor(`${LIVE} ${primary}`, 10000);
      const r = await app.browser.execute((live, p, o) => {
        const a = document.querySelector(`${live} ${p}`).getBoundingClientRect();
        const b = document.querySelector(`${live} ${o}`);
        return { same: Math.abs(a.top - b.getBoundingClientRect().top) < 2, label: b.getAttribute("aria-label") };
      }, LIVE, primary, other);
      assert.ok(r.same, `${view} at ${w}px: „Zusammenfassen“ on a row of its own`);
      assert.ok(r.label, `${view}: the icon-only action keeps its name`);
    }
  }
  await app.browser.setWindowSize(1280, 800);
});

test("one shortcut notation in tooltips and hint texts", async () => {
  const ribbonLabel = await app.browser.execute(() => document.querySelector('.ribbon [aria-label^="Befehlspalette"]')?.getAttribute("aria-label") ?? "");
  assert.match(ribbonLabel, /\(Strg\+K\)/);
  const foot = await app.text(".composer-foot");
  assert.match(foot, /Umschalt\+Eingabe/);
  // No label anywhere writes keys with spaces („Strg Umschalt D“).
  const spaced = await app.browser.execute(() =>
    [...document.querySelectorAll("[aria-label], [data-tooltip], [title]")]
      .map((e) => [e.getAttribute("aria-label"), e.getAttribute("data-tooltip"), e.getAttribute("title")].filter(Boolean).join(" | "))
      .filter((s) => /\b(Strg|Umschalt) (Strg|Umschalt|Alt|Eingabe|[A-Z0-9#])\b/.test(s)),
  );
  assert.deepEqual(spaced, []);
});

test("no console errors", async () => {
  const errors = await app.browser.execute(() => window.__arcaloErrors ?? []);
  assert.deepEqual(errors, []);
});
