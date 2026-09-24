// Smart paste (spreadsheet rows, a stack trace, a URL with its page title, undo to plain text)
// through synthetic paste events, and sharing a page as one self-contained HTML file.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
let server;
before(async () => {
  app = await launch();
  // A local page for the link title (no internet needed).
  server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end('<html><head><meta property="og:title" content="Projektwiki &amp; Handbuch"><title>x</title></head><body></body></html>');
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
});
after(async () => {
  await app?.close();
  server?.close();
});

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGM4YWMDRAwQCgAlPgUBdJmUYAAAAABJRU5ErkJggg==";
const pageId = async (title) => (await app.invoke("page_resolve", { title, create: false })).id;
const content = async (title) => (await app.invoke("page_get", { id: await pageId(title) })).content;
const waitContent = (title, re, msg) => app.browser.waitUntil(async () => re.test(await content(title)), { timeout: 8000, timeoutMsg: msg ?? `content of ${title} does not match ${re}` });

/**
 * The native save dialog cannot be driven here: after checking the menu entries, the export runs
 * through the same code with the path given (`annalo:share-html`, what the menu entry does after the dialog).
 */
async function share(title, withChildren, file) {
  await app.browser.execute((id, w, p) => window.dispatchEvent(new CustomEvent("annalo:share-html", { detail: { id, withChildren: w, path: p } })), await pageId(title), withChildren, file);
  await app.browser.waitUntil(() => fs.existsSync(file), { timeout: 10000, timeoutMsg: "HTML file not written" });
}

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

/** Caret at the end of the block with text `text`, then Enter for a fresh line. */
async function freshLineAfter(text) {
  await app.browser.execute((t) => {
    const pm = document.querySelector(".pane.active .ProseMirror");
    pm.focus();
    const el = [...pm.querySelectorAll("p, h1, h2, li")].find((e) => e.textContent === t);
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
  }, text);
  await app.browser.pause(80);
  await app.keys(["End"]);
  await app.keys(["Enter"]);
}

/** Dispatches a paste event carrying `text` (and `html`) on the active editor, like Ctrl+V. */
async function paste(text, html = "") {
  return app.browser.execute(
    (t, h) => {
      const dt = new DataTransfer();
      dt.setData("text/plain", t);
      if (h) dt.setData("text/html", h);
      let ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
      // Some engines drop `clipboardData` from the constructor.
      if (!ev.clipboardData) {
        ev = new Event("paste", { bubbles: true, cancelable: true });
        Object.defineProperty(ev, "clipboardData", { value: dt });
      }
      document.querySelector(".pane.active .ProseMirror").dispatchEvent(ev);
      return ev.defaultPrevented;
    },
    text,
    html,
  );
}

test("pasting Excel rows makes a table with a header row", async () => {
  await newPage("Einfuegen", "Start\n");
  await freshLineAfter("Start");
  const handled = await paste("Name\tStunden\tStatus\r\nAnna\t2,5\toffen\r\nBen\t4\terledigt\r\n", "<table><tr><td>Name</td><td>Stunden</td><td>Status</td></tr></table>");
  assert.equal(handled, true, "smart paste handled the event");
  await app.waitFor(".pane.active .ProseMirror table");
  assert.deepEqual(
    await app.browser.execute(() => [...document.querySelectorAll(".pane.active .ProseMirror table tr:first-child th")].map((c) => c.textContent)),
    ["Name", "Stunden", "Status"],
  );
  await waitContent("Einfuegen", /^\| Name +\| Stunden +\| Status +\|$/m);
  assert.match(await content("Einfuegen"), /^\| Ben +\| 4 +\| erledigt +\|$/m);
  await app.waitText(".paste-hint", /Als Text einfügen/);
  await app.shot("paste-table");
});

test("pasting a stack trace makes a code block; „Als Text einfügen“ undoes it", async () => {
  await newPage("Fehler", "Log\n");
  await freshLineAfter("Log");
  const trace = 'Exception in thread "main" java.lang.IllegalStateException: kaputt\n\tat com.firma.App.run(App.java:42)\n\tat com.firma.App.main(App.java:10)';
  await paste(trace);
  await app.waitFor(".pane.active .ProseMirror pre code");
  await waitContent("Fehler", /^```java\nException in thread "main"/m);
  await app.waitText(".paste-hint", /Als Text einfügen/);
  await app.shot("paste-stacktrace");
  await app.browser.execute(() => document.querySelector(".paste-hint").dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })));
  await app.browser.waitUntil(() => app.browser.execute(() => !document.querySelector(".pane.active .ProseMirror pre")), { timeoutMsg: "code block not undone" });
  await waitContent("Fehler", /^Exception in thread "main" java\.lang\.IllegalStateException: kaputt$/m, "plain text not pasted");
  await app.browser.waitUntil(async () => !/```/.test(await content("Fehler")), { timeoutMsg: "code block still saved" });
});

test("pasting a URL gives the link the page title", async () => {
  await newPage("Links", "Quellen\n");
  await freshLineAfter("Quellen");
  const url = `http://127.0.0.1:${server.address().port}/wiki`;
  await paste(url);
  await waitContent("Links", new RegExp(`^\\[Projektwiki & Handbuch\\]\\(${url.replace(/[./]/g, "\\$&")}\\)$`, "m"), "title not fetched");
  // Plain prose stays prose (the normal paste: paragraphs).
  await app.keys(["End"]);
  await app.keys(["Enter"]);
  await paste("Ein ganz normaler Satz.\nUnd noch einer.");
  await waitContent("Links", /^Ein ganz normaler Satz\.\n\nUnd noch einer\.$/m);
  assert.doesNotMatch(await content("Links"), /```|\| |^- /m);
});

test("a page is shared as one self-contained HTML file", async () => {
  const img = await app.invoke("attachment_save", { data: PNG, name: "Diagramm.png", mime: "image/png" });
  const md = `# Bericht\n\n[TOC]\n\n## Stand\n\nSiehe [[Architektur]] und https://example.com/doku, Quelle[^1].\n\n![[${img.name}]]\n\n> [!note]- Details\n> Versteckt\n\n[^1]: Die Quelle.\n`;
  await newPage("Bericht", md);
  const out = path.join(app.dataDir, "export", "Bericht.html");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  // The native save dialog cannot be driven: answer it with the path.
  await app.click('.pane.active [aria-label="Weitere Aktionen"]');
  await app.waitFor(".menu");
  const labels = await app.browser.execute(() => [...document.querySelectorAll(".menu-item")].map((b) => b.textContent.trim()));
  assert.ok(labels.includes("Als HTML-Datei teilen…"), labels.join(", "));
  assert.ok(!labels.some((l) => /Mit Unterseiten/.test(l)), "no subpages yet");
  await app.shot("share-menu");
  await app.keys(["Escape"]);
  await share("Bericht", false, out);
  await app.waitText(".toast-title", /HTML-Datei gespeichert/);
  const html = fs.readFileSync(out, "utf8");
  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, /<title>Bericht<\/title>/);
  assert.match(html, /<img src="data:image\/png;base64,[A-Za-z0-9+/=]+"/, "image inlined");
  assert.match(html, /Erstellt mit Annalo/);
  assert.match(html, /<details class="callout callout-note"><summary>/);
  assert.match(html, /<sup class="fn-ref">/);
  assert.match(html, /<nav class="toc"/);
  // Nothing is loaded from elsewhere: every src is a data URI, the only http(s) href is the content link.
  const srcs = [...html.matchAll(/\ssrc="([^"]*)"/g)].map((m) => m[1]);
  assert.ok(srcs.length >= 1 && srcs.every((s) => s.startsWith("data:")), `external src: ${srcs.filter((s) => !s.startsWith("data:"))}`);
  const hrefs = [...html.matchAll(/\shref="(https?:[^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(hrefs, ["https://example.com/doku"]);
  assert.doesNotMatch(html, /<script|<link |@import|url\(/i);
  // [[Architektur]] is not in the file: plain text.
  assert.match(html, /<span class="wikilink">Architektur<\/span>/);
  fs.copyFileSync(out, path.join(process.env.ANNALO_SHOTS ?? path.join(import.meta.dirname, "../screenshots"), "share-export.html"));
});

test("with subpages: one file with a table of contents and links between the pages", async () => {
  const parent = await pageId("Bericht");
  const child = await app.invoke("page_create", { title: "Anhang A", parentId: parent });
  await app.invoke("page_save", { id: child.id, content: "Zurück zum [[Bericht]].\n" });
  await app.browser.refresh();
  await app.browser.waitUntil(async () => (await app.browser.execute(() => document.body.classList.contains("ready"))) === true, { timeout: 20000 });
  const out = path.join(app.dataDir, "export", "Bericht mit Unterseiten.html");
  await app.browser.execute(() => [...document.querySelectorAll(".sidebar .tree-row")].find((r) => r.innerText.trim() === "Bericht").click());
  await app.waitText(".pane.active .tab.active .tab-title", /Bericht/);
  await app.click('.pane.active [aria-label="Weitere Aktionen"]');
  await app.waitFor(".menu");
  const labels = await app.browser.execute(() => [...document.querySelectorAll(".menu-item")].map((b) => b.textContent.trim()));
  assert.ok(labels.includes("Mit Unterseiten als HTML teilen…"), labels.join(", "));
  await app.keys(["Escape"]);
  await share("Bericht", true, out);
  const html = fs.readFileSync(out, "utf8");
  assert.match(html, /<nav class="doc-toc"[^>]*><h2>Inhalt<\/h2><ol><li[^>]*><a href="#page-\d+">Bericht<\/a><\/li><li[^>]*><a href="#page-\d+">Anhang A<\/a>/);
  assert.match(html, new RegExp(`<a class="wikilink" href="#page-${parent}">Bericht</a>`));
});
