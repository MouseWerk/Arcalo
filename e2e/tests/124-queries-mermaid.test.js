// Queries in notes and Mermaid diagrams (1.9): a ```query block runs the dashboard's query
// engine live (table, count, tasks tickable, bookings hidden with time tracking off, problems
// inline); ```mermaid renders flowchart, sequence, Gantt, class, state, ER and mind map under the
// app's CSP, follows the theme, shows errors with the source, toggles the source, exports SVG and
// PNG, and appears in HTML share, print and presentation. A page with 10 embeds, 3 queries and 3
// diagrams opens quickly and renders them lazily.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
const ids = {};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "annalo-e2e-124-"));

const fence = (lang, body) => `\`\`\`${lang}\n${body}\n\`\`\``;
const DIAGRAMS = {
  flowchart: "flowchart LR\n  A[Angebot] --> B{Freigabe}\n  B -->|ja| C[Auftrag]\n  B -->|nein| D[Ablage]",
  sequence: "sequenceDiagram\n  Kunde->>Vertrieb: Anfrage\n  Vertrieb-->>Kunde: Angebot",
  gantt: "gantt\n  dateFormat YYYY-MM-DD\n  title Plan\n  section Bau\n  Fundament :a1, 2026-10-01, 5d\n  Mauern :after a1, 4d",
  class: "classDiagram\n  class Seite {\n    +titel\n    +inhalt\n  }\n  Seite <|-- Tagesnotiz",
  state: "stateDiagram-v2\n  [*] --> Offen\n  Offen --> Erledigt\n  Erledigt --> [*]",
  er: "erDiagram\n  SEITE ||--o{ AUFGABE : enthaelt",
  mindmap: "mindmap\n  root((Arcalo))\n    Notizen\n    Aufgaben",
};
const BROKEN = "flowchart LR\n  A[[[ --> B";

const QUERIES = [
  fence("query", "from: tasks\nshow: table\nsort: title\n#e2eq status: offen"),
  fence("query", "aus: aufgaben\nanzeige: anzahl\n#e2eq status: offen"),
  fence("query", "from: bookings\nshow: count"),
  fence("query", "from: nirgends\n#e2eq"),
].join("\n\n");

const menuClick = (label) =>
  app.browser.execute((l) => {
    const item = [...document.querySelectorAll(".menu-item, [role^=menuitem]")].find((b) => b.textContent.trim().startsWith(l));
    item?.click();
    return !!item;
  }, label);
const content = async (id) => (await app.invoke("page_get", { id })).content;
async function open(id, title) {
  await app.invoke("search_open", { target: { kind: "page", page_id: id, new_tab: false } });
  await app.browser.waitUntil(async () => (await app.browser.execute(() => document.querySelector(".pane.active .page-title")?.value)) === title, { timeoutMsg: `${title} not open` });
  await app.waitFor(".pane.active .ProseMirror");
}
async function setSettings(patch) {
  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", { settings: patch(view.settings) });
}
/** Scrolls every preview of the active page into view once (they render lazily). */
async function scrollPreviews(sel = ".pane.active .rich-preview") {
  const n = await app.browser.execute((s) => document.querySelectorAll(s).length, sel);
  for (let i = 0; i < n; i++) {
    await app.browser.execute((s, k) => document.querySelectorAll(s)[k]?.scrollIntoView({ block: "center" }), sel, i);
    await app.browser.pause(150);
  }
}
const queryBlocks = () =>
  app.browser.execute(() => [...document.querySelectorAll(".pane.active .rich-preview.rich-query")].map((e) => ({ text: e.innerText, display: e.querySelector(".qb")?.dataset.display ?? "" })));

before(async () => {
  app = await launch();
  ids.tasks = (await app.invoke("page_create", { parentId: null, title: "Abfrage-Aufgaben", icon: null, content: "- [ ] Angebot schreiben #e2eq\n- [ ] Kunde anrufen #e2eq\n- [x] Schon erledigt #e2eq\n" })).id;
  ids.queries = (await app.invoke("page_create", { parentId: null, title: "Abfragen", icon: null, content: `Offene Aufgaben\n\n${QUERIES}\n` })).id;
  const all = Object.entries(DIAGRAMS).map(([, src]) => fence("mermaid", src));
  ids.diagrams = (await app.invoke("page_create", { parentId: null, title: "Diagramme", icon: null, content: `Diagramme\n\n${all.join("\n\n")}\n\n${fence("mermaid", BROKEN)}\n` })).id;
});
after(async () => {
  await app?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("query blocks: table, count, problems inline, the source on demand", async () => {
  await open(ids.queries, "Abfragen");
  await scrollPreviews();
  await app.browser.waitUntil(async () => (await queryBlocks()).length === 4 && (await queryBlocks()).every((q) => !/Wird geladen/.test(q.text)), { timeout: 10000, timeoutMsg: "queries not loaded" });
  const [table, count, bookings, bad] = await queryBlocks();
  assert.equal(table.display, "table");
  assert.match(table.text, /Aufgabe\s+Seite\s+Fällig/);
  assert.match(table.text, /Angebot schreiben[\s\S]*Kunde anrufen/, "sorted by title");
  assert.doesNotMatch(table.text, /Schon erledigt/);
  assert.match(table.text, /Aufgaben\s*·\s*2 Treffer/);
  assert.equal(count.display, "count");
  assert.match(count.text, /^2\s+Aufgaben/);
  assert.match(bookings.text, /h/);
  assert.match(bad.text, /Nicht verstanden: from: nirgends/);
  // The code is hidden; „Abfrage bearbeiten“ shows it, „Fertig“ hides it again.
  assert.equal(await app.browser.execute(() => getComputedStyle(document.querySelector(".pane.active pre.rich-src")).display), "none");
  await app.browser.execute(() => [...document.querySelectorAll(".pane.active .rich-query .rich-btn")][0].click());
  await app.browser.waitUntil(() => app.browser.execute(() => document.querySelector(".pane.active pre.rich-src").classList.contains("is-editing")), { timeoutMsg: "source not shown" });
  assert.notEqual(await app.browser.execute(() => getComputedStyle(document.querySelector(".pane.active pre.rich-src")).display), "none");
  await app.browser.execute(() => [...document.querySelectorAll(".pane.active .rich-query .rich-btn")][0].click());
  await app.browser.waitUntil(() => app.browser.execute(() => document.querySelector(".pane.active pre.rich-src").classList.contains("is-hidden")), { timeoutMsg: "source not hidden" });
  await app.shot("124-queries");
});

test("ticking a task in a query result checks it in its page; the counts follow", async () => {
  await app.browser.execute(() => {
    const row = [...document.querySelectorAll(".pane.active .qb-table tr")].find((r) => r.textContent.includes("Kunde anrufen"));
    row.querySelector(".qb-check").click();
  });
  await app.browser.waitUntil(async () => /- \[x\] Kunde anrufen/.test(await content(ids.tasks)), { timeout: 8000, timeoutMsg: "task not checked in its page" });
  await app.browser.waitUntil(async () => /^1\s+Aufgabe\b/.test((await queryBlocks())[1].text), { timeout: 8000, timeoutMsg: `count did not follow: ${(await queryBlocks())[1].text}` });
  await app.browser.waitUntil(async () => !/Kunde anrufen/.test((await queryBlocks())[0].text), { timeout: 8000, timeoutMsg: "table did not follow" });
});

test("with time tracking off the bookings source is hidden", async () => {
  await setSettings((s) => ({ ...s, time: { ...s.time, enabled: false } }));
  await app.browser.waitUntil(async () => /Die Zeiterfassung ist ausgeschaltet/.test((await queryBlocks())[2].text), { timeout: 8000, timeoutMsg: "bookings still shown" });
  await setSettings((s) => ({ ...s, time: { ...s.time, enabled: true } }));
  await app.browser.waitUntil(async () => !/ausgeschaltet/.test((await queryBlocks())[2].text), { timeout: 8000, timeoutMsg: "bookings not back" });
});

const diagramStates = () => app.browser.execute(() => [...document.querySelectorAll(".pane.active .rich-preview.mmd")].map((e) => ({ state: e.dataset.state, svg: !!e.querySelector(".mmd-view svg"), kind: e.querySelector(".rich-kind")?.textContent ?? "" })));
const flowchartSvg = () => app.browser.execute(() => document.querySelector(".pane.active .rich-preview.mmd .mmd-view")?.innerHTML ?? "");

test("Mermaid: seven diagram types render, errors show the source, the source toggles", async () => {
  await open(ids.diagrams, "Diagramme");
  // Lazy: nothing far below the fold renders before it is scrolled to.
  assert.ok((await diagramStates()).slice(-1)[0].state === "waiting", "the last diagram waits for the viewport");
  await scrollPreviews();
  await app.browser.waitUntil(async () => (await diagramStates()).every((d) => d.state === "ready" || d.state === "error"), { timeout: 20000, timeoutMsg: `not rendered: ${JSON.stringify(await diagramStates())}` });
  const states = await diagramStates();
  assert.deepEqual(
    states.map((d) => `${d.state}:${d.svg}`),
    [...Object.keys(DIAGRAMS).map(() => "ready:true"), "error:false"],
  );
  assert.deepEqual(states.map((d) => d.kind), ["Mermaid · flowchart", "Mermaid · sequenceDiagram", "Mermaid · gantt", "Mermaid · classDiagram", "Mermaid · stateDiagram-v2", "Mermaid · erDiagram", "Mermaid · mindmap", "Mermaid · flowchart"]);
  const err = await app.browser.execute(() => document.querySelector('.pane.active .mmd[data-state="error"] .rich-error').innerText);
  assert.match(err, /Das Diagramm enthält einen Fehler/);
  assert.match(err, /A\[\[\[ --> B/, "the source is shown with the error");
  assert.deepEqual(await app.browser.execute(() => window.__annaloErrors ?? []), []);
  // Source toggle.
  await app.browser.execute(() => document.querySelector(".pane.active .mmd .mmd-edit").click());
  await app.browser.waitUntil(() => app.browser.execute(() => document.querySelector(".pane.active pre.rich-src").classList.contains("is-editing")), { timeoutMsg: "source not shown" });
  assert.match(await app.browser.execute(() => document.querySelector(".pane.active .mmd .mmd-edit").textContent), /Fertig/);
  await app.browser.execute(() => document.querySelector(".pane.active .mmd .mmd-edit").click());
  await app.browser.waitUntil(() => app.browser.execute(() => document.querySelector(".pane.active pre.rich-src").classList.contains("is-hidden")), { timeoutMsg: "source not hidden" });
  assert.equal((await content(ids.diagrams)).split("```mermaid").length - 1, 8, "the Markdown is unchanged");
  await app.browser.execute(() => document.querySelector(".pane.active .rich-preview.mmd").scrollIntoView({ block: "start" }));
  await app.shot("124-mermaid-light");
});

test("Mermaid follows the theme", async () => {
  assert.match(await flowchartSvg(), /#ECECFF/i, "light theme colors");
  await setSettings((s) => ({ ...s, theme: "dark" }));
  await app.browser.waitUntil(async () => !/#ECECFF/i.test(await flowchartSvg()), { timeout: 10000, timeoutMsg: "diagram did not follow the dark theme" });
  await app.shot("124-mermaid-dark");
  await setSettings((s) => ({ ...s, theme: "light" }));
  await app.browser.waitUntil(async () => /#ECECFF/i.test(await flowchartSvg()), { timeout: 10000, timeoutMsg: "diagram did not return to light" });
});

test("Mermaid exports SVG and PNG; HTML share has inline SVG and query tables; print shows the diagrams", async () => {
  const svgFile = path.join(tmp, "plan.svg");
  const pngFile = path.join(tmp, "plan.png");
  for (const [format, file] of [["svg", svgFile], ["png", pngFile]])
    await app.browser.execute((source, f, p) => window.dispatchEvent(new CustomEvent("annalo:diagram-export", { detail: { source, format: f, path: p } })), DIAGRAMS.flowchart, format, file);
  await app.browser.waitUntil(() => fs.existsSync(svgFile) && fs.existsSync(pngFile), { timeout: 10000, timeoutMsg: "export files not written" });
  assert.match(fs.readFileSync(svgFile, "utf8"), /^<\?xml[\s\S]*<svg[^>]*xmlns="http:\/\/www.w3.org\/2000\/svg"[\s\S]*Angebot/);
  assert.deepEqual([...fs.readFileSync(pngFile).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);

  const file = path.join(tmp, "diagramme.html");
  await app.browser.execute((id, p) => window.dispatchEvent(new CustomEvent("annalo:share-html", { detail: { id, path: p } })), ids.diagrams, file);
  await app.browser.waitUntil(() => fs.existsSync(file), { timeout: 20000, timeoutMsg: "HTML file not written" });
  const html = fs.readFileSync(file, "utf8");
  assert.equal(html.match(/<figure class="diagram"><svg/g)?.length, 7, "seven inline SVGs");
  assert.match(html, /figure class="diagram diagram-error"/);
  const qfile = path.join(tmp, "abfragen.html");
  await app.browser.execute((id, p) => window.dispatchEvent(new CustomEvent("annalo:share-html", { detail: { id, path: p } })), ids.queries, qfile);
  await app.browser.waitUntil(() => fs.existsSync(qfile), { timeout: 10000, timeoutMsg: "HTML file not written" });
  const qhtml = fs.readFileSync(qfile, "utf8");
  assert.match(qhtml, /<table class="query"><thead><tr><th>Aufgabe<\/th><th>Seite<\/th><th>Fällig<\/th><\/tr><\/thead><tbody><tr><td>\[ \] Angebot schreiben<\/td>/);
  assert.doesNotMatch(qhtml, /```query|language-query/);

  // Print: the diagrams are SVG in the printed pane, rendered light.
  await setSettings((s) => ({ ...s, theme: "dark" }));
  await app.browser.waitUntil(async () => !/#ECECFF/i.test(await flowchartSvg()), { timeout: 10000 });
  await app.browser.execute(() => {
    window.__printed = null;
    window.print = () => (window.__printed = { svgs: document.querySelectorAll(".pane.active .mmd-view svg").length, light: /#ECECFF/i.test(document.querySelector(".pane.active .mmd-view").innerHTML) });
  });
  await app.click('.pane.active .page-view [aria-label="Weitere Aktionen"]');
  assert.ok(await menuClick("Drucken / als PDF"));
  await app.browser.waitUntil(() => app.browser.execute(() => window.__printed != null), { timeout: 15000, timeoutMsg: "print not reached" });
  assert.deepEqual(await app.browser.execute(() => window.__printed), { svgs: 7, light: true });
  await setSettings((s) => ({ ...s, theme: "light" }));
});

test("presentation mode shows diagrams and embedded sections", async () => {
  ids.deck = (await app.invoke("page_create", { parentId: null, title: "Vortrag Diagramm", icon: null, content: `# Ablauf\n\n${fence("mermaid", DIAGRAMS.flowchart)}\n\n![[Abfrage-Aufgaben]]\n` })).id;
  await open(ids.deck, "Vortrag Diagramm");
  await app.click('.pane.active .page-view [aria-label="Weitere Aktionen"]');
  assert.ok(await menuClick("Präsentieren"));
  await app.waitFor(".presentation .present-slide");
  await app.browser.waitUntil(() => app.browser.execute(() => !!document.querySelector(".presentation .slide-content .slide-diagram svg")), { timeout: 10000, timeoutMsg: "no diagram on the slide" });
  await app.browser.waitUntil(() => app.browser.execute(() => /Angebot schreiben/.test(document.querySelector(".presentation .slide-content .slide-page-embed")?.innerText ?? "")), { timeout: 10000, timeoutMsg: "no embed on the slide" });
  await app.shot("124-present");
  await app.keys(["Escape"]);
  await app.browser.waitUntil(() => app.browser.execute(() => !document.querySelector(".presentation")), { timeoutMsg: "presentation not closed" });
});

test("a page with 10 embeds, 3 queries and 3 diagrams opens without jank and renders lazily", async () => {
  const parts = [];
  for (let i = 0; i < 10; i++) parts.push(`Absatz ${i}\n\n![[Abfrage-Aufgaben]]`);
  parts.splice(2, 0, fence("query", "from: tasks\nshow: list\n#e2eq"));
  parts.splice(5, 0, fence("mermaid", DIAGRAMS.sequence));
  parts.splice(8, 0, fence("query", "from: pages\nshow: count"));
  parts.push(fence("mermaid", DIAGRAMS.state), fence("query", "from: tasks\nshow: chart"), fence("mermaid", DIAGRAMS.flowchart));
  ids.big = (await app.invoke("page_create", { parentId: null, title: "Viele Blöcke", icon: null, content: parts.join("\n\n") + "\n" })).id;
  // Long tasks while opening (observer installed before).
  await app.browser.execute(() => {
    window.__long = [];
    try {
      new PerformanceObserver((l) => window.__long.push(...l.getEntries().map((e) => e.duration))).observe({ type: "longtask", buffered: false });
    } catch {
      window.__long = null;
    }
  });
  const t0 = Date.now();
  await open(ids.big, "Viele Blöcke");
  await app.browser.waitUntil(() => app.browser.execute(() => document.querySelectorAll('.pane.active .page-embed[data-state="ready"]').length >= 1), { timeout: 8000, timeoutMsg: "first embed not shown" });
  const opened = Date.now() - t0;
  assert.ok(opened < 4000, `opened in ${opened} ms`);
  const states = await app.browser.execute(() => [...document.querySelectorAll(".pane.active .page-embed, .pane.active .rich-preview.mmd")].map((e) => e.dataset.state));
  assert.equal(states.length, 13);
  assert.ok(states.filter((s) => s === "waiting").length >= 5, `below the fold waits: ${states}`);
  const long = await app.browser.execute(() => window.__long);
  if (long) assert.ok(Math.max(0, ...long) < 1500, `long tasks: ${long}`);
});
