// Drawings (Excalidraw): slash menu, the drawing overlay, saved scene + SVG preview, reopen, palette.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
before(async () => {
  app = await launch();
  // CSP violations are not console errors: collect them to prove Excalidraw needs nothing remote.
  await app.browser.execute(() => {
    window.__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
});
after(async () => app?.close());

const pageId = async (title) => (await app.invoke("page_resolve", { title, create: false })).id;
const content = async (title) => (await app.invoke("page_get", { id: await pageId(title) })).content;
const drawingsIn = (md) => [...md.matchAll(/!\[\[([^\]|]+\.excalidraw)\]\]/g)].map((m) => m[1]);
const overlayOpen = async () => (await app.$$(".drawing-overlay")).length > 0;

/** Drags on the Excalidraw canvas from (x1, y1) to (x2, y2), relative to its center. */
async function drag(x1, y1, x2, y2) {
  const canvas = await app.$(".drawing-overlay canvas.excalidraw__canvas.interactive");
  await app.browser.performActions([
    {
      type: "pointer",
      id: "mouse",
      parameters: { pointerType: "mouse" },
      actions: [
        { type: "pointerMove", origin: canvas, x: x1, y: y1 },
        { type: "pointerDown", button: 0 },
        { type: "pointerMove", origin: canvas, x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2), duration: 100 },
        { type: "pointerMove", origin: canvas, x: x2, y: y2, duration: 100 },
        { type: "pointerUp", button: 0 },
      ],
    },
  ]);
  await app.browser.releaseActions();
}

let name;

test("slash menu inserts a drawing and opens the editor", async () => {
  await app.keys(["Control", "n"]);
  await app.browser.waitUntil(() => app.browser.execute(() => document.activeElement?.classList.contains("page-title") && document.activeElement.selectionEnd > 0));
  await app.type("Skizzen");
  await app.keys(["Enter"]);
  await app.browser.waitUntil(async () => (await app.invoke("page_resolve", { title: "Skizzen", create: false })) !== null);
  await app.type("Ablauf:");
  await app.keys(["Enter"]);
  await app.type("/zeichn");
  await app.waitText(".sugg-item.sel", /Zeichnung/);
  await app.keys(["Enter"]);
  await app.waitFor(".drawing-overlay canvas.excalidraw__canvas.interactive", 20000);
  await app.waitText(".drawing-title", /^Zeichnung \d{4}-\d\d-\d\d \d\d\.\d\d$/);
  // German Excalidraw UI.
  await app.browser.waitUntil(() => app.browser.execute(() => !!document.querySelector('.drawing-overlay [title^="Rechteck"]')), { timeoutMsg: "Excalidraw not in German" });

  await app.browser.waitUntil(async () => drawingsIn(await content("Skizzen")).length === 1, { timeoutMsg: "embed not saved" });
  [name] = drawingsIn(await content("Skizzen"));
  assert.match(name, /^Zeichnung \d{4}-\d\d-\d\d \d\d\.\d\d\.excalidraw$/);
  assert.match(await content("Skizzen"), new RegExp(`^!\\[\\[${name.replace(/[.()]/g, "\\$&")}\\]\\]$`, "m"));
  assert.equal(JSON.parse(await app.invoke("drawing_read", { name })).elements.length, 0);
});

test("app shortcuts do not fire inside the drawing editor", async () => {
  await app.keys(["Control", "k"]);
  await app.browser.pause(300);
  assert.equal((await app.$$(".palette")).length, 0, "palette opened over the drawing");
  assert.ok(await overlayOpen());
  // Keys aimed at the note behind the overlay do not edit it.
  const before = await content("Skizzen");
  await app.browser.execute(() => document.querySelector(".pane.active .ProseMirror").focus());
  await app.type("xy");
  await app.browser.pause(700);
  assert.equal(await content("Skizzen"), before);
  assert.ok(await app.browser.execute(() => document.querySelector(".drawing-overlay").contains(document.activeElement)), "focus back in the drawing");
});

test("drawing a rectangle saves the scene and the preview", async () => {
  await app.keys(["r"]);
  await drag(-160, -90, 120, 80);
  await app.browser.waitUntil(async () => JSON.parse(await app.invoke("drawing_read", { name })).elements.some((e) => e.type === "rectangle" && !e.isDeleted), {
    timeout: 8000,
    timeoutMsg: "rectangle not saved",
  });
  await app.waitText(".drawing-status", /Gespeichert/);
  const svg = path.join(app.dataDir, "attachments", `${name}.svg`);
  assert.ok(fs.existsSync(svg), svg);
  assert.match(fs.readFileSync(svg, "utf8"), /^<svg/);
  await app.shot("drawing-editor");

  await app.click(".drawing-done");
  await app.browser.waitUntil(async () => !(await overlayOpen()), { timeoutMsg: "overlay did not close" });
  const img = await app.waitFor(".pane.active .drawing-embed img.drawing-preview");
  await app.browser.waitUntil(() => app.browser.execute((el) => el.complete && el.naturalWidth > 0, img), { timeoutMsg: "preview did not load" });
  assert.equal(await app.browser.execute(() => document.querySelector(".pane.active .drawing-embed").classList.contains("is-empty")), false);
  await app.shot("drawing-in-note");
  // The note keeps the plain embed.
  assert.equal(drawingsIn(await content("Skizzen")).length, 1);
});

test("clicking the preview reopens the drawing with its content", async () => {
  await app.click(".pane.active .drawing-embed");
  await app.waitFor(".drawing-overlay canvas.excalidraw__canvas.interactive", 20000);
  await app.browser.pause(400);
  // The empty-canvas hints are gone: the rectangle was loaded.
  assert.equal((await app.$$(".drawing-overlay .welcome-screen-center, .drawing-overlay .welcome-screen-decor")).length, 0);

  // Text below the rectangle: the preview carries the hand-drawn font inline.
  await app.keys(["t"]);
  await app.browser.pause(200);
  const canvas = await app.$(".drawing-overlay canvas.excalidraw__canvas.interactive");
  await app.browser.performActions([
    { type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions: [{ type: "pointerMove", origin: canvas, x: -100, y: 160 }, { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }] },
  ]);
  await app.browser.releaseActions();
  await app.browser.pause(200);
  await app.type("Ablauf");
  // The first Esc leaves text editing, the second closes the editor.
  await app.keys(["Escape"]);
  await app.browser.pause(250);
  assert.ok(await overlayOpen(), "first Esc only ends text editing");
  await app.keys(["Escape"]);
  await app.browser.waitUntil(async () => !(await overlayOpen()), { timeoutMsg: "Esc did not close" });
  const elements = JSON.parse(await app.invoke("drawing_read", { name })).elements;
  assert.ok(elements.some((e) => e.type === "rectangle"));
  // Typing inside the overlay never reached the note behind it.
  assert.equal(await content("Skizzen"), `Ablauf:\n\n![[${name}]]\n`);
  assert.ok(elements.some((e) => e.type === "text" && e.text === "Ablauf"), JSON.stringify(elements.map((e) => e.type)));
  assert.match(fs.readFileSync(path.join(app.dataDir, "attachments", `${name}.svg`), "utf8"), /@font-face \{ font-family: Excalifont; src: url\(data:font\/woff2;base64,/);
});

test("the command palette inserts a new drawing", async () => {
  // Caret to the end without clicking (a click on the preview would open the drawing).
  await app.browser.execute(() => document.querySelector(".pane.active .ProseMirror").editor.commands.focus("end"));
  await app.keys(["Control", "k"]);
  await app.waitFor(".palette");
  await app.type("Neue Zeichnung");
  await app.waitText(".pal-item.sel", /Neue Zeichnung einfügen/);
  await app.keys(["Enter"]);
  await app.waitFor(".drawing-overlay canvas.excalidraw__canvas.interactive", 20000);
  await app.browser.waitUntil(async () => drawingsIn(await content("Skizzen")).length === 2, { timeoutMsg: "second embed not saved" });
  await app.click(".drawing-done");
  await app.browser.waitUntil(async () => !(await overlayOpen()));
  await app.waitText(".pane.active .drawing-embed.is-empty .drawing-empty", /Leere Zeichnung/);
});

test("drawings need nothing from the network", async () => {
  // Excalidraw also lists its CDN as a second source for every font; the CSP blocks that, the
  // fonts come from the app itself. Its font subsetting (WebAssembly, in a worker) is refused as well:
  // the preview then carries whole font files. Inline style reports come from the app's CSP hashes.
  const csp = await app.browser.execute(() => window.__csp);
  const expected = (v) =>
    v.startsWith("style-src") || v.startsWith("font-src https://esm.sh/@excalidraw/") || v === "script-src eval" || /^worker-src \S+\/subset-worker\.chunk-/.test(v);
  assert.deepEqual(csp.filter((v) => !expected(v)), []);
  assert.ok(await app.browser.execute(() => [...document.fonts].some((f) => f.family === "Excalifont" && f.status === "loaded")), "Excalifont not loaded locally");
  assert.deepEqual(await app.consoleErrors(), []);
});
