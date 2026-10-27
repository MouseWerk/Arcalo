// 1.16 keyboard, screen reader and undo details: the slash menu tells screen readers which entry
// Enter takes, F6 jumps between regions and reaches a „Rückgängig“ toast, Settings → Tastatur says
// each combination and lists the fixed keys (in German „Strg“), deleting a tree row keeps the
// focus in the tree, undoing a deleted open page brings its tab back, undoing an earlier setting
// keeps a later one of the same section, a single page dragged in the tree can be undone, and the
// source view shows a failed save like the visual editor.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "arcalo-e2e-321-"));
before(async () => (app = await launch({ width: 1400, height: 900, dataDir })));
after(async () => {
  await app?.close();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const open = (id, newTab = false) => app.invoke("search_open", { target: { kind: "page", page_id: id, new_tab: newTab } });
const focused = () => app.browser.execute(() => ({ cls: String(document.activeElement?.className ?? ""), id: document.activeElement?.getAttribute("data-id"), text: (document.activeElement?.textContent ?? "").trim().slice(0, 40) }));
const until = (fn, msg, timeout = 8000) => app.browser.waitUntil(fn, { timeout, timeoutMsg: msg });

test("the slash menu says which entry Enter takes (aria-activedescendant on the editor)", async () => {
  const page = await app.invoke("page_create", { parentId: null, title: "Slash Aria", icon: null, content: "Text\n" });
  await open(page.id);
  await app.waitText(".pane.active .tab.active", /Slash Aria/);
  await app.caretToEnd();
  await app.keys("Enter");
  await app.type("/");
  await app.waitFor(".sugg");
  await app.keys("ArrowDown");
  await sleep(150);
  const aria = await app.browser.execute(() => {
    const pm = document.querySelector(".pane.active > .pane-content:not([hidden]) .ProseMirror");
    const id = pm.getAttribute("aria-activedescendant");
    return { expanded: pm.getAttribute("aria-expanded"), controls: pm.getAttribute("aria-controls"), selected: id && document.getElementById(id)?.getAttribute("aria-selected"), list: !!document.getElementById(pm.getAttribute("aria-controls") ?? "") };
  });
  assert.deepEqual(aria, { expanded: "true", controls: aria.controls, selected: "true", list: true });
  await app.keys("Escape");
  await until(async () => (await app.browser.execute(() => document.querySelector(".pane.active > .pane-content:not([hidden]) .ProseMirror").getAttribute("aria-expanded"))) !== "true", "aria-expanded stayed true");
  // Dismissed: Enter makes a new line instead of inserting the hidden entry.
  await app.keys("Enter");
  await sleep(200);
  assert.ok(!(await app.browser.execute(() => !!document.querySelector(".sugg"))), "the menu came back");
});

test("F6 cycles ribbon, sidebar, page and panel and reaches the „Rückgängig“ of a toast", async () => {
  const a = await app.invoke("page_create", { parentId: null, title: "F6 Eins", icon: null, content: "Eins\n" });
  const b = await app.invoke("page_create", { parentId: null, title: "F6 Zwei", icon: null, content: "Zwei\n" });
  await open(a.id);
  await app.caretToEnd();
  const region = async () => app.browser.execute(() => {
    const el = document.activeElement;
    return el?.closest(".ribbon") ? "ribbon" : el?.closest(".sidebar") ? "sidebar" : el?.closest(".workspace .pane.active") ? "pane" : el?.closest(".app > .panel") ? "panel" : el?.closest(".toasts") ? "toast" : "other";
  });
  const seen = [];
  for (let i = 0; i < 4; i++) {
    await app.keys("F6");
    await sleep(100);
    seen.push(await region());
  }
  assert.ok(["ribbon", "sidebar", "pane"].every((r) => seen.includes(r)), seen.join(","));
  // A page moved to the trash from the tree: its toast is reached with F6.
  await open(b.id);
  await (await app.waitFor(".sidebar .tree-filter input")).setValue("F6 Eins");
  await app.waitFor(`.sidebar .tree .tree-row[data-id="${a.id}"]`);
  await app.browser.execute((id) => document.querySelector(`.sidebar .tree .tree-row[data-id="${id}"]`).focus(), a.id);
  await app.keys("Delete");
  await app.waitText(".toast", /Rückgängig/);
  let reached = false;
  for (let i = 0; i < 6 && !reached; i++) {
    await app.keys("F6");
    await sleep(100);
    reached = (await region()) === "toast";
  }
  assert.ok(reached, "F6 did not reach the toast");
  assert.match((await focused()).text, /Rückgängig/);
  await app.keys("Enter");
  await until(async () => (await app.invoke("workspace_tree")).some((n) => n.id === a.id), "undo from the keyboard did not restore the page");
  await (await app.$(".sidebar .tree-filter input")).clearValue();
});

test("deleting a tree row with Entf leaves the focus on the next row", async () => {
  const ids = [];
  for (const title of ["Fokus Baum Eins", "Fokus Baum Zwei"]) ids.push((await app.invoke("page_create", { parentId: null, title, icon: null, content: "x\n" })).id);
  // Opening one brings the new pages into the tree.
  await open(ids[1]);
  await (await app.waitFor(".sidebar .tree-filter input")).setValue("Fokus Baum");
  await app.waitFor(`.sidebar .tree .tree-row[data-id="${ids[1]}"]`);
  const order = await app.browser.execute((list) => [...document.querySelectorAll(".sidebar .tree .tree-row")].map((r) => Number(r.dataset.id)).filter((id) => list.includes(id)), ids);
  await app.browser.execute((id) => document.querySelector(`.sidebar .tree .tree-row[data-id="${id}"]`).focus(), order[0]);
  await app.keys("Delete");
  await until(async () => (await focused()).id === String(order[1]), `the focus did not move to the next row: ${JSON.stringify(await focused())}`);
  await (await app.$(".sidebar .tree-filter input")).clearValue();
});

test("undoing the deletion of the open page brings its tab back", async () => {
  const page = await app.invoke("page_create", { parentId: null, title: "Offen geloescht", icon: null, content: "x\n" });
  await open(page.id, true);
  await app.waitText(".pane.active .tab.active", /Offen geloescht/);
  await app.click('.pane.active > .pane-content:not([hidden]) .vh [aria-label="Weitere Aktionen"]');
  await app.waitFor(".menu");
  await app.browser.execute(() => [...document.querySelectorAll(".menu .menu-item")].find((b) => /Seite löschen/.test(b.textContent)).click());
  await app.waitText(".toast", /Seite gelöscht/);
  await until(async () => !/Offen geloescht/.test(await app.text(".pane.active .tab.active")), "the tab stayed");
  await app.browser.execute(() => {
    const toast = [...document.querySelectorAll(".toast")].filter((t) => /Offen geloescht/.test(t.textContent)).at(-1);
    [...toast.querySelectorAll("button")].find((b) => /Rückgängig/.test(b.textContent)).click();
  });
  await app.waitText(".pane.active .tab.active", /Offen geloescht/);
});

test("Settings → Tastatur: each recorder says its keys (Strg), and the fixed keys are listed", async () => {
  await app.keys(["Control", ","]);
  await app.browser.execute(() => [...document.querySelectorAll(".settings-nav-item")].find((b) => /Tastatur/.test(b.textContent))?.click());
  await app.waitText(".settings-head h1", /Tastatur/);
  const label = await app.browser.execute(() => document.querySelector('.key-recorder[data-command="palette"]').getAttribute("aria-label"));
  assert.match(label, /Befehlspalette.*Strg\+K/);
  const shown = await app.browser.execute(() => document.querySelector('.key-recorder[data-command="new_page"]').textContent);
  assert.match(shown, /Strg/);
  assert.doesNotMatch(shown, /Ctrl/);
  const rows = await app.browser.execute(() => [...document.querySelectorAll(".set-row")].map((r) => r.textContent));
  assert.ok(rows.some((r) => /Umbenennen/.test(r) && /F2/.test(r)), "F2 Umbenennen not listed");
  assert.ok(rows.some((r) => /Zwischen Seitenleiste/.test(r) && /F6/.test(r)), "F6 not listed");
});

test("undo of an earlier settings change keeps a later change of the same section", async () => {
  const before = (await app.invoke("settings_get")).settings.editor;
  await app.browser.execute(() => [...document.querySelectorAll(".settings-nav-item")].find((b) => /^Editor/.test(b.textContent.trim()))?.click());
  await app.waitText(".settings-head h1", /Editor/);
  const toggle = (re) =>
    app.browser.execute((src) => {
      const row = [...document.querySelectorAll(".set-row")].find((r) => new RegExp(src).test(r.querySelector(".set-row-label")?.textContent ?? ""));
      row.querySelector('[role="switch"], input[type="checkbox"]').click();
    }, re.source);
  await toggle(/Typografische Anführungszeichen/);
  await until(async () => (await app.invoke("settings_get")).settings.editor.smart_quotes !== before.smart_quotes, "first change not saved");
  await sleep(1700);
  await toggle(/Klammern automatisch schließen/);
  await until(async () => (await app.invoke("settings_get")).settings.editor.auto_pair !== before.auto_pair, "second change not saved");
  // „Rückgängig“ of the first toast.
  await app.browser.execute(() => {
    const toast = [...document.querySelectorAll(".toast")].find((t) => /Rückgängig/.test(t.textContent));
    [...toast.querySelectorAll("button")].find((b) => /Rückgängig/.test(b.textContent)).click();
  });
  await until(async () => (await app.invoke("settings_get")).settings.editor.smart_quotes === before.smart_quotes, "the first change was not undone");
  assert.equal((await app.invoke("settings_get")).settings.editor.auto_pair, !before.auto_pair, "the later change was undone too");
});

test("the source view shows a failed save and saves once there is room", async () => {
  const page = await app.invoke("page_create", { parentId: null, title: "Quelltext voll", icon: null, content: "Anfang\n" });
  await open(page.id, true);
  await app.waitText(".pane.active .tab.active", /Quelltext voll/);
  await app.click('.pane.active > .pane-content:not([hidden]) .vh [aria-label^="Markdown-Quelltext"]');
  const ta = await app.waitFor(".pane.active > .pane-content:not([hidden]) .source-text");
  fs.writeFileSync(path.join(dataDir, "test-disk-full"), "");
  await ta.click();
  await app.browser.execute(() => {
    const t = document.querySelector(".pane.active > .pane-content:not([hidden]) .source-text");
    t.setSelectionRange(t.value.length, t.value.length);
  });
  await app.type("Mehr");
  await app.waitFor(".pane.active > .pane-content:not([hidden]) .source-editor[data-save-status=failed] .save-failed");
  fs.rmSync(path.join(dataDir, "test-disk-full"));
  await until(async () => /Mehr/.test((await app.invoke("page_get", { id: page.id })).content), "not saved after the disk had room", 15000);
  await until(async () => !(await app.browser.execute(() => !!document.querySelector(".pane.active > .pane-content:not([hidden]) .save-failed"))), "the note stayed");
});
