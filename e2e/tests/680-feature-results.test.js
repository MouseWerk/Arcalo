// Results of features earlier hunts barely touched (q124 round 5): query blocks in notes give the
// done tasks for `status!=offen` and leave templates and filing folders out; PDF highlights keep
// the text as selected („Haus- und Gartenarbeit“ stays, a word hyphenated at the line break is
// joined), go into a note as a quote that links back and follow a renamed PDF; focus sessions
// that extend one entry round its total once, not once per session.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
before(async () => {
  app = await launch();
});
after(async () => app?.close());

const fence = (body) => `\`\`\`query\n${body}\n\`\`\``;
const ACTIVE = ".pane.active > .pane-content:not([hidden])";
const content = async (id) => (await app.invoke("page_get", { id })).content;
async function open(id, title) {
  await app.invoke("search_open", { target: { kind: "page", page_id: id, new_tab: false } });
  await app.browser.waitUntil(async () => (await app.browser.execute((s) => document.querySelector(`${s} .page-title`)?.value, ACTIVE)) === title, { timeoutMsg: `${title} not open` });
  await app.waitFor(`${ACTIVE} .ProseMirror`);
}
const queryBlocks = () => app.browser.execute((s) => [...document.querySelectorAll(`${s} .rich-preview.rich-query`)].map((e) => e.innerText), ACTIVE);
async function loadedBlocks(n) {
  let blocks = [];
  await app.browser.waitUntil(
    async () => {
      await app.browser.execute((s) => document.querySelectorAll(`${s} .rich-preview.rich-query`).forEach((e) => e.scrollIntoView({ block: "center" })), ACTIVE);
      blocks = await queryBlocks();
      return blocks.length === n && blocks.every((t) => /Abfrage bearbeiten/.test(t) && !/Wird geladen/.test(t));
    },
    { timeout: 10000, timeoutMsg: "queries not loaded" },
  );
  return blocks;
}

test("query blocks: status!=offen lists the done tasks; templates and filing folders are no results", async () => {
  await app.invoke("page_create", { parentId: null, title: "R5 Aufgaben", icon: null, content: "- [ ] Noch offen #r5q\n- [x] Schon fertig #r5q\n" });
  const templates = await app.invoke("templates_root");
  await app.invoke("page_create", { parentId: templates.id, title: "R5 Projektvorlage", icon: null, content: "---\nstatus: offen\n---\n#r5proj Vorlage\n\n- [ ] Vorlagenaufgabe #r5q\n" });
  await app.invoke("page_create", { parentId: null, title: "R5 Projekt", icon: null, content: "---\nstatus: offen\n---\n#r5proj Echt\n" });
  const q = await app.invoke("page_create", {
    parentId: null,
    title: "R5 Abfragen",
    icon: null,
    content: [
      "Abfragen",
      fence("from: tasks\nshow: table\n#r5q status!=offen"),
      fence("from: tasks\nshow: count\n#r5q"),
      fence("from: pages\nshow: table\ncolumns: status\n#r5proj status: offen"),
    ].join("\n\n") + "\n",
  });
  await open(q.id, "R5 Abfragen");
  const [done, open_, pages] = await loadedBlocks(3);
  assert.match(done, /Schon fertig/, done);
  assert.doesNotMatch(done, /Noch offen/, "an open task is not „not open“");
  assert.match(open_, /^1\s+Aufgabe\b/, "the template's task is no task");
  assert.match(pages, /R5 Projekt\b/);
  assert.doesNotMatch(pages, /R5 Projektvorlage/, "a template is no project page");
  assert.match(pages, /1 Treffer/);
});

/** A PDF from raw page content streams (Helvetica). */
function pdfFrom(streams) {
  const objs = [];
  const pageIds = streams.map((_, i) => 4 + i * 2);
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${streams.length} >>`;
  objs[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  streams.forEach((stream, i) => {
    objs[4 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`;
    objs[5 + i * 2] = `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`;
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
const textPage = (lines) => `BT /F1 20 Tf 72 660 Td 26 TL ${lines.map((l) => `(${l}) '`).join(" ")} ET`;

async function store(name, bytes) {
  const r = await app.browser.executeAsync(
    (n, b64, done) => {
      const data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      window.__TAURI_INTERNALS__.invoke("attachment_store", data, { headers: { "x-arcalo-name": encodeURIComponent(n) } }).then((ok) => done({ ok }), (err) => done({ err: String(err) }));
    },
    name,
    Buffer.from(bytes).toString("base64"),
  );
  if (r.err) throw new Error(r.err);
  return r.ok;
}

/** Selects the text-layer spans of page 1 from the one starting with `from` to the one ending with `to`. */
const selectSpans = (from, to) =>
  app.browser.execute(
    (s, a, b) => {
      const spans = [...document.querySelectorAll(`${s} .pdf-page[data-page="1"] .textLayer span`)].filter((x) => x.childNodes.length === 1 && x.firstChild.nodeType === 3);
      const first = spans.find((x) => x.textContent.startsWith(a));
      const last = spans.find((x) => x.textContent.endsWith(b));
      if (!first || !last) return null;
      const range = document.createRange();
      range.setStart(first.firstChild, 0);
      range.setEnd(last.firstChild, last.textContent.length);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.querySelector(`${s} .pdf-scroll`).dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      return sel.toString();
    },
    ACTIVE,
    from,
    to,
  );

test("PDF highlights keep the selected text, go into a note with a link back and follow a rename", async () => {
  await store("R5 Bericht.pdf", pdfFrom([textPage(["Haus- und Gartenarbeit, Daten-", "verarbeitung im Haus"])]));
  const note = await app.invoke("page_create", { parentId: null, title: "R5 Lesenotiz", icon: null, content: "Notizen zum Bericht\n\n![[R5 Bericht.pdf]]\n" });
  await app.keys(["Control", "k"]);
  const input = await app.waitFor(".palette input");
  await input.setValue("Anhänge verwalten");
  await app.waitText(".pal-item.sel", /Anhänge verwalten/);
  await app.keys(["Enter"]);
  const row = `${ACTIVE} .att-row[data-file="R5 Bericht.pdf"] .att-name`;
  await app.waitFor(row, 10000);
  await app.browser.execute((r) => document.querySelector(r).click(), row);
  await app.waitFor(`${ACTIVE} .pdf-pane .pdf-page[data-page="1"].is-rendered .textLayer span`, 20000);
  const raw = await selectSpans("Haus-", "im Haus");
  assert.ok(raw, "spans found");
  await app.waitFor(".pdf-selbar");
  await app.click('.pdf-selbar .pdf-swatch.is-yellow');
  await app.browser.waitUntil(async () => (await app.invoke("pdf_highlights_list", { name: "R5 Bericht.pdf" })).length === 1, { timeoutMsg: "no highlight stored" });
  const [h] = await app.invoke("pdf_highlights_list", { name: "R5 Bericht.pdf" });
  assert.equal(h.text, "Haus- und Gartenarbeit, Datenverarbeitung im Haus", `selected: ${JSON.stringify(raw)}`);
  // Into the note: the quote as written, with the link back to page 1.
  const md = await app.invoke("pdf_highlight_markdown", { name: "R5 Bericht.pdf", id: h.id });
  assert.match(md, /Haus- und Gartenarbeit, Datenverarbeitung im Haus/);
  await app.invoke("page_save", { id: note.id, content: `${await content(note.id)}\n${md}` });
  const link = `[[R5 Bericht.pdf#page=1&hl=${h.id}|S. 1]]`;
  assert.ok((await content(note.id)).includes(link), await content(note.id));
  // Renamed: the highlight and the link back move along.
  await app.invoke("attachment_rename", { name: "R5 Bericht.pdf", newName: "R5 Bericht 2026.pdf" });
  assert.equal((await app.invoke("pdf_highlights_list", { name: "R5 Bericht 2026.pdf" })).length, 1);
  const after = await content(note.id);
  assert.ok(after.includes(`[[R5 Bericht 2026.pdf#page=1&hl=${h.id}|S. 1]]`), after);
  assert.ok(after.includes("![[R5 Bericht 2026.pdf]]"), after);
});

test("focus sessions extending one entry round its total once", async () => {
  const view = await app.invoke("settings_get");
  const base = view.settings;
  await app.invoke("settings_save", { settings: { ...base, time: { ...base.time, rounding: { ...base.time.rounding, step_minutes: 15, mode: "up" } } }, base });
  const today = new Date();
  const from = new Date(today.getFullYear(), today.getMonth(), today.getDate()).toISOString();
  const durations = [];
  for (let i = 0; i < 3; i++) {
    await app.invoke("focus_start", { start: { reference: "NP-8801/1020", minutes: 0.05, break_minutes: 0, goal: "R5 Rundung" } });
    await app.browser.waitUntil(async () => (await app.invoke("focus_state"))?.phase !== "work", { timeout: 15000, timeoutMsg: "session did not end" });
    const entries = await app.invoke("time_entries", { from, to: null });
    const e = entries.filter((x) => x.description === "R5 Rundung");
    assert.equal(e.length, 1, "one entry for the sessions");
    durations.push(e[0].duration_minutes);
  }
  // Three sessions of a minute each: 3 minutes, rounded up to 15 once.
  assert.deepEqual(durations, [15, 15, 15]);
  await app.dismissToasts();
});
