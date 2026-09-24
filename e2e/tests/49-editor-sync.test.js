// 1.4 stabilization: nothing typed gets lost or lands in the wrong place. Switching between
// the visual editor and the Markdown source right after typing, two panes (visual or source)
// on the same page, dialogs keeping the focus, „Als Text einfügen“ after typing, shortcuts
// that belong to the text field, and Markdown the editor has no block for (raw HTML,
// comments, long code fences) surviving an edit.

import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
before(async () => (app = await launch()));
after(async () => app?.close());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const openTree = async (title) => {
  for (const r of await app.$$(".sidebar .tree-row")) if ((await app.textOf(r)) === title) return r.click();
  throw new Error(`no ${title}`);
};
const pageId = async (title, create = false) => (await app.invoke("page_resolve", { title, create })).id;
const content = async (title) => (await app.invoke("page_get", { id: await pageId(title) })).content;
const reload = async () => {
  await app.browser.execute(() => location.reload());
  await app.browser.waitUntil(async () => (await app.browser.execute(() => document.body.classList.contains("ready"))) === true, { timeout: 15000 });
  await sleep(500);
};
const splitRight = async () => {
  await app.browser.execute(() => document.querySelector(".pane.active .vh [aria-label='Weitere Aktionen']").click());
  await app.waitFor(".menu");
  await app.browser.execute(() => [...document.querySelectorAll(".menu [role=menuitem], .menu button")].find((b) => /Rechts daneben/.test(b.textContent))?.click());
  await app.browser.waitUntil(async () => (await app.$$(".workspace > .pane .ProseMirror")).length === 2, { timeoutMsg: "no split" });
};
const closeSplit = async () => {
  while ((await app.$$(".workspace > .pane")).length > 1) {
    await app.browser.execute(() => {
      const panes = document.querySelectorAll(".workspace > .pane");
      panes[panes.length - 1].querySelector(".tab.active [aria-label^='Schließen'], .tab.active .tab-close")?.click();
    });
    await sleep(300);
  }
};

test("visual → source right after typing shows the typed text, and back; nothing is lost", async () => {
  await openTree("Architektur");
  await app.waitFor(".pane.active .ProseMirror h2");
  await app.caretToEnd();
  await app.keys(["Enter"]);
  await app.type("RICHWORT1");
  // No pause: the switch comes while the autosave is still waiting.
  await app.keys(["Control", "Shift", "m"]);
  const ta = await app.waitFor(".pane.active .source-text");
  await app.browser.waitUntil(async () => (await ta.getValue()).includes("RICHWORT1"), { timeout: 3000, timeoutMsg: "source editor shows an old state" });
  // Typed in the source, switched back at once.
  await app.browser.execute(() => {
    const t = document.querySelector(".pane.active .source-text");
    t.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    setter.call(t, t.value + "\n\nSRCWORT2\n");
    t.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await app.keys(["Control", "Shift", "m"]);
  await app.waitFor(".pane.active .ProseMirror");
  await app.browser.waitUntil(async () => (await app.text(".pane.active .ProseMirror")).includes("SRCWORT2"), { timeout: 3000, timeoutMsg: "visual editor shows an old state" });
  await app.shot("sync-source-switch");
  // Typing afterwards keeps both earlier edits.
  await app.caretToEnd();
  await app.keys(["Enter"]);
  await app.type("LATER3");
  await sleep(1500);
  const stored = await content("Architektur");
  for (const w of ["RICHWORT1", "SRCWORT2", "LATER3"]) assert.ok(stored.includes(w), `${w} lost: ${stored.slice(-200)}`);
  // Real keystrokes in the source, switched back at once (well before its autosave).
  await app.keys(["Control", "Shift", "m"]);
  await app.waitFor(".pane.active .source-text");
  await app.browser.execute(() => {
    const t = document.querySelector(".pane.active .source-text");
    t.focus();
    t.setSelectionRange(t.value.length, t.value.length);
  });
  await app.keys(["Enter"]);
  await app.type("SRCKEYS4");
  await app.keys(["Control", "Shift", "m"]);
  await app.waitFor(".pane.active .ProseMirror");
  await app.browser.waitUntil(async () => (await app.text(".pane.active .ProseMirror")).includes("SRCKEYS4"), { timeout: 3000, timeoutMsg: "keys typed in the source are missing" });
  assert.ok((await content("Architektur")).includes("SRCKEYS4"), "not saved");
});

test("two panes on the same page: alternating typing keeps every edit", async () => {
  const id = await pageId("Zwei Fenster", true);
  await reload();
  await openTree("Zwei Fenster");
  await app.waitFor(".pane.active .ProseMirror");
  await splitRight();
  const typeIn = async (i, text) => {
    await app.browser.execute((i) => {
      const pm = document.querySelectorAll(".workspace > .pane")[i].querySelector(".ProseMirror");
      pm.focus();
      const sel = window.getSelection();
      const r = document.createRange();
      r.selectNodeContents(pm.lastElementChild ?? pm);
      r.collapse(false);
      sel.removeAllRanges();
      sel.addRange(r);
    }, i);
    await sleep(80);
    await app.keys(["End", "Enter"]);
    await app.type(text);
  };
  await typeIn(0, "AAA1");
  await typeIn(1, "BBB1");
  await typeIn(0, "AAA2");
  await typeIn(1, "BBB2");
  await sleep(2500);
  const c = (await app.invoke("page_get", { id })).content;
  for (const w of ["AAA1", "BBB1", "AAA2", "BBB2"]) assert.ok(c.includes(w), `${w} lost: ${JSON.stringify(c)}`);
  // Both panes end up showing everything.
  const texts = await app.browser.execute(() => [...document.querySelectorAll(".workspace > .pane .ProseMirror")].map((p) => p.innerText));
  for (const t of texts) for (const w of ["AAA1", "BBB1", "AAA2", "BBB2"]) assert.ok(t.includes(w), `pane misses ${w}: ${JSON.stringify(t)}`);
});

test("two panes in source mode: quick alternating edits keep both", async () => {
  const id = await pageId("Zwei Fenster");
  await app.keys(["Control", "Shift", "m"]);
  await app.browser.waitUntil(async () => (await app.$$(".workspace > .pane .source-text")).length === 2, { timeoutMsg: "no source" });
  const typeSrc = async (i, text) => {
    await app.browser.execute((i) => {
      const t = document.querySelectorAll(".workspace > .pane")[i].querySelector(".source-text");
      t.focus();
      t.setSelectionRange(t.value.length, t.value.length);
    }, i);
    await app.keys(["Enter"]);
    await app.type(text);
  };
  await typeSrc(0, "XXX");
  await typeSrc(1, "YYY");
  await typeSrc(0, "ZZZ");
  await sleep(2500);
  const c = (await app.invoke("page_get", { id })).content;
  for (const w of ["XXX", "YYY", "ZZZ"]) assert.ok(c.includes(w), `${w} lost: ${JSON.stringify(c)}`);
  const vals = await app.browser.execute(() => [...document.querySelectorAll(".source-text")].map((t) => t.value));
  for (const v of vals) for (const w of ["XXX", "YYY", "ZZZ"]) assert.ok(v.includes(w), `pane misses ${w}`);
  await app.shot("sync-two-source-panes");
  await app.keys(["Control", "Shift", "m"]);
  await app.browser.waitUntil(async () => (await app.$$(".workspace > .pane .ProseMirror")).length === 2, { timeoutMsg: "no visual editor" });
  await closeSplit();
});

test("a dialog keeps the focus while typing (template search in insert mode)", async () => {
  const root = await app.invoke("templates_root");
  for (const t of ["Vorlage A1", "Vorlage B2", "Vorlage C3"]) await app.invoke("page_create", { title: t, parentId: root.id, icon: "file-text" }).catch(() => {});
  await pageId("Notizzettel", true);
  await reload();
  await openTree("Notizzettel");
  await app.waitFor(".pane.active .ProseMirror");
  await app.caretToEnd();
  await app.type("/vorlage");
  await app.waitText(".sugg-item.sel", /Vorlage einfügen/);
  await app.keys(["Enter"]);
  const input = await app.waitFor('input[aria-label="Vorlage suchen"]');
  await sleep(400);
  await app.browser.execute(() => {
    window.__focusMoves = [];
    document.addEventListener("focusin", (e) => window.__focusMoves.push(e.target.getAttribute("aria-label") || e.target.className || e.target.tagName), true);
  });
  await app.browser.keys("vorlage b");
  await sleep(400);
  assert.equal(await input.getValue(), "vorlage b");
  assert.deepEqual(await app.browser.execute(() => window.__focusMoves), [], "focus left the search field while typing");
  await app.keys(["Escape"]);
  await sleep(800);
  assert.ok(!(await content("Notizzettel")).includes("vorlage b"), "keystrokes landed in the note");
});

test("Ctrl+F while typing in the command palette does not open the note search", async () => {
  await pageId("Notizzettel", true);
  await reload();
  await openTree("Notizzettel");
  await app.waitFor(".pane.active .ProseMirror");
  await app.caretToEnd();
  await app.keys(["Control", "k"]);
  await app.waitFor(".palette input");
  await app.type("Arch");
  await app.keys(["Control", "f"]);
  await sleep(300);
  assert.equal((await app.$$('.find-bar input[aria-label="In Seite suchen"]')).length, 0, "note search opened behind the palette");
  await app.keys(["Escape"]);
  await sleep(300);
  // In the note itself Ctrl+F still opens it.
  await app.caretToEnd();
  await app.keys(["Control", "f"]);
  await app.waitFor('.find-bar input[aria-label="In Seite suchen"]');
  await app.keys(["Escape"]);
});

test("Alt+← in the editor moves the caret, it does not go back in the history", async () => {
  await pageId("Notizzettel", true);
  await reload();
  await openTree("Architektur");
  await app.waitFor(".pane.active .ProseMirror h2");
  await openTree("Notizzettel");
  await app.waitFor(".pane.active .ProseMirror");
  await app.caretToEnd();
  await app.keys(["Alt", "ArrowLeft"]);
  await sleep(400);
  assert.equal(await app.text(".pane.active .tab.active"), "Notizzettel", "went back while typing");
  // Outside of text fields it still goes back.
  await app.browser.execute(() => document.activeElement?.blur());
  await app.keys(["Alt", "ArrowLeft"]);
  await app.waitText(".pane.active .tab.active", /Architektur/);
});

test("„Als Text einfügen“ right after typing keeps the typed text", async () => {
  const p = await app.invoke("page_resolve", { title: "Einfügen", create: true });
  await app.invoke("page_save", { id: p.id, content: "Start\n" });
  await reload();
  await openTree("Einfügen");
  await app.waitFor(".pane.active .ProseMirror");
  await app.caretToEnd();
  await app.keys(["Enter"]);
  // Typing and pasting in one go, like typing and then Ctrl+V.
  await app.browser.execute(() => {
    const pm = document.querySelector(".pane.active .ProseMirror");
    pm.focus();
    document.execCommand("insertText", false, "Getippt: ");
    const dt = new DataTransfer();
    dt.setData("text/plain", "Name\tStunden\r\nAnna\t2,5\r\n");
    let ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    if (!ev.clipboardData) {
      ev = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(ev, "clipboardData", { value: dt });
    }
    pm.dispatchEvent(ev);
  });
  await app.waitText(".paste-hint", /Als Text einfügen/);
  await app.browser.execute(() => document.querySelector(".paste-hint").dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })));
  await sleep(1500);
  const c = (await app.invoke("page_get", { id: p.id })).content;
  assert.ok(c.includes("Getippt: "), `typed text lost: ${JSON.stringify(c)}`);
  assert.ok(c.includes("Stunden"), "pasted text missing");
  assert.ok(!c.includes("| Name"), "still a table");
});

test("raw HTML, comments, long code fences, empty tasks and \\#tags survive an edit", async () => {
  const md =
    "Text mit <kbd>Strg</kbd> und a<b und c>d.\n\n<!-- Kommentar -->\n\n<details>\n<summary>Mehr</summary>\n\nInhalt\n\n</details>\n\n````md\n```\ninnen\n```\n````\n\n- [ ] \n- [ ] offen\n\nKein \\#tag hier\n\n<!-- spalten -->\n\nLinks\n\n<!-- spalte -->\n\nRechts\n\n<!-- /spalten -->\n";
  const p = await app.invoke("page_resolve", { title: "Rohes HTML", create: true });
  await app.invoke("page_save", { id: p.id, content: md });
  await reload();
  await openTree("Rohes HTML");
  await app.waitFor(".pane.active .ProseMirror .md-html");
  // Shown as source text, never rendered.
  assert.equal(await app.browser.execute(() => document.querySelectorAll(".pane.active .ProseMirror kbd, .pane.active .ProseMirror details").length), 0);
  await app.shot("sync-raw-html");
  await app.browser.execute(() => {
    const pm = document.querySelector(".pane.active .ProseMirror");
    pm.focus();
    const r = document.createRange();
    r.setStart(pm.querySelector("p").firstChild, 4);
    r.collapse(true);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  });
  await app.type("X");
  await sleep(1500);
  const c = (await app.invoke("page_get", { id: p.id })).content;
  assert.equal(c, md.replace("Text mit", "TextX mit"));
});
