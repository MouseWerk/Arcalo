// Attachment manager („Anhänge“): list with type, size and usage, filters, safe rename that
// rewrites every embed, delete into the file trash, clean-up of unused files. PDF hardening:
// pdf.js in a Web Worker (the UI keeps painting while a 150-page PDF loads), pages far from the
// viewport give their canvases back, text layer (select, copy, search hits), CJK CMaps, and a
// PDF dropped on the tab bar opens in a tab.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
before(async () => {
  app = await launch();
  await app.browser.execute(() => {
    window.__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
});
after(async () => app?.close());

const pageId = async (title) => (await app.invoke("page_resolve", { title, create: false })).id;
const content = async (title) => (await app.invoke("page_get", { id: await pageId(title) })).content;
const att = (name) => path.join(app.dataDir, "attachments", name);
const clickMenu = (label) => app.browser.execute((l) => [...document.querySelectorAll(".menu-item")].find((b) => b.textContent.trim() === l).click(), label);
const rowSel = (name) => `.att-row[data-file="${name}"]`;
const shownRows = () => app.browser.execute(() => [...document.querySelectorAll(".att-row[data-file]")].map((r) => r.dataset.file));

/** A PDF from raw page content streams; `fonts` are the objects the pages' /F1 resource names. */
function pdfFrom(streams, font = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", extra = []) {
  const objs = [];
  const n = streams.length;
  const first = 4 + extra.length;
  const pageIds = streams.map((_, i) => first + i * 2);
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${n} >>`;
  objs[3] = font;
  extra.forEach((o, i) => (objs[4 + i] = o));
  streams.forEach((stream, i) => {
    objs[first + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${first + 1 + i * 2} 0 R >>`;
    objs[first + 1 + i * 2] = `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`;
  });
  let out = "%PDF-1.4\n";
  const offsets = [];
  for (let i = 1; i < objs.length; i++) {
    offsets[i] = Buffer.byteLength(out, "latin1");
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const textPage = (lines) => `0.1 0.2 0.5 rg 72 720 468 30 re f BT /F1 20 Tf 72 660 Td 26 TL ${lines.map((l) => `(${l}) '`).join(" ")} ET`;

/** `attachment_store` with the raw bytes as body and the file name as header, like the drop handler. */
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

/** A small valid PNG (solid color), base64. */
function makePng(w = 24, h = 16) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const raw = Buffer.concat(Array.from({ length: h }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 0x55)])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]).toString("base64");
}
let png;

async function openByPalette(text) {
  await app.keys(["Control", "k"]);
  const input = await app.waitFor(".palette input");
  await input.setValue(text);
  await app.waitText(".pal-item.sel", new RegExp(text));
  await app.keys(["Enter"]);
}

async function openAttachments() {
  await app.keys(["Control", "k"]);
  const input = await app.waitFor(".palette input");
  await input.setValue("Anhänge verwalten");
  await app.waitText(".pal-item.sel", /Anhänge verwalten/);
  await app.keys(["Enter"]);
  await app.waitFor(".att-table", 10000);
}

test("the attachment manager lists every file with type, size, date and usage", async () => {
  png = (await app.invoke("attachment_save", { data: makePng(), name: "plan.png", mime: "image/png" })).name;
  await store("Handbuch.pdf", pdfFrom([textPage(["Erste Seite"]), textPage(["Zweite Seite"])]));
  await store("daten.xlsx", Buffer.from("PK xlsx daten"));
  await store("alt.zip", Buffer.alloc(2048, 7));
  const drawing = await app.invoke("drawing_create", { title: "Skizze" });
  await app.invoke("drawing_save", {
    name: drawing.name,
    scene: '{"type":"excalidraw","version":2,"elements":[],"appState":{},"files":{}}',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="#36c"/></svg>',
  });
  const a = await app.invoke("page_create", { parentId: null, title: "Anhang-Test", icon: null, content: null });
  await app.invoke("page_save", { id: a.id, content: `Handbuch: ![[Handbuch.pdf]]\n\nDaten: ![[daten.xlsx]]\n\n![[${png}|200]]\n\n![[Skizze.excalidraw]]\n` });
  const b = await app.invoke("page_create", { parentId: null, title: "Zweite Notiz", icon: null, content: null });
  await app.invoke("page_save", { id: b.id, content: `Seite 2: ![[Handbuch.pdf#page=2|S. 2]]\n\n![Plan](attachments/${png})\n` });

  const list = await app.invoke("attachments_list");
  const byName = Object.fromEntries(list.files.map((f) => [f.name, f]));
  assert.deepEqual(Object.keys(byName).sort(), ["Handbuch.pdf", "Skizze.excalidraw", "alt.zip", "daten.xlsx", png].sort());
  assert.deepEqual(byName["Handbuch.pdf"].used_in.map((u) => u.title).sort(), ["Anhang-Test", "Zweite Notiz"]);
  assert.deepEqual(byName[png].used_in.map((u) => u.title).sort(), ["Anhang-Test", "Zweite Notiz"], "embed and Markdown image link");
  assert.equal(byName["Skizze.excalidraw"].kind, "drawing");
  assert.equal(byName["Skizze.excalidraw"].preview, "Skizze.excalidraw.svg");
  assert.deepEqual(byName["alt.zip"].used_in, []);
  assert.equal(list.total_size, list.files.reduce((n, f) => n + f.size, 0));

  await openAttachments();
  await app.waitText(".att-summary", /5 Dateien · .* insgesamt · 1 unbenutzt \(2 kB\)/);
  assert.deepEqual(await shownRows(), ["alt.zip", "daten.xlsx", "Handbuch.pdf", png, "Skizze.excalidraw"].sort((x, y) => x.localeCompare(y, "de", { sensitivity: "base" })));
  await app.waitText(`${rowSel("alt.zip")} .att-unused`, /Nicht verwendet/);
  await app.waitText(`${rowSel("Handbuch.pdf")} .att-uses`, /Anhang-Test/);
  await app.waitText(`${rowSel("Handbuch.pdf")} .att-c-kind`, /PDF/);
  await app.waitText(`${rowSel("alt.zip")} .att-c-size`, /2 kB/);
  // Previews: the image, the drawing's SVG and the PDF's first page.
  await app.browser.waitUntil(
    () =>
      app.browser.execute(
        (p) =>
          document.querySelector(`.att-row[data-file="${p}"] .att-thumb img`)?.naturalWidth > 0 &&
          document.querySelector('.att-row[data-file="Skizze.excalidraw"] .att-thumb img')?.naturalWidth > 0 &&
          document.querySelector('.att-row[data-file="Handbuch.pdf"] .att-thumb canvas.ready')?.width > 0,
        png,
      ),
    { timeout: 15000, timeoutMsg: "thumbnails not shown" },
  );

  // Filters: type, unused, search (name or page), sort by size.
  await app.click('.att-toolbar .segmented button:nth-child(4)');
  await app.browser.waitUntil(async () => JSON.stringify(await shownRows()) === '["Handbuch.pdf"]', { timeoutMsg: "PDF filter" });
  await app.click('.att-toolbar .segmented button:nth-child(1)');
  await app.click(".att-chip:nth-child(1)");
  await app.browser.waitUntil(async () => JSON.stringify(await shownRows()) === '["alt.zip"]', { timeoutMsg: "unused filter" });
  await app.click(".att-chip:nth-child(1)");
  await app.click(".att-search-input");
  await app.type("zweite");
  await app.browser.waitUntil(async () => JSON.stringify((await shownRows()).sort()) === JSON.stringify(["Handbuch.pdf", png].sort()), { timeoutMsg: "search by page" });
  await app.browser.execute(() => document.querySelector(".att-search [aria-label='Suche leeren']").click());
  await app.select(".att-sort", "size");
  await app.browser.waitUntil(async () => (await shownRows())[0] === "Handbuch.pdf" || (await shownRows())[0] === "alt.zip", { timeoutMsg: "size sort" });
  await app.select(".att-sort", "name");
  await app.shot("attachments-manager");
  // „Verwendet in“ opens the page.
  await app.browser.execute((s) => [...document.querySelectorAll(`${s} .att-use`)].find((b) => b.textContent.includes("Zweite Notiz")).click(), rowSel("Handbuch.pdf"));
  await app.waitText(".tab.active .tab-title", /Zweite Notiz/);
  await app.waitFor('.pane.active .pdf-embed[data-file="Handbuch.pdf"]');
});

test("rename rewrites every embed through the save path; open editors follow", async () => {
  // „Zweite Notiz“ stays open in a tab while the file is renamed in the manager (in a new tab).
  await app.keys(["Control", "t"]);
  await app.waitText(".tab.active .tab-title", /Neuer Tab/);
  await openAttachments();
  const open = async (name) => {
    await app.browser.execute((s) => document.querySelector(`${s} .att-c-act button`).click(), rowSel(name));
    await app.waitFor(".menu-item");
    await clickMenu("Umbenennen…");
    return app.waitFor(".att-rename-input");
  };
  let input = await open("Handbuch.pdf");
  // The name without its extension is selected.
  assert.deepEqual(await app.browser.execute(() => [document.activeElement.selectionStart, document.activeElement.selectionEnd]), [0, 8]);
  for (const [bad, msg] of [
    ["Hand:buch.pdf", /Zeichen/],
    ["Handbuch.docx", /Dateiendung muss \.pdf bleiben/],
    ["DATEN.pdf", null],
  ]) {
    await input.setValue(bad);
    if (msg) {
      await app.waitText(".att-rename-hint.is-error", msg);
      assert.equal(await app.browser.execute(() => document.querySelector(".dialog .btn-primary").disabled), true);
    }
  }
  await input.setValue("Handbuch 2026.pdf");
  await app.keys(["Enter"]);
  await app.waitText(".toast-title", /Datei umbenannt/);
  await app.waitText(".toast-detail", /in 2 Seiten angepasst/);
  assert.ok(fs.existsSync(att("Handbuch 2026.pdf")) && !fs.existsSync(att("Handbuch.pdf")));
  assert.equal(await content("Anhang-Test"), `Handbuch: ![[Handbuch 2026.pdf]]\n\nDaten: ![[daten.xlsx]]\n\n![[${png}|200]]\n\n![[Skizze.excalidraw]]\n`);
  assert.match(await content("Zweite Notiz"), /!\[\[Handbuch 2026\.pdf#page=2\|S\. 2\]\]/);
  // The previous content is kept as a version.
  const versions = await app.invoke("page_versions", { pageId: await pageId("Zweite Notiz") });
  assert.match(await app.invoke("page_version_content", { versionId: versions[0].id }), /!\[\[Handbuch\.pdf#page=2/);
  await app.waitFor(`${rowSel("Handbuch 2026.pdf")}`);

  // The open editor of „Zweite Notiz“ shows the new name without a reload by hand.
  await app.browser.execute(() => [...document.querySelectorAll(".tab")].find((t) => t.textContent.includes("Zweite Notiz")).dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 })));
  await app.waitFor('.pane.active .pdf-embed[data-file="Handbuch 2026.pdf"]');

  // The shell checks names too: other extensions and taken names (any case) are refused.
  await assert.rejects(app.invoke("attachment_rename", { name: "alt.zip", newName: "DATEN.xlsx" }), /Dateiendung/);
  await store("Belegt.zip", Buffer.from("PK belegt"));
  await assert.rejects(app.invoke("attachment_rename", { name: "alt.zip", newName: "BELEGT.zip" }), /gibt es schon/);
  await app.invoke("attachment_trash", { names: ["Belegt.zip"] });
  await app.invoke("attachment_purge", { id: (await app.invoke("attachments_trashed"))[0].id, name: "Belegt.zip" });
  // A drawing renames its preview with it.
  const out = await app.invoke("attachment_rename", { name: "Skizze.excalidraw", newName: "Plan.excalidraw" });
  assert.deepEqual(out.pages, [await pageId("Anhang-Test")]);
  assert.ok(fs.existsSync(att("Plan.excalidraw")) && fs.existsSync(att("Plan.excalidraw.svg")) && !fs.existsSync(att("Skizze.excalidraw.svg")));
});

test("delete warns when the file is used, goes to the trash and can be undone; clean-up removes unused files", async () => {
  await openAttachments();
  await app.browser.execute((s) => document.querySelector(`${s} .att-c-act button`).click(), rowSel("daten.xlsx"));
  await app.waitFor(".menu-item");
  await clickMenu("Löschen…");
  await app.waitText(".dialog .dialog-text", /wird in 1 Seite verwendet \(„Anhang-Test“\); dort erscheint dann „Datei fehlt“/);
  await app.click(".dialog .btn-danger");
  await app.browser.waitUntil(async () => !(await shownRows()).includes("daten.xlsx"), { timeoutMsg: "row not removed" });
  assert.ok(!fs.existsSync(att("daten.xlsx")));
  const trashed = await app.invoke("attachments_trashed");
  assert.deepEqual(trashed.map((f) => f.name), ["daten.xlsx"]);
  assert.ok(fs.existsSync(path.join(app.dataDir, "trash", "files", trashed[0].id, "daten.xlsx")));
  // „Rückgängig“ in the toast brings it back.
  await app.browser.execute(() => [...document.querySelectorAll(".toast button")].find((b) => b.textContent.trim() === "Rückgängig").click());
  await app.browser.waitUntil(async () => (await shownRows()).includes("daten.xlsx"), { timeoutMsg: "undo did not restore" });
  assert.ok(fs.existsSync(att("daten.xlsx")));

  // Clean-up lists the unused files with their total size.
  await store("rest.bin", Buffer.alloc(1000, 1));
  await app.click('.view-actions [aria-label="Neu laden"]');
  await app.waitText(".att-summary", /2 unbenutzt/);
  await app.browser.execute(() => [...document.querySelectorAll(".view-actions button")].find((b) => b.textContent.includes("Unbenutzte aufräumen")).click());
  await app.waitFor(".att-clean-list");
  assert.deepEqual(await app.browser.execute(() => [...document.querySelectorAll(".att-clean-name")].map((e) => e.textContent)), ["alt.zip", "rest.bin"]);
  await app.waitText(".dialog .btn-danger", /2 Dateien löschen \(3 kB\)/);
  await app.shot("attachments-cleanup");
  // Only one of them.
  await app.browser.execute(() => document.querySelector('.att-clean-item input[aria-label="rest.bin"]').click());
  await app.waitText(".dialog .btn-danger", /1 Datei löschen \(2 kB\)/);
  await app.click(".dialog .btn-danger");
  await app.browser.waitUntil(async () => !(await shownRows()).includes("alt.zip"), { timeoutMsg: "clean-up did not delete" });
  assert.ok(!fs.existsSync(att("alt.zip")) && fs.existsSync(att("rest.bin")));

  // The trash shows deleted files; restore puts them back.
  await app.dismissToasts();
  await app.keys(["Control", "k"]);
  const input = await app.waitFor(".palette input");
  await input.setValue("Papierkorb");
  await app.waitText(".pal-item.sel", /Papierkorb/);
  await app.keys(["Enter"]);
  await app.waitText('.trash-files .trash-item[data-file="alt.zip"] .trash-item-title', /alt\.zip/);
  await app.browser.execute(() => document.querySelector('.trash-files .trash-item[data-file="alt.zip"] button').click());
  await app.browser.waitUntil(() => fs.existsSync(att("alt.zip")), { timeoutMsg: "not restored from the trash" });
});

// ------------------------------------------------------------------ PDF

const TREFFER = { 10: ["Seite 10 Treffer"], 75: ["Treffer und Treffer auf Seite 75"], 140: ["Seite 140 mit Treffer"] };

test("a 150-page PDF parses in a worker; the UI keeps painting and far pages give their canvases back", async () => {
  const streams = Array.from({ length: 150 }, (_, i) => textPage([`Seite ${i + 1} von 150`, ...(TREFFER[i + 1] ?? ["Text ohne Suchbegriff"])]));
  await store("Gross.pdf", pdfFrom(streams));
  await openAttachments();
  // Frames counted while the PDF opens: a blocked main thread would stop them.
  await app.browser.execute(() => {
    window.__frames = [];
    const tick = (t) => {
      window.__frames.push(t);
      if (window.__frames.length < 100000) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const start = await app.browser.execute(() => window.__frames.length);
  await app.browser.execute(() => document.querySelector('.att-row[data-file="Gross.pdf"] .att-name').click());
  await app.waitFor(".pane.active .pdf-pane", 15000);
  await app.waitText(".pane.active .pdf-pane .pdf-page-count", /\/ 150/, 20000);
  await app.browser.waitUntil(() => app.browser.execute(() => !!document.querySelector('.pdf-pane .pdf-page[data-page="1"].is-rendered')), { timeout: 15000, timeoutMsg: "first page not rendered" });
  const frames = await app.browser.execute((s) => {
    const f = window.__frames.slice(s);
    let gap = 0;
    for (let i = 1; i < f.length; i++) gap = Math.max(gap, f[i] - f[i - 1]);
    return { count: f.length, gap };
  }, start);
  assert.ok(frames.count >= 10, `frames kept coming: ${JSON.stringify(frames)}`);
  assert.ok(frames.gap < 600, `no long freeze: ${JSON.stringify(frames)}`);
  assert.equal(await app.browser.execute(() => document.querySelector(".pdf-pane").dataset.worker), "worker", "pdf.js runs in its Web Worker");
  await app.waitText(".tab.active .tab-title", /Gross\.pdf/);
  await app.shot("pdf-tab");

  // Through the whole document: only pages near the viewport hold pixels.
  for (const p of [20, 60, 100, 150]) {
    await app.browser.execute((n) => {
      const sc = document.querySelector(".pdf-pane .pdf-scroll");
      sc.scrollTop = document.querySelector(`.pdf-pane .pdf-page[data-page="${n}"]`).offsetTop - 16;
    }, p);
    await app.browser.waitUntil(() => app.browser.execute((n) => !!document.querySelector(`.pdf-pane .pdf-page[data-page="${n}"].is-rendered`), p), { timeout: 15000, timeoutMsg: `page ${p} not rendered` });
  }
  const canvases = await app.browser.execute(() => {
    const all = [...document.querySelectorAll(".pdf-pane .pdf-page canvas")];
    return { held: all.filter((c) => c.width > 0).length, first: all[0].width, total: all.length, layers: document.querySelectorAll(".pdf-pane .textLayer span").length };
  });
  assert.equal(canvases.total, 150);
  assert.ok(canvases.held > 0 && canvases.held <= 20, `canvases with pixels: ${JSON.stringify(canvases)}`);
  assert.equal(canvases.first, 0, "page 1 gave its canvas back");
  assert.ok(canvases.layers < 400, `text layers released too: ${JSON.stringify(canvases)}`);
});

test("search highlights every hit with next/previous; text can be selected and copied", async () => {
  await app.click(".pdf-pane .pdf-search-input");
  await app.type("treffer");
  await app.keys(["Enter"]);
  // Four hits on three pages; the first one at or after the current page (150) wraps to page 10.
  await app.waitText(".pdf-pane .pdf-hits", /Seite 10 · 1\/4/, 20000);
  const hitsOn = (p) => app.browser.execute((n) => ({ all: document.querySelectorAll(`.pdf-pane .pdf-page[data-page="${n}"] .highlight`).length, sel: document.querySelectorAll(`.pdf-pane .pdf-page[data-page="${n}"] .highlight.selected`).length }), p);
  await app.browser.waitUntil(async () => (await hitsOn(10)).sel === 1, { timeout: 15000, timeoutMsg: "hit on page 10 not highlighted" });
  await app.keys(["Enter"]);
  await app.waitText(".pdf-pane .pdf-hits", /Seite 75 · 2\/4/);
  let on75;
  await app.browser
    .waitUntil(async () => (on75 = await hitsOn(75)).all === 2 && on75.sel === 1, { timeout: 15000 })
    .catch(() => assert.fail(`both hits on page 75 highlighted: ${JSON.stringify(on75)}`));
  await app.click(".pdf-pane .pdf-hit-next");
  await app.waitText(".pdf-pane .pdf-hits", /Seite 75 · 3\/4/);
  await app.click(".pdf-pane .pdf-hit-next");
  await app.waitText(".pdf-pane .pdf-hits", /Seite 140 · 4\/4/);
  await app.click(".pdf-pane .pdf-hit-prev");
  await app.waitText(".pdf-pane .pdf-hits", /Seite 75 · 3\/4/);
  await app.click(".pdf-pane .pdf-hit-next");
  await app.waitText(".pdf-pane .pdf-hits", /Seite 140 · 4\/4/);
  await app.browser.waitUntil(async () => (await hitsOn(140)).sel === 1, { timeout: 15000, timeoutMsg: "hit on page 140 not highlighted" });
  const box = await app.browser.execute(() => {
    const r = document.querySelector(".pdf-pane .highlight.selected").getBoundingClientRect();
    return { w: r.width, h: r.height };
  });
  assert.ok(box.w > 20 && box.h > 8, `highlight covers the word: ${JSON.stringify(box)}`);
  await app.shot("pdf-search-hits");

  // Select the first line of page 140 in its text layer and copy it.
  const selected = await app.browser.execute(() => {
    const span = [...document.querySelectorAll('.pdf-pane .pdf-page[data-page="140"] .textLayer span')].find((s) => s.textContent.startsWith("Seite 140 von"));
    const range = document.createRange();
    range.selectNodeContents(span);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    window.__copied = null;
    document.addEventListener("copy", () => (window.__copied = document.getSelection().toString()), { once: true });
    return sel.toString();
  });
  assert.equal(selected, "Seite 140 von 150");
  await app.keys(["Control", "c"]);
  await app.browser.waitUntil(() => app.browser.execute(() => window.__copied === "Seite 140 von 150"), { timeout: 4000, timeoutMsg: "copy did not carry the selected text" });
  await app.browser.execute(() => window.getSelection().removeAllRanges());
});

test("Chinese/Japanese/Korean text in a font that is not embedded renders with the CMaps", async () => {
  // 日本語テキスト in UCS-2 with the predefined CMap UniJIS-UCS2-H; the font (KozMinPr6N) is not embedded.
  const stream = "BT /F1 44 Tf 72 600 Td <65E5672C8A9E30C630AD30B930C8> Tj ET";
  const font = "<< /Type /Font /Subtype /Type0 /BaseFont /KozMinPr6N-Regular /Encoding /UniJIS-UCS2-H /DescendantFonts [4 0 R] >>";
  const extra = [
    "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /KozMinPr6N-Regular /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 6 >> /FontDescriptor 5 0 R /DW 1000 >>",
    "<< /Type /FontDescriptor /FontName /KozMinPr6N-Regular /Flags 6 /FontBBox [-437 -340 1147 1317] /ItalicAngle 0 /Ascent 1317 /Descent -349 /CapHeight 742 /StemV 80 >>",
  ];
  await store("Japanisch.pdf", pdfFrom([stream], font, extra));
  await app.invoke("page_save", { id: await pageId("Zweite Notiz"), content: "CJK: ![[Japanisch.pdf]]\n" });
  await app.browser.execute(() => window.dispatchEvent(new CustomEvent("annalo:reload-pages", { detail: {} })));
  await openByPalette("Zweite Notiz");
  await app.click('.pane.active .pdf-embed[data-file="Japanisch.pdf"]');
  await app.waitFor(".pdf-overlay .pdf-page.is-rendered", 20000);
  await app.browser.waitUntil(() => app.browser.execute(() => document.querySelector(".pdf-overlay .textLayer")?.textContent.includes("日本語テキスト")), { timeout: 10000, timeoutMsg: "CJK text not in the text layer" });
  // Glyphs were drawn: dark pixels in the text's band (the page has nothing else).
  const ink = await app.browser.execute(() => {
    const c = document.querySelector(".pdf-overlay .pdf-page canvas");
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let dark = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 0 && d[i] < 110 && d[i + 1] < 110 && d[i + 2] < 110) dark++;
    return { dark, w: c.width, h: c.height };
  });
  assert.ok(ink.dark > 500, `CJK glyphs rendered: ${JSON.stringify(ink)}`);
  await app.shot("pdf-cjk");
  await app.keys(["Escape"]);
  await app.browser.waitUntil(async () => (await app.$$(".pdf-overlay")).length === 0);
});

test("a PDF dropped on the tab bar (or on a pane without a note) opens in a tab", async () => {
  const bytes = pdfFrom([textPage(["Abgelegt"])]).toString("base64");
  const drop = (sel, name) =>
    app.browser.execute(
      (s, n, b64) => {
        const target = document.querySelector(s);
        const dt = new DataTransfer();
        dt.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], n, { type: "application/pdf" }));
        const r = target.getBoundingClientRect();
        const opts = { dataTransfer: dt, bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
        target.dispatchEvent(new DragEvent("dragover", opts));
        const ev = new DragEvent("drop", opts);
        target.dispatchEvent(ev);
        return ev.defaultPrevented;
      },
      sel,
      name,
      bytes,
    );
  assert.ok(await drop(".pane.active .tabbar .tabs", "Abgelegt.pdf"), "drop handled");
  await app.waitText(".tab.active .tab-title", /^Abgelegt\.pdf$/, 10000);
  await app.waitFor('.pane.active .pdf-pane[aria-label="PDF Abgelegt.pdf"] .pdf-page.is-rendered', 15000);
  assert.ok(fs.existsSync(att("Abgelegt.pdf")));

  // A new, empty tab (start page): dropping on its content opens the PDF too.
  await app.keys(["Control", "t"]);
  await app.waitText(".tab.active .tab-title", /Neuer Tab/);
  assert.ok(await drop(".pane.active .pane-content", "Zweiter Drop.pdf"));
  await app.waitText(".tab.active .tab-title", /^Zweiter Drop\.pdf$/, 10000);
  await app.waitFor(".pane.active .pdf-pane .pdf-page.is-rendered", 15000);
});

test("no CSP violations and a clean console", async () => {
  const csp = await app.browser.execute(() => window.__csp);
  assert.deepEqual(csp.filter((v) => !v.startsWith("style-src")), []);
  assert.deepEqual(await app.consoleErrors(), []);
});
