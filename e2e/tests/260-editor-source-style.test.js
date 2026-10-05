// 1.13 editor: a page keeps the author's Markdown (an edit changes only the edited line, also in
// a file written by other tools); hovering [[Seite#Abschnitt]], [[Seite#^id]] or [[#Abschnitt]]
// previews that section, not the page top; the HTML export links sections inside the file.

import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
before(async () => (app = await launch({ width: 1280, height: 800 })));
after(async () => app?.close());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Markdown as other tools write it: every block in a style the editor would not choose itself.
const SOURCE = `Stil 260
========

Ein Absatz mit _Betonung_, __Fett__ und einem [Verweis][doku].
Zweite Zeile direkt darunter.

* Punkt eins
* Punkt zwei
    * tiefer

1) erstens
2) zweitens

- [ ] Aufgabe
\t- [ ] Teilaufgabe

~~~js
const x = 1;
~~~

***

| A | B |
|---|---|
| 1 | 2 |


Letzter Absatz.

[doku]: https://example.com/doku
`;

const filler = Array.from({ length: 30 }, (_, i) => `Oben Fülltext ${i + 1}.`).join("\n\n");
const TARGET = `# Ziel 260\n\nSeitenanfang mit Einleitung.\n\n${filler}\n\n## Zweiter Abschnitt\n\nInhalt des zweiten Abschnitts.\n\n## Dritter\n\nDrittes.\n\nEin besonderer Block. ^b260\n`;
const LINKS = `# Quelle 260\n\nSiehe [[Ziel 260#Zweiter Abschnitt]], [[Ziel 260#^b260]] und [[#Unten]].\n\n${filler}\n\n## Unten\n\nText ganz unten auf dieser Seite.\n`;

const ids = {};
const openTree = async (title) => {
  await app.browser.waitUntil(async () => {
    for (const r of await app.$$(".sidebar .tree-row")) if ((await app.textOf(r)) === title) return (await r.click(), true);
    return false;
  }, { timeout: 8000, timeoutMsg: `no ${title} in the tree` });
};
const reload = async () => {
  await app.browser.execute(() => location.reload());
  await app.browser.waitUntil(async () => (await app.browser.execute(() => document.body.classList.contains("ready"))) === true, { timeout: 15000 });
};

test("an edit changes only the edited line of a page written elsewhere", async () => {
  ids.style = (await app.invoke("page_create", { parentId: null, title: "Stil 260", icon: "file-text", content: SOURCE })).id;
  ids.target = (await app.invoke("page_create", { parentId: null, title: "Ziel 260", icon: "file-text", content: TARGET })).id;
  ids.links = (await app.invoke("page_create", { parentId: null, title: "Quelle 260", icon: "file-text", content: LINKS })).id;
  await reload();
  await openTree("Stil 260");
  await app.waitFor(".pane.active .ProseMirror pre");
  await app.shot("260-source-style");
  // Typing at the end of the last paragraph.
  await app.browser.execute(() => {
    const p = [...document.querySelectorAll(".pane.active .ProseMirror p")].find((e) => e.textContent === "Letzter Absatz.");
    const r = document.createRange();
    r.selectNodeContents(p);
    r.collapse(false);
    p.closest(".ProseMirror").focus();
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  });
  await app.type(" Neu");
  await app.browser.waitUntil(async () => (await app.invoke("page_get", { id: ids.style })).content.includes("Absatz. Neu"), { timeout: 5000, timeoutMsg: "not saved" });
  assert.equal((await app.invoke("page_get", { id: ids.style })).content, SOURCE.replace("Letzter Absatz.", "Letzter Absatz. Neu"));
  // An edited list keeps its markers.
  await app.browser.execute(() => {
    const li = [...document.querySelectorAll(".pane.active .ProseMirror li p")].find((e) => e.textContent === "Punkt zwei");
    const r = document.createRange();
    r.selectNodeContents(li);
    r.collapse(false);
    li.closest(".ProseMirror").focus();
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  });
  await app.type("!");
  await app.browser.waitUntil(async () => (await app.invoke("page_get", { id: ids.style })).content.includes("Punkt zwei!"), { timeout: 5000, timeoutMsg: "not saved" });
  assert.equal((await app.invoke("page_get", { id: ids.style })).content, SOURCE.replace("Letzter Absatz.", "Letzter Absatz. Neu").replace("* Punkt zwei", "* Punkt zwei!"));
});

/** Hovers the n-th wiki link of the active page and waits for its card. */
async function hover(n) {
  await app.browser.execute(() => document.querySelector(".pane.active .page-scroll")?.scrollTo(0, 0));
  await app.browser.execute(() => document.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
  await sleep(300);
  const links = await app.$$(".pane.active .ProseMirror a.wikilink");
  await (await app.$(".pane.active .ProseMirror h1")).moveTo();
  await sleep(300);
  await links[n].moveTo();
  await app.waitFor(".link-preview .link-preview-title");
  await sleep(250);
  return {
    title: await app.textOf(await app.$(".link-preview-title")),
    body: await app.textOf(await app.$(".link-preview-body")),
  };
}

test("hovering [[Seite#Abschnitt]] previews that section", async () => {
  await openTree("Quelle 260");
  await app.waitFor(".pane.active .ProseMirror a.wikilink");
  const card = await hover(0);
  assert.match(card.title, /Ziel 260\s*›\s*Zweiter Abschnitt/);
  assert.match(card.body, /Inhalt des zweiten Abschnitts/);
  assert.doesNotMatch(card.body, /Seitenanfang|Drittes/);
  await app.shot("260-preview-section");
});

test("hovering [[Seite#^id]] previews the block, [[#Abschnitt]] the section of this page", async () => {
  const block = await hover(1);
  assert.match(block.title, /Ziel 260\s*›\s*\^b260/);
  assert.match(block.body, /Ein besonderer Block/);
  assert.doesNotMatch(block.body, /Seitenanfang/);
  const here = await hover(2);
  assert.match(here.title, /Quelle 260\s*›\s*Unten/);
  assert.match(here.body, /Text ganz unten/);
  // The card's title opens the page at the section.
  await (await app.$(".link-preview-title")).click();
  await app.browser.waitUntil(
    () =>
      app.browser.execute(() => {
        const h = [...document.querySelectorAll(".pane.active .ProseMirror h2")].find((e) => e.textContent === "Unten");
        const r = h?.getBoundingClientRect();
        const box = h?.closest(".page-scroll")?.getBoundingClientRect();
        return !!r && r.top >= box.top && r.bottom <= box.bottom;
      }),
    { timeout: 5000, timeoutMsg: "section not shown" },
  );
});

test("a missing section previews the page top with a hint", async () => {
  await app.invoke("page_save", { id: ids.links, content: LINKS.replace("[[#Unten]]", "[[Ziel 260#Gibt es nicht]]") });
  await reload();
  await openTree("Quelle 260");
  await app.waitFor(".pane.active .ProseMirror a.wikilink");
  const card = await hover(2);
  assert.match(card.body, /Seitenanfang/);
  assert.match(await app.textOf(await app.$(".link-preview-note")), /Gibt es nicht/);
  await app.shot("260-preview-missing");
});

test("the HTML export links sections inside the file", async () => {
  await app.invoke("page_save", { id: ids.target, content: `${TARGET}\nZurück zu [[#Zweiter Abschnitt]] und [[#^b260]].\n` });
  const out = path.join(app.dataDir, "export", "Ziel 260.html");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await app.browser.execute((id, p) => window.dispatchEvent(new CustomEvent("annalo:share-html", { detail: { id, withChildren: false, path: p } })), ids.target, out);
  await app.browser.waitUntil(() => fs.existsSync(out), { timeout: 8000, timeoutMsg: "no export" });
  const html = fs.readFileSync(out, "utf8");
  const page = `page-${ids.target}`;
  assert.match(html, new RegExp(`<h2 id="${page}-zweiter-abschnitt">`));
  assert.match(html, new RegExp(`<p id="${page}-block-b260">Ein besonderer Block\\.</p>`));
  assert.match(html, new RegExp(`<a class="wikilink" href="#${page}-zweiter-abschnitt">Zweiter Abschnitt</a>`));
  assert.match(html, new RegExp(`<a class="wikilink" href="#${page}-block-b260">\\^b260</a>`));
});
