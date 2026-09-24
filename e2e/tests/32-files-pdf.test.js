// File attachments and PDFs: raw-byte storing, the file chip and its menu, a dropped file,
// the PDF preview card (pdf.js without a worker) and the PDF viewer (pages, search, Esc).
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
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

/** A small valid PDF: one page per text, Helvetica (a standard font, not embedded) and a dark bar. */
function makePdf(texts) {
  const objs = [];
  const n = texts.length;
  const pageIds = texts.map((_, i) => 4 + i * 2);
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${n} >>`;
  objs[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  texts.forEach((t, i) => {
    const stream = `0.1 0.2 0.5 rg 72 700 468 40 re f BT /F1 24 Tf 72 640 Td (${t}) Tj ET`;
    objs[4 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`;
    objs[5 + i * 2] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
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

async function reload() {
  await app.browser.execute(() => window.dispatchEvent(new CustomEvent("annalo:reload-pages", { detail: {} })));
}

/** Right-clicks `sel` and returns the labels of the menu that opens. */
async function contextMenu(sel) {
  await app.browser.execute((s) => {
    const el = document.querySelector(s);
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: r.left + 10, clientY: r.top + 10 }));
  }, sel);
  await app.waitFor(".menu-item");
  return app.browser.execute(() => [...document.querySelectorAll(".menu-item")].map((b) => b.textContent.trim()));
}

const clickMenu = (label) => app.browser.execute((l) => [...document.querySelectorAll(".menu-item")].find((b) => b.textContent.trim() === l).click(), label);

test("files are stored by name, raw bytes through IPC", async () => {
  const docx = await store("Bericht Q3.docx", Buffer.from("PK docx eins"));
  assert.deepEqual([docx.name, docx.markdown, docx.size], ["Bericht Q3.docx", "![[Bericht Q3.docx]]", 12]);
  assert.equal(fs.readFileSync(att("Bericht Q3.docx"), "utf8"), "PK docx eins");
  // Same name, same bytes: reused. Other bytes: a free name.
  assert.equal((await store("Bericht Q3.docx", Buffer.from("PK docx eins"))).name, "Bericht Q3.docx");
  assert.equal((await store("Bericht Q3.docx", Buffer.from("PK docx zwei"))).name, "Bericht Q3 2.docx");
  // Folders in the name are dropped, reserved characters replaced; files without an extension are refused.
  assert.equal((await store("../../x/Plan: Entwurf?.zip", Buffer.from("zip"))).name, "Plan- Entwurf-.zip");
  assert.ok(!fs.existsSync(path.join(app.dataDir, "x")));
  await assert.rejects(store("Makefile", Buffer.from("all:")), /Dateiendung/);
  assert.equal(await app.invoke("attachment_size", { name: "Bericht Q3.docx" }), 12);
  assert.equal(await app.invoke("attachment_size", { name: "fehlt.docx" }), null);
});

test("a file embed renders as a chip with size and menu", async () => {
  await app.keys(["Control", "n"]);
  await app.browser.waitUntil(() => app.browser.execute(() => document.activeElement?.classList.contains("page-title") && document.activeElement.selectionEnd > 0));
  await app.type("Anhänge");
  await app.keys(["Enter"]);
  await app.browser.waitUntil(async () => (await app.invoke("page_resolve", { title: "Anhänge", create: false })) !== null);
  await app.invoke("page_save", { id: await pageId("Anhänge"), content: "Bericht: ![[Bericht Q3.docx]] und ![[fehlt.xlsx]]\n" });
  await reload();
  await app.waitText(".pane.active .file-embed .file-embed-name", /^Bericht Q3\.docx$/);
  await app.waitText(".pane.active .file-embed .file-embed-size", /^12 B$/);
  await app.waitText(".pane.active .file-embed.is-missing .file-embed-size", /Datei fehlt/);
  assert.equal(await app.browser.execute(() => !!document.querySelector('.pane.active .file-embed[data-file="Bericht Q3.docx"] svg')), true, "type icon");
  await app.shot("file-chip");

  const labels = await contextMenu('.pane.active .file-embed[data-file="Bericht Q3.docx"]');
  assert.deepEqual(labels, ["Öffnen", "Im Ordner zeigen", "Einbettung kopieren", "Aus der Notiz entfernen"]);
  await clickMenu("Aus der Notiz entfernen");
  await app.browser.waitUntil(async () => !(await content("Anhänge")).includes("Bericht Q3.docx"), { timeoutMsg: "embed not removed" });
  assert.match(await content("Anhänge"), /!\[\[fehlt\.xlsx\]\]/);
  // The file itself stays (other notes may embed it).
  assert.ok(fs.existsSync(att("Bericht Q3.docx")));
});

test("a dropped file is stored and embedded", async () => {
  await app.caretToEnd();
  const handled = await app.browser.execute(() => {
    const pm = document.querySelector(".pane.active .ProseMirror");
    const dt = new DataTransfer();
    dt.items.add(new File([new TextEncoder().encode("a;b\n1;2\n")], "Messwerte.csv", { type: "text/csv" }));
    const r = pm.lastElementChild.getBoundingClientRect();
    const ev = new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true, clientX: r.right - 2, clientY: r.top + r.height / 2 });
    pm.dispatchEvent(ev);
    return ev.defaultPrevented;
  });
  assert.ok(handled, "drop handled");
  await app.browser.waitUntil(async () => (await content("Anhänge")).includes("![[Messwerte.csv]]"), { timeoutMsg: "dropped file not embedded" });
  assert.equal(fs.readFileSync(att("Messwerte.csv"), "utf8"), "a;b\n1;2\n");
  await app.waitText(".pane.active .file-embed .file-embed-name", /^Messwerte\.csv$/);
});

test("a PDF shows its first page and opens in the viewer", async () => {
  const pdf = await store("Handbuch.pdf", makePdf(["Erste Seite Annalo", "Zweite Seite Suchwort", "Dritte Seite"]));
  assert.equal(pdf.name, "Handbuch.pdf");
  await app.invoke("page_save", { id: await pageId("Anhänge"), content: `Handbuch:\n\n${pdf.markdown}\n` });
  await reload();
  const card = '.pane.active .pdf-embed[data-file="Handbuch.pdf"]';
  await app.browser.waitUntil(() => app.browser.execute((s) => document.querySelector(s)?.classList.contains("is-ready"), card), {
    timeout: 20000,
    timeoutMsg: "PDF preview not rendered",
  });
  await app.waitText(`${card} .file-embed-size`, /^3 Seiten · \d/);
  // The canvas holds the page: white paper and the dark bar.
  const pixels = await app.browser.execute((s) => {
    const c = document.querySelector(`${s} canvas`);
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let dark = 0;
    let white = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] > 0 && d[i] < 80 && d[i + 2] > 80) dark++;
      if (d[i] > 240 && d[i + 1] > 240 && d[i + 2] > 240) white++;
    }
    return { w: c.width, h: c.height, dark, white };
  }, card);
  assert.ok(pixels.w > 100 && pixels.dark > 100 && pixels.white > 1000, JSON.stringify(pixels));
  await app.shot("pdf-card");

  const labels = await contextMenu(card);
  assert.deepEqual(labels, ["Ansehen", "Extern öffnen", "Im Ordner zeigen", "Einbettung kopieren", "Aus der Notiz entfernen"]);
  await app.keys(["Escape"]);

  await app.click(card);
  await app.waitFor(".pdf-overlay .pdf-page canvas", 20000);
  await app.waitText(".pdf-overlay .pdf-page-count", /\/ 3/);
  await app.browser.waitUntil(
    () =>
      app.browser.execute(() => {
        const c = document.querySelector('.pdf-overlay .pdf-page[data-page="1"] canvas');
        return c && c.width > 200 && c.getContext("2d").getImageData(0, 0, c.width, c.height).data.some((v, i) => i % 4 === 0 && v < 80);
      }),
    { timeout: 10000, timeoutMsg: "viewer page not rendered" },
  );
  await app.shot("pdf-viewer");

  // Search jumps to the page with the text.
  await app.click(".pdf-search-input");
  await app.type("suchwort");
  await app.keys(["Enter"]);
  await app.waitText(".pdf-hits", /Seite 2 · 1\/1/);
  await app.browser.waitUntil(() => app.browser.execute(() => document.querySelector(".pdf-page-input").value === "2"), { timeoutMsg: "did not scroll to page 2" });
  await app.browser.execute(() => document.querySelector(".pdf-search-input").select());
  await app.type("gibtesnicht");
  await app.keys(["Enter"]);
  await app.waitText(".pdf-hits", /Keine Treffer/);

  // Zoom changes the page size.
  const width = () => app.browser.execute(() => document.querySelector('.pdf-page[data-page="1"]').getBoundingClientRect().width);
  const before = await width();
  await app.click('.pdf-overlay [aria-label="Vergrößern"]');
  await app.browser.waitUntil(async () => (await width()) > before + 10, { timeoutMsg: "zoom did not grow the page" });

  // App shortcuts do not fire behind the viewer; Esc closes it.
  await app.browser.execute(() => document.querySelector(".pdf-overlay").focus());
  await app.keys(["Control", "k"]);
  await app.browser.pause(300);
  assert.equal((await app.$$(".palette")).length, 0, "palette opened over the viewer");
  await app.keys(["Escape"]);
  await app.browser.waitUntil(async () => (await app.$$(".pdf-overlay")).length === 0, { timeoutMsg: "Esc did not close the viewer" });
  assert.equal(await content("Anhänge"), `Handbuch:\n\n![[Handbuch.pdf]]\n`);
});

test("PDFs need no worker, no network and log no errors", async () => {
  // pdf.js runs in the main thread: the CSP (worker-src 'none') is never hit.
  const csp = await app.browser.execute(() => window.__csp);
  assert.deepEqual(csp.filter((v) => !v.startsWith("style-src")), []);
  assert.deepEqual(await app.consoleErrors(), []);
});

test("vault export carries file attachments", async () => {
  const out = path.join(app.dataDir, "export");
  await app.invoke("vault_export", { path: out });
  assert.ok(fs.existsSync(path.join(out, "attachments", "Handbuch.pdf")));
  // Not embedded anywhere any more: not exported.
  assert.ok(!fs.existsSync(path.join(out, "attachments", "Bericht Q3.docx")));
  // `![[Handbuch.pdf]]` is an embed, not a link to a page „Handbuch.pdf“.
  assert.equal(await app.invoke("page_resolve", { title: "Handbuch.pdf", create: false }), null);
});
