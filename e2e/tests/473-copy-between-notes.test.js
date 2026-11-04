// q124 round 2, H1: mixed content (lists with tasks, a table, code with tabs, a callout, a quote,
// links, text in other scripts) copied or cut from one note and pasted into another arrives as the
// same Markdown, and pasted back where it was cut gives the first note again. (A line break inside
// a paragraph comes back as a hard break, `  ` at the line's end: R2A low in r2-editor-export.md.)

import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
before(async () => (app = await launch({ width: 1280, height: 860 })));
after(async () => app?.close());

const ED = ".pane.active > .pane-content:not([hidden]) .ProseMirror";
const stored = async (id) => (await app.invoke("page_get", { id })).content;

const BODY = [
  "- Punkt mit **fett** und [[Seite]]",
  "  - verschachtelt",
  "- [ ] Aufgabe due:2026-12-01",
  "- [x] erledigt",
  "",
  "1. eins",
  "2. zwei",
  "",
  "| A   | B        |",
  "| --- | -------- |",
  "| 1   | `x \\| y` |",
  "",
  "```go",
  "func main() {",
  "\tif x {",
  "\t\treturn",
  "\t}",
  "}",
  "```",
  "",
  "> [!note] Hinweis",
  ">",
  "> Text im Callout",
  "",
  "> Ein Zitat",

  "",
  "שלום עולם · 中文 · é",
  "",
].join("\n");

async function openPage(title, md) {
  const id = (await app.invoke("page_create", { parentId: null, title, icon: "file-text", content: md })).id;
  await app.invoke("search_open", { target: { kind: "page", page_id: id, new_tab: false } });
  await app.browser.waitUntil(() => app.browser.execute((sel, t) => document.querySelector(".pane.active > .pane-content:not([hidden]) .page-title")?.value === t && !!document.querySelector(sel), ED, title), { timeout: 8000 });
  return id;
}

/** Selects everything after the first heading and fires `copy` or `cut`; the clipboard's types. */
async function copyBody(kind) {
  return app.browser.execute(
    (sel, k) => {
      const ed = document.querySelector(sel).editor;
      const first = ed.state.doc.firstChild;
      ed.commands.focus();
      ed.commands.setTextSelection({ from: first.nodeSize, to: ed.state.doc.content.size });
      const dt = new DataTransfer();
      let ev = new ClipboardEvent(k, { clipboardData: dt, bubbles: true, cancelable: true });
      if (!ev.clipboardData) {
        ev = new Event(k, { bubbles: true, cancelable: true });
        Object.defineProperty(ev, "clipboardData", { value: dt });
      }
      ed.view.dom.dispatchEvent(ev);
      window.__clip = { text: dt.getData("text/plain"), html: dt.getData("text/html") };

      return { text: window.__clip.text.length, html: window.__clip.html.length };
    },
    ED,
    kind,
  );
}

/** Pastes the clipboard taken by `copyBody` at the end of the open note. */
async function pasteAtEnd() {
  await app.browser.execute((sel) => {
    const ed = document.querySelector(sel).editor;
    ed.commands.focus("end");
    const dt = new DataTransfer();
    dt.setData("text/plain", window.__clip.text);
    if (window.__clip.html) dt.setData("text/html", window.__clip.html);
    let ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    if (!ev.clipboardData) {
      ev = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(ev, "clipboardData", { value: dt });
    }
    ed.view.dom.dispatchEvent(ev);
  }, ED);
}

let source;
let target;

test("copied mixed content pastes into another note as the same Markdown", async () => {
  source = await openPage("Quelle", `# Quelle\n\n${BODY}`);
  const sizes = await copyBody("copy");
  assert.ok(sizes.text > 0 && sizes.html > 0, `clipboard ${JSON.stringify(sizes)}`);
  target = await openPage("Ziel", "# Ziel\n");
  await pasteAtEnd();
  await app.browser.waitUntil(async () => (await stored(target)).includes("Text im Callout"), { timeout: 8000, timeoutMsg: "paste not saved" });
  await app.browser.pause(900);
  assert.equal(await stored(target), `# Ziel\n\n${BODY}`);
});

test("cut and pasted back gives the first note again", async () => {
  await app.invoke("search_open", { target: { kind: "page", page_id: source, new_tab: false } });
  await app.browser.waitUntil(() => app.browser.execute(() => document.querySelector(".pane.active > .pane-content:not([hidden]) .page-title")?.value === "Quelle"), { timeout: 8000 });
  await copyBody("cut");
  await app.browser.waitUntil(async () => !(await stored(source)).includes("Text im Callout"), { timeout: 8000, timeoutMsg: "cut not saved" });
  await pasteAtEnd();
  await app.browser.waitUntil(async () => (await stored(source)).includes("Text im Callout"), { timeout: 8000, timeoutMsg: "paste not saved" });
  await app.browser.pause(900);
  assert.equal(await stored(source), `# Quelle\n\n${BODY}`);
});

test("no console errors", async () => {
  assert.deepEqual(await app.consoleErrors(), []);
});
