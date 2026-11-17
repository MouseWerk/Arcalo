// q124 round 7, hunt C: the command palette. R7C-6: on a canvas tab the palette offered the
// editor's commands, and „Präsentieren“ (also Strg+Umschalt+P) showed the board's JSON as a
// slide; „Quelltext“, „Volle Breite“ and „Eigenschaft hinzufügen“ did nothing there. R7C-8: the
// palette kept the content hits of the query before until the new one was answered, so Enter
// right after typing opened a page of the old query instead of creating the page typed.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
before(async () => {
  app = await launch();
});
after(async () => {
  await app?.close();
});

const items = () => app.browser.execute(() => [...document.querySelectorAll(".palette .pal-item")].map((e) => e.innerText.split("\n")[0].trim()));
const openPalette = async () => {
  await app.keys(["Control", "k"]);
  await app.waitFor(".palette input");
};
const closePalette = async () => {
  await app.keys(["Escape"]);
  await app.browser.waitUntil(async () => !(await app.browser.execute(() => !!document.querySelector(".palette"))), { timeout: 4000 });
};

test("a canvas tab offers no editor commands and does not present its JSON (R7C-6)", async () => {
  const canvas = await app.invoke("canvas_create", { parentId: null, title: "Board Q4" });
  assert.ok(canvas.id);
  await app.reload();
  await app.keys(["Control", "o"]);
  await app.waitFor(".palette input");
  await app.type("Board Q4");
  await app.waitText(".pal-item.sel", /Board Q4/);
  await app.keys(["Enter"]);
  await app.waitFor(".canvas-view, .canvas");

  await openPalette();
  await app.type("Pr");
  await app.browser.pause(400);
  const offered = await items();
  assert.ok(!offered.some((t) => /Präsentieren|Quelltext|Volle Breite|Eigenschaft hinzufügen|Zeichnung/.test(t)), `offered on a canvas: ${offered.join(", ")}`);
  await closePalette();

  await app.keys(["Control", "Shift", "p"]);
  await app.browser.pause(800);
  assert.equal(await app.browser.execute(() => !!document.querySelector(".presentation")), false, "no presentation of a canvas");
  await app.keys(["Escape"]);

  // A note still has them.
  await app.keys(["Control", "o"]);
  await app.waitFor(".palette input");
  await app.type("Architektur");
  await app.waitText(".pal-item.sel", /Architektur/);
  await app.keys(["Enter"]);
  await app.waitFor(".ProseMirror");
  await openPalette();
  await app.type("Präsent");
  await app.waitText(".pal-item", /Präsentieren/);
  await closePalette();
});

test("Enter right after typing acts on what is typed, not on the hits of the query before (R7C-8)", async () => {
  const p = await app.invoke("page_create", { title: "Lieferantenliste", parentId: null });
  await app.invoke("page_save", { id: p.id, content: "Zebrafinken-Futter bestellen bei Firma Huber.\n" });
  await openPalette();
  await app.type("Zebrafinken");
  await app.waitText(".pal-item", /Lieferantenliste/);
  // More typed and Enter at once: the hit of „Zebrafinken“ is no answer to „Zebrafinken Käfig“.
  await app.type(" Käfig");
  await app.keys(["Enter"]);
  await app.browser.waitUntil(async () => !(await app.browser.execute(() => !!document.querySelector(".palette"))), { timeout: 4000 });
  await app.waitText(".pane.active .tab.active .tab-title", /Zebrafinken Käfig/).catch(async () => {
    const active = await app.browser.execute(() => document.querySelector(".pane.active .tab.active .tab-title")?.textContent ?? "");
    assert.fail(`the page typed was not created and opened; the active tab is „${active}“`);
  });
});
