// Loose ends of 1.4 (1.4.1): `[[Angebot.pdf]]` links are file links (icon, opens the file, never a
// page to create, not unresolved), file errors name the file and its folder, code on slides is
// highlighted like in the editor (light colors on the white Beamer slide of a dark theme), and
// tabs grow to show long titles while there is room.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
before(async () => (app = await launch()));
after(async () => app?.close());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errorOf = (p) => p.then(() => "", (e) => String(e).replace(/^Error: /, ""));

/** A small valid one-page PDF. */
function makePdf(text) {
  const stream = `BT /F1 24 Tf 72 640 Td (${text}) Tj ET`;
  const objs = [
    null,
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [4 0 R] /Count 1 >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let out = "%PDF-1.4\n";
  const offsets = [];
  for (let i = 1; i < objs.length; i++) {
    offsets[i] = out.length;
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** `attachment_store` with the raw bytes, like the drop handler. */
async function store(name, bytes) {
  const r = await app.browser.executeAsync(
    (n, b64, done) => {
      const data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      window.__TAURI_INTERNALS__
        .invoke("attachment_store", data, { headers: { "x-annalo-name": encodeURIComponent(n) } })
        .then((ok) => done({ ok }), (err) => done({ err: String(err) }));
    },
    name,
    Buffer.from(bytes).toString("base64"),
  );
  if (r.err) throw new Error(r.err);
  return r.ok;
}

async function openPage(title, content) {
  const page = await app.invoke("page_create", { parentId: null, title, icon: null, content });
  await app.invoke("search_open", { target: { kind: "page", page_id: page.id, new_tab: true } });
  await app.browser.waitUntil(async () => (await (await app.$(".pane.active .page-title")).getValue()) === title, { timeoutMsg: `${title} not open` });
  await app.waitFor(".pane.active .ProseMirror");
  return page;
}

const menuClick = (label) =>
  app.browser.execute((l) => {
    const item = [...document.querySelectorAll(".menu-item, [role=menuitem]")].find((b) => b.textContent.trim().startsWith(l));
    item?.click();
    return !!item;
  }, label);

test("[[file.ext]] links show and open the file; a missing one is a missing file, not a page to create", async () => {
  await store("Angebot.pdf", makePdf("Angebot Annalo"));
  await store("Daten.xlsx", Buffer.from("PK fake xlsx"));
  const pagesBefore = (await app.invoke("workspace_tree")).length;
  const page = await openPage("Dateiverweise", "Angebot: [[Angebot.pdf]], Tabelle: [[Ordner/Daten.xlsx|die Daten]], fehlt: [[Fehlt.docx]] und [[Neue Seite E2E]].\n");
  await app.browser.waitUntil(async () => (await app.$$(".pane.active .ProseMirror .wikilink.file-link")).length === 3, { timeoutMsg: "file links not rendered" });
  await app.browser.waitUntil(async () => (await app.$$(".pane.active .wikilink.file-link.is-missing")).length === 1, { timeoutMsg: "missing file not marked" });
  const links = await app.browser.execute(() =>
    [...document.querySelectorAll(".pane.active .ProseMirror a[data-wikilink]")].map((a) => ({ cls: a.className, file: a.dataset.fileLink ?? null, text: a.innerText.trim(), icon: !!a.querySelector(".file-link-icon svg") })),
  );
  assert.deepEqual(links, [
    { cls: "wikilink file-link", file: "Angebot.pdf", text: "Angebot.pdf", icon: true },
    { cls: "wikilink file-link", file: "Daten.xlsx", text: "die Daten", icon: true },
    { cls: "wikilink file-link is-missing", file: "Fehlt.docx", text: "Fehlt.docx", icon: true },
    { cls: "wikilink unresolved", file: null, text: "Neue Seite E2E", icon: false },
  ]);
  // Only the page link counts as unresolved (the core's page_save and page_get agree).
  const saved = await app.invoke("page_save", { id: page.id, content: (await app.invoke("page_get", { id: page.id })).content });
  assert.deepEqual(saved.unresolved_links, ["Neue Seite E2E"]);
  assert.deepEqual((await app.invoke("page_get", { id: page.id })).unresolved_links, ["Neue Seite E2E"]);
  // The linked files count as used in the attachment manager.
  const files = (await app.invoke("attachments_list")).files;
  assert.ok(files.find((f) => f.name === "Angebot.pdf")?.used_in.some((u) => u.id === page.id), "Angebot.pdf used by the page");

  // Links panel: files under „Anhänge“, only the page under „Ausgehende Links“.
  await app.browser.execute(() => {
    if (!document.querySelector(".app > .panel")) document.querySelector(".workspace > .pane:last-child .tabbar > button:last-of-type").click();
  });
  await app.click('.panel-tab[title="Verknüpfungen"]');
  await app.waitText(".links-panel h3", /Anhänge/i);
  const panel = await app.browser.execute(() => {
    const out = {};
    let cur = "";
    for (const el of document.querySelector(".links-panel").children) {
      if (el.tagName === "H3") cur = el.firstChild.textContent.trim();
      else if (el.classList.contains("link-row")) (out[cur] ??= []).push(el.querySelector(".link-row-text > span").textContent);
    }
    return out;
  });
  assert.deepEqual(panel["Ausgehende Links"], ["Neue Seite E2E"]);
  assert.deepEqual(panel["Anhänge"], ["Angebot.pdf", "Daten.xlsx", "Fehlt.docx"]);
  await app.shot("61-file-links");

  // Hovering a file link previews no page.
  const pdfLink = await app.$('.pane.active .wikilink.file-link[data-file-link="Angebot.pdf"]');
  await pdfLink.moveTo();
  await sleep(900);
  assert.equal(await (await app.$(".link-preview")).isExisting(), false, "no page preview for a file");

  // A click on the PDF link opens the viewer, like a PDF card.
  await pdfLink.click();
  await app.waitFor(".pdf-overlay .pdf-page canvas", 20000);
  await app.waitText(".pdf-overlay .pdf-page-count", /\/ 1/);
  await app.keys(["Escape"]);
  await app.browser.waitUntil(async () => !(await (await app.$(".pdf-overlay")).isExisting()), { timeoutMsg: "viewer not closed" });

  // A click on the missing file names file and folder; no page is created.
  await app.dismissToasts();
  await (await app.$('.pane.active .wikilink.file-link[data-file-link="Fehlt.docx"]')).click();
  const missing = path.join(app.dataDir, "attachments", "Fehlt.docx");
  await app.waitText(".toast-danger .toast-detail", new RegExp(`^Datei nicht gefunden: ${missing.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}$`));
  await app.shot("61-missing-file-toast");
  assert.equal((await app.invoke("workspace_tree")).length, pagesBefore + 1, "no page was created for the file");
  assert.equal(await app.invoke("page_resolve", { title: "Fehlt.docx", create: false }), null);
  await app.dismissToasts();
});

test("file errors name the file or the folder", async () => {
  const missing = path.join(app.dataDir, "attachments", "Weg.pdf");
  assert.equal(await errorOf(app.invoke("attachment_read", { name: "Weg.pdf" })), `Datei nicht gefunden: ${missing}`);
  // Writing into a folder that does not exist names that folder.
  const gone = path.join(app.dataDir, "gibt-es-nicht");
  assert.equal(await errorOf(app.invoke("html_file_write", { path: path.join(gone, "tief", "Seite.html"), html: "<p>x</p>" })), `Ordner nicht gefunden: ${gone}`);
  // The developer log keeps the full path and the system's own words.
  const log = await app.invoke("devlog_read", {});
  const text = JSON.stringify(log);
  assert.match(text, /Ordner nicht gefunden: [^"]*gibt-es-nicht \(/, "the log has the path and the OS error");
});

test("code on slides is highlighted; the white Beamer slide uses light code colors in a dark theme", async () => {
  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", { settings: { ...view.settings, theme: "dark" } });
  await app.browser.refresh();
  await app.browser.waitUntil(async () => app.browser.execute(() => document.body.classList.contains("ready")), { timeout: 20000 });
  await openPage("Folien mit Code", "# Code auf Folien\n\n```ts\nconst antwort: number = 42; // Kommentar\nfunction frage(): string {\n  return \"Leben\";\n}\n```\n\n```rust\nfn main() { let x = 1; }\n```\n");
  await app.click('.pane.active .page-view [aria-label="Weitere Aktionen"]');
  assert.ok(await menuClick("Präsentieren"));
  await app.waitFor(".presentation .present-slide .slide-content .hljs-keyword", 10000);
  // Rust is loaded on demand.
  await app.browser.waitUntil(async () => app.browser.execute(() => !!document.querySelector('.presentation .slide-content code.language-rust .hljs-keyword')), { timeoutMsg: "rust not highlighted" });
  const colors = () =>
    app.browser.execute(() => {
      const c = (sel) => getComputedStyle(document.querySelector(`.presentation .slide-content ${sel}`)).color;
      return { keyword: c(".hljs-keyword"), string: c(".hljs-string"), comment: c(".hljs-comment"), plain: c("pre code"), bg: getComputedStyle(document.querySelector(".presentation .slide-content pre")).backgroundColor };
    });
  const dark = await colors();
  assert.notEqual(dark.keyword, dark.plain, `keywords colored: ${JSON.stringify(dark)}`);
  assert.notEqual(dark.string, dark.plain);
  assert.equal(dark.keyword, "rgb(192, 132, 252)", "the dark theme's keyword color");
  await app.shot("61-slide-code-dark");
  await app.keys(["b"]);
  await app.browser.waitUntil(async () => app.browser.execute(() => document.querySelector(".presentation").classList.contains("beamer")), { timeoutMsg: "no beamer" });
  const light = await colors();
  assert.equal(light.keyword, "rgb(147, 51, 234)", `light keyword color on the white slide: ${JSON.stringify(light)}`);
  assert.equal(light.string, "rgb(21, 128, 61)");
  assert.equal(light.bg, "rgb(245, 246, 248)");
  await app.shot("61-slide-code-beamer");
  await app.keys(["b"]);
  await app.keys(["Escape"]);
  await app.browser.waitUntil(async () => !(await (await app.$(".presentation")).isExisting()), { timeoutMsg: "presentation not closed" });
  await app.invoke("settings_save", { settings: { ...view.settings } });
});

test("tabs grow to show a long title while there is room", async () => {
  await app.browser.setWindowSize(1480, 920);
  const title = "Protokoll Lenkungskreis Quartalsplanung 2026";
  await openPage(title, "x");
  await sleep(400);
  const tab = await app.browser.execute(() => {
    const t = document.querySelector(".pane.active .tab.active");
    const tt = t.querySelector(".tab-title");
    return { w: t.getBoundingClientRect().width, cut: tt.scrollWidth > tt.clientWidth, text: tt.textContent };
  });
  assert.equal(tab.text, title);
  assert.equal(tab.cut, false, `whole title: ${JSON.stringify(tab)}`);
  assert.ok(tab.w > 230 && tab.w <= 360, `wider than the old 220 px cap: ${JSON.stringify(tab)}`);
  await app.shot("61-tabs-long-title");
});
