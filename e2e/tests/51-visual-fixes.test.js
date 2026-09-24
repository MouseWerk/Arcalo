// Visual fixes of 1.4, measured in the DOM: callouts without a title keep their type label, the
// page icon menu is German and stays inside the window, table titles use the whole cell, board
// cards, the word count of the source editor and of the focused pane, slides with table of
// contents, footnotes, highlights and columns, the presenter's 16:9 slide, tabs, KPI cards in a
// narrow pane, code colors, the source editor without ligatures and the smaller details.

import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
before(async () => (app = await launch()));
after(async () => app?.close());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const menuClick = (label) =>
  app.browser.execute((l) => {
    const item = [...document.querySelectorAll(".menu .menu-item")].find((b) => b.textContent.trim().startsWith(l));
    item?.click();
    return !!item;
  }, label);
const create = (title, content, parentId = null) => app.invoke("page_create", { parentId, title, icon: null, content });
async function open(page) {
  await app.invoke("search_open", { target: { kind: "page", page_id: page.id, new_tab: false } });
  await app.browser.waitUntil(async () => (await app.browser.execute(() => document.querySelector(".pane.active .page-title")?.value)) === page.title, {
    timeoutMsg: `${page.title} not open`,
  });
  await sleep(400);
}
const words = () => app.browser.execute(() => document.querySelector(".statusbar .sb-static")?.textContent.trim() ?? "");

test("a callout without a title shows its type label; with a title only the title", async () => {
  const page = await create("Callouts ohne Titel", "> [!question]\n> Wer gibt frei?\n\n> [!warning] Eigener Titel\n> Achtung\n\n> [!tip]\n> Tipp\n");
  await open(page);
  await app.waitFor(".pane.active blockquote.callout");
  const labels = await app.browser.execute(() =>
    [...document.querySelectorAll(".pane.active blockquote.callout .callout-marker")].map((m) => [m.dataset.label, getComputedStyle(m, "::before").content]),
  );
  assert.deepEqual(labels, [
    ["Frage", '"Frage"'],
    ["", "none"],
    ["Tipp", '"Tipp"'],
  ]);
  // The violet of question callouts is a theme token, readable on the page.
  const color = await app.browser.execute(() => getComputedStyle(document.querySelector(".pane.active blockquote.callout-question .callout-marker"), "::before").color);
  assert.equal(color, await app.browser.execute(() => {
    const probe = document.createElement("span");
    probe.style.color = "var(--violet)";
    document.body.append(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  }));
  await app.shot("vis-callouts");
});

test("„Symbol ändern“: German names, the list scrolls inside the window and sets the icon", async () => {
  const page = await create("Symbolseite", "Text");
  await app.browser.refresh();
  await app.browser.waitUntil(async () => app.browser.execute(() => document.body.classList.contains("ready")), { timeout: 20000 });
  await app.browser.setWindowSize(1100, 700);
  await sleep(400);
  const row = await app.$(`.sidebar .tree-row[data-id="${page.id}"]`);
  await row.waitForExist({ timeout: 8000 });
  await app.browser.execute((r) => r.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 160, clientY: 560 })), row);
  await app.waitFor(".menu");
  await app.browser.execute(() => {
    const b = [...document.querySelectorAll(".menu .menu-item")].find((x) => x.textContent.includes("Symbol ändern"));
    b.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    b.click();
  });
  await app.browser.waitUntil(async () => (await app.$$(".menu")).length === 2, { timeoutMsg: "no submenu" });
  const menus = await app.browser.execute(() =>
    [...document.querySelectorAll(".menu")].map((m) => {
      const r = m.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, scroll: m.scrollHeight > m.clientHeight, labels: [...m.querySelectorAll(".menu-label")].map((l) => l.textContent) };
    }),
  );
  const [, sub] = menus;
  for (const m of menus) assert.ok(m.top >= 0 && m.bottom <= 700 && m.left >= 0 && m.right <= 1100, `menu inside the window: ${JSON.stringify(m)}`);
  assert.ok(sub.scroll, "the long icon list scrolls");
  for (const name of ["Dokument", "Rakete", "Aufgabenliste", "Startseite"]) assert.ok(sub.labels.includes(name), `${name} in ${sub.labels}`);
  assert.ok(!sub.labels.some((l) => /^(file text|rocket|list todo)$/.test(l)), "no English icon names");
  await app.shot("vis-icon-menu");
  // The last entries are reachable: scrolled into view and chosen.
  await app.browser.execute(() => {
    const item = [...document.querySelectorAll(".menu")][1].querySelector(".menu-item:last-child");
    item.scrollIntoView({ block: "nearest" });
    item.click();
  });
  await app.browser.waitUntil(async () => (await app.invoke("page_get", { id: page.id })).icon === "kanban", { timeoutMsg: "icon not set" });
  await app.browser.setWindowSize(1480, 920);
});

const SPRINT = "---\neigenschaften:\n  status: {typ: auswahl, optionen: {Offen: grau, Fertig: grün}}\n  aufwand: zahl\nansicht:\n  typ: tabelle\n---\nAufgaben\n";

test("table: the page icon keeps its size and titles use the whole cell", async () => {
  const parent = await create("Sprint Tabelle", SPRINT);
  await create("Kurz", "---\nstatus: Offen\naufwand: 3\n---\n", parent.id);
  await create("Delta-Load testen und die Ergebnisse mit dem Fachbereich in einem ausführlichen Termin abstimmen", "---\nstatus: Fertig\naufwand: 8\n---\n", parent.id);
  await open(parent);
  await app.waitFor(".pane.active .coll-title");
  const cells = await app.browser.execute(() =>
    [...document.querySelectorAll(".pane.active .coll-title")].map((t) => {
      const icon = t.querySelector("svg").getBoundingClientRect();
      const link = t.querySelector(".coll-title-link").getBoundingClientRect();
      const open = getComputedStyle(t.querySelector(".coll-open"));
      return { icon: icon.width, title: t.getBoundingClientRect().width, gap: link.left - icon.right, link: link.width, cut: t.querySelector(".coll-title-link").scrollWidth > t.querySelector(".coll-title-link").clientWidth, openPos: open.position, openVis: open.visibility };
    }),
  );
  assert.equal(cells.length, 2);
  for (const c of cells) {
    assert.equal(Math.round(c.icon), 14, `icon keeps 14 px: ${JSON.stringify(c)}`);
    assert.equal(c.openPos, "absolute", "„Öffnen“ takes no room from the title");
    assert.equal(c.openVis, "hidden", "„Öffnen“ only on hover or focus");
  }
  const long = cells.find((c) => c.cut);
  assert.ok(long, "the long title is shortened");
  assert.ok(long.link >= long.title - long.icon - long.gap - 1, `the long title runs to the cell's end: ${JSON.stringify(long)}`);
  await app.shot("vis-table");
});

test("board: a long title keeps its icon on the first line, a bare number shows its name", async () => {
  const parent = await create("Sprint Board", SPRINT.replace("typ: tabelle", "typ: board\n  gruppierung: status\n  karten: [aufwand]"));
  await create("Delta-Load testen und die Ergebnisse mit dem Fachbereich in einem ausführlichen Termin abstimmen", "---\nstatus: Offen\naufwand: 8\n---\n", parent.id);
  await open(parent);
  await app.waitFor(".pane.active .board-card");
  const card = await app.browser.execute(() => {
    const t = document.querySelector(".pane.active .board-card-title");
    const icon = t.querySelector("svg").getBoundingClientRect();
    const text = t.querySelector("span").getBoundingClientRect();
    const prop = document.querySelector(".pane.active .board-card-prop");
    return { iconTop: icon.top - text.top, textHeight: text.height, prop: prop?.innerText.replace(/\s+/g, " ").trim() };
  });
  assert.ok(card.textHeight > 30, "the title wraps");
  assert.ok(card.iconTop >= 0 && card.iconTop < 8, `icon on the first line: ${JSON.stringify(card)}`);
  assert.equal(card.prop, "aufwand 8");
  await app.shot("vis-board");
});

test("the status bar counts the source editor and follows the focused pane", async () => {
  const a = await create("Zählen A", "---\nstatus: offen\n---\n# Eins zwei\n\n- drei **vier**\n");
  const b = await create("Zählen B", "eins zwei drei vier fünf sechs sieben");
  await open(a);
  await app.browser.waitUntil(async () => (await words()) === "4 Wörter", { timeoutMsg: `visual: ${await words()}` });
  await app.click('.pane.active .vh [aria-label^="Markdown-Quelltext"]');
  await app.waitFor(".pane.active .source-text");
  // Properties, markers and fences do not count; the count is the source editor's own.
  await app.browser.waitUntil(async () => (await words()) === "4 Wörter", { timeoutMsg: `source: ${await words()}` });
  await app.browser.execute(() => {
    const ta = document.querySelector(".pane.active .source-text");
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  });
  await app.type(" fünf");
  await app.browser.waitUntil(async () => (await words()) === "5 Wörter", { timeoutMsg: `typed: ${await words()}` });
  await app.browser.waitUntil(async () => /fünf/.test((await app.invoke("page_get", { id: a.id })).content), { timeoutMsg: "not saved" });
  await app.browser.execute(() => document.querySelector(".pane.active .vh [aria-label^='Normaler Editor']").click());
  await app.waitFor(".pane.active .ProseMirror");
  // Split: the other pane shows B; the count follows the focus.
  await app.browser.execute(() => document.querySelector('.pane.active .tabbar [aria-label="Rechts teilen"]').click());
  await app.browser.waitUntil(async () => (await app.$$(".workspace > .pane")).length === 2);
  await open(b);
  await app.browser.waitUntil(async () => (await words()) === "7 Wörter", { timeoutMsg: `pane B: ${await words()}` });
  await app.browser.execute(() => document.querySelector(".workspace > .pane:first-child .ProseMirror").dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
  await app.browser.waitUntil(async () => (await words()) === "5 Wörter", { timeoutMsg: `pane A again: ${await words()}` });
  await app.shot("vis-status-split");
  // Back to one pane for the next tests.
  await app.browser.execute(() => document.querySelector(".workspace > .pane:last-child .tab.active .tab-close").click());
  await app.browser.waitUntil(async () => (await app.$$(".workspace > .pane")).length === 1);
});

const DECK = "# Agenda\n\n[TOC]\n\n---\n\n# Zahlen\n\nUmsatz ==steigt== deutlich[^q].\n\n<!-- spalten -->\n\n- links\n\n<!-- spalte -->\n\n- rechts\n\n<!-- /spalten -->\n\n---\n\n# Ende[^w]\n\nDanke.\n\n[^q]: Quelle Controlling.\n[^w]: Fragen an Anna.\n";

test("slides: table of contents, footnotes, highlights and columns; the presenter's slide is 16:9", async () => {
  const deck = await create("Folien E2E", DECK);
  await open(deck);
  await app.click('.pane.active .vh [aria-label="Weitere Aktionen"]');
  assert.ok(await menuClick("Präsentieren"));
  await app.waitFor(".presentation .present-slide");
  await app.waitText(".presentation .present-counter", /^1 \/ 3$/);
  const toc = await app.browser.execute(() => [...document.querySelectorAll(".presentation .slide-toc li")].map((li) => li.textContent));
  assert.deepEqual(toc, ["Zahlen", "Ende"], "the agenda lists the other slides, without footnote marks");
  await app.keys(["ArrowRight"]);
  await app.waitText(".presentation .present-counter", /^2 \/ 3$/);
  const slide = await app.browser.execute(() => {
    const c = document.querySelector(".presentation .present-slide .slide-content");
    const cols = [...c.querySelectorAll(".slide-columns > .slide-column")].map((x) => x.getBoundingClientRect());
    return {
      text: c.innerText,
      mark: c.querySelector("mark")?.textContent,
      ref: c.querySelector("p sup.slide-fn")?.textContent,
      foot: c.querySelector(".slide-footnotes")?.innerText.replace(/\s+/g, " ").trim(),
      sideBySide: cols.length === 2 && Math.abs(cols[0].top - cols[1].top) < 2 && cols[1].left > cols[0].right,
    };
  });
  assert.equal(slide.mark, "steigt");
  assert.equal(slide.ref, "1");
  assert.equal(slide.foot, "1 Quelle Controlling.");
  assert.ok(slide.sideBySide, "two columns side by side");
  assert.doesNotMatch(slide.text, /\[\^|==|\[TOC\]|spalte/, "no raw Markdown on the slide");
  await app.shot("vis-slide-blocks");
  await app.keys(["r"]);
  await app.waitFor(".presentation .presenter");
  for (const [w, h] of [[1480, 920], [1600, 760], [1100, 760]]) {
    await app.browser.setWindowSize(w, h);
    await sleep(500);
    const box = await app.browser.execute(() => {
      const r = document.querySelector(".presenter-current").getBoundingClientRect();
      return { w: r.width, h: r.height, bottom: r.bottom, vh: innerHeight };
    });
    assert.ok(Math.abs(box.w / box.h - 16 / 9) < 0.02, `16:9 at ${w}×${h}: ${JSON.stringify(box)}`);
    if (w > 1100) assert.ok(box.bottom <= box.vh, `the slide fits the window at ${w}×${h}: ${JSON.stringify(box)}`);
  }
  await app.browser.setWindowSize(1480, 920);
  await sleep(300);
  await app.shot("vis-presenter");
  await app.keys(["r"]);
  await app.keys(["Escape"]);
  await app.browser.waitUntil(async () => (await app.$$(".presentation")).length === 0);
});

test("tabs: titles are whole while there is room; short tabs stay whole when it gets tight", async () => {
  for (const t of await app.browser.execute(() => [...document.querySelectorAll(".pane.active .tab")].map((x) => x.querySelector(".tab-close")))) await app.browser.execute((b) => b.click(), t);
  const titles = ["Kurz", "Protokoll Lenkungskreis", "Plan"];
  for (const title of titles) {
    const p = await create(title, "x");
    await app.invoke("search_open", { target: { kind: "page", page_id: p.id, new_tab: true } });
    await sleep(500);
  }
  const measure = () =>
    app.browser.execute(() => [...document.querySelectorAll(".pane.active .tab")].map((t) => ({ title: t.querySelector(".tab-title").textContent, cut: t.querySelector(".tab-title").scrollWidth > t.querySelector(".tab-title").clientWidth, w: t.getBoundingClientRect().width })));
  const wide = await measure();
  // With room to spare a title is only shortened at the tab's maximum width (220 px).
  assert.ok(wide.every((t) => !t.cut || t.w >= 219), `nothing cut below the maximum width: ${JSON.stringify(wide)}`);
  assert.ok(wide.some((t) => t.title === "Protokoll Lenkungskreis" && t.w > 200 && !t.cut), `a longer title gets the room it needs: ${JSON.stringify(wide)}`);
  // Narrow: only long titles are shortened.
  await app.browser.setWindowSize(900, 700);
  await app.browser.execute(() => {
    if (document.querySelector(".app > .panel")) document.querySelector(".workspace > .pane:last-child .tabbar > button:last-of-type").click();
  });
  for (let i = 0; i < 2; i++) {
    const p = await create(`Weitere lange Seite Nummer ${i + 1}`, "x");
    await app.invoke("search_open", { target: { kind: "page", page_id: p.id, new_tab: true } });
    await sleep(300);
  }
  const tight = await measure();
  const short = tight.filter((x) => x.title.startsWith("Kurz") || x.title === "Plan");
  assert.equal(short.length, 2);
  for (const t of short) assert.equal(t.cut, false, `short title whole: ${JSON.stringify(tight)}`);
  assert.ok(tight.some((t) => t.cut), "long titles are shortened");
  await app.shot("vis-tabs-tight");
  await app.browser.setWindowSize(1480, 920);
});

test("time tracking: the four KPI cards are two by two in a narrow pane", async () => {
  await app.browser.setWindowSize(1100, 760);
  await app.click('.ribbon [aria-label="Zeiterfassung"]');
  await app.waitFor(".pane.active .stat-row");
  await app.browser.execute(() => document.querySelector('.pane.active .tabbar [aria-label="Rechts teilen"]').click());
  await app.browser.waitUntil(async () => (await app.$$(".workspace > .pane")).length === 2);
  await sleep(500);
  const rows = await app.browser.execute(() => [...document.querySelector(".workspace > .pane:first-child .stat-row").children].map((c) => Math.round(c.getBoundingClientRect().top)));
  assert.equal(rows.length, 4);
  assert.equal(new Set(rows).size, 2, `two rows: ${rows}`);
  assert.equal(rows[0], rows[1]);
  assert.equal(rows[2], rows[3]);
  await app.shot("vis-kpi-narrow");
  await app.browser.execute(() => document.querySelector(".workspace > .pane:last-child .tab.active .tab-close").click());
  await app.browser.waitUntil(async () => (await app.$$(".workspace > .pane")).length === 1);
  await app.browser.setWindowSize(1480, 920);
});

test("source editor without ligatures; task boxes, badges, disclosure rows and provider presets", async () => {
  const page = await create("Kleinigkeiten", "- [ ] Angebot schicken\n\n```js\nconst a = 1;\n```\n");
  await open(page);
  const label = await app.browser.execute(() => document.querySelector(".pane.active ul[data-type=taskList] input[type=checkbox]")?.getAttribute("aria-label"));
  assert.equal(label, "Aufgabe: Angebot schicken");
  await app.click('.pane.active .vh [aria-label^="Markdown-Quelltext"]');
  await app.waitFor(".pane.active .source-text");
  const lig = await app.browser.execute(() => {
    const s = getComputedStyle(document.querySelector(".pane.active .source-text"));
    return [s.fontVariantLigatures, s.fontFeatureSettings];
  });
  assert.equal(lig[0], "none");
  assert.match(lig[1], /"calt" 0/);
  await app.browser.execute(() => document.querySelector(".pane.active .vh [aria-label^='Normaler Editor']").click());
  // A badge with an icon keeps a gap between icon and text.
  assert.equal(await app.browser.execute(() => {
    const b = document.createElement("span");
    b.className = "badge";
    document.body.append(b);
    const gap = getComputedStyle(b).columnGap;
    b.remove();
    return gap;
  }), "4px");
  // Settings → KI: every preset has an icon; the disclosure row shows a chevron, no browser triangle.
  await app.keys(["Control", ","]);
  await app.waitFor(".settings-nav-item[data-section='ai']");
  await app.browser.execute(() => document.querySelector(".settings-nav-item[data-section='ai']").click());
  await app.browser.waitUntil(async () => app.browser.execute(() => [...document.querySelectorAll(".pane.active .settings button")].some((b) => /Anbieter hinzufügen/.test(b.innerText))));
  await app.browser.execute(() => [...document.querySelectorAll(".pane.active .settings button")].find((b) => /Anbieter hinzufügen/.test(b.innerText)).click());
  await app.waitFor(".menu");
  const presets = await app.browser.execute(() => [...document.querySelectorAll(".menu .menu-item")].map((b) => [b.textContent.trim(), !!b.querySelector(".menu-icon svg")]));
  assert.ok(presets.length >= 8);
  assert.deepEqual(presets.filter(([, icon]) => !icon), [], "every preset has an icon");
  await app.keys(["Escape"]);
  await app.browser.execute(() => document.querySelector('[data-provider] button[aria-label$="bearbeiten"]')?.click());
  await app.waitFor(".provider-more > summary");
  const summary = await app.browser.execute(() => {
    const s = document.querySelector(".provider-more > summary");
    return { display: getComputedStyle(s).display, listStyle: getComputedStyle(s).listStyleType, chevron: getComputedStyle(s, "::before").borderRightStyle };
  });
  assert.deepEqual(summary, { display: "flex", listStyle: "none", chevron: "solid" });
  await app.keys(["Escape"]);
});
