// Typing inside the drawing editor (q123): Excalidraw renders its dialogs (Mermaid, command
// palette, help) into a container on <body>, outside the overlay; the overlay's modal key guard
// used to drop every key there, so nothing could be typed into the Mermaid field. Also the other
// inputs (text on the canvas, link, color hex, font search, canvas search, frame name), the
// shortcuts in both directions, undo/redo, copy/paste, links and the preview after reopening.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
let pageId;
let name;
const NOTE = "Notiz mit Zeichnung";

const content = async () => (await app.invoke("page_get", { id: pageId })).content;
const elements = async () => JSON.parse(await app.invoke("drawing_read", { name })).elements.filter((e) => !e.isDeleted);
const overlayOpen = async () => (await app.$$(".drawing-overlay")).length > 0;
const value = (sel) => app.browser.execute((s) => document.querySelector(s)?.value ?? null, sel);
const focused = (sel) => app.browser.execute((s) => !!document.activeElement?.matches(s), sel);
/** Waits until the saved scene satisfies `check` (the editor saves 800 ms after the last change). */
const saved = (check, msg) => app.browser.waitUntil(async () => check(await elements()), { timeout: 10000, timeoutMsg: msg });

async function pointer(actions) {
  const canvas = await app.$(".drawing-overlay canvas.excalidraw__canvas.interactive");
  await app.browser.performActions([{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions: actions.map((a) => (a.type === "pointerMove" ? { origin: canvas, ...a } : a)) }]);
  await app.browser.releaseActions();
}
const drag = (x1, y1, x2, y2) =>
  pointer([
    { type: "pointerMove", x: x1, y: y1 },
    { type: "pointerDown", button: 0 },
    { type: "pointerMove", x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2), duration: 100 },
    { type: "pointerMove", x: x2, y: y2, duration: 100 },
    { type: "pointerUp", button: 0 },
  ]);
const clickAt = (x, y) => pointer([{ type: "pointerMove", x, y }, { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }]);

async function openEditor() {
  await app.click(".pane.active > .pane-content:not([hidden]) .drawing-embed");
  await app.waitFor(".drawing-overlay canvas.excalidraw__canvas.interactive", 20000);
  await app.browser.waitUntil(() => app.browser.execute(() => document.querySelector(".drawing-overlay").contains(document.activeElement)), { timeoutMsg: "focus not in the drawing" });
}
async function closeEditor() {
  await app.click(".drawing-done");
  await app.browser.waitUntil(async () => !(await overlayOpen()), { timeoutMsg: "overlay did not close" });
}
/** Clicks the first visible element matching `sel` whose text matches `pattern`. */
const clickText = (sel, pattern) =>
  app.browser.execute(
    (s, src) => {
      const re = new RegExp(src);
      const el = [...document.querySelectorAll(s)].find((e) => e.getClientRects().length && re.test(e.textContent));
      el?.click();
      return !!el;
    },
    sel,
    pattern.source,
  );

before(async () => {
  app = await launch();
  ({ name } = await app.invoke("drawing_create", { title: "Eingaben" }));
  pageId = (await app.invoke("page_create", { parentId: null, title: NOTE, icon: null, content: `Vorher\n\n![[${name}]]\n` })).id;
  await app.invoke("search_open", { target: { kind: "page", page_id: pageId, new_tab: false } });
  await app.waitFor(".pane.active > .pane-content:not([hidden]) .drawing-embed");
});
after(async () => app?.close());

test("the Mermaid dialog takes typing and inserts the diagram", async () => {
  await openEditor();
  await app.click(".drawing-overlay .App-toolbar__extra-tools-trigger");
  assert.ok(await app.browser.waitUntil(() => clickText(".drawing-overlay .dropdown-menu-item", /Mermaid/), { timeoutMsg: "no Mermaid item" }));
  await app.waitFor(".ttd-dialog-input");
  await app.browser.waitUntil(() => focused(".ttd-dialog-input"), { timeoutMsg: "Mermaid field not focused" });
  // Replace the example with typed text: every key reaches the field.
  await app.keys(["Control", "a"]);
  await app.keys(["Backspace"]);
  await app.type("flowchart LR");
  await app.keys(["Enter"]);
  await app.type("A[Start] --> B[Ziel]");
  assert.equal(await value(".ttd-dialog-input"), "flowchart LR\nA[Start] --> B[Ziel]");
  assert.ok(await focused(".ttd-dialog-input"), "the field keeps the focus while typing");
  // App shortcuts stay quiet in the dialog too.
  await app.keys(["Control", "k"]);
  await app.browser.pause(300);
  assert.equal((await app.$$(".palette")).length, 0, "the app's palette opened over the drawing");
  // The preview renders (mermaid-to-excalidraw under the app's CSP).
  await app.browser.waitUntil(() => app.browser.execute(() => !!document.querySelector(".ttd-dialog-output-canvas-container canvas")), { timeout: 15000, timeoutMsg: "no Mermaid preview" });
  assert.equal(await app.browser.execute(() => document.querySelector("[data-testid=ttd-dialog-output-error]")?.textContent ?? ""), "");
  await app.shot("412-mermaid-dialog");
  // Ctrl+Enter inserts the diagram and closes the dialog; the editor stays open.
  await app.keys(["Control", "Enter"]);
  await app.browser.waitUntil(async () => (await app.$$(".ttd-dialog-input")).length === 0, { timeoutMsg: "dialog still open" });
  assert.ok(await overlayOpen());
  await saved((els) => ["Start", "Ziel"].every((t) => els.some((e) => e.type === "text" && e.text === t)) && els.some((e) => e.type === "arrow"), "Mermaid diagram not saved");
  assert.equal(await content(), `Vorher\n\n![[${name}]]\n`, "the note behind did not change");
});

test("Esc in the Mermaid dialog closes only the dialog", async () => {
  await app.click(".drawing-overlay .App-toolbar__extra-tools-trigger");
  await app.browser.waitUntil(() => clickText(".drawing-overlay .dropdown-menu-item", /Mermaid/), { timeoutMsg: "no Mermaid item" });
  await app.waitFor(".ttd-dialog-input");
  await app.keys(["Escape"]);
  await app.browser.waitUntil(async () => (await app.$$(".ttd-dialog-input")).length === 0, { timeoutMsg: "dialog still open" });
  assert.ok(await overlayOpen(), "Esc closed the whole editor");
});

test("links in Excalidraw's dialogs open in the browser, the app stays", async () => {
  const before = app.opened().length;
  await app.click(".drawing-overlay .App-toolbar__extra-tools-trigger");
  await app.browser.waitUntil(() => clickText(".drawing-overlay .dropdown-menu-item", /Mermaid/), { timeoutMsg: "no Mermaid item" });
  await app.waitFor(".ttd-dialog-desc a");
  await app.click(".ttd-dialog-desc a");
  await app.browser.waitUntil(async () => app.opened().length > before, { timeout: 8000, timeoutMsg: "link not handed to the browser" });
  assert.match(app.opened().at(-1), /mermaid\.js\.org/);
  assert.ok(await app.browser.execute(() => location.protocol !== "https:" && !!document.querySelector(".drawing-overlay")), "the window navigated away");
  await app.keys(["Escape"]);
  await app.browser.waitUntil(async () => (await app.$$(".ttd-dialog-input")).length === 0);
});

test("Excalidraw's help (a dialog on <body>): its links open outside, Esc closes only the help", async () => {
  await app.browser.execute(() => document.querySelector(".drawing-overlay .excalidraw")?.focus());
  await app.keys(["?"]);
  await app.waitFor(".HelpDialog a.HelpDialog__btn");
  const before = app.opened().length;
  await app.click(".HelpDialog a.HelpDialog__btn");
  await app.browser.waitUntil(async () => app.opened().length > before, { timeout: 8000, timeoutMsg: "help link not handed to the browser" });
  assert.match(app.opened().at(-1), /^https:\/\//);
  assert.ok(await app.browser.execute(() => !!document.querySelector(".drawing-overlay")), "the window navigated away");
  await app.keys(["Escape"]);
  await app.browser.waitUntil(async () => (await app.$$(".HelpDialog")).length === 0, { timeoutMsg: "help still open" });
  assert.ok(await overlayOpen(), "Esc closed the whole editor");
});

test("text on the canvas, link, color hex, font search, canvas search and frame names take typing", async () => {
  await app.browser.execute(() => document.querySelector(".drawing-overlay .excalidraw")?.focus());
  // Text tool on the canvas.
  await app.keys(["t"]);
  await clickAt(-200, 200);
  await app.waitFor(".drawing-overlay textarea.excalidraw-wysiwyg");
  await app.type("Notiz äöü");
  await app.keys(["Escape"]);
  await saved((els) => els.some((e) => e.type === "text" && e.text === "Notiz äöü"), "canvas text not saved");

  // The new text is selected: font search in the font picker.
  await app.click(".drawing-overlay [data-testid=font-family-show-fonts]");
  await app.waitFor(".QuickSearch__input");
  await app.browser.execute(() => document.querySelector(".QuickSearch__input").focus());
  await app.type("nunito");
  assert.equal(await value(".QuickSearch__input"), "nunito");
  await app.keys(["Escape"]);

  // Stroke color as hex.
  await app.click(".drawing-overlay .color-picker__button.active-color");
  await app.waitFor(".drawing-overlay input.color-picker-input");
  await app.browser.execute(() => {
    const i = document.querySelector(".drawing-overlay input.color-picker-input");
    i.focus();
    i.select();
  });
  await app.type("c2255c");
  assert.equal(await value(".drawing-overlay input.color-picker-input"), "c2255c");
  await app.keys(["Escape"]);
  await saved((els) => els.some((e) => e.type === "text" && e.strokeColor === "#c2255c"), "hex color not applied");

  // Link of the selected shape (Ctrl+K is Excalidraw's here, not the app's palette).
  await app.browser.execute(() => document.querySelector(".drawing-overlay .excalidraw")?.focus());
  await app.keys(["Control", "k"]);
  await app.waitFor(".drawing-overlay .excalidraw-hyperlinkContainer-input");
  assert.equal((await app.$$(".palette")).length, 0);
  await app.type("https://example.org/plan");
  await app.keys(["Enter"]);
  await saved((els) => els.some((e) => e.type === "text" && e.link === "https://example.org/plan"), "link not saved");
  const before = app.opened().length;
  await app.waitFor(".drawing-overlay a.excalidraw-hyperlinkContainer-link");
  await app.click(".drawing-overlay a.excalidraw-hyperlinkContainer-link");
  await app.browser.waitUntil(async () => app.opened().length > before, { timeout: 8000, timeoutMsg: "shape link not handed to the browser" });
  assert.equal(app.opened().at(-1), "https://example.org/plan");
  assert.ok(await overlayOpen());

  // Search on the canvas (Ctrl+F is Excalidraw's here).
  await app.browser.execute(() => document.querySelector(".drawing-overlay .excalidraw")?.focus());
  await app.keys(["Control", "f"]);
  await app.waitFor(".drawing-overlay .layer-ui__search input");
  await app.browser.waitUntil(() => focused(".drawing-overlay .layer-ui__search input"), { timeoutMsg: "search not focused" });
  await app.type("Ziel");
  assert.equal(await value(".drawing-overlay .layer-ui__search input"), "Ziel");
  await app.waitText(".drawing-overlay .layer-ui__search", /\b1\b/);
  // Esc in a field of the editor never closes the whole editor.
  await app.keys(["Escape"]);
  await app.browser.pause(250);
  assert.ok(await overlayOpen(), "Esc in the search closed the editor");

  // Frame: draw one, rename it by double-clicking its name; Esc ends the renaming only.
  await app.browser.execute(() => document.querySelector(".drawing-overlay .excalidraw")?.focus());
  await app.keys(["f"]);
  await drag(150, -250, 330, -120);
  await saved((els) => els.some((e) => e.type === "frame"), "frame not saved");
  const frameName = '.drawing-overlay [id*="-frame-name-"]';
  const nameEl = await app.waitFor(frameName);
  await nameEl.doubleClick();
  await app.waitFor(`${frameName} input`);
  await app.browser.waitUntil(() => focused(`${frameName} input`), { timeoutMsg: "frame name not focused" });
  await app.browser.execute((s) => document.querySelector(s).select(), `${frameName} input`);
  await app.type("Bereich");
  assert.equal(await value(`${frameName} input`), "Bereich");
  await app.keys(["Escape"]);
  await app.browser.pause(250);
  assert.ok(await overlayOpen(), "Esc in the frame name closed the editor");
  await saved((els) => els.some((e) => e.type === "frame" && e.name === "Bereich"), "frame name not saved");
  assert.equal(await content(), `Vorher\n\n![[${name}]]\n`, "the note behind did not change");
  await app.shot("412-drawing-inputs");
});

test("undo/redo and copy/paste work inside the drawing, the note stays", async () => {
  await app.browser.execute(() => document.querySelector(".drawing-overlay .excalidraw")?.focus());
  const count = (await elements()).length;
  await app.keys(["r"]);
  await drag(-300, -250, -200, -180);
  await saved((els) => els.length === count + 1, "rectangle not saved");
  await app.keys(["Control", "z"]);
  await saved((els) => els.length === count, "undo did not remove the rectangle");
  await app.keys(["Control", "Shift", "z"]);
  await saved((els) => els.length === count + 1, "redo did not bring it back");
  // The rectangle is selected after redo: copy and paste it.
  await app.keys(["Control", "c"]);
  await app.keys(["Control", "v"]);
  await saved((els) => els.filter((e) => e.type === "rectangle").length >= 2 && els.length === count + 2, "paste did not add a copy");
  // App shortcuts do not fire (Ctrl+N would add a page), the note keeps its text.
  const pages = async () => {
    const count = (nodes) => nodes.reduce((n, x) => n + 1 + count(x.children ?? []), 0);
    return count(await app.invoke("workspace_tree"));
  };
  const before = await pages();
  await app.keys(["Control", "n"]);
  await app.browser.pause(400);
  assert.ok(await overlayOpen());
  assert.equal(await pages(), before, "Ctrl+N added a page");
  assert.equal(await content(), `Vorher\n\n![[${name}]]\n`);
});

test("after closing, the note shows the new preview; reopening keeps everything", async () => {
  await closeEditor();
  const img = await app.waitFor(".pane.active > .pane-content:not([hidden]) .drawing-embed img.drawing-preview");
  await app.browser.waitUntil(() => app.browser.execute((el) => el.complete && el.naturalWidth > 0, img), { timeoutMsg: "preview did not load" });
  const n = (await elements()).length;
  await openEditor();
  await app.browser.pause(300);
  assert.equal((await elements()).length, n, "reopening changed the drawing");
  await app.keys(["Escape"]);
  await app.browser.waitUntil(async () => !(await overlayOpen()), { timeoutMsg: "Esc did not close" });
  assert.deepEqual(await app.consoleErrors(), []);
});

test("Mermaid in a note: slash menu, typing with live preview, errors and back", async () => {
  const id = (await app.invoke("page_create", { parentId: null, title: "Diagramm-Notiz", icon: null, content: "Ablauf\n" })).id;
  await app.invoke("search_open", { target: { kind: "page", page_id: id, new_tab: false } });
  await app.browser.waitUntil(async () => (await app.browser.execute(() => document.querySelector(".pane.active > .pane-content:not([hidden]) .page-title")?.value)) === "Diagramm-Notiz");
  await app.caretToEnd();
  await app.keys(["Enter"]);
  await app.type("/mermaid");
  await app.waitText(".sugg-item.sel", /Mermaid/);
  await app.keys(["Enter"]);
  const preview = ".pane.active > .pane-content:not([hidden]) .rich-preview.mmd";
  const state = () => app.browser.execute((s) => document.querySelector(s)?.dataset.state, preview);
  const svgText = () => app.browser.execute((s) => document.querySelector(`${s} .mmd-view svg`)?.textContent ?? "", preview);
  await app.browser.waitUntil(async () => (await state()) === "ready", { timeout: 15000, timeoutMsg: "starter diagram not rendered" });
  assert.match(await svgText(), /Idee/);
  // The caret is in the source: typing updates the preview live.
  assert.ok(await app.browser.execute(() => document.querySelector(".pane.active > .pane-content:not([hidden]) pre.rich-src")?.classList.contains("is-editing")), "source not shown after inserting");
  await app.keys(["Enter"]);
  await app.type("  C --> D[Neu]");
  await app.browser.waitUntil(async () => /Neu/.test(await svgText()), { timeout: 10000, timeoutMsg: "preview did not follow the typing" });
  // A broken line shows the error with the source; removing it brings the diagram back.
  await app.keys(["Enter"]);
  await app.type("  E -->");
  await app.browser.waitUntil(async () => (await state()) === "error", { timeout: 10000, timeoutMsg: "no error for broken source" });
  for (let i = 0; i < "  E -->".length + 1; i++) await app.keys(["Backspace"]);
  await app.browser.waitUntil(async () => (await state()) === "ready" && /Neu/.test(await svgText()), { timeout: 10000, timeoutMsg: "diagram did not come back" });
  await app.browser.waitUntil(async () => /```mermaid\nflowchart LR\n {2}A\[Idee\] --> B\[Plan\] --> C\[Fertig\]\n {2}C --> D\[Neu\]\n```/.test((await app.invoke("page_get", { id })).content), {
    timeout: 8000,
    timeoutMsg: "Markdown not saved",
  });
  await app.shot("412-mermaid-note");
  assert.deepEqual(await app.consoleErrors(), []);
});
