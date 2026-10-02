// Link and tag suggestions, duplicate hints and PDF highlights (1.10), shared by the German
// (143) and the English (144) run: `L` holds the language's labels and expected Markdown.
import assert from "node:assert/strict";

/** A small text PDF: one page per text, Helvetica (standard font, not embedded). An empty text gives a page without text. */
export function makePdf(texts) {
  const objs = [];
  const n = texts.length;
  const pageIds = texts.map((_, i) => 4 + i * 2);
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${n} >>`;
  objs[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  texts.forEach((t, i) => {
    const text = t ? ` 0 g BT /F1 22 Tf 72 640 Td (${t}) Tj ET` : "";
    const stream = `0.85 0.85 0.85 rg 72 700 468 40 re f${text}`;
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

export function helpers(app) {
  const b = () => app.browser;
  const content = async (id) => (await app.invoke("page_get", { id })).content;
  const create = async (title, text) => app.invoke("page_create", { title, parentId: null, content: text });
  async function open(id, title) {
    await app.invoke("search_open", { target: { kind: "page", page_id: id, new_tab: false } });
    await b().waitUntil(async () => (await b().execute(() => document.querySelector(".pane.active .page-title")?.value)) === title, { timeoutMsg: `${title} not open` });
    await app.waitFor(".pane.active .ProseMirror");
  }
  async function waitContent(id, check, msg) {
    let last = "";
    await b().waitUntil(async () => check((last = await content(id))), { timeout: 10000, timeoutMsg: `${msg}: ${JSON.stringify(last)}` });
    return last;
  }
  async function linksPanel() {
    await b().execute(() => {
      if (!document.querySelector(".app > .panel")) document.querySelector(".workspace > .pane:last-child .tabbar > button:last-of-type")?.click();
    });
    await app.click(".panel-tab:nth-child(3)");
    await app.waitFor(".links-panel");
  }
  /** Clicks the button matching `sel` whose text starts with `label` (inside `scope`). */
  const clickText = (scope, label) =>
    b().execute(
      (s, l) => {
        const el = [...document.querySelectorAll(s)].find((x) => x.textContent.trim().startsWith(l));
        el?.click();
        return !!el;
      },
      scope,
      label,
    );
  async function store(name, bytes) {
    const r = await b().executeAsync(
      (n, b64, done) => {
        const data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        window.__TAURI_INTERNALS__.invoke("attachment_store", data, { headers: { "x-annalo-name": encodeURIComponent(n) } }).then((ok) => done({ ok }), (err) => done({ err: String(err) }));
      },
      name,
      Buffer.from(bytes).toString("base64"),
    );
    if (r.err) throw new Error(r.err);
    return r.ok;
  }
  return { content, create, open, waitContent, linksPanel, clickText, store };
}

/** Unlinked mentions: link one, link all of a page, link from the open page, the inline hint. */
export async function mentionsFlow(app, L, shot) {
  const h = helpers(app);
  const portal = await h.create(L.portal, L.portalText);
  const plan = await h.create(L.plan, L.planText);
  const maint = await h.create(L.maint, L.maintText);
  const pay = await h.create(L.pay, "");
  await h.open(portal.id, L.portal);
  await h.linksPanel();
  await app.waitText(".mentions h3", new RegExp(L.mentionsTitle, "i"));
  await app.waitFor(`.mentions .mention-group[data-page="${plan.id}"]`);
  const groups = await app.browser.execute(() => [...document.querySelectorAll(".mentions .mention-group")].map((g) => ({ page: Number(g.dataset.page), n: g.querySelectorAll(".mention-item").length })));
  assert.deepEqual(
    groups.sort((a, b) => a.page - b.page),
    [
      { page: plan.id, n: 2 },
      { page: maint.id, n: 1 },
      { page: pay.id, n: 1 },
    ].sort((a, b) => a.page - b.page),
    "the code span is no mention",
  );
  if (shot) await app.shot(shot);

  // One mention (an inflection keeps its text as the alias).
  await app.click(`.mentions .mention-group[data-page="${maint.id}"] .mention-link`);
  await h.waitContent(maint.id, (c) => c === L.maintLinked, "link one");
  // All mentions of a page.
  await app.waitFor(`.mentions .mention-group[data-page="${plan.id}"] .mention-link-all`);
  await app.click(`.mentions .mention-group[data-page="${plan.id}"] .mention-link-all`);
  await h.waitContent(plan.id, (c) => c === L.planLinked, "link all");
  await app.browser.waitUntil(async () => !(await app.browser.execute((p, m) => !!document.querySelector(`.mentions .mention-group[data-page="${p}"], .mentions .mention-group[data-page="${m}"]`), plan.id, maint.id)), { timeoutMsg: "linked mentions still listed" });
  // In the open page itself: the editor shows the new link.
  await app.click(`.mentions .mention-group[data-page="${pay.id}"] .mention-link`);
  await h.waitContent(portal.id, (c) => c.includes(`[[${L.pay}]]`), "link in the open page");
  await app.waitFor(`.pane.active .ProseMirror .wikilink[data-target="${L.pay}"]`);
  // The backlinks moved with it: the portal page now has backlinks from the linked pages.
  const doc = await app.invoke("page_get", { id: portal.id });
  assert.deepEqual(doc.backlinks.map((x) => x.page_id).sort(), [plan.id, maint.id].sort());

  // Inline hints (off by default): a dotted underline, a click links.
  const view = await app.invoke("settings_get");
  assert.equal(view.settings.editor.mention_hints, false);
  await app.invoke("settings_save", { settings: { ...view.settings, editor: { ...view.settings.editor, mention_hints: true } } });
  const note = await h.create(L.hintPage, L.hintText);
  await h.open(note.id, L.hintPage);
  await app.waitFor(".pane.active .ProseMirror .mention-hint", 10000);
  await app.click(".pane.active .ProseMirror .mention-hint");
  await app.waitFor(`.pane.active .ProseMirror .wikilink[data-target="${L.pay}"]`);
  await h.waitContent(note.id, (c) => c.includes(`[[${L.pay}`), "inline hint");
  await app.invoke("settings_save", { settings: { ...view.settings, editor: { ...view.settings.editor, mention_hints: false } } });
}

/** A local tag suggestion is accepted into the frontmatter; another one is dismissed. */
export async function tagsFlow(app, L) {
  const h = helpers(app);
  const a = await h.create(L.tagA, L.tagAText);
  await h.create(L.tagB, L.tagBText);
  const p = await h.create(L.tagPage, L.tagPageText);
  await h.open(p.id, L.tagPage);
  await app.waitFor(`.pane.active .tag-suggest-chip[data-tag="${L.tag}"]`, 10000);
  await app.waitText(".pane.active .tag-suggest-label", new RegExp(L.suggestionLabel));
  await app.click(`.pane.active .tag-suggest-chip[data-tag="${L.tag}"] .tag-suggest-accept`);
  await h.waitContent(p.id, (c) => c.startsWith(`---\ntags: [${L.tag}]\n---\n`), "accepted tag");
  assert.ok((await app.invoke("page_get", { id: p.id })).tags.includes(L.tag));
  void a;
}

/** A duplicate hint: compare side by side, merge (links moved, other page in the trash), undo. */
export async function duplicatesFlow(app, L, shot) {
  const h = helpers(app);
  const a = await h.create(L.dupA, L.dupText);
  const b = await h.create(L.dupB, `${L.dupText}\n\n${L.dupExtra}`);
  const src = await h.create(L.dupSrc, `[[${L.dupB}]]`);
  await h.open(a.id, L.dupA);
  await app.waitFor(".pane.active .dup-hint", 10000);
  await app.waitText(".pane.active .dup-hint", new RegExp(`${L.similarLabel}.*${L.dupB}.*\\d+ %`));
  await app.click(".pane.active .dup-compare");
  await app.waitFor(".compare .compare-row");
  const changed = await app.browser.execute(() => [...document.querySelectorAll(".compare-row.is-changed pre.diff-add")].map((p) => p.textContent));
  assert.ok(changed.includes(L.dupExtra), JSON.stringify(changed));
  if (shot) await app.shot(shot);
  await app.keys(["Escape"]);
  await app.browser.waitUntil(async () => !(await app.browser.execute(() => !!document.querySelector(".compare"))), { timeoutMsg: "compare dialog open" });

  await app.click(".pane.active .dup-merge");
  await app.waitFor(".dialog .btn-primary");
  await app.click(".dialog .btn-primary");
  await h.waitContent(a.id, (c) => c.includes(`## ${L.dupB}`) && c.includes(L.dupExtra), "merged content");
  assert.equal(await h.content(src.id), `[[${L.dupA}]]`, "links point to the kept page");
  assert.ok((await app.invoke("page_get", { id: b.id })).deleted_at, "the other page is in the trash");
  // Undo from the toast.
  await app.browser.waitUntil(() => h.clickText(".toasts .btn-ghost", L.undo), { timeoutMsg: "no undo in the toast" });
  await h.waitContent(a.id, (c) => c === L.dupText, "undo restores the content");
  assert.equal(await h.content(src.id), `[[${L.dupB}]]`);
  assert.equal((await app.invoke("page_get", { id: b.id })).deleted_at, null);
  // The command lists the pair.
  const pairs = await app.invoke("duplicates_all");
  assert.ok(pairs.some((x) => [x.a, x.b].sort().join() === [a.id, b.id].sort().join()));
}

/** PDF highlights: select, highlight, note, into the note, the link opens the page and flashes it; a scan shows the hint. */
export async function pdfFlow(app, L, shot) {
  const h = helpers(app);
  await h.store(L.pdf, makePdf([L.pdfPage1, L.pdfPage2]));
  await h.store(L.scan, makePdf([""]));
  const page = await h.create(L.readPage, `${L.readIntro} [[${L.pdf}]] [[${L.scan}]]`);
  await h.open(page.id, L.readPage);
  // A click on the file link opens the viewer.
  await app.click(`.pane.active .ProseMirror .wikilink.file-link[data-file-link="${L.pdf}"]`);
  await app.waitFor('.pdf-overlay .pdf-page[data-page="2"].is-rendered .textLayer span', 15000);
  // Select the text of page 2 and highlight it in green.
  await app.browser.execute(() => document.querySelector('.pdf-overlay .pdf-page[data-page="2"]').scrollIntoView({ block: "center" }));
  await app.browser.pause(300);
  await app.browser.execute(() => {
    const span = [...document.querySelectorAll('.pdf-overlay .pdf-page[data-page="2"] .textLayer span')].find((s) => s.textContent.trim());
    const r = document.createRange();
    r.selectNodeContents(span);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    document.querySelector(".pdf-overlay .pdf-scroll").dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  await app.waitFor(".pdf-selbar .pdf-swatch.is-green");
  await app.click(".pdf-selbar .pdf-swatch.is-green");
  await app.waitFor('.pdf-overlay .pdf-page[data-page="2"] .pdf-mark.is-green');
  const [hl] = await app.invoke("pdf_highlights_list", { name: L.pdf });
  assert.equal(hl.page, 2);
  assert.equal(hl.text, L.pdfPage2);
  assert.ok(hl.rects[0][2] > 0.1 && hl.rects[0][1] < 0.3, JSON.stringify(hl.rects));
  // Its popover: a note, then into the note.
  await app.click(".pdf-overlay .pdf-mark.is-green");
  await app.waitFor(".pdf-hl-pop textarea");
  await app.click(".pdf-hl-pop textarea");
  await app.type(L.hlNote);
  await app.keys(["Enter"]);
  await app.browser.waitUntil(async () => (await app.invoke("pdf_highlights_list", { name: L.pdf }))[0].note === L.hlNote, { timeoutMsg: "note not saved" });
  if (shot) await app.shot(shot);
  await app.click(".pdf-hl-pop .pdf-hl-take");
  const quote = `> ${L.q[0]}${L.pdfPage2}${L.q[1]} ([[${L.pdf}#page=2&hl=${hl.id}|${L.pageLabel} 2]])`;
  await h.waitContent(page.id, (c) => c.includes(quote) && c.includes(`> *${L.hlNote}*`), "quote in the note");
  // „Alle Markierungen übernehmen“.
  await app.click(".pdf-overlay .pdf-take-all");
  await h.waitContent(page.id, (c) => c.includes(L.summaryHead), "summary block");
  await app.keys(["Escape"]);
  await app.browser.waitUntil(async () => !(await app.browser.execute(() => !!document.querySelector(".pdf-overlay"))), { timeoutMsg: "viewer still open" });

  // The link in the quote opens the PDF on page 2 and flashes the highlight.
  await app.waitFor(`.pane.active .ProseMirror .wikilink.file-link[data-file-link="${L.pdf}"]`);
  await app.browser.execute((label) => {
    const link = [...document.querySelectorAll(".pane.active .ProseMirror .wikilink.file-link")].find((a) => a.textContent.trim() === label);
    link.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
  }, `${L.pageLabel} 2`);
  await app.waitFor(".pdf-overlay .pdf-mark.is-flash", 15000);
  await app.browser.waitUntil(async () => (await app.browser.execute(() => document.querySelector(".pdf-overlay .pdf-page-input")?.value)) === "2", { timeoutMsg: "not on page 2" });
  // Deleting a highlight.
  await app.click(".pdf-overlay .pdf-mark.is-green");
  await app.click(".pdf-hl-pop .pdf-hl-delete");
  await app.browser.waitUntil(async () => (await app.invoke("pdf_highlights_list", { name: L.pdf })).length === 0, { timeoutMsg: "not deleted" });
  await app.keys(["Escape"]);

  // A PDF without text: the hint.
  await app.click(`.pane.active .ProseMirror .wikilink.file-link[data-file-link="${L.scan}"]`);
  await app.waitText(".pdf-overlay .pdf-notext", new RegExp(L.noText), 15000);
  await app.keys(["Escape"]);
}
