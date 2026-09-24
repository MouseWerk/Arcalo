// Themes beyond Annalo Hell: code blocks, callouts, the slash menu, the formatting bubble, the
// inline AI bar and the PDF tab in Annalo Dunkel, Nord, Solarized Light and high contrast, and the
// white Beamer slides in a dark theme. Text is measured against the background it is drawn on (WCAG contrast).

import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
before(async () => (app = await launch()));
after(async () => app?.close());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A one-page PDF (Helvetica, not embedded). */
function makePdf(text) {
  const stream = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;
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

/**
 * Text in `root` with less than `min` contrast against its composited background, as
 * "ratio selector text". Skips hidden text, images, canvases, PDF pages and `skip`.
 */
function lowContrast(root, min, skip = null) {
  const parse = (c) => {
    let m = c.match(/^rgba?\(([^)]+)\)/);
    if (m) {
      const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
      return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
    }
    m = c.match(/^color\(srgb ([^)]+)\)/);
    if (m) {
      const p = m[1].split(/[ /]+/).filter(Boolean).map(Number);
      return [p[0] * 255, p[1] * 255, p[2] * 255, p.length > 3 ? p[3] : 1];
    }
    return null;
  };
  const lum = ([r, g, b]) => {
    const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
  const over = (top, bot) => [0, 1, 2].map((i) => top[i] * top[3] + bot[i] * (1 - top[3])).concat(1);
  const out = [];
  const box = document.querySelector(root);
  if (!box) return [`missing ${root}`];
  const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    if (!n.textContent.trim() || !el) continue;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    if (r.width < 2 || r.height < 2 || s.visibility === "hidden" || el.closest("canvas, .pdf-page, img, [aria-hidden=true]") || (skip && el.closest(skip))) continue;
    let opacity = 1;
    const bgs = [];
    for (let p = el; p; p = p.parentElement) {
      const ps = getComputedStyle(p);
      opacity *= Number(ps.opacity);
      const b = parse(ps.backgroundColor);
      if (b && b[3] > 0) bgs.push(b);
    }
    if (opacity < 0.9 || el.matches(":disabled, [aria-disabled=true]") || el.closest(":disabled")) continue;
    let bg = [255, 255, 255, 1];
    for (let i = bgs.length - 1; i >= 0; i--) bg = over(bgs[i], bg);
    const fg = parse(s.color);
    if (!fg) continue;
    const c = ratio(over(fg, bg), bg);
    if (c < min) out.push(`${c.toFixed(2)} ${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]} "${n.textContent.trim().slice(0, 24)}"`);
  }
  return out;
}

async function theme(mode, id) {
  const view = await app.invoke("settings_get");
  const ap = { ...view.settings.appearance };
  if (mode === "light") ap.theme_light = id;
  else ap.theme_dark = id;
  await app.invoke("settings_save", { settings: { ...view.settings, theme: mode, appearance: ap } });
  await app.browser.refresh();
  await app.browser.waitUntil(async () => app.browser.execute(() => document.body.classList.contains("ready")), { timeout: 20000 });
  await app.browser.waitUntil(async () => (await app.browser.execute(() => document.documentElement.dataset.themeId)) === id, { timeoutMsg: `theme ${id} not applied` });
  await sleep(500);
}

const NOTE = [
  "Das Auftragsportal übergibt Bestellungen an SAP.",
  "",
  "> [!question]",
  "> Wer gibt frei?",
  "",
  "```js",
  "// Kommentar",
  'import x from "y";',
  "const a = { ok: true, n: null, v: 42 };",
  "class Foo extends Bar { static run() { return `tpl ${a}`; } }",
  "```",
  "",
  "```python",
  "@decorator",
  "def f(x: int) -> None:",
  "    return None",
  "```",
  "",
  "Ende",
].join("\n");

let page;
let pdfOk = false;

test("setup: a note with code and a PDF", async () => {
  page = await app.invoke("page_create", { parentId: null, title: "Themen-Check", icon: null, content: NOTE });
  const r = await app.browser.executeAsync((b64, done) => {
    const data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    window.__TAURI_INTERNALS__.invoke("attachment_store", data, { headers: { "x-annalo-name": encodeURIComponent("Themen.pdf") } }).then((ok) => done({ ok }), (err) => done({ err: String(err) }));
  }, makePdf("Themen PDF").toString("base64"));
  assert.ok(r.ok, r.err);
  pdfOk = true;
});

for (const [mode, id] of [["dark", "annalo-dark"], ["dark", "nord"], ["light", "solarized-light"], ["dark", "contrast-dark"]]) {
  test(`${id}: code, callouts, slash menu, bubble, AI bar and PDF tab are readable`, async () => {
    await theme(mode, id);
    await app.invoke("search_open", { target: { kind: "page", page_id: page.id, new_tab: false } });
    await app.waitFor(".pane.active .ProseMirror pre");
    await sleep(500);

    // Code: its own background, every token readable on it.
    // Comments are quieter on purpose (--text-3, at least 3:1); every other token 4.5:1.
    assert.deepEqual(await app.browser.execute(lowContrast, ".pane.active .ProseMirror pre", 4.5, ".hljs-comment"), [], `${id} code tokens`);
    assert.deepEqual(await app.browser.execute(lowContrast, ".pane.active .ProseMirror pre", 3), [], `${id} code comments`);
    const tokens = await app.browser.execute(() => new Set([...document.querySelectorAll(".pane.active pre [class^=hljs-]")].map((s) => getComputedStyle(s).color)).size);
    assert.ok(tokens >= 4, `${id}: several syntax colors (${tokens})`);
    const bgs = await app.browser.execute(() => [getComputedStyle(document.querySelector(".pane.active pre")).backgroundColor, getComputedStyle(document.querySelector(".pane.active .page-scroll")).backgroundColor]);
    assert.notEqual(bgs[0], bgs[1], `${id}: code block background differs from the page`);
    // The callout label (violet) and the page text.
    assert.deepEqual(await app.browser.execute(lowContrast, ".pane.active .ProseMirror", 4.5, ".hljs-comment"), [], `${id} page text`);
    const label = await app.browser.execute(() => {
      const m = document.querySelector(".pane.active blockquote.callout-question .callout-marker");
      return getComputedStyle(m, "::before").content;
    });
    assert.equal(label, '"Frage"');
    await app.shot(`themes-${id}-note`);

    // Slash menu at the end of the note.
    await app.browser.execute(() => document.querySelector(".pane.active .ProseMirror").editor.commands.focus("end"));
    await app.keys(["Enter"]);
    await app.type("/");
    await app.waitFor(".sugg");
    await sleep(300);
    assert.deepEqual(await app.browser.execute(lowContrast, ".sugg", 3), [], `${id} slash menu`);
    assert.deepEqual(await app.browser.execute(lowContrast, ".sugg .sugg-title", 4.5), [], `${id} slash menu titles`);
    await app.shot(`themes-${id}-slash`);
    await app.keys(["Escape"]);
    await app.keys(["Backspace"]);

    // Formatting bubble and inline AI bar over a selection.
    await app.browser.execute(() => {
      const ed = document.querySelector(".pane.active .ProseMirror").editor;
      ed.commands.focus();
      ed.commands.setTextSelection({ from: 1, to: 18 });
    });
    await app.waitFor(".bubble");
    await sleep(300);
    const bubble = await app.browser.execute(() => {
      const b = document.querySelector(".bubble");
      const icons = [...b.querySelectorAll("svg")].map((s) => getComputedStyle(s).color);
      return { icons: icons.length, bg: getComputedStyle(b).backgroundColor };
    });
    assert.ok(bubble.icons >= 5, `${id}: bubble buttons`);
    assert.deepEqual(await app.browser.execute(lowContrast, ".bubble", 3), [], `${id} bubble`);
    await app.shot(`themes-${id}-bubble`);
    await app.keys(["Control", "j"]);
    await app.waitFor(".ai-bar");
    await sleep(300);
    assert.deepEqual(await app.browser.execute(lowContrast, ".ai-bar", 3), [], `${id} AI bar`);
    await app.shot(`themes-${id}-aibar`);
    await app.keys(["Escape"]);
    await app.browser.execute(() => document.querySelector(".pane.active .ProseMirror").editor.commands.undo());

    // PDF tab: toolbar readable, the page is paper white.
    if (pdfOk) {
      await app.invoke("search_open", { target: { kind: "page", page_id: page.id, new_tab: false } });
      await app.keys(["Control", "k"]);
      const input = await app.waitFor(".palette input");
      await input.setValue("Anhänge verwalten");
      await app.waitText(".pal-item.sel", /Anhänge/);
      await app.keys(["Enter"]);
      await app.waitFor('.att-row[data-file="Themen.pdf"] .att-name');
      await app.browser.execute(() => document.querySelector('.att-row[data-file="Themen.pdf"] .att-name').click());
      await app.waitFor(".pane.active .pdf-pane .pdf-page", 15000);
      await sleep(800);
      assert.deepEqual(await app.browser.execute(lowContrast, ".pane.active .pdf-pane", 3), [], `${id} PDF tab`);
      await app.shot(`themes-${id}-pdf`);
      await app.browser.execute(() => document.querySelector(".pane.active .tab.active .tab-close").click());
    }
  });
}

test("„Beamer“ slides are dark on white in a dark theme too", async () => {
  await theme("dark", "annalo-dark");
  const p = await app.invoke("page_create", {
    parentId: null,
    title: "Beamer-Check",
    icon: null,
    content: "# Code\n\n> [!question] Frage\n> Text mit [Link](https://example.com) und ==Markierung==[^1]\n\n```js\nconst a = { ok: true, n: null, v: 42 };\n```\n\n[^1]: Fußnote\n",
  });
  await app.invoke("search_open", { target: { kind: "page", page_id: p.id, new_tab: false } });
  await app.waitFor(".pane.active .ProseMirror");
  await app.click('.pane.active .vh [aria-label="Weitere Aktionen"]');
  await app.browser.execute(() => [...document.querySelectorAll(".menu .menu-item")].find((b) => b.textContent.trim().startsWith("Präsentieren")).click());
  await app.waitFor(".presentation .present-slide");
  const beamer = () => app.browser.execute(() => document.querySelector(".presentation").classList.contains("beamer"));
  if (!(await beamer())) await app.keys(["b"]);
  await app.browser.waitUntil(beamer, { timeoutMsg: "no beamer look" });
  await sleep(1200);
  assert.deepEqual(await app.browser.execute(lowContrast, ".presentation .slide-content", 4.5), [], "beamer slide text");
  await app.shot("themes-beamer-dark");
  await app.keys(["b"]);
  await app.keys(["Escape"]);
  await app.browser.waitUntil(async () => (await app.$$(".presentation")).length === 0);
});
