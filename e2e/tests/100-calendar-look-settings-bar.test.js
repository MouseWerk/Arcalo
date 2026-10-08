// 1.6 polish: the settings menu runs the full height of the pane with back and forward in the
// bar beside it (no separate header strip), its first and last items are reachable at every
// window size, with the side panel, in split view, with the custom title bar and a backdrop;
// meetings in the Kalender are filled blocks with a bar on the left instead of a colored border
// all around, and their text reads at 4.5:1 or more in three themes.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { launch, guarded } from "../lib/harness.js";
import { outlookEnv, serveTeam, writeFixtures, writeMeetingNow } from "../lib/calendar-fixtures.js";

const test = guarded(nodeTest, () => app);
let app, fx, now, team;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  fx = writeFixtures();
  now = writeMeetingNow("Jour fixe Kunde X");
  team = await serveTeam();
  app = await launch({ env: outlookEnv(fx.outlook) });
  await app.invoke("calendar_source_add", { name: "Team", url: team.url, path: null });
  await app.invoke("calendar_source_add", { name: "Projektplan", url: null, path: fx.file });
  await app.invoke("calendar_source_add", { name: "Heute", url: null, path: now.file });
  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", { settings: { ...view.settings, calendar: { ...view.settings.calendar, outlook: true } } });
  await app.invoke("calendar_sync_now", { source: null });
  await app.browser.waitUntil(async () => (await app.invoke("calendar_status")).sources.every((s) => !s.enabled || (s.status?.synced_at && !s.syncing)), { timeout: 20000, timeoutMsg: "not synced" });
});
after(async () => {
  await app?.close();
  team?.server.close();
  for (const f of [fx, now]) if (f) fs.rmSync(f.dir, { recursive: true, force: true });
});

const toggle = async (cls, combo, want) => {
  const has = await app.browser.execute((c) => document.querySelector(".app")?.classList.contains(c), cls);
  if (has !== want) await app.keys(combo);
  await sleep(300);
};
const panel = (open) => toggle("with-panel", ["Control", "Shift", "\\"], open);

/** Every settings view in the window: the menu (or the narrow bar) measured against the window. */
const measure = () =>
  app.browser.execute(() =>
    [...document.querySelectorAll(".settings")].map((s) => {
      const r = (el) => el.getBoundingClientRect();
      const nav = s.querySelector(".settings-nav");
      const bar = s.querySelector(".settings-bar");
      const pane = s.closest(".pane-content");
      const out = {
        // No separate header strip above the settings: they start right below the tab row.
        top: Math.round(r(s).top - r(pane).top),
        bottom: Math.round(r(pane).bottom - r(s).bottom),
        strayHeader: !!pane.querySelector(":scope > .vh"),
        barNav: !!bar?.querySelector(".vh-nav button"),
        win: innerHeight,
        navShown: !!nav && nav.offsetParent !== null,
      };
      if (!out.navShown) {
        const topbar = s.querySelector(".settings-topbar");
        out.topbarInBar = !!topbar && bar.contains(topbar) && topbar.offsetParent !== null;
        out.barBottom = Math.round(r(bar).bottom);
        return out;
      }
      const list = s.querySelector(".settings-nav-list");
      const items = [...s.querySelectorAll(".settings-nav-item")];
      list.scrollTop = 0;
      const first = r(items[0]);
      const listBox = r(list);
      out.firstVisible = first.top >= listBox.top - 0.5 && first.bottom <= listBox.bottom + 0.5 && first.top >= 0;
      out.scrollable = list.scrollHeight <= list.clientHeight || getComputedStyle(list).overflowY === "auto";
      list.scrollTop = list.scrollHeight;
      const last = r(items[items.length - 1]);
      out.lastVisible = last.bottom <= listBox.bottom + 0.5 && last.top >= listBox.top - 0.5 && last.bottom <= innerHeight;
      out.navInside = r(nav).top >= r(pane).top - 0.5 && r(nav).bottom <= r(pane).bottom + 0.5 && r(nav).bottom <= innerHeight;
      list.scrollTop = 0;
      // Back and forward sit on the row of the menu's title (or of the search when it is hidden).
      const head = [...nav.children].find((c) => c.offsetParent !== null && c.getBoundingClientRect().height > 0);
      const mid = (b) => (b.top + b.bottom) / 2;
      out.aligned = Math.abs(mid(r(bar.querySelector(".vh-nav"))) - mid(r(head))) <= 3;
      return out;
    }),
  );

const checkSettings = async (label) => {
  const all = await measure();
  assert.ok(all.length > 0, `${label}: no settings`);
  for (const m of all) {
    const where = `${label}: ${JSON.stringify(m)}`;
    assert.equal(m.top, 0, `settings start at the top of the pane, ${where}`);
    assert.equal(m.bottom, 0, `settings reach the bottom of the pane, ${where}`);
    assert.equal(m.strayHeader, false, `no separate header strip, ${where}`);
    assert.equal(m.barNav, true, `back and forward in the settings bar, ${where}`);
    if (m.navShown) {
      for (const k of ["firstVisible", "lastVisible", "scrollable", "navInside", "aligned"]) assert.equal(m[k], true, `${k}, ${where}`);
    } else {
      assert.equal(m.topbarInBar, true, `search and sections in the bar, ${where}`);
      assert.ok(m.barBottom < m.win, where);
    }
  }
  return all;
};

test("settings: the menu is whole and reachable at every window size, with and without panels", async () => {
  await app.keys(["Control", ","]);
  await app.waitFor(".pane.active .settings");
  const sidebarHidden = async (hide) => {
    const shown = await app.browser.execute(() => !!document.querySelector(".sidebar") && document.querySelector(".sidebar").offsetParent !== null);
    if (shown === hide) await app.keys(["Control", "\\"]);
    await sleep(300);
  };
  let navSeen = 0;
  for (const open of [false, true]) {
    for (const hideSide of [true, false]) {
      // Toggled in a wide window (a narrow one trades the sidebar for the panel).
      await app.browser.setWindowSize(1600, 1000);
      await sleep(200);
      await panel(open);
      await sidebarHidden(hideSide);
      for (const [w, h] of [
        [1600, 1200],
        [1480, 920],
        [1200, 760],
        [1000, 560],
        [900, 700],
        [900, 560],
      ]) {
        await app.browser.setWindowSize(w, h);
        await sleep(350);
        const all = await checkSettings(`${w}×${h} panel ${open} sidebar hidden ${hideSide}`);
        navSeen += all.filter((m) => m.navShown).length;
      }
    }
  }
  assert.ok(navSeen >= 8, `the menu was measured in several sizes: ${navSeen}`);
  await app.browser.setWindowSize(1600, 1000);
  await panel(false);
  await sidebarHidden(true);
  await app.browser.setWindowSize(1000, 560);
  await sleep(300);
  await app.shot("100-settings-1000x560");
  await app.browser.setWindowSize(1600, 1000);
  await sidebarHidden(false);
  await panel(true);
});

test("settings: Windows' own title bar, the backdrop and split view keep the menu whole", async () => {
  await app.browser.setWindowSize(1480, 920);
  await app.browser.execute(() => {
    document.documentElement.classList.add("frame-custom");
    document.documentElement.dataset.backdrop = "mica";
  });
  await sleep(300);
  await checkSettings("custom frame + backdrop");
  await app.browser.setWindowSize(1100, 600);
  await sleep(300);
  await checkSettings("custom frame + backdrop 1100×600");
  await app.browser.execute(() => {
    document.documentElement.classList.remove("frame-custom");
    delete document.documentElement.dataset.backdrop;
  });
  // Split: settings in both panes.
  await app.browser.setWindowSize(1600, 900);
  await panel(false);
  await app.browser.execute(() => document.querySelector(".pane.active .tab.active")?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 300, clientY: 20 })));
  await app.waitText(".menu-item", /Rechts daneben öffnen/);
  await app.browser.execute(() => [...document.querySelectorAll(".menu-item")].find((b) => /Rechts daneben öffnen/.test(b.textContent)).click());
  await app.browser.waitUntil(async () => (await app.browser.execute(() => document.querySelectorAll(".pane .settings").length)) === 2, { timeoutMsg: "no split" });
  await sleep(300);
  for (const [w, h] of [
    [1600, 900],
    [1600, 560],
    [1200, 700],
  ]) {
    await app.browser.setWindowSize(w, h);
    await sleep(350);
    await checkSettings(`split ${w}×${h}`);
  }
  await app.shot("100-settings-split");
  // Close the second pane again.
  await app.browser.execute(() => document.querySelector(".pane.active .tab.active .tab-close")?.click());
  await app.browser.waitUntil(async () => (await app.browser.execute(() => document.querySelectorAll(".pane").length)) === 1, { timeoutMsg: "split not closed" });
  await app.browser.setWindowSize(1480, 920);
  await panel(true);
});

/** The meeting blocks of the open Kalender: borders, shadow and the contrast of their text. */
const blocks = () =>
  app.browser.execute(() => {
    const parse = (c) => {
      let m = /^rgba?\(([\d.]+),? ([\d.]+),? ([\d.]+)(?:,? \/? ?([\d.]+))?\)$/.exec(c.replace(/\s+/g, " "));
      if (m) return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
      m = /^color\(srgb ([\d.e-]+) ([\d.e-]+) ([\d.e-]+)(?: \/ ([\d.]+))?\)$/.exec(c);
      if (m) return [m[1] * 255, m[2] * 255, m[3] * 255, m[4] === undefined ? 1 : +m[4]];
      return null;
    };
    const lum = ([r, g, b]) => {
      const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const ratio = (a, b) => {
      const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
      return (x + 0.05) / (y + 0.05);
    };
    return [...document.querySelectorAll(".pane.active .calv-ev")].map((el) => {
      const cs = getComputedStyle(el);
      const bg = parse(cs.backgroundColor);
      const title = el.querySelector(".calv-ev-title");
      const meta = el.querySelector(".calv-ev-meta");
      const shown = (x) => x && x.offsetParent !== null && x.getClientRects().length > 0;
      return {
        title: title?.textContent,
        cls: el.className,
        border: ["Top", "Right", "Bottom", "Left"].map((s) => cs[`border${s}Width`]),
        radius: parseFloat(cs.borderTopLeftRadius),
        shadow: cs.boxShadow,
        bar: getComputedStyle(el, "::before").content,
        bg: cs.backgroundColor,
        hatched: cs.backgroundImage !== "none",
        titleRatio: bg && bg[3] === 1 && title ? ratio(parse(getComputedStyle(title).color), bg) : null,
        metaRatio: bg && bg[3] === 1 && shown(meta) ? ratio(parse(getComputedStyle(meta).color), bg) : null,
      };
    });
  });

test("Kalender: blocks have a fill, no bar or colored border, and readable text in three themes", async () => {
  await panel(false);
  await app.click(".ribbon-calendar-view");
  await app.waitFor(".pane.active .calv-grid");
  await app.browser.execute(() => [...document.querySelectorAll(".pane.active .calv-views button")].find((b) => b.textContent.trim() === "Woche")?.click());
  await app.waitText(".pane.active .calv-ev .calv-ev-title", /^Sprint Review$/);
  for (const [mode, light, dark] of [
    ["light", "annalo-light", "annalo-dark"],
    ["dark", "annalo-light", "annalo-dark"],
    ["dark", "annalo-light", "gruvbox-dark"],
    ["light", "solarized-light", "annalo-dark"],
  ]) {
    const v = await app.invoke("settings_get");
    await app.invoke("settings_save", { settings: { ...v.settings, theme: mode, appearance: { ...v.settings.appearance, theme_light: light, theme_dark: dark } } });
    await app.browser.waitUntil(async () => (await app.browser.execute(() => `${document.documentElement.dataset.theme}|${document.documentElement.dataset.themeId}`)) === `${mode}|${mode === "dark" ? dark : light}`, { timeoutMsg: `theme ${mode} not applied` });
    await sleep(300);
    const list = await blocks();
    assert.ok(list.length >= 8, `blocks: ${list.length}`);
    const solid = list.filter((b) => b.titleRatio !== null);
    assert.ok(solid.length >= 6, `blocks with a solid fill: ${solid.length}`);
    for (const b of list) {
      const what = `${mode}/${mode === "dark" ? dark : light} ${b.title} (${b.cls})`;
      assert.deepEqual(b.border, ["0px", "0px", "0px", "0px"], `no border around ${what}`);
      assert.equal(b.bar, "none", `no bar on the left of ${what}`);
      assert.ok(b.radius >= 4 && b.radius <= 6, `small radius on ${what}: ${b.radius}`);
      if (!/\bselected\b/.test(b.cls)) assert.equal(b.shadow, "none", `no glow on ${what}`);
      if (b.titleRatio !== null) assert.ok(b.titleRatio >= 4.5, `title of ${what}: ${b.titleRatio.toFixed(2)} on ${b.bg}`);
      if (b.metaRatio !== null) assert.ok(b.metaRatio >= 4.5, `time of ${what}: ${b.metaRatio.toFixed(2)} on ${b.bg}`);
    }
    // The private meeting is hatched, not filled with a border.
    assert.ok(list.some((b) => /veiled/.test(b.cls) && b.hatched), "the private meeting is hatched");
  }
  await app.shot("100-calendar-week-solarized");
  // A meeting opened: lifted with a stronger fill and a bolder title, no outline or colored border.
  const look = () =>
    app.browser.execute(() => {
      const el = [...document.querySelectorAll(".pane.active .calv-ev")].find((b) => b.querySelector(".calv-ev-title")?.textContent === "Sprint Review");
      const cs = getComputedStyle(el);
      return { bg: cs.backgroundColor, shadow: cs.boxShadow, outline: cs.outlineStyle, border: cs.borderLeftWidth, weight: Number(getComputedStyle(el.querySelector(".calv-ev-title")).fontWeight) };
    });
  const plain = await look();
  await app.browser.execute(() => [...document.querySelectorAll(".pane.active .calv-ev")].find((b) => b.querySelector(".calv-ev-title")?.textContent === "Sprint Review").click());
  await app.waitFor(".pane.active .calv-detail");
  await app.waitFor(".pane.active .calv-ev.selected");
  await sleep(250);
  const picked = await look();
  assert.equal(picked.outline, "none", "no outline on the selected meeting");
  assert.equal(picked.border, "0px", "no border on the selected meeting");
  assert.notEqual(picked.bg, plain.bg, "the selected meeting has a stronger fill");
  assert.notEqual(picked.shadow, "none", "the selected meeting is lifted");
  assert.ok(picked.weight > plain.weight, `bolder title: ${plain.weight} -> ${picked.weight}`);
  await app.keys(["Escape"]);
  const v = await app.invoke("settings_get");
  await app.invoke("settings_save", { settings: { ...v.settings, theme: "light", appearance: { ...v.settings.appearance, theme_light: "annalo-light", theme_dark: "annalo-dark" } } });
  await panel(true);
});

test("Kalender: the legend is dots and names, the month shows one line per meeting", async () => {
  await panel(false);
  const legend = await app.browser.execute(() =>
    [...document.querySelectorAll(".pane.active .calv-legend-item")].map((b) => {
      const cs = getComputedStyle(b);
      return { border: cs.borderTopWidth, radius: parseFloat(cs.borderTopLeftRadius), dot: !!b.querySelector(".calv-legend-dot") };
    }),
  );
  assert.ok(legend.length >= 3, "legend");
  for (const l of legend) {
    assert.equal(l.border, "0px", "no pill border");
    assert.ok(l.radius <= 6, "no pill");
    assert.ok(l.dot);
  }
  await app.browser.execute(() => [...document.querySelectorAll(".pane.active .calv-views button, .pane.active .calv-view-select")].find((b) => b.textContent.trim() === "Monat")?.click());
  await app.waitFor(".pane.active .calv-month");
  const rows = await app.browser.execute(() => [...document.querySelectorAll(".pane.active .calv-mev:not(.allday)")].map((b) => Math.round(b.getBoundingClientRect().height)));
  assert.ok(rows.length > 3 && rows.every((h) => h === 20), `single-line chips: ${rows.join(",")}`);
  await app.waitText(".pane.active .calv-more", /^\+\d+ weitere$/);
  await app.browser.execute(() => [...document.querySelectorAll(".pane.active .calv-views button")].find((b) => b.textContent.trim() === "Arbeitswoche")?.click());
  await panel(true);
});
