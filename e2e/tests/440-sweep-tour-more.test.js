// The second screenshot tour (q123 round 2): what the first tour (412) left out. The presentation
// (every slide type, Beamer, the presenter overlay, the controls), drawings (the Excalidraw editor,
// its tools menu and Mermaid dialog, the embed's preview in a note), images in notes (sizes, a
// caption, side by side, a table cell, the image menu and its size submenu, the full screen
// viewer, the hover preview of a linked note), the PDF card and viewer, the Jira surfaces against
// a fake Jira (Issues list, row menu, issue view, a chip's hover card, the create dialog, Settings
// → Jira with a site), the intro and setup, the update toast and its release notes, the voice
// bar (recording, paused, transcribing, done; a WAV file stands in for the microphone), the
// capture window, the graph (panel, list, search) and the context menus of the start page, the
// ribbon, tasks, attachments, the board, a canvas and the editor. Six combinations of language,
// theme and size, like 412. Every stop is photographed and checked by the layout audit (and in
// English for German words); a stop that cannot be reached or does not close with Esc is a finding.
import { test as nodeTest, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { launch, guarded, EDITOR } from "../lib/harness.js";
import { launchEnglish } from "../lib/english.js";
import { createTour, PANE, sleep } from "../lib/tour.js";
import { defaultIssues, pngOf, startFakeJira } from "../lib/fake-jira.js";
import { makePdf } from "../lib/pdf.js";
import { startFeed, throwawayKey } from "../lib/update-feed.js";
import { voiceFixtures } from "../lib/voice.js";
import { openCapture } from "../lib/capture.js";

const test = guarded(nodeTest, () => app);
let app;
let jira;
let feed;
let fx;
let enDir = null;
const key = throwawayKey();
after(async () => {
  await app?.close();
  await jira?.close();
  await feed?.close();
  if (enDir) fs.rmSync(enDir, { recursive: true, force: true });
  if (fx) fs.rmSync(fx.dir, { recursive: true, force: true });
});

const tour = createTour(() => app, {
  prefix: "tour2",
  auditOk: [
    // Multi-line buttons: cards and rows are buttons on purpose.
    /^wraps: /,
    // The page icon sits left of the title column.
    /^overflows header\.page-header .*button\.page-icon-btn/,
    // Containers that scroll sideways on purpose: the board, wide tables, code, a narrow toolbar.
    /^cut sideways: (div\.board|div\.coll-table-wrap|pre|div\.editor-toolbar)\b/,
    /^overlap: button\.tb-/,
    // The query block's checkboxes and the scroll outline's marks are small on purpose.
    /^tiny: button\.(so-mark|qb-check)/,
    // The intro's scene bar: thin segments with a taller hit area, also reached with the arrows.
    /^tiny: button\.fr-seg/,
    // The canvas board is larger than its view and scrolls (pans) inside it.
    /^cut sideways: div\.cv-board\b/,
  ],
  // Names of the fixtures and of the fake Jira's people and projects.
  // The setup describes each language in that language („Deutsch“ in German).
  germanOk: [/Mia Meyer|Acme|PROJ-\d+/, /Panorama|Hochkant|Quadrat/, /Hilfetexte auf Deutsch/],
});
const t = (k, v) => tour.t(k, v);
const de = () => tour.lang === "de";

const ENV = { ARCALO_SECRET_STORE: "file", ARCALO_BACKUP_DELAY_SECS: "3600", ARCALO_JIRA_DELAY_SECS: "600" };
const next = (v) => v.replace(/^(\d+)\.(\d+)\.(\d+).*$/, (_, a, b, c) => `${a}.${b}.${Number(c) + 1}`);

/** `attachment_store` with the raw bytes as body and the file name as header, like the drop handler. */
async function store(name, bytes) {
  const r = await app.browser.executeAsync(
    (n, b64, done) => {
      const data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      window.__TAURI_INTERNALS__
        .invoke("attachment_store", data, { headers: { "x-arcalo-name": encodeURIComponent(n) } })
        .then((ok) => done({ ok }), (err) => done({ err: String(err) }));
    },
    name,
    Buffer.from(bytes).toString("base64"),
  );
  if (r.err) throw new Error(r.err);
  return r.ok;
}

const SCENE = JSON.stringify({
  type: "excalidraw",
  version: 2,
  elements: [{ id: "r1", type: "rectangle", x: 0, y: 0, width: 220, height: 90, angle: 0, strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid", roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: null, seed: 1, version: 1, versionNonce: 1, isDeleted: false, boundElements: null, updated: 1, link: null, locked: false }],
  appState: {},
  files: {},
});
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="110" viewBox="0 0 240 110"><rect x="10" y="10" width="220" height="90" rx="4" fill="none" stroke="#1e1e1e" stroke-width="2"/></svg>';

/** The deck: every kind of slide the presentation knows. */
const DECK = (n) =>
  de()
    ? `# Quartalsbericht\n\nStand der Arbeiten im Herbst\n\n---\n\n## Ziele\n\n- Schneller liefern\n- Weniger Fehler\n  - im Login\n  - im Export\n1. Erstens\n2. Zweitens\n\n> [!notiz]\n> Begrüßen und die Agenda zeigen.\n\n---\n\n![[${n.wide}]]\n\n---\n\n## Zwei Bilder\n\n![[${n.square}|240]] ![[${n.tall}|240]]\n\n---\n\n## Code\n\n\`\`\`ts\nconst summe = werte.reduce((a, b) => a + b, 0); // eine längere Zeile, die auf der Folie umbrechen muss, statt abgeschnitten zu werden\n\`\`\`\n\n---\n\n## Tabelle\n\n| Name | Status | Stunden |\n| --- | --- | ---: |\n| Alpha | Offen | 2,5 |\n| Beta | Erledigt | 10 |\n\n---\n\n## Diagramm\n\n\`\`\`mermaid\ngraph LR\n  A[Idee] --> B[Plan] --> C[Ergebnis]\n\`\`\`\n\n---\n\n## Hinweise und Aufgaben\n\n> [!tip] Tipp\n> Mit [[Projektplan]] verknüpft\n\n> Ein Zitat zum Schluss.\n\n- [x] Erledigt\n- [ ] Offen\n\n---\n\n## Skizze\n\n![[${n.drawing}]]\n\n---\n\n# Danke\n`
    : `# Quarterly report\n\nWhere the work stands this autumn\n\n---\n\n## Goals\n\n- Ship faster\n- Fewer bugs\n  - in the login\n  - in the export\n1. First\n2. Second\n\n> [!note]\n> Greet and show the agenda.\n\n---\n\n![[${n.wide}]]\n\n---\n\n## Two images\n\n![[${n.square}|240]] ![[${n.tall}|240]]\n\n---\n\n## Code\n\n\`\`\`ts\nconst sum = values.reduce((a, b) => a + b, 0); // a longer line that has to wrap on the slide instead of being cut off at its edge\n\`\`\`\n\n---\n\n## Table\n\n| Name | Status | Hours |\n| --- | --- | ---: |\n| Alpha | Open | 2.5 |\n| Beta | Done | 10 |\n\n---\n\n## Diagram\n\n\`\`\`mermaid\ngraph LR\n  A[Idea] --> B[Plan] --> C[Result]\n\`\`\`\n\n---\n\n## Notes and tasks\n\n> [!tip] Tip\n> Linked to [[Project plan]]\n\n> A quote to finish.\n\n- [x] Done\n- [ ] Open\n\n---\n\n## Sketch\n\n![[${n.drawing}]]\n\n---\n\n# Thank you\n`;
const SLIDES = 10;

const IMAGES = (n) => {
  const [a, b, c] = de() ? ["Bilder in Notizen", "Bildunterschrift", "Zelle"] : ["Images in notes", "Caption", "Cell"];
  return `# ${a}\n\n![[${n.small}]]\n\n![[${n.wide}|240]]\n\n![[${n.wide}|480]]\n\n![[${n.wide}|720]]\n\n![[${n.square}|${b}]]\n\n![[${n.square}|240]] ![[${n.tall}|240]]\n\n| ${c} | ${de() ? "Bild" : "Image"} |\n| --- | --- |\n| A | ![[${n.small}\\|120]] |\n\n![[${n.drawing}]]\n\n${n.pdf.markdown}\n`;
};

let pages;
/** Pages and files for the tour, in the current language. */
async function seed() {
  const names = {
    wide: (await store("Panorama.png", pngOf(1600, 500, [40, 120, 200]))).name,
    tall: (await store("Hochkant.png", pngOf(500, 1400, [200, 90, 40]))).name,
    square: (await store("Quadrat.png", pngOf(800, 800, [60, 160, 90]))).name,
    small: (await store("Klein.png", pngOf(96, 96, [150, 60, 160]))).name,
    pdf: await store("Handbuch.pdf", makePdf(de() ? ["Erste Seite", "Zweite Seite Suchwort", "Dritte Seite"] : ["First page", "Second page keyword", "Third page"])),
  };
  const drawing = await app.invoke("drawing_create", { title: de() ? "Ablauf" : "Flow" });
  await app.invoke("drawing_save", { name: drawing.name, scene: SCENE, svg: SVG });
  names.drawing = drawing.name;
  const mk = (title, content) => app.invoke("page_create", { parentId: null, title, icon: null, content });
  const deck = await mk(de() ? "Vortrag Tour" : "Talk tour", DECK(names));
  const images = await mk(de() ? "Bilder Tour" : "Images tour", IMAGES(names));
  const link = await mk(de() ? "Verweis Tour" : "Link tour", de() ? "Siehe [[Bilder Tour]] und PROJ-123 hier.\n\n- [ ] Ein Issue daraus machen\n" : "See [[Images tour]] and PROJ-123 here.\n\n- [ ] Make an issue of it\n");
  const canvas = await app.invoke("canvas_create", { parentId: null, title: de() ? "Tafel Tour" : "Board tour" });
  const board = await mk(de() ? "Board Tour" : "Board tour list", de() ? "---\neigenschaften:\n  status: {typ: auswahl, optionen: {Offen: blau, Erledigt: grün}}\nansicht: board\n---\n" : "---\nproperties:\n  status: {type: select, options: {Open: blue, Done: green}}\nview: board\n---\n");
  await app.invoke("page_create", { parentId: board.id, title: de() ? "Karte A" : "Card A", icon: null, content: `---\nstatus: ${de() ? "Offen" : "Open"}\n---\n` });
  return { names, deck: deck.id, images: images.id, link: link.id, canvas: canvas.id, board: board.id };
}

async function openPage(id, ready = EDITOR) {
  await app.invoke("search_open", { target: { kind: "page", page_id: id, new_tab: false } });
  await app.waitFor(`${PANE} ${ready}`);
  await sleep(500);
}
/** Waits until every image in `sel` has loaded. */
const loaded = (sel) =>
  app.browser.waitUntil(() => app.browser.execute((s) => [...document.querySelectorAll(s)].length > 0 && [...document.querySelectorAll(s)].every((i) => i.complete), sel), { timeout: 10000, timeoutMsg: `${sel} did not load` });

async function openSettings(section) {
  if (!(await app.browser.execute((p) => !!document.querySelector(`${p} .settings-nav, ${p} .settings-section-select`), PANE))) {
    await app.keys(["Control", ","]);
    await app.browser.waitUntil(() => app.browser.execute((p) => [...document.querySelectorAll(`${p} .settings-nav-item, ${p} .settings-section-select`)].some((e) => e.offsetParent), PANE), { timeoutMsg: "no settings" });
  }
  const listed = await app.browser.execute((p, s) => {
    const b = [...document.querySelectorAll(`${p} .settings-nav-item[data-section="${s}"]`)].find((x) => x.offsetParent);
    b?.click();
    return !!b;
  }, PANE, section);
  if (!listed) await app.select(`${PANE} .settings-section-select`, section);
  await sleep(400);
}

/** What a slide of the deck must show (the slide number counts from 1). */
async function slideChecks(i) {
  const m = await app.browser.execute(() => {
    const c = document.querySelector(".presentation .present-slide .slide-content");
    const box = document.querySelector(".presentation .present-slide").getBoundingClientRect();
    const unit = 1600 / box.width;
    const ol = c.querySelector("ol");
    const cell = [...c.querySelectorAll("td")].pop();
    const img = c.querySelector("img.slide-drawing");
    return {
      olPad: ol ? parseFloat(getComputedStyle(ol).paddingLeft) / parseFloat(getComputedStyle(ol).fontSize) : null,
      cell: cell ? getComputedStyle(cell).textAlign : null,
      drawing: img ? Math.round(img.getBoundingClientRect().width * unit) : null,
    };
  });
  // A numbered list's „1.“ stays inside the text column (it stood left of the title).
  if (m.olPad != null && m.olPad < 1.5) tour.note(`present-slide-${i}`, `a numbered list's numbers stick out on the left (padding ${m.olPad.toFixed(2)} em)`);
  // `---:` right-aligns the hours on the slide too.
  if (i === 6 && m.cell !== "right") tour.note("present-slide-6", `the right-aligned column is aligned ${m.cell}`);
  // The 240 px drawing is enlarged like the text (it was a sixth of the slide).
  if (i === 9 && !(m.drawing > 350)) tour.note("present-slide-9", `the drawing stays small: ${m.drawing} design px`);
}

/** Every slide, the controls, Beamer, the presenter overlay and the presentation's menu. */
async function presentation() {
  await tour.stop("present-slides", async () => {
    await openPage(pages.deck);
    await tour.command("cmd.present");
    await app.waitFor(".presentation .present-slide");
    for (let i = 1; i <= SLIDES; i++) {
      if (i > 1) await app.keys(["ArrowRight"]);
      await app.waitText(".presentation .present-counter", new RegExp(`^${i} / ${SLIDES}$`));
      await app.browser.waitUntil(() => app.browser.execute(() => [...document.querySelectorAll(".presentation .slide-content img")].every((im) => im.complete) && !document.querySelector(".presentation figure.slide-diagram:empty")), { timeout: 10000, timeoutMsg: `slide ${i} not settled` });
      await tour.shot(`present-slide-${i}`, ".presentation .present-slide");
      // Nothing sticks out of the slide.
      const cut = await app.browser.execute(() => {
        const box = document.querySelector(".presentation .present-slide").getBoundingClientRect();
        return [...document.querySelectorAll(".presentation .present-slide .slide-content *")]
          .filter((el) => {
            const r = el.getBoundingClientRect();
            return r.width && r.height && (r.left < box.left - 1 || r.right > box.right + 1 || r.top < box.top - 1 || r.bottom > box.bottom + 1);
          })
          .map((el) => `${el.tagName.toLowerCase()}.${el.className}`);
      });
      if (cut.length) tour.note(`present-slide-${i}`, `sticks out of the slide: ${cut.slice(0, 3).join(", ")}`);
      await slideChecks(i);
    }
    // The controls show on a mouse move.
    await app.browser.execute(() => document.querySelector(".presentation").dispatchEvent(new MouseEvent("mousemove", { bubbles: true })));
    await sleep(300);
    await tour.shot("present-controls", ".presentation");
    await app.keys(["Home"]);
    await app.keys(["b"]);
    await app.waitFor(".presentation.beamer");
    await tour.shot("present-beamer-title", ".presentation .present-slide");
    await app.keys(["6", "Enter"]);
    await tour.shot("present-beamer-table", ".presentation .present-slide");
    await app.keys(["7", "Enter"]);
    await sleep(600);
    await tour.shot("present-beamer-diagram", ".presentation .present-slide");
    await app.keys(["b"]);
    await app.keys(["2", "Enter"]);
    await app.keys(["r"]);
    await app.waitFor(".presentation .presenter");
    await tour.shot("present-presenter", ".presentation .presenter");
    // „Aktuelle Folie 2 / 10 · Ziele“: the dot has the same room on both sides (it had a gap and a space).
    const gaps = await app.browser.execute(() =>
      [...document.querySelectorAll(".presentation .presenter-label")].flatMap((l) => {
        const sep = l.querySelector(".presenter-sep");
        if (!sep) return [];
        const r = sep.getBoundingClientRect();
        return [[Math.round(r.left - sep.previousElementSibling.getBoundingClientRect().right), Math.round(sep.nextElementSibling.getBoundingClientRect().left - r.right)]];
      }),
    );
    if (gaps.length !== 2 || gaps.some(([a, b]) => Math.abs(a - b) > 1)) tour.note("present-presenter", `uneven room around the separators: ${JSON.stringify(gaps)}`);
    // In a narrow window the parts stack: the current slide never runs under the next one, the labels keep their line.
    const stack = await app.browser.execute(() => {
      const r = (s) => document.querySelector(`.presentation ${s}`)?.getBoundingClientRect();
      const cur = r(".presenter-current");
      const nxt = r(".presenter-next");
      const overlap = !!cur && !!nxt && cur.left < nxt.right && nxt.left < cur.right && cur.top < nxt.bottom && nxt.top < cur.bottom;
      return { overlap, labels: [...document.querySelectorAll(".presentation .presenter-label")].map((l) => Math.round(l.getBoundingClientRect().height)) };
    });
    if (stack.overlap || stack.labels.some((h) => h < 10)) tour.note("present-presenter", `the presenter's parts overlap or shrink: ${JSON.stringify(stack)}`);
    await app.keys(["ArrowRight"]);
    await tour.shot("present-presenter-no-notes", ".presentation .presenter");
    // The hint's syntax pieces stay on one line each.
    const broken = await app.browser.execute(() => [...document.querySelectorAll(".presentation .presenter-hint code")].filter((c) => c.getClientRects().length > 1).map((c) => c.textContent));
    if (broken.length) tour.note("present-presenter-no-notes", `syntax broken over lines: ${broken.join(", ")}`);
    await app.keys(["r"]);
  });
  await tour.stop("present-right-click", async () => {
    if (!(await app.browser.execute(() => !!document.querySelector(".presentation")))) {
      await openPage(pages.deck);
      await tour.command("cmd.present");
      await app.waitFor(".presentation .present-slide");
    }
    // A right-click goes back a slide, as in other presentation programs (no menu).
    await app.keys(["3", "Enter"]);
    await app.waitText(".presentation .present-counter", new RegExp(`^3 / ${SLIDES}$`));
    await tour.rightClick(".presentation .present-slide", ".presentation");
    await app.waitText(".presentation .present-counter", new RegExp(`^2 / ${SLIDES}$`));
  });
  // The presentation itself is no menu or dialog of the tour's list: end it.
  if (await app.browser.execute(() => !!document.querySelector(".presentation"))) {
    await app.keys(["Escape"]);
    await app.browser.waitUntil(() => app.browser.execute(() => !document.querySelector(".presentation")), { timeoutMsg: "the presentation does not end with Esc" }).catch((e) => tour.note("present", e.message));
  }
}

/** Images in a note, their menus, the viewer, the hover preview; the drawing; the PDF. */
async function media() {
  await tour.stop("images", async () => {
    await openPage(pages.images);
    await loaded(`${PANE} ${EDITOR} img.embed-image`);
    const scroller = `${PANE} .page-scroll`;
    const pagesN = await app.browser.execute((s) => {
      const el = document.querySelector(s);
      el.scrollTop = 0;
      return Math.ceil(el.scrollHeight / el.clientHeight);
    }, scroller);
    for (let i = 0; i < Math.min(pagesN, 6); i++) {
      await app.browser.execute((s, k) => (document.querySelector(s).scrollTop = document.querySelector(s).clientHeight * k * 0.9), scroller, i);
      await tour.shot(`images-${i + 1}`, PANE);
    }
  });
  await tour.stop("image-menu", async () => {
    await openPage(pages.images);
    await loaded(`${PANE} ${EDITOR} img.embed-image`);
    await tour.rightClick(`${PANE} ${EDITOR} img.embed-image`);
    await tour.shot("image-menu");
    await tour.clickText(".menu-item", new RegExp(`^${t("img.size")}`));
    await app.browser.waitUntil(() => app.browser.execute((txt) => [...document.querySelectorAll(".menu-item")].some((m) => m.textContent.includes(txt)), t("img.large")), { timeoutMsg: "no size submenu" });
    await tour.shot("image-menu-size");
  });
  await tour.stop("image-viewer", async () => {
    await tour.rightClick(`${PANE} ${EDITOR} img.embed-image`);
    await tour.clickText(".menu-item", new RegExp(t("img.fullscreen")));
    await app.waitFor(".image-viewer");
    await tour.shot("image-viewer", ".image-viewer");
  });
  await tour.stop("table-image-menu", async () => {
    await tour.rightClick(`${PANE} ${EDITOR} td img.embed-image`);
    await tour.shot("table-image-menu");
  });
  await tour.stop("drawing-embed", async () => {
    const embed = await app.waitFor(`${PANE} .drawing-embed`);
    await app.browser.execute((e) => e.scrollIntoView({ block: "center" }), embed);
    await embed.moveTo();
    await tour.shot("drawing-embed", PANE);
  });
  await tour.stop("drawing-editor", async () => {
    await app.click(`${PANE} .drawing-embed`);
    await app.waitFor(".drawing-overlay canvas.excalidraw__canvas.interactive", 20000);
    await sleep(800);
    await tour.shot("drawing-editor", ".drawing-overlay .drawing-header", { german: false });
    await app.click(".drawing-overlay .App-toolbar__extra-tools-trigger");
    await sleep(300);
    await tour.shot("drawing-tools-menu", ".drawing-overlay .drawing-header", { german: false });
    await tour.clickText(".drawing-overlay .dropdown-menu-item", /Mermaid/);
    await app.waitFor(".ttd-dialog-input");
    await app.browser.waitUntil(() => app.browser.execute(() => !!document.querySelector(".ttd-dialog-output-canvas-container canvas")), { timeout: 15000, timeoutMsg: "no Mermaid preview" }).catch(() => {});
    await tour.shot("drawing-mermaid", ".drawing-overlay .drawing-header", { german: false });
    await app.keys(["Escape"]);
    await app.browser.waitUntil(async () => (await app.$$(".ttd-dialog-input")).length === 0, { timeoutMsg: "Esc does not close the Mermaid dialog" });
    await app.click(".drawing-done");
    await app.browser.waitUntil(async () => (await app.$$(".drawing-overlay")).length === 0, { timeoutMsg: "the editor does not close" });
  });
  await tour.stop("pdf-card", async () => {
    const card = await app.waitFor(`${PANE} .pdf-embed`);
    await app.browser.execute((e) => e.scrollIntoView({ block: "center" }), card);
    await app.browser.waitUntil(() => app.browser.execute((p) => !!document.querySelector(`${p} .pdf-embed.is-ready, ${p} .pdf-embed.is-failed`), PANE), { timeout: 15000, timeoutMsg: "PDF preview not ready" });
    await tour.shot("pdf-card", PANE);
    await tour.rightClick(`${PANE} .pdf-embed`);
    await tour.shot("pdf-menu");
  });
  await tour.stop("pdf-viewer", async () => {
    await app.click(`${PANE} .pdf-embed`);
    await app.waitFor(".pdf-overlay .pdf-page canvas", 20000);
    await sleep(500);
    await tour.shot("pdf-viewer", ".pdf-overlay");
    await app.click(".pdf-search-input");
    await app.type(de() ? "Suchwort" : "keyword");
    await app.keys(["Enter"]);
    await sleep(600);
    await tour.shot("pdf-search", ".pdf-overlay");
  });
  await tour.stop("hover-preview", async () => {
    await openPage(pages.link);
    const link = await app.waitFor(`${PANE} ${EDITOR} .wikilink`);
    await link.moveTo();
    await app.waitFor(".link-preview-title");
    await loaded(".link-preview-body img").catch(() => {});
    await tour.shot("hover-preview", ".link-preview");
    // Images on lines of their own in the note stay on lines of their own in the preview.
    const tops = await app.browser.execute(() => [...document.querySelectorAll(".link-preview-body img")].slice(0, 2).map((i) => Math.round(i.getBoundingClientRect().top)));
    if (tops.length === 2 && tops[0] === tops[1]) tour.note("hover-preview", "two images of separate paragraphs share a line");
    await (await app.$(`${PANE} ${EDITOR} p`)).moveTo({ xOffset: -200 });
  });
}

/** The Jira surfaces against the fake Jira. */
async function jiraStops() {
  await tour.stop("issues", async () => {
    await app.click(".ribbon-issues");
    await app.waitFor('[data-issue-row="PROJ-123"]', 10000);
    await tour.shot("issues");
    // The summaries start at the same place in every group (OPS-7 and PROJ-123 are keys of different lengths).
    const lefts = await app.browser.execute(() => [...new Set([...document.querySelectorAll(".issues-view .issue-summary")].map((e) => Math.round(e.getBoundingClientRect().left)))]);
    if (lefts.length !== 1) tour.note("issues", `the summaries start at different places: ${lefts.join(", ")}`);
    await (await app.$('[data-issue-row="PROJ-123"] .issue-key')).moveTo();
    await sleep(300);
    await tour.shot("issues-hover");
    await tour.rightClick('[data-issue-row="PROJ-123"]');
    await tour.shot("issues-menu");
  });
  await tour.stop("issue-view", async () => {
    await app.keys(["Control", "k"]);
    await app.waitFor(".palette input");
    await app.type("PROJ-123");
    await app.browser.waitUntil(() => app.browser.execute((want) => (document.querySelector(".pal-item.sel")?.textContent ?? "").includes(want), t("cmd.issueOpenKey", { key: "PROJ-123" })), { timeoutMsg: "the issue is not the first item" });
    await app.keys(["Enter"]);
    await app.waitFor('[data-issue-view="PROJ-123"] .iv-summary, [data-issue-view="PROJ-123"] .iv-summary-edit', 15000);
    await app.browser.waitUntil(() => app.browser.execute(() => !document.querySelector(".iv-refreshing")), { timeout: 15000, timeoutMsg: "still loading" });
    await tour.shot("issue-view", ".iv");
    const tab = await tour.tabCycle(".iv", 8);
    if (tab.left) tour.note("issue-view", `Tab leaves the issue view to ${tab.left}`);
  });
  await tour.stop("issue-chip-card", async () => {
    await openPage(pages.link);
    const chip = await app.waitFor(`${PANE} ${EDITOR} .issue-chip[data-issue="PROJ-123"]`, 10000);
    await chip.moveTo();
    await app.waitFor(".issue-preview .issue-open-buttons", 6000);
    await tour.shot("issue-chip-card", ".issue-preview");
    await (await app.$(`${PANE} ${EDITOR} p`)).moveTo({ xOffset: -200 });
  });
  await tour.stop("jira-create", async () => {
    await openPage(pages.link);
    await tour.rightClick(`${PANE} ${EDITOR} li[data-checked]`);
    await tour.shot("editor-task-menu");
    await tour.clickText(".menu [role^='menuitem'], .menu button", new RegExp(t("jira.createTitle")));
    await app.waitFor(".dialog");
    await sleep(800);
    await tour.shot("jira-create");
    // The title field has the same room above it as stacked fields (it sat 3 px under the row of selects).
    const gap = await app.browser.execute(() => {
      const row = document.querySelector(".dialog .field-row");
      const next = row?.nextElementSibling;
      return row && next ? Math.round(next.getBoundingClientRect().top - row.getBoundingClientRect().bottom) : null;
    });
    if (!(gap >= 10)) tour.note("jira-create", `the title field sits ${gap} px under the row above`);
    // Tab stays in the dialog.
    const tab = await tour.tabCycle(".dialog", 8);
    if (tab.left) tour.note("jira-create", `Tab leaves the dialog to ${tab.left}`);
  });
  await tour.stop("settings-jira", async () => {
    await openSettings("jira");
    await tour.shot("settings-jira", PANE);
  });
}

/** Context menus not on the first tour. */
async function contextMenus() {
  await tour.stop("ctx-ribbon", async () => {
    // A right-click on „Heutige Tagesnotiz“ opens the calendar of daily notes.
    await tour.rightClick(".ribbon .ribbon-daily button", ".calendar");
    await tour.shot("ctx-ribbon-daily");
  });
  await tour.stop("ctx-home", async () => {
    await app.click(".pane.active .tabbar-home");
    await sleep(500);
    await tour.rightClick(`${PANE} .dash-tab`);
    await tour.shot("ctx-home-tab");
  });
  await tour.stop("ctx-tasks", async () => {
    await app.click(`.ribbon [aria-label^="${t("ribbon.tasks")}"]`);
    await tour.rightClick(`${PANE} .task-row`);
    await tour.shot("ctx-tasks");
  });
  await tour.stop("ctx-attachments", async () => {
    await tour.command("cmd.attachments");
    await tour.rightClick(`${PANE} .att-row[data-file] .att-c-name`);
    await tour.shot("ctx-attachments");
    // The drawing's „Bearbeiten“ (in Arcalo) and „Mit Standard-App öffnen“ (outside) have icons of their own.
    const icons = await app.browser.execute(() => [...document.querySelectorAll(".menu .menu-item")].slice(0, 2).map((m) => (m.querySelector("svg")?.getAttribute("class") ?? "").match(/lucide-[a-z0-9-]+/)?.[0] ?? ""));
    if (icons.length === 2 && icons[0] === icons[1]) tour.note("ctx-attachments", `two different actions share the icon ${icons[0]}`);
  });
  await tour.stop("ctx-board", async () => {
    await openPage(pages.board, ".board-card");
    await tour.rightClick(`${PANE} .board-card`);
    await tour.shot("ctx-board");
  });
  await tour.stop("ctx-canvas", async () => {
    await openPage(pages.canvas, ".canvas-view");
    await tour.shot("canvas", PANE);
    await tour.rightClick(`${PANE} .canvas-view`);
    await tour.shot("ctx-canvas");
  });
}

/** The graph: plain, with its settings panel, as a list, with a search. */
async function graph() {
  await tour.stop("graph", async () => {
    await app.click(`.ribbon [aria-label^="${t("ribbon.graph")}"]`);
    await app.waitFor(`${PANE} .graph-view`);
    await sleep(1200);
    await app.click(`${PANE} .graph-panel-toggle`);
    await sleep(400);
    await tour.shot("graph-panel", PANE);
    await app.click(`${PANE} .graph-panel-toggle`);
    await app.click(`${PANE} .graph-search-input`);
    await app.type(de() ? "Tour" : "tour");
    await sleep(500);
    await tour.shot("graph-search", PANE);
    await app.click(`${PANE} .graph-list-toggle`);
    await sleep(400);
    await tour.shot("graph-list", PANE);
    await app.click(`${PANE} .graph-list-toggle`);
  });
}

/** The voice bar: recording, paused, transcribing (as long as it lasts), done. */
async function voice() {
  await tour.stop("voice", async () => {
    await app.click(".ribbon-voice");
    await app.waitFor(".voice-bar .voice-rec", 10000);
    await sleep(1200);
    await tour.shot("voice-recording", ".voice-bar");
    await app.click(".voice-pause");
    await app.waitFor(".voice-rec.is-paused");
    await tour.shot("voice-paused", ".voice-bar");
    await app.click(".voice-pause");
    await app.click(".voice-stop");
    await app.waitFor(".voice-bar .voice-done", 20000);
    await tour.shot("voice-done", ".voice-bar");
  });
}

/** The intro and the setup, every step (rerun from the palette; closed without changes). */
async function intro() {
  await tour.stop("intro", async () => {
    await tour.command("cmd.intro");
    await app.waitFor(".fr-intro");
    await app.click(".fr-seg:nth-child(1)");
    await sleep(3300);
    await tour.shot("intro-scene-1", ".fr-overlay");
    await app.click(".fr-seg:nth-child(4)");
    await sleep(3300);
    await tour.shot("intro-scene-4", ".fr-overlay");
    await app.click(".fr-setup");
    await app.waitFor(".fr-intake");
    for (const id of ["language", "theme", "ai", "work", "calendar", "workspace", "done"]) {
      const rail = await app.browser.execute((s) => {
        const b = document.querySelector(`.fr-rail-item[data-step="${s}"]`);
        if (b?.offsetParent) b.click();
        return !!b?.offsetParent;
      }, id);
      if (!rail && id !== "language") await app.click(".fr-next");
      await app.waitFor(`.fr-step-${id}`);
      await sleep(450);
      await tour.shot(`setup-${id}`, ".fr-overlay");
    }
    await app.click(".fr-close");
    await app.browser.waitUntil(() => app.browser.execute(() => !document.querySelector(".fr-overlay")), { timeoutMsg: "the setup does not close" });
  });
}

/** A newer version on the feed: the toast and its release notes. */
async function update() {
  await tour.stop("update", async () => {
    const status = await app.invoke("update_status");
    feed.version = next(status.current_version);
    await openSettings("about");
    await app.dismissToasts();
    await tour.clickText(`${PANE} button`, new RegExp(t("upd.checkNow")));
    await app.waitFor(".update-toast", 15000);
    await tour.shot("update-toast", ".update-toast");
    // Each button of the toast has a name of its own (the menu button was „Später“ like the close button).
    const names = await app.browser.execute(() => [...document.querySelectorAll(".update-toast button")].map((b) => b.getAttribute("aria-label") || b.textContent.trim()));
    if (new Set(names).size !== names.length) tour.note("update-toast", `buttons share a name: ${names.join(" | ")}`);
    // With the voice bar shown, the toast stands above it (they covered each other).
    const [toast, bar] = [await tour.rect(".update-toast"), await tour.rect(".voice-bar")];
    if (toast && bar && toast.bottom > bar.top + 1 && toast.left < bar.right && toast.right > bar.left) tour.note("update-toast", `the toast covers the voice bar (${Math.round(toast.bottom)} > ${Math.round(bar.top)})`);
    await tour.clickText(".update-toast button", new RegExp(t("upd.whatsNew").replace("?", "\\?")));
    await app.waitFor("[role=dialog] .update-notes");
    await tour.shot("update-notes");
    // The notes' „## Neu“ is a section of the dialog, not larger than its title.
    const sizes = await app.browser.execute(() => {
      const d = document.querySelector("[role=dialog] .update-notes")?.closest("[role=dialog]");
      const fs = (e) => (e ? parseFloat(getComputedStyle(e).fontSize) : null);
      return { title: fs(d?.querySelector(".dialog-title")), heading: fs(d?.querySelector(".update-notes :is(h1, h2, h3)")) };
    });
    if (!(sizes.heading < sizes.title)) tour.note("update-notes", `the notes' heading is not smaller than the title: ${JSON.stringify(sizes)}`);
    const tab = await tour.tabCycle("[role=dialog]:has(.update-notes)", 6);
    if (tab.left) tour.note("update-notes", `Tab leaves the dialog to ${tab.left}`);
  });
  // The feed has nothing new again: the next combinations start without the toast.
  feed.version = "0.0.0";
  // „Später“ closes the update toast (it stays until then).
  await app.browser.execute((label) => document.querySelector(`.update-toast [aria-label="${label}"]`)?.click(), t("common.later"));
  await app.dismissToasts();
}

/** The capture window (its own window). */
async function capture() {
  await tour.stop("capture", async () => {
    const w = await openCapture(app);
    try {
      await tour.shot("capture", ".capture");
      await app.type(de() ? "Idee für morgen #projekt" : "Idea for tomorrow #project");
      await sleep(400);
      await tour.shot("capture-typed", ".capture");
      await app.keys(["Control", "a"]);
      await app.keys(["Backspace"]);
      await app.keys(["Escape"]);
    } finally {
      await w.toMain();
    }
  });
}

async function all({ full }) {
  await presentation();
  await media();
  await jiraStops();
  await contextMenus();
  await graph();
  if (full) {
    await voice();
    await update();
    // The finished voice note's row goes (it would stand over the intro's controls).
    await app.browser.execute((label) => document.querySelector(`.voice-bar .voice-done [aria-label="${label}"]`)?.click(), t("common.close"));
    await intro();
    await capture();
  }
}

async function start(english) {
  jira ??= await startFakeJira({ flavor: "cloud", issues: defaultIssues() });
  feed ??= await startFeed({ key, version: "0.0.0" });
  fx ??= voiceFixtures("[00:00] Guten Morgen.\n[00:02] Anna schickt das Angebot.\n");
  const env = { ...ENV, ...fx.env, ARCALO_UPDATE_PUBKEY: key.pubkey, ARCALO_UPDATE_ENDPOINT: feed.url };
  if (english) ({ app, dataDir: enDir } = await launchEnglish({ env: { ...env, ARCALO_LOCALE: "en-US" } }));
  else app = await launch({ demo: true, env });
  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", { settings: { ...view.settings, updates: { ...view.settings.updates, mode: "notify" } } });
  await app.invoke("jira_site_save", {
    site: { id: "", name: "Acme", color: "", kind: "cloud", url: jira.url, email: "mia@firma.de", enabled: true, log_work: false, allow_writes: true },
    token: "secret-token",
  });
  await app.invoke("jira_sync_now", { site: "acme" });
  pages = await seed();
}

test("German, light, 1480x920", { timeout: 1200000 }, async () => {
  await start(false);
  tour.combo = "de-light-1480";
  await tour.look("light", "arcalo-light", 1480, 920);
  await all({ full: true });
});

test("German, dark, 900x700", { timeout: 1200000 }, async () => {
  tour.combo = "de-dark-900";
  await tour.look("dark", "arcalo-dark", 900, 700);
  await all({ full: true });
});

test("German, high contrast dark, 1920x1080", { timeout: 1200000 }, async () => {
  tour.combo = "de-hcdark-1920";
  await tour.look("dark", "contrast-dark", 1920, 1080);
  await all({ full: false });
  await app.close();
  app = null;
});

test("English, high contrast light, 1480x920", { timeout: 1200000 }, async () => {
  tour.setLang("en");
  await start(true);
  tour.combo = "en-hclight-1480";
  await tour.look("light", "contrast-light", 1480, 920);
  await all({ full: true });
});

test("English, dark, 900x700", { timeout: 1200000 }, async () => {
  tour.combo = "en-dark-900";
  await tour.look("dark", "arcalo-dark", 900, 700);
  await all({ full: false });
});

test("English, light, 1920x1080", { timeout: 1200000 }, async () => {
  tour.combo = "en-light-1920";
  await tour.look("light", "arcalo-light", 1920, 1080);
  await all({ full: true });
});

test("no findings on the tour", () => {
  assert.deepEqual(tour.findings, []);
});
