// Tasks 1.13: bulk actions in Aufgaben. Select several tasks (Auswählen, Shift+click, Ctrl+A,
// keyboard), then set the due date, the priority, mark them done, move them to another page with
// their subtasks or delete them; each action has one undo, and the count is announced.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
let src;
let dst;
before(async () => (app = await launch({ width: 1280, height: 800 })));
after(async () => app?.close());

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const tomorrow = iso(new Date(Date.now() + 86400000));
const body = async (p) => (await app.invoke("page_get", { id: p.id })).content;
const row = (ordinal) => `.tasks-view .task-row[data-page="${src.id}"][data-ordinal="${ordinal}"]`;
const until = (f, msg) => app.browser.waitUntil(f, { timeout: 8000, timeoutMsg: msg });
const announced = () => app.browser.execute(() => document.querySelector('.tasks-view [role="status"]')?.textContent ?? "");
const SOURCE = "# Liste\n\n- [ ] Angebot schreiben #bulk\n- [ ] Rechnung prüfen #bulk\n  - [ ] Beleg suchen\n- [ ] Termin abstimmen #bulk\n- [ ] Bleibt hier #bulk\n";

async function menuItem(pattern) {
  await until(async () => {
    for (const el of await app.$$(".menu .menu-item")) if (pattern.test(await app.textOf(el))) return (await el.click(), true);
    return false;
  }, `no menu item ${pattern}`);
}

async function bulkButton(pattern) {
  await until(async () => {
    for (const b of await app.$$(".task-bulk button")) if (pattern.test(await app.textOf(b)) && (await b.isEnabled())) return (await b.click(), true);
    return false;
  }, `no bulk button ${pattern}`);
}

async function toastUndo(title) {
  await until(async () => {
    for (const t of await app.$$(".toast")) {
      if (!title.test(await app.textOf(t))) continue;
      for (const b of await t.$$("button")) if (/Rückgängig/.test(await app.textOf(b))) return (await b.click(), true);
    }
    return false;
  }, `no undo toast ${title}`);
}

/** Selects exactly the rows `ordinals` (first click, then Ctrl+clicks). */
async function selectRows(...ordinals) {
  if (!(await (await app.$(".task-bulk")).isExisting())) await app.click(".tasks-select-toggle");
  await app.waitFor(".task-bulk");
  for (const el of await app.$$(".task-row.selected .task-select")) await el.click();
  for (const o of ordinals) await app.click(`${row(o)} .task-select`);
  await until(async () => (await app.$$(".tasks-view .task-row.selected")).length === ordinals.length, "selection not made");
}

test("select with the boxes, Shift+click, keyboard and Ctrl+A; the count is announced", async () => {
  src = await app.invoke("page_create", { parentId: null, title: "Bulk-Quelle", icon: null, content: SOURCE });
  dst = await app.invoke("page_create", { parentId: null, title: "Bulk-Ziel", icon: null, content: "# Ziel\n\n- [ ] Schon da\n" });
  await app.keys(["Control", "Shift", "a"]);
  await app.waitFor(row(0));
  await app.select('.tasks-view [role="combobox"]', "bulk");
  await until(async () => (await app.$$(`.tasks-view .task-row[data-page="${src.id}"]`)).length === 4, "tag filter");

  await app.click(".tasks-select-toggle");
  await app.waitFor(".task-bulk");
  assert.equal(await (await app.$(".tasks-select-toggle")).getAttribute("aria-pressed"), "true");
  await app.click(`${row(0)} .task-select`);
  await app.click(`${row(4)} .task-select`);
  // Shift+click on another row: the range from the last clicked one.
  await app.browser.execute((sel) => document.querySelector(sel).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, shiftKey: true })), `${row(3)} .task-select`);
  await until(async () => (await app.$$(".tasks-view .task-row.selected")).length >= 3, "Shift range not selected");
  assert.match(await announced(), /Aufgaben ausgewählt/);
  assert.equal(await (await app.$(`${row(0)} .task-select`)).getAttribute("aria-label"), "„Angebot schreiben #bulk“ auswählen");
  await app.shot("tasks-bulk-selected");

  // Ctrl+A selects all shown; Escape ends the selection.
  await app.browser.execute((sel) => document.querySelector(sel).focus(), `${row(0)} .task-select`);
  await app.keys(["Control", "a"]);
  await until(async () => (await announced()) === "4 Aufgaben ausgewählt", "Ctrl+A");
  await app.keys(["Escape"]);
  await until(async () => !(await (await app.$(".task-bulk")).isExisting()), "Escape did not end the selection");

  // Keyboard: arrows move between rows, Shift+arrow extends the selection.
  await app.click(".tasks-select-toggle");
  await app.browser.execute((sel) => document.querySelector(sel).focus(), `${row(0)} .task-select`);
  await app.keys(["Shift", "ArrowDown"]);
  await until(async () => (await announced()) === "2 Aufgaben ausgewählt", "Shift+ArrowDown");
  const focused = await app.browser.execute(() => document.activeElement?.closest(".task-row")?.dataset.ordinal);
  assert.equal(focused, "1");
});

test("due date, priority and done for the selection, each with one undo", async () => {
  await selectRows(0, 1, 3);
  await bulkButton(/Fälligkeit/);
  await menuItem(/^Morgen$/);
  await until(async () => (await body(src)).split(`due:${tomorrow}`).length === 4, "due dates not set");
  assert.match(await body(src), /^- \[ \] Bleibt hier #bulk$/m, "unselected task untouched");
  await app.waitText(".toast", /Fälligkeit von 3 Aufgaben geändert/);
  await toastUndo(/Fälligkeit von 3 Aufgaben/);
  await until(async () => (await body(src)) === SOURCE, "due undo");

  await selectRows(0, 3);
  await bulkButton(/Priorität/);
  await menuItem(/^Hoch$/);
  await until(async () => /^- \[ \] Angebot schreiben #bulk !!$/m.test(await body(src)) && /^- \[ \] Termin abstimmen #bulk !!$/m.test(await body(src)), "priority not set");
  await toastUndo(/Priorität von 2 Aufgaben/);
  await until(async () => (await body(src)) === SOURCE, "priority undo");

  await selectRows(0, 3);
  await bulkButton(/Erledigen/);
  await until(async () => /^- \[x\] Angebot schreiben/m.test(await body(src)) && /^- \[x\] Termin abstimmen/m.test(await body(src)), "not done");
  await app.waitText(".toast", /2 Aufgaben erledigt/);
  await toastUndo(/2 Aufgaben erledigt/);
  await until(async () => (await body(src)) === SOURCE, "done undo");
});

test("move to another page takes subtasks along; delete; both undone", async () => {
  await selectRows(1);
  await bulkButton(/^Verschieben/);
  await app.waitFor(".dialog .move-search");
  await app.type("Bulk-Ziel");
  await app.waitText(".dialog .move-opt.cursor", /Bulk-Ziel/);
  await app.shot("tasks-bulk-move-dialog");
  await app.keys(["Enter"]);
  await until(async () => (await body(dst)).includes("- [ ] Schon da\n- [ ] Rechnung prüfen #bulk\n  - [ ] Beleg suchen\n"), "not moved");
  assert.ok(!(await body(src)).includes("Rechnung prüfen"), "still in the source");
  assert.ok(!(await body(src)).includes("Beleg suchen"), "subtask left behind");
  await app.waitText(".toast", /1 Aufgabe nach „Bulk-Ziel“ verschoben/);
  await toastUndo(/verschoben/);
  await until(async () => (await body(src)) === SOURCE && (await body(dst)) === "# Ziel\n\n- [ ] Schon da\n", "move undo");

  await selectRows(0);
  await app.keys(["Delete"]);
  await until(async () => !(await body(src)).includes("Angebot schreiben"), "not deleted");
  await toastUndo(/1 Aufgabe gelöscht/);
  await until(async () => (await body(src)) === SOURCE, "delete undo");
});

test("the task menu acts on one task or on the selection", async () => {
  await app.click(".task-bulk [aria-label='Auswahl beenden']");
  await (await app.$(row(4))).click({ button: "right" });
  await menuItem(/Priorität/);
  await menuItem(/^Mittel$/);
  await until(async () => /^- \[ \] Bleibt hier #bulk !$/m.test(await body(src)), "menu priority");
  await toastUndo(/Priorität von 1 Aufgabe/);
  await until(async () => (await body(src)) === SOURCE, "menu undo");
  // A narrow split pane: the bar wraps, nothing overflows.
  await selectRows(0, 1);
  await app.click('.pane.active .tabbar [aria-label="Rechts teilen"]');
  await until(async () => (await app.$$(".pane")).length === 2, "split");
  await app.browser.execute(() => document.querySelector(".pane:first-child .view-scroll")?.scrollTo(0, 0));
  const overflow = await app.browser.execute(() => {
    const bar = document.querySelector(".pane:first-child .task-bulk");
    return bar ? bar.scrollWidth - bar.clientWidth : -1;
  });
  assert.ok(overflow <= 1, `bar overflows by ${overflow}px`);
  await app.shot("tasks-bulk-split");
});
