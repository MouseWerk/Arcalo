// 1.16 keyboard and tab logic: shortcuts and the mouse's back button wait behind an open dialog
// (and act on the palette only to switch it), a destructive confirmation starts on „Abbrechen“
// and is announced with its text, closing the palette gives the focus back, switching tabs keeps
// a note's scroll position, caret and undo history and a view's filter, the outline follows the
// page shown (also in the source view), Escape that closes a popup keeps the focus mode, and an
// Enter that finishes an input-method composition does not submit.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
before(async () => (app = await launch({ width: 1400, height: 900 })));
after(async () => app?.close());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const open = (id, newTab = false) => app.invoke("search_open", { target: { kind: "page", page_id: id, new_tab: newTab } });
const tabCount = () => app.browser.execute(() => document.querySelectorAll(".pane.active .tab").length);
const activeTitle = () => app.browser.execute(() => document.querySelector(".pane.active .tab.active .tab-title")?.textContent ?? "");
const focused = () => app.browser.execute(() => {
  const el = document.activeElement;
  return { tag: el?.tagName, cls: String(el?.className ?? ""), text: (el?.textContent ?? "").trim().slice(0, 40) };
});
/** Shows the tab whose title matches, as a click on it does. */
const showTab = (re) =>
  app.browser.execute((src) => [...document.querySelectorAll(".pane.active .tab")].find((t) => new RegExp(src).test(t.textContent)).dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 })), re.source);
const scroller = () => app.browser.execute(() => document.querySelector(".pane.active .pane-content:not([hidden]) .page-scroll")?.scrollTop ?? -1);

test("behind a confirmation no shortcut runs; it starts on „Abbrechen“ and is an alertdialog with its text", async () => {
  const parent = await app.invoke("page_create", { parentId: null, title: "Dialog Eltern", icon: null, content: "x\n" });
  await app.invoke("page_create", { parentId: parent.id, title: "Dialog Kind", icon: null, content: "y\n" });
  const other = await app.invoke("page_create", { parentId: null, title: "Dialog Andere", icon: null, content: "z\n" });
  await open(other.id);
  await open(parent.id, true);
  await app.waitText(".pane.active .tab.active", /Dialog Eltern/);
  const before = await tabCount();
  await app.click('.pane.active > .pane-content:not([hidden]) .vh [aria-label="Weitere Aktionen"]');
  await app.waitFor(".menu");
  await app.browser.execute(() => [...document.querySelectorAll(".menu .menu-item")].find((b) => /Seite löschen/.test(b.textContent)).click());
  await app.waitFor(".dialog");
  // The safe answer has the focus; the dialog says what happens.
  await app.browser.waitUntil(async () => /Abbrechen/.test((await focused()).text), { timeoutMsg: "the focus is not on „Abbrechen“" });
  const aria = await app.browser.execute(() => {
    const d = document.querySelector(".dialog");
    const desc = document.getElementById(d.getAttribute("aria-describedby") ?? "");
    const label = document.getElementById(d.getAttribute("aria-labelledby") ?? "");
    return { role: d.getAttribute("role"), desc: desc?.textContent ?? "", label: label?.tagName ?? "" };
  });
  assert.equal(aria.role, "alertdialog");
  assert.match(aria.desc, /Papierkorb/);
  assert.equal(aria.label, "H2");
  // Ctrl+W, Ctrl+N, Ctrl+T and the mouse's back button do nothing behind it.
  await app.keys(["Control", "w"]);
  await app.keys(["Control", "n"]);
  await app.keys(["Control", "t"]);
  await app.browser.execute(() => window.dispatchEvent(new MouseEvent("mouseup", { button: 3, bubbles: true })));
  await sleep(400);
  assert.equal(await tabCount(), before, "a tab was closed or opened behind the dialog");
  assert.match(await activeTitle(), /Dialog Eltern/);
  assert.ok(!(await app.invoke("workspace_tree")).some((n) => n.title === "Unbenannt"), "Ctrl+N created a page behind the dialog");
  // Enter on the focused „Abbrechen“ keeps the page.
  await app.keys("Enter");
  await app.browser.waitUntil(async () => !(await app.browser.execute(() => !!document.querySelector(".dialog"))), { timeoutMsg: "Enter did not close the dialog" });
  assert.ok((await app.invoke("workspace_tree")).some((n) => n.id === parent.id), "Enter deleted the page");
  // Without the dialog Ctrl+W closes the tab again.
  await app.keys(["Control", "w"]);
  await app.browser.waitUntil(async () => (await tabCount()) === before - 1, { timeoutMsg: "Ctrl+W did not close the tab afterwards" });
});

test("over the palette Ctrl+W does not close the tab; closing the palette gives the editor its focus back", async () => {
  const page = await app.invoke("page_create", { parentId: null, title: "Fokus zurück", icon: null, content: "Erste Zeile\n\nZweite Zeile\n" });
  await open(page.id);
  await app.waitText(".pane.active .tab.active", /Fokus zurück/);
  await app.caretToEnd();
  const before = await tabCount();
  await app.keys(["Control", "k"]);
  await app.waitFor(".palette input");
  await app.keys(["Control", "w"]);
  await sleep(300);
  assert.equal(await tabCount(), before, "Ctrl+W closed the tab under the palette");
  await app.keys("Escape");
  await app.browser.waitUntil(async () => (await focused()).cls.includes("ProseMirror"), { timeoutMsg: "the focus did not go back to the editor" });
  // Typing goes on where the caret was.
  await app.type("!");
  await app.browser.waitUntil(async () => /Zweite Zeile!/.test(await app.text(".pane.active > .pane-content:not([hidden]) .ProseMirror")), { timeoutMsg: "the caret was not kept" });
});

test("switching tabs keeps scroll position, undo history and a view's filter", async () => {
  const long = Array.from({ length: 160 }, (_, i) => `Absatz ${i + 1} mit etwas Text, damit die Seite lang wird.`).join("\n\n");
  const a = await app.invoke("page_create", { parentId: null, title: "Lange Seite A", icon: null, content: `${long}\n` });
  const b = await app.invoke("page_create", { parentId: null, title: "Seite B", icon: null, content: "Kurz\n" });
  await open(a.id, true);
  await app.waitText(".pane.active .tab.active", /Lange Seite A/);
  await app.waitFor(".pane.active > .pane-content:not([hidden]) .ProseMirror");
  await app.browser.execute(() => (document.querySelector(".pane.active > .pane-content:not([hidden]) .page-scroll").scrollTop = 3000));
  await sleep(200);
  const at = await scroller();
  assert.ok(at > 2000, `not scrolled: ${at}`);
  await open(b.id, true);
  await app.waitText(".pane.active .tab.active", /Seite B/);
  await showTab(/Lange Seite A/);
  await app.waitText(".pane.active .tab.active", /Lange Seite A/);
  await sleep(200);
  assert.ok(Math.abs((await scroller()) - at) <= 24, `scroll position lost: ${await scroller()} instead of ${at}`);
  // Typing, a switch and back: Ctrl+Z still takes the typing back.
  await app.caretToEnd();
  await app.type(" Zusatz");
  await app.browser.waitUntil(async () => /Zusatz/.test(await app.text(".pane.active > .pane-content:not([hidden]) .ProseMirror")));
  await showTab(/Seite B/);
  await app.waitText(".pane.active .tab.active", /Seite B/);
  await showTab(/Lange Seite A/);
  await app.waitText(".pane.active .tab.active", /Lange Seite A/);
  await app.browser.execute(() => document.querySelector(".pane.active > .pane-content:not([hidden]) .ProseMirror").focus());
  await app.keys(["Control", "z"]);
  await app.browser.waitUntil(async () => !/Zusatz/.test(await app.text(".pane.active > .pane-content:not([hidden]) .ProseMirror")), { timeoutMsg: "the undo history was lost by switching tabs" });
  // A view's filter: Aufgaben „Erledigt“ survives a switch.
  await app.keys(["Control", "Shift", "a"]);
  await app.waitFor(".pane.active > .pane-content:not([hidden]) .tasks-view [role=radio]");
  await app.browser.execute(() => [...document.querySelectorAll(".pane.active > .pane-content:not([hidden]) .tasks-view [role=radio]")].find((x) => /Erledigt/.test(x.textContent))?.click());
  await sleep(300);
  const chosen = () => app.browser.execute(() => [...document.querySelectorAll(".pane.active .pane-content:not([hidden]) .tasks-view [role=radio]")].filter((x) => x.getAttribute("aria-checked") === "true").map((x) => x.textContent.trim()).join("|"));
  assert.match(await chosen(), /Erledigt/, "„Erledigt“ was not chosen");
  await showTab(/Seite B/);
  await sleep(200);
  await showTab(/Aufgaben/);
  await app.waitFor(".pane.active .pane-content:not([hidden]) .tasks-view");
  assert.match(await chosen(), /Erledigt/, "the filter fell back after a tab switch");
});

test("the outline shows the shown page's headings, also in the source view", async () => {
  const a = await app.invoke("page_create", { parentId: null, title: "Gliederung A", icon: null, content: "# Alpha\n\nText\n\n## Beta\n\nText\n" });
  const b = await app.invoke("page_create", { parentId: null, title: "Gliederung B", icon: null, content: "# Gamma\n\nText\n" });
  await open(a.id, true);
  await app.waitFor(".pane.active > .pane-content:not([hidden]) .ProseMirror h2");
  // The outline tab of the side panel.
  await app.browser.execute(() => {
    if (!document.querySelector(".app > .panel")) document.querySelector('.tabbar [aria-label^="Seitenpanel"]')?.click();
  });
  await app.waitFor(".panel");
  await app.click("#panel-tab-outline");
  await app.waitText(".panel .outline", /Alpha/);
  await open(b.id, true);
  await app.waitText(".pane.active .tab.active", /Gliederung B/);
  await app.click('.pane.active > .pane-content:not([hidden]) .vh [aria-label^="Markdown-Quelltext"]');
  await app.waitFor(".pane.active > .pane-content:not([hidden]) .source-text");
  await app.browser.waitUntil(async () => /Gamma/.test(await app.text(".panel .outline-panel")), { timeoutMsg: "the outline did not follow to the source view" });
  assert.doesNotMatch(await app.text(".panel .outline-panel"), /Alpha|Beta/);
});

test("Escape that closes the slash menu keeps the focus mode; a second Escape ends it", async () => {
  const page = await app.invoke("page_create", { parentId: null, title: "Fokusmodus Escape", icon: null, content: "Text\n" });
  await open(page.id);
  await app.waitText(".pane.active .tab.active", /Fokusmodus Escape/);
  await app.caretToEnd();
  await app.keys(["Control", "."]);
  await app.browser.waitUntil(async () => app.browser.execute(() => document.querySelector(".app").classList.contains("focus")), { timeoutMsg: "no focus mode" });
  await app.keys("Enter");
  await app.type("/");
  await app.waitFor(".sugg");
  await app.keys("Escape");
  await sleep(300);
  assert.ok(await app.browser.execute(() => document.querySelector(".app").classList.contains("focus")), "Escape on the menu ended the focus mode");
  await app.keys("Escape");
  await app.browser.waitUntil(async () => !(await app.browser.execute(() => document.querySelector(".app").classList.contains("focus"))), { timeoutMsg: "the second Escape did not end it" });
});

test("an Enter that finishes a composition (keyCode 229) neither commits the title nor the tree rename", async () => {
  const page = await app.invoke("page_create", { parentId: null, title: "Komposition", icon: null, content: "Text\n" });
  await open(page.id);
  await app.waitFor(".pane.active > .pane-content:not([hidden]) .page-title");
  const composingEnter = (sel) =>
    app.browser.execute((s) => {
      const el = document.querySelector(s);
      el.focus();
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 229, bubbles: true, cancelable: true }));
      return document.activeElement === el;
    }, sel);
  assert.equal(await composingEnter(".pane.active > .pane-content:not([hidden]) .page-title"), true, "the title lost the focus on a composing Enter");
  // Tree rename (F2): the field stays open.
  // The tree may only draw the rows in view: filter it down to the page.
  await (await app.waitFor(".sidebar .tree-filter input")).setValue("Komposition");
  await app.waitFor(`.sidebar .tree .tree-row[data-id="${page.id}"]`);
  await app.browser.execute((id) => document.querySelector(`.sidebar .tree .tree-row[data-id="${id}"]`).focus(), page.id);
  await app.keys("F2");
  await app.waitFor(".sidebar .tree input");
  assert.equal(await composingEnter(".sidebar .tree input"), true, "the rename closed on a composing Enter");
  await app.keys("Escape");
});
