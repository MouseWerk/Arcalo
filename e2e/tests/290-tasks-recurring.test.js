// Tasks 1.13: repeating tasks. The rule is plain text in the note (`every:weekly`); ticking a
// repeating task off (task view or editor) adds the next occurrence below it, one undo takes both
// back, and „Wiederholen…“ edits the rule.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
let page;
before(async () => (app = await launch({ width: 1280, height: 800 })));
after(async () => app?.close());

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const inDays = (n) => iso(new Date(Date.now() + n * 86400000));
const today = inDays(0);
const content = async () => (await app.invoke("page_get", { id: page.id })).content;
const row = (ordinal) => `.tasks-view .task-row[data-page="${page.id}"][data-ordinal="${ordinal}"]`;
const until = (f, msg) => app.browser.waitUntil(f, { timeout: 8000, timeoutMsg: msg });

async function menuItem(pattern) {
  await until(async () => {
    for (const el of await app.$$(".menu .menu-item")) if (pattern.test(await app.textOf(el))) return (await el.click(), true);
    return false;
  }, `no menu item ${pattern}`);
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

test("the task view shows the rule and ticking off adds the next occurrence", async () => {
  page = await app.invoke("page_create", {
    parentId: null,
    title: "Wiederkehrend",
    icon: null,
    content: `# Haushalt\n\n- [ ] Müll rausbringen every:weekly due:${today}\n  - [ ] Gelbe Tonne\n- [ ] Blumen gießen every:alle 3 Tage\n- [ ] Bericht \u{1F501} every month on the 15th\n- [ ] Einmalig\n`,
  });
  await app.keys(["Control", "Shift", "a"]);
  await app.waitFor(row(0));
  assert.equal(await app.text(`${row(0)} .task-recur-label`), "Wöchentlich");
  assert.equal(await app.text(`${row(2)} .task-recur-label`), "Alle 3 Tage");
  assert.equal(await app.text(`${row(3)} .task-recur-label`), "Monatlich · am 15.");
  assert.match(await app.text(row(3)), /^Bericht/, "the Obsidian marker is not shown as text");
  assert.ok(!(await (await app.$(`${row(4)} .task-recur`)).isExisting()), "plain tasks have no label");
  assert.equal(await (await app.$(`${row(0)} .task-recur`)).getAttribute("aria-label"), "Wiederholt sich: Wöchentlich");
  await app.shot("tasks-recur-list");

  await app.click(`${row(0)} .task-check`);
  await until(async () => (await content()).includes(`- [ ] Müll rausbringen every:weekly due:${inDays(7)}`), "next occurrence not added");
  assert.ok((await content()).includes(`- [x] Müll rausbringen every:weekly due:${today}\n  - [ ] Gelbe Tonne\n- [ ] Müll rausbringen every:weekly due:${inDays(7)}\n`), await content());
  await app.waitText(".toast", /Nächste am/);
  await app.shot("tasks-recur-done-toast");
  await toastUndo(/Aufgabe erledigt/);
  await until(async () => (await content()).includes(`- [ ] Müll rausbringen every:weekly due:${today}\n  - [ ] Gelbe Tonne\n- [ ] Blumen`), "undo did not restore both");
});

test("„Wiederholen…“ sets and removes the rule", async () => {
  await app.dismissToasts();
  await app.waitFor(row(4));
  await app.browser.execute((sel) => document.querySelector(sel)?.scrollIntoView({ block: "center" }), row(4));
  await (await app.$(row(4))).moveTo();
  await app.click(`${row(4)} .task-more`);
  await menuItem(/Wiederholen/);
  await app.waitFor(".dialog .recur-form");
  await app.click('.dialog .segmented [role="radio"]:nth-child(4)');
  await (await app.$("#recur-day")).setValue("31");
  await app.waitText(".dialog .recur-preview", /Nächste Termine: /);
  assert.equal(await app.text(".dialog .recur-syntax code"), "every:monthly,31");
  await app.shot("tasks-recur-dialog");
  await app.click('[data-testid="recur-save"]');
  await until(async () => /^- \[ \] Einmalig every:monthly,31$/m.test(await content()), "rule not written");
  await app.waitText(`${row(4)} .task-recur-label`, /Monatlich · am 31\./);

  // The label opens the dialog too; „Nie“ removes the rule.
  await app.click(`${row(4)} .task-recur`);
  await app.waitFor(".dialog .recur-form");
  await app.click('.dialog .segmented [role="radio"]:nth-child(1)');
  await app.click('[data-testid="recur-save"]');
  await until(async () => /^- \[ \] Einmalig$/m.test(await content()), "rule not removed");
});

test("ticking a repeating task in the editor adds the next one; Ctrl+Z takes both back", async () => {
  await app.dismissToasts();
  await app.click(`${row(2)} .task-page`);
  await app.waitText(".pane.active .tab.active .tab-title", /Wiederkehrend/);
  await app.waitFor(".ProseMirror li[data-checked]");
  const before = await content();
  // The third task item of the note: „Blumen gießen“.
  await app.browser.execute(() => {
    const li = [...document.querySelectorAll(".pane.active .ProseMirror li[data-checked]")].find((l) => l.textContent.includes("Blumen gießen"));
    li.querySelector("input[type=checkbox]").click();
  });
  await until(async () => (await content()).includes(`- [x] Blumen gießen every:alle 3 Tage\n- [ ] Blumen gießen every:alle 3 Tage due:${inDays(3)}\n`), "editor did not add the next occurrence");
  await app.browser.execute(() => document.querySelector(".pane.active .ProseMirror").focus());
  await app.keys(["Control", "z"]);
  await until(async () => (await content()) === before, "one undo did not take both back");
});
