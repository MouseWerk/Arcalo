// Editor blocks: foldable callouts, columns, the live table of contents and footnotes,
// inserted through the slash menu and saved as Obsidian-compatible Markdown.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
before(async () => (app = await launch()));
after(async () => app?.close());

const pageId = async (title) => (await app.invoke("page_resolve", { title, create: false })).id;
const content = async (title) => (await app.invoke("page_get", { id: await pageId(title) })).content;
const waitContent = (title, re, msg) => app.browser.waitUntil(async () => re.test(await content(title)), { timeout: 6000, timeoutMsg: msg ?? `content of ${title} does not match ${re}` });

/** Ctrl+N, title, Enter; then the page holds `md` and is shown. */
async function newPage(title, md) {
  await app.keys(["Control", "n"]);
  await app.browser.waitUntil(() => app.browser.execute(() => document.activeElement?.classList.contains("page-title") && document.activeElement.selectionEnd > 0));
  await app.type(title);
  await app.keys(["Enter"]);
  await app.browser.waitUntil(async () => (await app.invoke("page_resolve", { title, create: false })) !== null);
  await app.invoke("page_save", { id: await pageId(title), content: md });
  await app.browser.execute(() => window.dispatchEvent(new CustomEvent("annalo:reload-pages", { detail: {} })));
  await app.browser.waitUntil(() => app.browser.execute((t) => document.querySelector(".pane.active .ProseMirror")?.textContent.includes(t), md.split("\n")[0].replace(/^#+ /, "")));
}

/** Puts the caret at the end of the block whose text is `text`. */
async function caretAfter(text) {
  await app.browser.execute((t) => {
    const pm = document.querySelector(".pane.active .ProseMirror");
    pm.focus();
    const el = [...pm.querySelectorAll("p, h1, h2, h3, li")].find((e) => e.textContent === t);
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }, text);
  await app.browser.pause(80);
}

async function slash(query, item) {
  await app.type(query);
  await app.waitText(".sugg-item.sel", item);
  await app.keys(["Enter"]);
}

test("/Aufklappbar inserts a foldable callout; the chevron folds it and writes -/+", async () => {
  await newPage("Bausteine", "Start\n");
  await caretAfter("Start");
  await app.keys(["Enter"]);
  await app.shot("blocks-slash-menu");
  await slash("/aufklappbar", /Aufklappbar/);
  await app.type("Details");
  await app.keys(["ArrowDown"]);
  await app.type("Versteckter Inhalt");
  await waitContent("Bausteine", /^> \[!note\]\+ Details\n>\n> Versteckter Inhalt$/m);
  const quote = ".pane.active .ProseMirror blockquote.callout.is-foldable";
  await app.waitFor(`${quote} .callout-fold`);
  await app.click(`${quote} .callout-fold`);
  await waitContent("Bausteine", /^> \[!note\]- Details$/m, "folded marker not saved");
  await app.waitFor(`${quote}.is-folded`);
  const hidden = await app.browser.execute(() => [...document.querySelectorAll(".pane.active .callout-folded-rest")].every((e) => getComputedStyle(e).display === "none"));
  assert.equal(hidden, true, "content hidden while folded");
  assert.match(await app.text(`${quote}`), /Details/);
  await app.shot("blocks-callout-folded");
  await app.click(`${quote} .callout-fold`);
  await waitContent("Bausteine", /^> \[!note\]\+ Details$/m, "unfolded marker not saved");
});

test("/Spalten puts content side by side", async () => {
  await newPage("Spalten", "Start\n");
  await caretAfter("Start");
  await app.keys(["Enter"]);
  await slash("/spalten", /2 Spalten/);
  await app.type("Links");
  await app.keys(["ArrowRight"]);
  await app.type("Rechts");
  await waitContent("Spalten", /<!-- spalten -->\n\nLinks\n\n<!-- spalte -->\n\nRechts\n\n<!-- \/spalten -->/);
  const [a, b] = await app.browser.execute(() => [...document.querySelectorAll(".pane.active .columns > .column")].map((c) => c.getBoundingClientRect().toJSON()));
  assert.ok(b.left >= a.right && Math.abs(a.top - b.top) < 2, "columns side by side");
  await app.shot("blocks-columns");
});

test("/Inhaltsverzeichnis lists the headings and follows typing", async () => {
  await newPage("Inhalt", "## Eins\n\nText\n");
  await caretAfter("Text");
  await app.keys(["Enter"]);
  await slash("/inhaltsverzeichnis", /Inhaltsverzeichnis/);
  await waitContent("Inhalt", /^\[TOC\]$/m);
  const links = () => app.browser.execute(() => [...document.querySelectorAll(".pane.active .toc-block .toc-link")].map((b) => b.textContent));
  assert.deepEqual(await links(), ["Eins"]);
  await caretAfter("Text");
  await app.keys(["Enter"]);
  await app.type("### Zwei a");
  await app.browser.waitUntil(async () => JSON.stringify(await links()) === JSON.stringify(["Eins", "Zwei a"]), { timeoutMsg: "TOC did not follow typing" });
  await app.keys(["Backspace"]);
  await app.browser.waitUntil(async () => JSON.stringify(await links()) === JSON.stringify(["Eins", "Zwei"]));
  // Nested under „Eins“.
  assert.equal(await app.browser.execute(() => document.querySelectorAll(".pane.active .toc-block ul ul .toc-link").length), 1);
  await app.shot("blocks-toc");
  // A click on an entry moves the caret into that heading.
  await app.browser.execute(() => {
    const b = document.querySelector(".pane.active .toc-block .toc-link");
    b.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
  });
  await app.browser.waitUntil(() => app.browser.execute(() => window.getSelection().anchorNode?.parentElement?.closest("h2")?.textContent === "Eins"), { timeoutMsg: "caret not in heading" });
});

test("/Fußnote adds a reference and its definition; hover shows it, click jumps", async () => {
  await newPage("Fussnoten", "Ein Satz\n");
  await caretAfter("Ein Satz");
  await app.type(" ");
  await slash("/fussnote", /Fußnote/);
  await app.type("Quelle der Aussage");
  await waitContent("Fussnoten", /^Ein Satz \[\^1\]\n\n\[\^1\]: Quelle der Aussage$/m);
  await app.waitFor(".pane.active .footnotes-head");
  assert.equal(await app.text(".pane.active .footnotes-head"), "Fußnoten");
  assert.equal(await app.browser.execute(() => document.querySelector(".pane.active .footnote-ref").dataset.num), "1");
  const ref = await app.$(".pane.active .footnote-ref");
  await ref.moveTo();
  await app.waitText(".footnote-preview", /Quelle der Aussage/);
  await app.shot("blocks-footnote-hover");
  // Click: the caret goes into the definition; the back-link returns to the reference.
  await app.browser.execute(() => document.querySelector(".pane.active .footnote-ref").dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 })));
  await app.browser.waitUntil(() => app.browser.execute(() => !!window.getSelection().anchorNode?.parentElement?.closest(".footnote-def")), { timeoutMsg: "caret not in definition" });
  assert.ok(await app.browser.execute(() => !!document.querySelector(".pane.active .footnote-back")));
});

test("all blocks in light and dark, stacked in a narrow pane", async () => {
  const md = "# Übersicht\n\n[TOC]\n\n## Ziele\n\n<!-- spalten -->\n\n### Links\n\n- eins\n- zwei\n\n<!-- spalte -->\n\n### Rechts\n\nText mit Verweis[^1].\n\n<!-- /spalten -->\n\n> [!tip]+ Mehr dazu\n> Aufgeklappter Inhalt\n\n> [!warning]- Eingeklappt\n> Unsichtbar\n\n[^1]: Die Fußnote.\n";
  await newPage("Alle Bausteine", md);
  for (const theme of ["light", "dark"]) {
    const view = await app.invoke("settings_get");
    await app.invoke("settings_save", { settings: { ...view.settings, theme } });
    await app.browser.execute((t) => (document.documentElement.dataset.theme = t), theme);
    await app.shot(`blocks-all-${theme}`);
  }
  assert.equal(await content("Alle Bausteine"), md, "showing the page does not change it");
  // Split view at a small window: the pane is narrow, the columns stack.
  await app.click('.pane.active [aria-label="Weitere Aktionen"]');
  await app.waitFor(".menu");
  await app.browser.execute(() => [...document.querySelectorAll(".menu-item")].find((b) => /Rechts daneben/.test(b.textContent)).click());
  await app.browser.setWindowSize(1000, 800);
  await app.browser.waitUntil(async () => {
    const r = await app.browser.execute(() => [...document.querySelectorAll(".pane.active .columns > .column")].map((c) => c.getBoundingClientRect().toJSON()));
    return r.length === 2 && r[1].top >= r[0].bottom - 1;
  }, { timeoutMsg: "columns did not stack in a narrow pane" });
  await app.shot("blocks-narrow-pane");
  await app.browser.setWindowSize(1480, 920);
});
