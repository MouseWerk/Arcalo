// Visual polish of 1.16 (q116): meetings carry a round dot in their calendar color, never an
// upright bar; the Projekte table fits its card; calendar day heads keep their chips inside the
// column and the booked time stays a readable strip; text that is cut shows in full as a tooltip;
// split panes do not scroll sideways and show no cut tab; the query table renders [[links]] and
// keeps its checkbox column narrow; Mermaid labels sit on the page's background; today's markers
// and German shortcut names; one hour format.

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
const ids = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fence = (lang, body) => `\`\`\`${lang}\n${body}\n\`\`\``;

before(async () => {
  fx = writeFixtures();
  now = writeMeetingNow("Jour fixe Kunde X");
  team = await serveTeam();
  app = await launch({ env: outlookEnv(fx.outlook), width: 1280, height: 800 });
  await app.invoke("calendar_source_add", { name: "Team", url: team.url, path: null });
  await app.invoke("calendar_source_add", { name: "Projektplan", url: null, path: fx.file });
  await app.invoke("calendar_source_add", { name: "Heute", url: null, path: now.file });
  await app.invoke("calendar_sync_now", { source: null }).catch(() => {});
  ids.target = (await app.invoke("page_create", { parentId: null, title: "Weekly sync 22.09.", icon: null, content: "Notizen" })).id;
  ids.tasks = (await app.invoke("page_create", { parentId: null, title: "Polish-Aufgaben", icon: null, content: "- [ ] Protokoll aus [[Weekly sync 22.09.]] verschicken #e2epolish\n- [ ] Zweite Aufgabe #e2epolish\n" })).id;
  ids.rich = (await app.invoke("page_create", {
    parentId: null,
    title: "Polish-Blöcke",
    icon: null,
    content: `Blöcke\n\n${fence("query", "from: tasks\nshow: table\nsort: title\n#e2epolish status: offen")}\n\n${fence("mermaid", "flowchart LR\n  A[Angebot] --> B{Freigabe}\n  B -->|ja| C[Auftrag]\n  B -->|nein| D[Ablage]")}\n`,
  })).id;
});
after(async () => {
  await app?.close();
  team?.server.close();
  for (const f of [fx, now]) if (f) fs.rmSync(f.dir, { recursive: true, force: true });
});

const ribbon = async (label) => {
  await app.dismissToasts();
  await app.click(`.ribbon [aria-label^="${label}"]`);
  await sleep(700);
};
async function open(id) {
  await app.invoke("search_open", { target: { kind: "page", page_id: id, new_tab: false } });
  await app.waitFor(".pane.active .ProseMirror");
  await sleep(400);
}
/** Elements of `sel` that are drawn as a thin upright bar (≤ 4 px wide, taller than wide). */
const bars = (sel) =>
  app.browser.execute((s) => [...document.querySelectorAll(s)].map((e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return { w: Math.round(r.width), h: Math.round(r.height), radius: cs.borderRadius }; }), sel);

test("meetings show a round dot in their calendar color, never an upright bar", async () => {
  await app.click(".pane.active .tabbar-home");
  await sleep(700);
  await app.waitFor(".pane.active .dw-agenda-dot", 15000);
  const dots = await bars(".pane.active .dw-agenda-dot");
  assert.ok(dots.length > 0);
  for (const d of dots) assert.ok(d.w === 8 && d.h === 8 && d.radius === "50%", JSON.stringify(d));
  // Nothing in a row is drawn as a colored bar at its left.
  const upright = await app.browser.execute(() =>
    [...document.querySelectorAll(".pane.active .dw-agenda-row *, .pane.active .ts-meeting *")]
      .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.width <= 4 && r.height >= 8 && getComputedStyle(e).backgroundColor !== "rgba(0, 0, 0, 0)"; })
      .map((e) => e.className),
  );
  assert.deepEqual(upright, []);
});

test("the Projekte table fits its card next to the side panel and in a narrow window", async () => {
  for (const [w, h] of [[1280, 800], [900, 700]]) {
    await app.browser.setWindowSize(w, h);
    await ribbon("Projekte");
    await app.waitFor(".pane.active .vorgaenge");
    await sleep(500);
    const s = await app.browser.execute(() => {
      const box = document.querySelector(".pane.active .side-scroll .table-wrap");
      const r = box.getBoundingClientRect();
      const out = [...box.querySelectorAll("th, td")].filter((c) => c.getBoundingClientRect().width > 0 && c.getBoundingClientRect().right > r.right + 1).length;
      return { scroll: box.scrollWidth - box.clientWidth, out, more: !!document.querySelector(".pane.active .side-scroll-more") };
    });
    assert.deepEqual(s, { scroll: 0, out: 0, more: false }, `${w}px`);
  }
  // What the narrow layout leaves out of its columns is in the second line under the name.
  assert.match(await app.text(".pane.active .vorgaenge tbody tr:first-child .vg-sub"), /T\d+–T\d+|\d+ T/);
  await app.browser.setWindowSize(1280, 800);
});

test("calendar day heads keep their chips inside the column; booked time stays a readable strip", async () => {
  await ribbon("Kalender");
  await app.waitFor(".pane.active .calv-dayhead");
  await sleep(800);
  const heads = await app.browser.execute(() =>
    [...document.querySelectorAll(".pane.active .calv-dayhead")].map((h) => {
      const r = h.getBoundingClientRect();
      return [...h.querySelectorAll("*")].filter((e) => { const x = e.getBoundingClientRect(); return x.width > 0 && x.right > r.right + 1; }).length;
    }),
  );
  assert.ok(heads.length >= 5);
  assert.deepEqual(heads.filter((n) => n > 0), [], "nothing runs out of a day head");
  const lanes = await app.browser.execute(() => [...document.querySelectorAll(".pane.active .calv-lane")].map((l) => Math.round(l.getBoundingClientRect().width)));
  for (const w of lanes) assert.ok(w >= 12, `booked time strip ${w} px`);
  // A tooltip shown under a still pointer goes when the view changes under it.
  const chip = await app.$(".pane.active .calv-dayhead [data-tooltip]");
  if (await chip.isExisting()) {
    await chip.moveTo();
    await app.browser.waitUntil(async () => app.browser.execute(() => !!document.querySelector(".tooltip.on")), { timeout: 3000, timeoutMsg: "no tooltip on hover" });
    await app.browser.execute(() => [...document.querySelectorAll(".pane.active .calv-views button")].find((b) => b.textContent.trim() === "Monat")?.click());
    await app.browser.waitUntil(async () => app.browser.execute(() => !document.querySelector(".tooltip.on")), { timeout: 3000, timeoutMsg: "tooltip left behind after the view changed" });
  }
});

test("cut text shows in full as a tooltip (a meeting in a narrow month cell)", async () => {
  await app.browser.execute(() => [...document.querySelectorAll(".pane.active .calv-views button")].find((b) => b.textContent.trim() === "Monat")?.click());
  await sleep(800);
  const target = await app.browser.execute(() => {
    const ev = [...document.querySelectorAll(".pane.active .calv-mev[data-tooltip-full]")].find((e) => {
      const t = e.querySelector(".calv-ev-title");
      return t && t.scrollWidth > t.clientWidth + 1;
    });
    if (!ev) return null;
    ev.setAttribute("data-e2e-cut", "1");
    return ev.dataset.tooltipFull;
  });
  if (!target) return; // the month view fits every title at this width
  await (await app.$('[data-e2e-cut="1"]')).moveTo();
  await app.browser.waitUntil(async () => (await app.browser.execute(() => document.querySelector(".tooltip.on")?.textContent ?? "")) === target, { timeout: 3000, timeoutMsg: `no tooltip „${target}“` });
  await (await app.$(".pane.active h1, .pane.active .calv-heading")).moveTo();
});

test("split panes do not scroll sideways and show no cut tab", async () => {
  await open(ids.rich);
  await app.click('.pane.active .tabbar [aria-label="Rechts teilen"]');
  await sleep(600);
  await ribbon("Aufgaben");
  for (const t of [ids.target, ids.tasks]) {
    await app.invoke("search_open", { target: { kind: "page", page_id: t, new_tab: true } });
    await sleep(300);
  }
  await ribbon("Aufgaben");
  await sleep(600);
  const s = await app.browser.execute(() => ({
    sideways: [...document.querySelectorAll(".pane .page-scroll, .pane .view-scroll")].filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.className),
    // A tab of the strip is either wholly visible or hidden, never a sliver under the fade.
    slivers: [...document.querySelectorAll(".pane .tabs")].flatMap((strip) => {
      const b = strip.getBoundingClientRect();
      return [...strip.querySelectorAll(".tab")].filter((t) => getComputedStyle(t).visibility !== "hidden" && t.getBoundingClientRect().left < b.left - 1).map((t) => t.textContent);
    }),
  }));
  assert.deepEqual(s, { sideways: [], slivers: [] });
  await app.browser.execute(() => document.querySelectorAll(".pane")[1]?.querySelectorAll(".tab-close").forEach((b) => b.click()));
  await sleep(500);
});

test("the query table renders [[links]] and keeps the checkbox column narrow; Mermaid labels sit on the page", async () => {
  await open(ids.rich);
  await app.browser.execute(() => document.querySelector(".pane.active .qb-table")?.scrollIntoView({ block: "center" }));
  await app.waitText(".pane.active .qb-table", /Protokoll aus/, 10000);
  const q = await app.browser.execute(() => {
    const t = document.querySelector(".pane.active .qb-table");
    const row = [...t.querySelectorAll("tbody tr")].find((r) => r.textContent.includes("Protokoll"));
    const check = row.querySelector(".qb-check-cell").getBoundingClientRect();
    const box = row.querySelector(".qb-check").getBoundingClientRect();
    const main = row.querySelector(".qb-main").getBoundingClientRect();
    return { text: row.querySelector(".qb-main").textContent, link: row.querySelector(".qb-main .wikilink")?.textContent ?? null, width: Math.round(check.width), middle: Math.abs(box.top + box.height / 2 - (main.top + main.height / 2)) };
  });
  assert.equal(q.text, "Protokoll aus Weekly sync 22.09. verschicken");
  assert.equal(q.link, "Weekly sync 22.09.");
  assert.ok(q.width <= 40, `checkbox column ${q.width} px`);
  assert.ok(q.middle <= 2, `checkbox off the text's middle by ${q.middle} px`);
  // The link opens its page.
  await app.click(".pane.active .qb-table .qb-main .wikilink");
  await app.browser.waitUntil(async () => (await app.browser.execute(() => document.querySelector(".pane.active .page-title")?.value)) === "Weekly sync 22.09.", { timeoutMsg: "link did not open" });
  await open(ids.rich);
  await app.browser.execute(() => document.querySelector(".pane.active .mmd")?.scrollIntoView({ block: "center" }));
  await app.waitFor(".pane.active .mmd-view svg .edgeLabel", 10000);
  const label = await app.browser.execute(() => {
    const rect = document.querySelector(".pane.active .mmd-view svg .edgeLabel .label rect");
    const probe = document.createElement("div");
    probe.style.background = "var(--bg-canvas)";
    document.body.append(probe);
    const canvas = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return { fill: rect ? getComputedStyle(rect).fill : null, canvas };
  });
  assert.equal(label.fill, label.canvas);
});

test("German shortcut names, today's marker and one hour format", async () => {
  // „Strg“ and „Umschalt“, as German keyboards print them.
  const ribbonLabel = await app.browser.execute(() => document.querySelector('.ribbon [aria-label^="Befehlspalette"]')?.getAttribute("aria-label") ?? "");
  assert.match(ribbonLabel, /Strg/);
  assert.doesNotMatch(ribbonLabel, /\b(Ctrl|Shift)\b/);
  // Today's date in the calendar: text on the solid marker has 4.5:1.
  await ribbon("Kalender");
  await app.waitFor(".pane.active .calv-dayhead.today .calv-dn, .pane.active .calv-mcell.today .calv-mday");
  const marker = await app.browser.execute(() => {
    const e = document.querySelector(".pane.active .calv-dayhead.today .calv-dn, .pane.active .calv-mcell.today .calv-mday");
    const cs = getComputedStyle(e);
    return [cs.color, cs.backgroundColor];
  });
  const lum = (c) => {
    const [r, g, b] = c.match(/\d+(\.\d+)?/g).slice(0, 3).map((v) => { const x = Number(v) / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [a, b] = marker.map(lum).sort((x, y) => y - x);
  assert.ok((a + 0.05) / (b + 0.05) >= 4.5, `today's marker ${marker.join(" on ")}`);
  // The daily review: hours with two decimals everywhere, also the target and the focus time.
  await ribbon("Tagesrückblick");
  await app.waitText(".pane.active .rv-stat.tone-time", /h/, 10000);
  assert.match(await app.text(".pane.active .rv-stat.tone-time"), /\d+,\d\d h\s*\/\s*\d+,\d\d h/);
  assert.match(await app.text(".pane.active .rv-stat.tone-focus"), /\d+,\d\d h/);
});

test("no console errors", async () => {
  const errors = await app.browser.execute(() => window.__arcaloErrors ?? []);
  assert.deepEqual(errors, []);
});
