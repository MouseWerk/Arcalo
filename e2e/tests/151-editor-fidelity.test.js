// 1.12 editor quality: Markdown that other tools write survives an edit unchanged (same-page and
// block links, link destinations in <…>, entities, the blank line under the frontmatter, tables with
// links and code, a task list right after a bullet list); `[[#Abschnitt]]` and `[[Seite#^id]]`
// scroll to their target; the find field brings the first match into view; the toolbar's block
// format is never cut off and every toolbar button has a name.

import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
before(async () => (app = await launch({ width: 1280, height: 800 })));
after(async () => app?.close());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const filler = Array.from({ length: 40 }, (_, i) => `Fülltext Absatz ${i + 1}.`).join("\n\n");

const SOURCE = `---
status: offen
---

# Treue

Sprung zu [[#Abschnitt zwei]] und zum Block [[Ziel 151#^blk-1]], Firma&nbsp;GmbH, [Plan](<Ordner/Mein Plan.md>).

- Punkt
- [ ] Aufgabe
- [x] erledigt

| Seite           | Code    |
| --------------- | ------- |
| [x](https://example.com/a_b) | \`a\\|b\` |

${filler}

## Abschnitt zwei

Ende.
`;
// The table as the editor writes it (columns padded to the cell text).
const EXPECTED = SOURCE.replace(
  "| Seite           | Code    |\n| --------------- | ------- |\n| [x](https://example.com/a_b) | `a\\|b` |",
  "| Seite                        | Code   |\n| ---------------------------- | ------ |\n| [x](https://example.com/a_b) | `a\\|b` |",
);

let id;
const openTree = async (title) => {
  await app.browser.waitUntil(async () => {
    for (const r of await app.$$(".sidebar .tree-row")) if ((await app.textOf(r)) === title) return (await r.click(), true);
    return false;
  }, { timeout: 8000, timeoutMsg: `no ${title} in the tree` });
};
const inView = (sel, text) =>
  app.browser.execute((s, t) => {
    const el = [...document.querySelectorAll(s)].find((e) => e.textContent.includes(t));
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const box = el.closest(".page-scroll")?.getBoundingClientRect() ?? { top: 0, bottom: innerHeight };
    return r.top >= box.top && r.bottom <= box.bottom;
  }, sel, text);

test("an edit keeps the Markdown other tools wrote", async () => {
  await app.invoke("page_create", { parentId: null, title: "Ziel 151", icon: "file-text", content: "# Ziel\n\n" + filler + "\n\nDer Block hier ^blk-1\n" });
  id = (await app.invoke("page_create", { parentId: null, title: "Treue 151", icon: "file-text", content: SOURCE })).id;
  await app.browser.execute(() => location.reload());
  await app.browser.waitUntil(async () => (await app.browser.execute(() => document.body.classList.contains("ready"))) === true, { timeout: 15000 });
  await openTree("Treue 151");
  await app.waitFor(".pane.active .ProseMirror h2");
  // The same-page link is a link (not `[[#…]]` text) and shows only the section.
  const label = await app.browser.execute(() => [...document.querySelectorAll(".pane.active .ProseMirror a.wikilink")].map((a) => a.textContent));
  assert.deepEqual(label.slice(0, 2), ["Abschnitt zwei", "Ziel 151 › ^blk-1"]);
  assert.match(await app.text(".pane.active .ProseMirror p"), /Firma GmbH/);
  await app.browser.execute(() => {
    const p = [...document.querySelectorAll(".pane.active .ProseMirror p")].find((e) => e.textContent === "Ende.");
    const r = document.createRange();
    r.selectNodeContents(p);
    r.collapse(false);
    p.closest(".ProseMirror").focus();
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  });
  await app.keys(["End"]);
  await app.type(" Neu");
  await app.browser.waitUntil(async () => (await app.invoke("page_get", { id })).content.includes("Ende. Neu"), { timeout: 5000, timeoutMsg: "not saved" });
  assert.equal((await app.invoke("page_get", { id })).content, EXPECTED.replace("Ende.\n", "Ende. Neu\n"));
});

test("[[#Abschnitt]] scrolls to the heading on the same page", async () => {
  await app.browser.execute(() => document.querySelector(".pane.active .page-scroll")?.scrollTo(0, 0));
  await sleep(200);
  assert.equal(await inView(".pane.active .ProseMirror h2", "Abschnitt zwei"), false);
  await app.click(".pane.active .ProseMirror a.wikilink");
  await app.browser.waitUntil(() => inView(".pane.active .ProseMirror h2", "Abschnitt zwei"), { timeout: 4000, timeoutMsg: "heading not shown" });
  assert.equal(await app.browser.execute(() => document.querySelector(".pane.active .ProseMirror h2").classList.contains("cite-flash")), true);
  const tabs = await app.browser.execute(() => [...document.querySelectorAll(".pane.active .tab")].map((t) => t.textContent.trim()));
  assert.deepEqual(tabs, ["Treue 151"]);
});

test("[[Seite#^id]] opens the page at that block", async () => {
  await app.browser.execute(() => document.querySelector(".pane.active .page-scroll")?.scrollTo(0, 0));
  await sleep(200);
  const links = await app.$$(".pane.active .ProseMirror a.wikilink");
  await links[1].click();
  await app.browser.waitUntil(() => inView(".pane.active .ProseMirror p", "Der Block hier"), { timeout: 6000, timeoutMsg: "block not shown" });
  const flashed = await app.browser.execute(() => document.querySelector(".pane.active .ProseMirror .cite-flash")?.textContent);
  assert.equal(flashed, "Der Block hier ^blk-1");
});

test("Alt+Enter follows the link at the caret (keyboard only)", async () => {
  await openTree("Treue 151");
  await app.waitFor(".pane.active .ProseMirror h1");
  await app.browser.execute(() => document.querySelector(".pane.active .page-scroll")?.scrollTo(0, 0));
  // Caret right after the first link: Home on its line, then past „Sprung zu “ and the link.
  await app.browser.execute(() => {
    const a = document.querySelector(".pane.active .ProseMirror a.wikilink");
    const r = document.createRange();
    r.setStartAfter(a);
    r.collapse(true);
    a.closest(".ProseMirror").focus();
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  });
  await sleep(150);
  await app.keys(["Alt", "Enter"]);
  await app.browser.waitUntil(() => inView(".pane.active .ProseMirror h2", "Abschnitt zwei"), { timeout: 4000, timeoutMsg: "Alt+Enter did not follow the link" });
  // No line break was typed.
  assert.equal(await app.browser.execute(() => document.querySelector(".pane.active .ProseMirror p").textContent.startsWith("Sprung zu Abschnitt zwei und")), true);
});

test("find brings the first match into view while typing", async () => {
  await app.browser.execute(() => document.querySelector(".pane.active .page-scroll")?.scrollTo(0, 0));
  await app.browser.execute(() => document.querySelector(".pane.active .ProseMirror").focus());
  await app.keys(["Control", "f"]);
  await app.waitFor(".find-bar input");
  await app.type("Ende. Neu");
  await app.browser.waitUntil(() => inView(".pane.active .ProseMirror p", "Ende. Neu"), { timeout: 4000, timeoutMsg: "match not scrolled into view" });
  await app.keys(["Escape"]);
});

test("toolbar: the block format is not cut off and every button has a name", async () => {
  await openTree("Treue 151");
  await app.waitFor(".pane.active .ProseMirror h1");
  await app.browser.execute(() => {
    const h = document.querySelector(".pane.active .ProseMirror h1");
    const r = document.createRange();
    r.selectNodeContents(h);
    r.collapse(true);
    h.closest(".ProseMirror").focus();
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  });
  await app.browser.waitUntil(async () => /Überschrift 1/.test(await app.browser.execute(() => document.querySelector(".pane.active .tb-select")?.textContent ?? "")), { timeout: 3000 });
  const cut = await app.browser.execute(() => {
    const v = [...document.querySelectorAll(".pane.active .tb-select .select-value > span")].find((s) => s.getClientRects().length && !s.classList.contains("select-sizer"));
    return v ? v.scrollWidth - v.clientWidth : -1;
  });
  assert.equal(cut, 0);
  const unnamed = await app.browser.execute(() =>
    [...document.querySelectorAll(".pane.active .editor-toolbar button")].filter((b) => b.getClientRects().length && !(b.getAttribute("aria-label") || b.getAttribute("aria-labelledby") || b.innerText.trim())).map((b) => b.className),
  );
  assert.deepEqual(unnamed, []);
});
