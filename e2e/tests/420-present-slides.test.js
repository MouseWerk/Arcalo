// Presentation quality: every block type on a slide (images of all sizes and aspect ratios,
// Markdown images, side-by-side images, drawings, long code, wide tables, long lists, Mermaid),
// nothing cut off at 900 and 1920 px, white Beamer slides with light diagrams in a dark theme,
// keys never edit the note underneath, the focus and the window come back after the end and
// after a reload, the slides follow changes of the note, notes with only `##` sections.

import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";
import { pngOf } from "../lib/fake-jira.js";

const test = guarded(nodeTest, () => app);
let app;
before(async () => (app = await launch()));
after(async () => app?.close());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const counter = (re) => app.waitText(".presentation .present-counter", re);
/** Jumps to slide `n` with its number and Enter (WebKit's WebDriver sends a repeated digit once, so 11 goes by End). */
const jump = (n, last = 11) => app.keys(n === last ? ["End"] : [...String(n), "Enter"]);
const isFullscreen = () => app.browser.executeAsync((done) => window.__TAURI__.window.getCurrentWindow().isFullscreen().then(done, () => done(null)));

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
  return r.ok.name ?? r.ok;
}

async function theme(mode, id) {
  const view = await app.invoke("settings_get");
  const ap = { ...view.settings.appearance };
  if (mode === "light") ap.theme_light = id;
  else ap.theme_dark = id;
  await app.invoke("settings_save", { settings: { ...view.settings, theme: mode, appearance: ap } });
  await app.reload();
  await app.browser.waitUntil(async () => (await app.browser.execute(() => document.documentElement.dataset.themeId)) === id, { timeoutMsg: `theme ${id} not applied` });
}

async function open(page) {
  // A presentation left open by a failed test step would hold the keys.
  if ((await app.$$(".presentation")).length) await stop();
  await app.invoke("search_open", { target: { kind: "page", page_id: page.id, new_tab: false } });
  await app.browser.waitUntil(async () => (await (await app.$(".page-title")).getValue()) === page.title, { timeoutMsg: `${page.title} not open` });
  await app.waitFor(".ProseMirror");
}

/** Starts the presentation of the open page through the command palette. */
async function present() {
  await app.keys(["Control", "k"]);
  await app.waitFor(".palette");
  await app.type("Präsentieren");
  await app.waitText(".pal-item", /Präsentieren/);
  await app.keys(["Enter"]);
  await app.waitFor(".presentation .present-slide");
}

async function stop() {
  await app.keys(["Escape"]);
  await app.browser.waitUntil(async () => (await app.$$(".presentation")).length === 0, { timeoutMsg: "presentation still shown" });
}

/**
 * Waits until the slide has settled (images loaded, diagrams drawn) and measures it: images with
 * their natural and shown aspect, and whether anything sticks out of the slide.
 */
async function measure() {
  await app.browser.waitUntil(
    () =>
      app.browser.execute(() => {
        const c = document.querySelector(".presentation .present-slide .slide-content");
        return !!c && [...c.querySelectorAll("img")].every((i) => i.complete) && !c.querySelector("figure.slide-diagram:empty");
      }),
    { timeout: 10000, timeoutMsg: "slide not settled" },
  );
  await sleep(150);
  return app.browser.execute(() => {
    const box = document.querySelector(".presentation .present-slide").getBoundingClientRect();
    const c = document.querySelector(".presentation .present-slide .slide-content");
    const out = (r) => r.left < box.left - 1 || r.top < box.top - 1 || r.right > box.right + 1 || r.bottom > box.bottom + 1;
    const cut = [];
    for (const el of c.querySelectorAll("*")) {
      const r = el.getBoundingClientRect();
      if (r.width && r.height && out(r)) cut.push(`${el.tagName.toLowerCase()}.${el.className}`);
      // Content hidden inside a box that clips it (a code block, a table wrapper).
      const s = getComputedStyle(el);
      if (/hidden|auto|scroll|clip/.test(s.overflowX) && el.scrollWidth > el.clientWidth + 2) cut.push(`clipped ${el.tagName.toLowerCase()} ${el.scrollWidth}>${el.clientWidth}`);
    }
    const imgs = [...c.querySelectorAll("img")].map((i) => {
      const r = i.getBoundingClientRect();
      return { src: i.getAttribute("src"), nw: i.naturalWidth, nh: i.naturalHeight, w: r.width, h: r.height, top: Math.round(r.top) };
    });
    const svg = c.querySelector(".slide-diagram svg")?.getBoundingClientRect();
    // In design pixels of the 1600 px slide.
    const unit = 1600 / box.width;
    return { cut, imgs, scale: Number(c.dataset.scale), text: c.innerText, diagram: svg ? Math.round(svg.width * unit) : null };
  });
}

const aspectOk = (i) => i.nw > 0 && Math.abs(i.w / i.h - i.nw / i.nh) / (i.nw / i.nh) < 0.03;

let names;
let deck;
const DECK = () =>
  [
    "# Bilder im Vortrag",
    "",
    `![[${names.wide}]]`,
    "",
    "---",
    "",
    `![[${names.tall}]]`,
    "",
    "---",
    "",
    "## Hochformat mit Breite",
    "",
    `![[${names.tall}|720]]`,
    "",
    "---",
    "",
    "## Markdown-Bild",
    "",
    `![Diagramm](attachments/${encodeURI(names.wide)})`,
    "",
    "---",
    "",
    "## Nebeneinander",
    "",
    `![[${names.square}|240]] ![[${names.small}|240]]`,
    "",
    "---",
    "",
    "## Langer Code",
    "",
    "```ts",
    `const sehrLangeZeile = ${JSON.stringify("x".repeat(220))}; // Ende der Zeile sichtbar`,
    "function kurz() { return 1; }",
    "```",
    "",
    "---",
    "",
    "## Breite Tabelle",
    "",
    `| ${Array.from({ length: 14 }, (_, i) => `Spalte ${i + 1}`).join(" | ")} |`,
    `|${" --- |".repeat(14)}`,
    `| ${Array.from({ length: 14 }, (_, i) => `Wert ${i + 1} lang`).join(" | ")} |`,
    "",
    "---",
    "",
    "## Lange Liste",
    "",
    ...Array.from({ length: 40 }, (_, i) => `- Punkt ${i + 1}`),
    "",
    "---",
    "",
    "## Diagramm",
    "",
    "```mermaid",
    "graph LR",
    "  A[Start] --> B[Ende]",
    "```",
    "",
    "---",
    "",
    "## Aufgaben und Hinweis",
    "",
    "- [x] Erledigt",
    "- [ ] Offen",
    "",
    "> [!tip] Tipp",
    "> Mit [[Projektplan]] verknüpft",
    "",
    "---",
    "",
    "## Skizze",
    "",
    `![[${names.drawing}]]`,
    "",
  ].join("\n");

test("images of every size and aspect, Markdown images, code, tables and lists fit the slide", async () => {
  names = {
    wide: await store("Panorama Breit.png", pngOf(2400, 600, [40, 120, 200])),
    tall: await store("Hochkant.png", pngOf(600, 2000, [200, 90, 40])),
    square: await store("Quadrat.png", pngOf(800, 800, [60, 160, 90])),
    small: await store("Klein.png", pngOf(64, 64, [150, 60, 160])),
    drawing: (await app.invoke("drawing_create", { title: "Leere Skizze" })).name,
  };
  deck = await app.invoke("page_create", { parentId: null, title: "Folien Bilder E2E", icon: null, content: DECK() });
  await open(deck);
  await present();
  await counter(/^1 \/ 11$/);
  const report = [];
  for (let n = 1; n <= 11; n++) {
    if (n > 1) {
      await app.keys(["ArrowRight"]);
      await counter(new RegExp(`^${n} / 11$`));
    }
    const m = await measure();
    report.push({ n, ...m, text: m.text.slice(0, 40) });
    await app.shot(`420-slide-${n}`);
  }
  console.log(JSON.stringify(report, null, 1));
  for (const r of report) {
    assert.deepEqual(r.cut, [], `slide ${r.n}: nothing cut off`);
    for (const i of r.imgs) assert.ok(aspectOk(i), `slide ${r.n}: image ${i.src} loaded and undistorted: ${JSON.stringify(i)}`);
  }
  const [square, small] = report[4].imgs;
  assert.ok(square && small && Math.abs(square.top - small.top) < 4, `two images in one paragraph stand side by side: ${JSON.stringify(report[4].imgs)}`);
  assert.ok(report[1].imgs[0].h > 0.7 * (await app.browser.execute(() => innerHeight)), "an image alone on its slide fills its height");
  assert.ok(report[7].scale > 0.55, `a long list flows into columns instead of shrinking: ${report[7].scale}`);
  assert.ok(report[8].diagram > 400, `the diagram is enlarged with the slide: ${report[8].diagram}`);
  assert.match(report[10].text, /Bild fehlt: Leere Skizze/, "an empty drawing shows its name instead of a broken image");
  assert.deepEqual(await app.consoleErrors(), []);
  await stop();
});

test("at 900 and 1920 px nothing is cut off and the controls stay apart", async () => {
  await open(deck);
  // The other tests run at the default size, also after a failure here.
  try {
    for (const [w, h] of [[900, 640], [1920, 1080]]) {
      await app.browser.setWindowSize(w, h);
      await present();
      for (const n of [1, 3, 6, 7, 8]) {
        await jump(n);
        await counter(new RegExp(`^${n} / 11$`));
        const m = await measure();
        assert.deepEqual(m.cut, [], `${w}px slide ${n}: nothing cut off`);
        for (const i of m.imgs) assert.ok(aspectOk(i), `${w}px slide ${n}: image undistorted: ${JSON.stringify(i)}`);
      }
      await app.browser.execute(() => document.querySelector(".presentation").dispatchEvent(new MouseEvent("mousemove", { bubbles: true })));
      await sleep(300);
      const layout = await app.browser.execute(() => {
        const r = (s) => document.querySelector(s).getBoundingClientRect();
        const hud = r(".present-hud");
        const corner = r(".present-corner");
        return { title: r(".present-title").height, hud: [hud.left, hud.right], corner: [corner.left, corner.right], vw: innerWidth, overlap: !(hud.right <= corner.left || corner.right <= hud.left || hud.bottom <= corner.top || corner.bottom <= hud.top) };
      });
      await app.shot(`420-hud-${w}`);
      assert.ok(layout.hud[0] >= 0 && layout.hud[1] <= layout.vw, `${w}px: the controls are inside the window ${JSON.stringify(layout)}`);
      assert.ok(layout.title < 24, `${w}px: the title stays on one line ${JSON.stringify(layout)}`);
      assert.ok(!layout.overlap, `${w}px: the controls do not cover the counter ${JSON.stringify(layout)}`);
      await stop();
    }
  } finally {
    await app.browser.setWindowSize(1480, 920);
  }
});

test("keys never type into the note, Tab stays in the presentation, focus and scroll come back", async () => {
  await open(deck);
  await app.caretToEnd();
  const scroller = () =>
    app.browser.execute(() => {
      let el = document.querySelector(".ProseMirror");
      while (el && !(el.scrollHeight > el.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(el).overflowY))) el = el.parentElement;
      return el ? Math.round(el.scrollTop) : -1;
    });
  const before = (await app.invoke("page_get", { id: deck.id })).content;
  const top = await scroller();
  await present();
  for (const k of ["a", "x", "Delete", "Tab", "Tab", "Tab", "Tab", "Tab", "Tab", "Tab", "Tab"]) {
    await app.keys([k]);
    const inside = await app.browser.execute(() => !!document.activeElement?.closest(".presentation"));
    assert.ok(inside, `the focus stays in the presentation after ${k}`);
  }
  await app.keys(["Escape"]);
  await app.browser.waitUntil(async () => (await app.$$(".presentation")).length === 0);
  assert.ok(await app.browser.execute(() => !!document.activeElement?.closest(".ProseMirror")), "the editor has the focus again");
  await sleep(600);
  assert.equal((await app.invoke("page_get", { id: deck.id })).content, before, "the note is unchanged");
  const after = await scroller();
  assert.ok(Math.abs(after - top) < 40, `scroll position kept: ${top} -> ${after}`);
});

test("the slides follow changes of the note made elsewhere", async () => {
  await open(deck);
  await present();
  await app.keys(["End"]);
  await counter(/^11 \/ 11$/);
  const short = "# Eins\n\n---\n\n# Zwei geändert\n";
  await app.invoke("page_save", { id: deck.id, content: short });
  await app.browser.execute((id) => void window.__TAURI__.event.emit("data://pages", [id]), deck.id);
  await counter(/^2 \/ 2$/);
  await app.browser.waitUntil(async () => /Zwei geändert/.test(await app.text(".presentation .present-slide .slide-content")), { timeoutMsg: "slide not updated" });
  await stop();
  await app.invoke("page_save", { id: deck.id, content: DECK() });
  await app.browser.execute((id) => void window.__TAURI__.event.emit("data://pages", [id]), deck.id);
});

test("a note with one title and ## sections is split at the sections", async () => {
  const page = await app.invoke("page_create", {
    parentId: null,
    title: "Abschnitte E2E",
    icon: null,
    content: "# Bericht\n\nEinleitung\n\n## Ziele\n\n- Schneller\n\n## Stand\n\nGut\n\n## Ausblick\n\nMehr\n",
  });
  await open(page);
  await present();
  await counter(/^1 \/ 4$/);
  await app.keys(["End"]);
  await app.waitText(".presentation .present-slide .slide-content", /Ausblick/);
  await stop();
});

test("the white Beamer slide draws diagrams light in a dark theme; screenshots per theme", async () => {
  const dark = (rgb) => {
    const [r, g, b] = rgb.match(/\d+(\.\d+)?/g).map(Number);
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.5;
  };
  const labelColor = () =>
    app.browser.execute(() => {
      const el = document.querySelector(".presentation .present-slide .slide-diagram .nodeLabel, .presentation .present-slide .slide-diagram svg text");
      if (!el) return null;
      const s = getComputedStyle(el);
      return el instanceof SVGElement ? s.fill : s.color;
    });
  for (const [mode, id] of [["light", "arcalo-light"], ["dark", "arcalo-dark"], ["dark", "contrast-dark"]]) {
    await theme(mode, id);
    await open(deck);
    await present();
    for (const n of [1, 2, 5, 6, 7, 9, 10, 11]) {
      await jump(n);
      await counter(new RegExp(`^${n} / 11$`));
      await measure();
      await app.shot(`420-${id}-slide-${n}`);
    }
    await app.keys(["9", "Enter"]);
    await counter(/^9 \/ 11$/);
    await app.browser.waitUntil(async () => (await labelColor()) != null, { timeoutMsg: "no diagram" });
    if (mode === "dark") assert.ok(!dark(await labelColor()), `light labels on the dark slide (${id})`);
    await app.keys(["b"]);
    await app.waitFor(".presentation.beamer");
    await app.browser.waitUntil(
      async () => {
        const c = await labelColor();
        return c != null && dark(c);
      },
      { timeoutMsg: `diagram labels stay light on the white slide (${id})` },
    );
    await app.shot(`420-${id}-beamer-diagram`);
    await app.keys(["7", "Enter"]);
    await counter(/^7 \/ 11$/);
    await app.shot(`420-${id}-beamer-table`);
    await app.keys(["b"]);
    await app.keys(["r"]);
    await app.waitFor(".presentation .presenter");
    await app.shot(`420-${id}-presenter`);
    await app.keys(["r"]);
    await stop();
  }
  await theme("light", "arcalo-light");
});

test("the presenter window takes the theme of the settings", async () => {
  await theme("dark", "contrast-dark");
  await app.reload("#presenter");
  await app.waitFor(".presenter-wait");
  const slides = [
    { index: 0, markdown: "# Erste Folie\n\nText", notes: "Begrüßen", title: "Erste Folie" },
    { index: 1, markdown: "## Zweite", notes: "", title: "Zweite" },
  ];
  await app.browser.execute((s) => void window.__TAURI__.event.emit("presentation://state", { title: "T", slides: s, index: 0, startedAt: Date.now(), target: null, beamer: false, theme: "dark" }), slides);
  await app.waitText(".presenter-notes", /Begrüßen/);
  await app.browser.waitUntil(async () => (await app.browser.execute(() => document.documentElement.dataset.themeId)) === "contrast-dark", { timeoutMsg: "the presenter window ignores the theme" });
  await app.shot("420-presenter-window-contrast");
  await app.reload("");
  await theme("light", "arcalo-light");
});

test("a reload in the middle of a presentation leaves full screen", async () => {
  await open(deck);
  await present();
  const during = await isFullscreen();
  await app.reload();
  await app.browser.waitUntil(async () => (await isFullscreen()) === false, { timeout: 8000, timeoutMsg: `still full screen after the reload (during: ${during})` });
  assert.equal((await app.$$(".presentation")).length, 0);
  assert.deepEqual(await app.consoleErrors(), []);
});
