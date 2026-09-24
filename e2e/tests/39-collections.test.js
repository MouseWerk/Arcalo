// Typed page properties and table/board views of a page's child pages: the schema lives in the
// parent's frontmatter, values in the children's, and every edit writes only that frontmatter.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
let parent;
const kids = {};
before(async () => (app = await launch()));
after(async () => app?.close());

const content = async (id) => (await app.invoke("page_get", { id })).content;
const view = '.pane.active .coll[data-page]';
const cell = (id, key) => `${view} [data-cell="${id}:${key}"]`;
/** Titles of the table rows, top to bottom. */
const rowTitles = () => app.browser.execute(() => [...document.querySelectorAll(".pane.active .coll-row .coll-title-link")].map((b) => b.innerText.trim()));
/** Presses keys one after another (WebKit drops characters of a string sent at once). */
const press = async (...keys) => {
  for (const k of keys) await app.keys([k]);
};
const openTree = async (title) => {
  for (const r of await app.$$(".sidebar .tree-row")) if ((await app.textOf(r)) === title) return r.click();
  throw new Error(`no ${title}`);
};

test("a folder with three pages shows them as a table", async () => {
  parent = await app.invoke("page_create", { parentId: null, title: "Sprint-Board", icon: null, content: "Die Aufgaben dieses Sprints.\n" });
  kids.login = (await app.invoke("page_create", { parentId: parent.id, title: "Login bauen", icon: null, content: "Formular und Fehlertexte.\n" })).id;
  kids.export = (await app.invoke("page_create", { parentId: parent.id, title: "Export prüfen", icon: null, content: "---\nnotiz: frei\n---\nCSV und JSON.\n" })).id;
  kids.suche = (await app.invoke("page_create", { parentId: parent.id, title: "Suche planen", icon: null, content: "" })).id;
  await app.browser.refresh();
  await app.browser.waitUntil(async () => (await app.browser.execute(() => document.body.classList.contains("ready"))) === true, { timeout: 20000 });
  await openTree("Sprint-Board");
  await app.waitFor(".pane.active .ProseMirror");
  await app.click('.pane.active .vh [aria-label="Weitere Aktionen"]');
  await app.browser.execute(() => [...document.querySelectorAll(".menu .menu-item")].find((b) => b.innerText.includes("Als Tabelle anzeigen")).click());
  await app.waitFor(`${view} .coll-table`);
  await app.browser.waitUntil(async () => (await rowTitles()).length === 3, { timeoutMsg: "three rows" });
  assert.deepEqual(await rowTitles(), ["Login bauen", "Export prüfen", "Suche planen"]);
  // Properties found on the children become columns; the view is stored on the parent.
  assert.ok(await (await app.$(`${view} th[data-col="notiz"]`)).isExisting(), "unknown property column");
  await app.browser.waitUntil(async () => /\nansicht: tabelle\n/.test(await content(parent.id)), { timeoutMsg: "view not saved" });
  assert.match(await content(parent.id), /Die Aufgaben dieses Sprints\./, "text kept");
});

test("define the schema and edit cells with typed controls", async () => {
  const addProp = async (name, kind) => {
    await app.click(`${view} .coll-add-col`);
    const input = await app.waitFor('.coll-pop input[aria-label="Name der Eigenschaft"]');
    await input.setValue(name);
    await app.browser.execute((k) => [...document.querySelectorAll(".coll-pop .coll-kind")].find((b) => b.innerText.trim() === k).click(), kind);
    await app.click('.coll-pop button[type="submit"]');
    await app.waitFor(`${view} th[data-col="${name}"]`);
  };
  await addProp("status", "Auswahl");
  await addProp("aufwand", "Zahl");
  await addProp("fällig", "Datum");
  await app.browser.waitUntil(async () => /eigenschaften:\n {2}status: auswahl\n {2}aufwand: zahl\n {2}fällig: datum\n/.test(await content(parent.id)), { timeoutMsg: `schema not saved: ${await content(parent.id)}` });

  // Select: typing a new name creates the option and sets it.
  const setStatus = async (id, name) => {
    await app.click(cell(id, "status"));
    const q = await app.waitFor('.coll-pop .opt-picker-input');
    await q.setValue(name);
    await press("Enter");
    await app.browser.waitUntil(async () => new RegExp(`\\nstatus: ${name}\\n`).test(await content(id)), { timeoutMsg: `status ${name} not saved` });
  };
  await setStatus(kids.login, "Offen");
  await setStatus(kids.export, "In Arbeit");
  await setStatus(kids.suche, "Offen");
  assert.match(await content(parent.id), /status: \{typ: auswahl, optionen: \{Offen: grau, In Arbeit: braun\}\}/);
  // Only the frontmatter changed: the text is untouched and other properties stay.
  assert.equal(await content(kids.export), "---\nnotiz: frei\nstatus: In Arbeit\n---\nCSV und JSON.\n");
  assert.equal(await content(kids.login), "---\nstatus: Offen\n---\nFormular und Fehlertexte.\n");

  // Number: German input, stored as a YAML number, shown German again.
  const setNumber = async (id, text) => {
    await app.click(cell(id, "aufwand"));
    await app.waitFor(`${cell(id, "aufwand")} input`);
    for (const ch of text) await press(ch);
    await press("Enter");
  };
  await setNumber(kids.login, "3,5");
  await setNumber(kids.export, "1");
  await setNumber(kids.suche, "8");
  await app.browser.waitUntil(async () => /\naufwand: 3\.5\n/.test(await content(kids.login)), { timeoutMsg: "number not saved" });
  await app.waitText(cell(kids.login, "aufwand"), /^3,5$/);

  // Keyboard: from the number cell one to the right is the date; Enter opens the calendar.
  await app.browser.execute((sel) => document.querySelector(sel).focus(), cell(kids.suche, "aufwand"));
  await press("ArrowRight");
  assert.equal(await app.browser.execute(() => document.activeElement?.dataset.cell), `${kids.suche}:fällig`);
  await press("Enter");
  await app.waitFor(".calendar");
  await app.browser.execute(() => document.querySelector(".calendar .cal-day.today").click());
  await app.browser.waitUntil(async () => /\nfällig: \d{4}-\d{2}-\d{2}\n/.test(await content(kids.suche)), { timeoutMsg: "date not saved" });
  await app.waitText(cell(kids.suche, "fällig"), /^\d{2}\.\d{2}\.\d{4}$/);
  // Arrow up to the row above, Escape leaves the grid.
  await app.browser.execute((sel) => document.querySelector(sel).focus(), cell(kids.suche, "status"));
  await press("ArrowUp");
  assert.equal(await app.browser.execute(() => document.activeElement?.dataset.cell), `${kids.export}:status`);
  await app.shot("collection-table");
});

test("sort by clicking a header and filter with the filter bar", async () => {
  await app.browser.execute(() => document.querySelector(".pane.active th[data-col='aufwand'] .coll-th-inner").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: 10, clientY: 10 })));
  await app.browser.execute(() => window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0, clientX: 10, clientY: 10 })));
  await app.browser.waitUntil(async () => (await rowTitles()).join() === "Export prüfen,Login bauen,Suche planen", { timeoutMsg: `not sorted: ${await rowTitles()}` });
  await app.browser.execute(() => document.querySelector(".pane.active th[data-col='aufwand'] .coll-th-inner").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: 10, clientY: 10 })));
  await app.browser.execute(() => window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0, clientX: 10, clientY: 10 })));
  await app.browser.waitUntil(async () => (await rowTitles()).join() === "Suche planen,Login bauen,Export prüfen", { timeoutMsg: "not descending" });
  await app.browser.waitUntil(async () => /sortierung: \{feld: aufwand, richtung: ab\}/.test(await content(parent.id)), { timeoutMsg: "sort not saved" });

  await app.browser.execute(() => [...document.querySelectorAll(".pane.active .coll-tools .btn")].find((b) => b.innerText.includes("Filter")).click());
  await app.waitFor('.coll-pop [role="combobox"][aria-label="Eigenschaft"]');
  await app.select('.coll-pop [role="combobox"][aria-label="Eigenschaft"]', "status");
  await app.select('.coll-pop [role="combobox"][aria-label="Bedingung"]', "ist");
  await app.select('.coll-pop [role="combobox"][aria-label="Wert"]', "Offen");
  await app.browser.execute(() => [...document.querySelectorAll(".coll-pop .btn")].find((b) => b.innerText.includes("Fertig")).click());
  await app.browser.waitUntil(async () => (await rowTitles()).join() === "Suche planen,Login bauen", { timeoutMsg: `not filtered: ${await rowTitles()}` });
  assert.match(await app.text(`${view} .coll-filters`), /status\s+ist „Offen“/);
  assert.match(await app.text(`${view} .coll-count`), /2 von 3/);
  await app.browser.waitUntil(async () => /filter: \[\{feld: status, op: ist, wert: Offen\}\]/.test(await content(parent.id)), { timeoutMsg: "filter not saved" });
  await app.shot("collection-filtered");
  // Remove the filter again.
  await app.click(`${view} .coll-filter .coll-chip-x`);
  await app.browser.waitUntil(async () => (await rowTitles()).length === 3);
});

test("board: drag a card to another column sets the child's property", async () => {
  await app.browser.execute(() => [...document.querySelectorAll(".pane.active .coll-switch button")].find((b) => b.innerText.includes("Board")).click());
  await app.waitFor(`${view} .board`);
  await app.browser.waitUntil(async () => /\n {2}typ: board\n/.test(await content(parent.id)), { timeoutMsg: "board not saved" });
  const col = (name) => `${view} .board-col[data-group="${name}"]`;
  assert.match(await app.text(`${col("Offen")} .board-count`), /^2$/, "WIP count");
  assert.match(await app.text(`${col("In Arbeit")} .board-count`), /^1$/);
  assert.ok(await (await app.$(`${view} .board-col[data-group=""]`)).isExisting(), "Ohne Wert column");

  const card = await app.$(`${col("Offen")} .board-card[data-row="${kids.login}"]`);
  const target = await app.$(`${col("In Arbeit")} .board-add`);
  await app.browser.performActions([
    {
      type: "pointer",
      id: "mouse",
      parameters: { pointerType: "mouse" },
      actions: [
        { type: "pointerMove", origin: card, x: 0, y: 0 },
        { type: "pointerDown", button: 0 },
        { type: "pointerMove", origin: "pointer", x: 40, y: 10, duration: 100 },
        { type: "pointerMove", origin: target, x: 0, y: -6, duration: 200 },
        { type: "pointerUp", button: 0 },
      ],
    },
  ]);
  await app.browser.releaseActions();
  await app.browser.waitUntil(async () => /\nstatus: In Arbeit\n/.test(await content(kids.login)), { timeoutMsg: `not moved: ${await content(kids.login)}` });
  assert.equal(await content(kids.login), "---\nstatus: In Arbeit\naufwand: 3.5\n---\nFormular und Fehlertexte.\n", "only the frontmatter changed");
  await app.waitFor(`${col("In Arbeit")} .board-card[data-row="${kids.login}"]`);
  assert.match(await app.text(`${col("In Arbeit")} .board-count`), /^2$/);
  // Dropping does not open the page.
  assert.equal(await app.text(".pane.active .tab.active .tab-title"), "Sprint-Board");

  // Collapse a column (its buttons show on hover); it stays collapsed (stored with the view).
  await (await app.$(`${col("Offen")} .board-col-head`)).moveTo();
  await app.click(`${col("Offen")} [aria-label="Offen einklappen"]`);
  await app.waitFor(`${col("Offen")}.collapsed`);
  await app.browser.waitUntil(async () => /eingeklappt: \[Offen\]/.test(await content(parent.id)), { timeoutMsg: "collapse not saved" });
  await app.shot("collection-board");
  await app.click(`${col("Offen")} .board-col-expand`);
  await app.browser.execute(() => (document.documentElement.dataset.theme = "light"));
  await app.shot("collection-board-light");
  await app.browser.execute(() => (document.documentElement.dataset.theme = "dark"));
});

test("invalid values are marked, kept and fixed in the property editor", async () => {
  // Written by hand (or by another tool): not a number, not an option.
  const text = "---\nstatus: Später\naufwand: viel\n---\nCSV und JSON.\n";
  await app.invoke("page_save", { id: kids.export, content: text });
  await app.browser.execute((id, c) => window.dispatchEvent(new CustomEvent("annalo:page-saved", { detail: { id, content: c, from: "test" } })), kids.export, text);
  await app.browser.execute(() => [...document.querySelectorAll(".pane.active .coll-switch button")].find((b) => b.innerText.includes("Tabelle")).click());
  await app.waitFor(`${cell(kids.export, "aufwand")} .val-invalid`);
  assert.equal(await app.browser.execute((sel) => document.querySelector(sel).dataset.tooltip, `${cell(kids.export, "aufwand")} .val-invalid`), "Keine Zahl");
  assert.equal(await app.text(cell(kids.export, "aufwand")), "viel", "shown as written");
  assert.equal(await app.browser.execute((sel) => document.querySelector(sel).dataset.tooltip, `${cell(kids.export, "status")} .val-invalid`), "„Später“ ist keine Option");
  assert.equal(await content(kids.export), text, "nothing rewritten");
  await app.shot("collection-invalid");

  // The child page: typed rows from the folder's schema, the invalid value marked there too.
  await app.browser.execute((id) => document.querySelector(`.pane.active [data-cell="${id}:titel"] .coll-title-link`).click(), kids.export);
  await app.waitFor('.pane.active .properties [data-prop-key="aufwand"][data-kind="number"]');
  assert.ok(await (await app.$('.pane.active .properties [data-prop-key="aufwand"] .val-invalid')).isExisting(), "marked in the editor");
  assert.ok(await (await app.$('.pane.active .properties [data-prop-key="fällig"] .prop-date')).isExisting(), "missing schema property listed as a date");
  const input = await app.$('.pane.active .properties [data-prop-key="aufwand"] input');
  await input.click();
  await app.browser.keys(["Control", "a"]);
  await press("2", ",", "5", "Enter");
  await app.browser.waitUntil(async () => /\naufwand: 2\.5\n/.test(await content(kids.export)), { timeoutMsg: `not fixed: ${await content(kids.export)}` });
  await app.browser.waitUntil(async () => !(await (await app.$('.pane.active .properties [data-prop-key="aufwand"] .val-invalid')).isExisting()), { timeoutMsg: "still marked" });
  await app.shot("collection-child-properties");
});

test("a property of one page can become a property of the folder", async () => {
  const text = await content(kids.export);
  await app.invoke("page_save", { id: kids.export, content: text.replace("---\nstatus", "---\nquelle: https://example.org\nstatus") });
  await app.browser.execute(() => window.dispatchEvent(new CustomEvent("annalo:reload-pages", { detail: {} })));
  await app.waitFor('.pane.active .properties [data-prop-key="quelle"] .prop-icon-btn');
  await app.click('.pane.active .properties [data-prop-key="quelle"] .prop-icon-btn');
  await app.browser.execute(() => [...document.querySelectorAll(".menu .menu-item")].find((b) => b.innerText.includes("Für alle Seiten im Ordner")).click());
  await app.browser.waitUntil(async () => /\n {2}quelle: link\n/.test(await content(parent.id)), { timeoutMsg: `not in the schema: ${await content(parent.id)}` });
  await app.waitFor('.pane.active .properties [data-prop-key="quelle"][data-kind="link"]');
});

test("no console errors", async () => {
  assert.deepEqual(await app.consoleErrors(), []);
});
