// Visual consistency across views: every list view puts its title at the same place in the same type,
// tool views (Kalender, Graph) share one header height, stat tiles keep their numbers on one line in a
// narrow split pane, nothing sticks out of a pane, and keyboard focus is always visible.

import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";
import { auditLayout } from "../lib/layout-audit.js";

const test = guarded(nodeTest, () => app);
let app;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  app = await launch({ width: 1440, height: 900 });
});
after(async () => {
  await app?.close();
});

const open = async (label) => {
  await app.dismissToasts();
  await app.click(label.startsWith(".") ? label : `.ribbon [aria-label^="${label}"]`);
  await sleep(500);
};

/** Title box, type and the header bar of the active pane. */
const header = () =>
  app.browser.execute(() => {
    const pc = document.querySelector(".pane.active .pane-content");
    const h1 = pc.querySelector(".view-header h1, .settings-head h1");
    const p = pc.getBoundingClientRect();
    const r = h1?.getBoundingClientRect();
    const s = h1 && getComputedStyle(h1);
    return h1 ? { top: Math.round(r.top - p.top), size: s.fontSize, weight: s.fontWeight, tracking: s.letterSpacing } : null;
  });

/** Elements that stick out of their pane on the right without a scrolling parent that clips them. */
const sticking = () =>
  app.browser.execute(() => {
    const out = [];
    for (const p of document.querySelectorAll(".pane-content")) {
      const pr = p.getBoundingClientRect();
      for (const el of p.querySelectorAll("*")) {
        const er = el.getBoundingClientRect();
        if (!er.width || er.right <= pr.right + 1 || !el.offsetParent) continue;
        let clipped = false;
        for (let q = el.parentElement; q && q !== p; q = q.parentElement) {
          if (/(auto|scroll|hidden)/.test(getComputedStyle(q).overflowX) && q.getBoundingClientRect().right <= pr.right + 1) {
            clipped = true;
            break;
          }
        }
        if (!clipped) out.push(`${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]}`);
      }
    }
    return out.slice(0, 5);
  });

test("list views share one title position and type", async () => {
  const seen = {};
  for (const label of ["Aufgaben", "Zeiterfassung", "Projekte", "Aktivität", "Morgen-Briefing", "Tagesrückblick", "Einstellungen"]) {
    await open(label);
    await app.waitFor(".pane.active .view-header h1, .pane.active .settings-head h1");
    seen[label] = await header();
    // Activity rows are two-line buttons by design (time, kind, title and detail).
    const problems = (await app.browser.execute(auditLayout, ".pane.active .pane-content")).filter((p) => !p.startsWith("wraps: button.activity-item"));
    assert.deepEqual(problems, [], `layout problems in ${label}`);
  }
  const ref = seen.Aufgaben;
  for (const [label, h] of Object.entries(seen)) {
    assert.equal(h.size, ref.size, `${label}: title size`);
    assert.equal(h.weight, ref.weight, `${label}: title weight`);
    assert.equal(h.tracking, ref.tracking, `${label}: title tracking`);
    assert.ok(Math.abs(h.top - ref.top) <= 4, `${label}: title at ${h.top}, Aufgaben at ${ref.top}`);
  }
});

test("tool views share one header height and title size", async () => {
  await open(".ribbon-calendar-view");
  await app.waitFor(".pane.active .calv-head");
  const cal = await app.browser.execute(() => {
    const h = document.querySelector(".pane.active .calv-head");
    return { min: getComputedStyle(h).minHeight, title: getComputedStyle(h.querySelector("h1")).fontSize };
  });
  await open("Graphansicht");
  await app.waitFor(".pane.active .graph-toolbar");
  const graph = await app.browser.execute(() => {
    const h = document.querySelector(".pane.active .graph-toolbar");
    return { min: getComputedStyle(h).minHeight, height: h.getBoundingClientRect().height, title: getComputedStyle(h.querySelector("h1")).fontSize };
  });
  assert.equal(cal.min, graph.min);
  assert.equal(cal.title, graph.title);
  assert.equal(Math.round(graph.height), parseInt(graph.min), "a one-row tool header is exactly the token height");
});

test("a narrow split pane keeps stat numbers on one line and nothing sticks out", async () => {
  await open("Aufgaben");
  await app.click('.pane.active .tabbar [aria-label="Rechts teilen"]');
  await sleep(500);
  await open("Zeiterfassung");
  await app.waitFor(".pane.active .stat-value");
  // Narrow the new pane by widening the panes around it: the window keeps its size.
  await app.browser.setWindowSize(1100, 800);
  await sleep(600);
  const width = await app.browser.execute(() => document.querySelector(".pane.active .pane-content").getBoundingClientRect().width);
  assert.ok(width < 520, `the pane is narrow (${width} px)`);
  const lines = await app.browser.execute(() =>
    [...document.querySelectorAll(".pane.active .stat-value")].map((v) => Math.round(v.getBoundingClientRect().height / parseFloat(getComputedStyle(v).lineHeight))),
  );
  assert.ok(lines.length >= 2 && lines.every((n) => n === 1), `stat values on one line: ${lines}`);
  assert.deepEqual(await sticking(), []);
  await app.browser.setWindowSize(1440, 900);
});

test("keyboard focus is visible and neutral on buttons, fields and segments", async () => {
  await open("Aufgaben");
  const rings = [];
  for (const sel of [".pane.active .view-header .segmented button.on", ".pane.active .view-header .select", ".ribbon .icon-btn"]) {
    const el = await app.$(sel);
    await app.browser.execute((e) => e.focus({ focusVisible: true }), el);
    await app.keys(["Shift"]);
    rings.push(
      await app.browser.execute((s) => {
        const e = document.activeElement;
        const st = getComputedStyle(e);
        // The ring is neutral gray, not the accent (CLAUDE.md: no accent frames on focus or selection).
        const probe = document.body.appendChild(Object.assign(document.createElement("i"), { style: "color: var(--accent)" }));
        const accent = getComputedStyle(probe).color;
        probe.remove();
        const ring = st.outlineStyle !== "none" && parseFloat(st.outlineWidth) >= 2;
        // A field without an outline shows focus with its border and halo.
        const color = ring ? st.outlineColor : st.borderTopColor;
        const [r, g, b] = (color.match(/[\d.]+/g) ?? []).map(Number);
        const gray = Math.max(r, g, b) - Math.min(r, g, b) < 40;
        return { sel: s, color, ok: e.matches(":focus-visible") && (ring || st.boxShadow !== "none") && color !== accent && gray };
      }, sel),
    );
  }
  assert.deepEqual(rings.filter((r) => !r.ok), []);
});

test("no console errors", async () => {
  assert.deepEqual(await app.consoleErrors(), []);
});
