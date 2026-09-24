// Table/board views beyond the basics: a folder of 500 pages, a narrow split pane, card order
// within a board column, renaming options and person suggestions.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
before(async () => (app = await launch()));
after(async () => app?.close());

const content = async (id) => (await app.invoke("page_get", { id })).content;
const ready = () => app.browser.waitUntil(async () => (await app.browser.execute(() => document.body.classList.contains("ready"))) === true, { timeout: 20000 });
const openTree = async (title) => {
  // A large tree renders only the rows in view: scroll through it until the row is there.
  await app.browser.executeAsync((t, done) => {
    const sc = document.querySelector(".sidebar .sidebar-scroll");
    const has = () => [...document.querySelectorAll(".sidebar .tree-row")].find((r) => r.textContent.trim() === t);
    const step = (top) => {
      const row = has();
      if (row) return (row.scrollIntoView({ block: "nearest" }), setTimeout(done, 100));
      if (top > sc.scrollHeight) return done();
      sc.scrollTop = top;
      setTimeout(() => step(top + sc.clientHeight / 2), 60);
    };
    step(0);
  }, title);
  for (const r of await app.$$(".sidebar .tree-row")) if ((await app.textOf(r)) === title) return r.click();
  throw new Error(`no ${title}`);
};
const press = async (...keys) => {
  for (const k of keys) await app.keys([k]);
};

test("500 pages: the table renders a window of rows and stays quick", async () => {
  const schema = "---\neigenschaften:\n  status: {typ: auswahl, optionen: {Offen: grau, Fertig: grün}}\n  nr: zahl\nansicht: tabelle\n---\nViele Seiten.\n";
  const big = await app.invoke("page_create", { parentId: null, title: "Großer Ordner", icon: null, content: schema });
  for (let i = 1; i <= 500; i++) {
    await app.invoke("page_create", { parentId: big.id, title: `Eintrag ${String(i).padStart(3, "0")}`, icon: null, content: `---\nstatus: ${i % 3 ? "Offen" : "Fertig"}\nnr: ${i}\n---\n` });
  }
  await app.browser.refresh();
  await ready();
  await openTree("Großer Ordner");
  const t0 = Date.now();
  await app.waitFor(".pane.active .coll-table .coll-row");
  const ms = Date.now() - t0;
  const rendered = await app.browser.execute(() => document.querySelectorAll(".pane.active .coll-row").length);
  assert.ok(rendered < 120, `only a window of rows is rendered (${rendered})`);
  assert.match(await app.text(".pane.active .coll-count"), /500 Seiten/);
  assert.ok(ms < 5000, `opened in ${ms} ms`);
  // Sorting 500 rows by a number, descending, and scrolling to the end.
  await app.browser.execute(() => {
    const th = document.querySelector(".pane.active th[data-col='nr'] .coll-th-inner");
    for (let i = 0; i < 2; i++) {
      th.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: 5, clientY: 5 }));
      window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0, clientX: 5, clientY: 5 }));
    }
  });
  await app.waitText(".pane.active .coll-row:first-of-type .coll-title-link, .pane.active .coll-row .coll-title-link", /Eintrag 500/);
  await app.browser.execute(() => {
    const w = document.querySelector(".pane.active .coll-table-wrap");
    w.scrollTop = w.scrollHeight;
    w.dispatchEvent(new Event("scroll"));
  });
  await app.waitText(".pane.active .coll-row .coll-title-link", /Eintrag 001/);
  // The header stays at the top of the scroll box.
  const stuck = await app.browser.execute(() => {
    const w = document.querySelector(".pane.active .coll-table-wrap").getBoundingClientRect();
    const th = document.querySelector(".pane.active .coll-th").getBoundingClientRect();
    return Math.abs(th.top - w.top) < 3;
  });
  assert.ok(stuck, "sticky header");
  await app.shot("collection-500");
});

test("narrow split pane: the table scrolls sideways with the title column fixed", async () => {
  await app.click('.pane.active .vh [aria-label="Weitere Aktionen"]');
  await app.browser.execute(() => [...document.querySelectorAll(".menu .menu-item")].find((b) => b.innerText.includes("Rechts daneben öffnen")).click());
  await app.browser.waitUntil(async () => (await app.$$(".pane")).length === 2, { timeoutMsg: "no split" });
  await app.waitFor(".pane.active .coll-table-wrap");
  // Wider columns than the pane.
  await app.browser.execute(() => {
    const w = document.querySelector(".pane.active .coll-table-wrap");
    w.scrollLeft = 400;
  });
  const r = await app.browser.execute(() => {
    const w = document.querySelector(".pane.active .coll-table-wrap");
    const wr = w.getBoundingClientRect();
    const title = document.querySelector(".pane.active .coll-row .coll-title-cell").getBoundingClientRect();
    return { scrolls: w.scrollWidth > w.clientWidth, left: title.left - wr.left, scrollLeft: w.scrollLeft, pageScroll: document.documentElement.scrollWidth <= window.innerWidth };
  });
  assert.ok(r.scrolls, "the table scrolls sideways");
  assert.ok(r.scrollLeft > 0);
  assert.ok(Math.abs(r.left) <= 2, `title column stays at the left edge (${r.left})`);
  assert.ok(r.pageScroll, "no page-wide horizontal scroll");
  await app.shot("collection-narrow");
  // Back to one pane.
  for (const t of await app.$$(".pane:nth-of-type(2) .tab")) await app.browser.execute((e) => e.querySelector(".tab-close")?.click(), t);
  await app.browser.waitUntil(async () => (await app.$$(".pane")).length === 1, { timeoutMsg: "split not closed" });
});

let folder;
const kids = {};
test("board: reorder cards within a column, add a card to a column", async () => {
  folder = await app.invoke("page_create", {
    parentId: null,
    title: "Team-Board",
    icon: null,
    content: "---\neigenschaften:\n  status: {typ: auswahl, optionen: {Offen: grau, Fertig: grün}}\n  wer: person\nansicht:\n  typ: board\n  gruppierung: status\n---\n",
  });
  for (const t of ["Alpha", "Beta", "Gamma"]) kids[t] = (await app.invoke("page_create", { parentId: folder.id, title: t, icon: null, content: "---\nstatus: Offen\n---\n" })).id;
  await app.invoke("page_create", { parentId: null, title: "Notizen Team", icon: null, content: "Rückfrage an @Anna und @Bernd.\n" });
  await app.browser.refresh();
  await ready();
  await openTree("Team-Board");
  const col = '.pane.active .board-col[data-group="Offen"]';
  await app.waitFor(`${col} .board-card[data-row="${kids.Gamma}"]`);
  const order = () => app.browser.execute((c) => [...document.querySelectorAll(`${c} .board-card`)].map((e) => e.getAttribute("aria-label")), col);
  assert.deepEqual(await order(), ["Alpha", "Beta", "Gamma"]);
  // Gamma to the top.
  const gamma = await app.$(`${col} .board-card[data-row="${kids.Gamma}"]`);
  const alpha = await app.$(`${col} .board-card[data-row="${kids.Alpha}"]`);
  await app.browser.performActions([
    {
      type: "pointer",
      id: "mouse",
      parameters: { pointerType: "mouse" },
      actions: [
        { type: "pointerMove", origin: gamma, x: 0, y: 0 },
        { type: "pointerDown", button: 0 },
        { type: "pointerMove", origin: "pointer", x: 0, y: -20, duration: 100 },
        { type: "pointerMove", origin: alpha, x: 0, y: -12, duration: 200 },
        { type: "pointerUp", button: 0 },
      ],
    },
  ]);
  await app.browser.releaseActions();
  await app.browser.waitUntil(async () => (await order()).join() === "Gamma,Alpha,Beta", { timeoutMsg: `order: ${await order()}` });
  // Stored as the folder's page order (also the sidebar order).
  const stored = await app.invoke("page_collection", { parentId: folder.id });
  assert.deepEqual(stored.rows.map((r) => r.title), ["Gamma", "Alpha", "Beta"]);
  assert.equal(await content(kids.Gamma), "---\nstatus: Offen\n---\n", "reordering does not touch the page");

  // Without dragging: the card menu moves it; the toast undoes the move.
  await app.dismissToasts();
  await app.browser.execute((id) => document.querySelector(`.pane.active .board-card[data-row="${id}"] .board-card-menu`).click(), kids.Beta);
  await app.browser.execute(() => {
    const item = [...document.querySelectorAll(".menu .menu-item")].find((b) => b.innerText.includes("Verschieben nach"));
    item.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    item.click();
  });
  await app.browser.waitUntil(async () => app.browser.execute(() => [...document.querySelectorAll(".menu .menu-item")].some((b) => b.innerText.trim() === "Fertig")));
  await app.browser.execute(() => [...document.querySelectorAll(".menu .menu-item")].find((b) => b.innerText.trim() === "Fertig").click());
  await app.browser.waitUntil(async () => (await content(kids.Beta)) === "---\nstatus: Fertig\n---\n", { timeoutMsg: "not moved by menu" });
  await app.waitText(".toast .toast-title", /„Beta“ → Fertig/);
  await app.browser.execute(() => [...document.querySelectorAll(".toast .btn")].find((b) => b.innerText.includes("Rückgängig")).click());
  await app.browser.waitUntil(async () => (await content(kids.Beta)) === "---\nstatus: Offen\n---\n", { timeoutMsg: `not undone: ${await content(kids.Beta)}` });
  await app.waitFor(`${col} .board-card[data-row="${kids.Beta}"]`);

  // „+“ in the „Fertig“ column: a new page with status Fertig.
  await app.click('.pane.active .board-col[data-group="Fertig"] .board-add');
  await app.waitFor('.pane.active .board-col[data-group="Fertig"] .board-card');
  const col2 = await app.invoke("page_collection", { parentId: folder.id });
  const created = col2.rows.find((r) => /^Unbenannt/.test(r.title));
  assert.ok(created, "new page");
  assert.match(await content(created.id), /^---\nstatus: Fertig\n---\n/);
});

test("renaming an option updates the pages that use it", async () => {
  await app.browser.execute(() => [...document.querySelectorAll(".pane.active .coll-switch button")].find((b) => b.innerText.includes("Tabelle")).click());
  await app.waitFor('.pane.active th[data-col="status"]');
  await app.browser.execute(() => document.querySelector(".pane.active th[data-col='status'] .coll-th-menu").click());
  await app.browser.execute(() => [...document.querySelectorAll(".menu .menu-item")].find((b) => b.innerText.includes("Optionen bearbeiten")).click());
  const name = await app.waitFor('.dialog input[aria-label="Name der Option"]');
  await name.setValue("Neu");
  await app.browser.execute(() => [...document.querySelectorAll(".dialog .btn")].find((b) => b.innerText.includes("Speichern")).click());
  await app.browser.waitUntil(async () => /status: \{typ: auswahl, optionen: \{Neu: grau, Fertig: grün\}\}/.test(await content(folder.id)), { timeoutMsg: `schema: ${await content(folder.id)}` });
  for (const t of ["Alpha", "Beta", "Gamma"]) await app.browser.waitUntil(async () => (await content(kids[t])) === "---\nstatus: Neu\n---\n", { timeoutMsg: `${t} not renamed: ${await content(kids[t])}` });
  await app.waitText(`.pane.active [data-cell="${kids.Alpha}:status"]`, /^Neu$/);
});

test("person cells suggest known names (values and @mentions)", async () => {
  await app.click(`.pane.active [data-cell="${kids.Beta}:wer"]`);
  await app.waitFor(`.pane.active [data-cell="${kids.Beta}:wer"] input`);
  await press("A", "n");
  await app.waitText(".pane.active .combo-item", /^Anna$/);
  await press("ArrowDown", "Enter");
  await app.browser.waitUntil(async () => /\nwer: Anna\n/.test(await content(kids.Beta)), { timeoutMsg: "person not saved" });
  await app.waitText(`.pane.active [data-cell="${kids.Beta}:wer"]`, /Anna/);
  // Escape while editing keeps the old value.
  await app.click(`.pane.active [data-cell="${kids.Alpha}:wer"]`);
  await app.waitFor(`.pane.active [data-cell="${kids.Alpha}:wer"] input`);
  await press("X", "Escape");
  await app.browser.waitUntil(async () => !(await (await app.$(`.pane.active [data-cell="${kids.Alpha}:wer"] input`)).isExisting()));
  assert.equal(await content(kids.Alpha), "---\nstatus: Neu\n---\n");
  await app.shot("collection-person");
});

test("no console errors", async () => {
  assert.deepEqual(await app.consoleErrors(), []);
});
