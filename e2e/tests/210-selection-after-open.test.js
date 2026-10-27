// A selection made right after a note opens is kept (1.12): ProseMirror restores its own selection
// 20 ms after the editor gets the focus, and WebKit reports a new selection late when the main
// thread is busy (a note that just opened). The busy main thread is made here on purpose, so the
// late report comes after that restore every time.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
before(async () => (app = await launch()));
after(async () => app?.close());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const openFromTree = async (title) => {
  for (const r of await app.$$(".sidebar .tree-row")) if ((await app.textOf(r)) === title) return r.click();
  throw new Error(`tree row ${title} not found`);
};
/** Focuses the open note and selects its first longer paragraph at once, then keeps the main thread busy for `busy` ms. */
const selectWhileBusy = (busy) =>
  app.browser.execute((ms) => {
    const root = document.querySelector(".pane.active > .pane-content:not([hidden]) .ProseMirror");
    const p = [...root.querySelectorAll("p")].find((x) => x.textContent.length > 30);
    root.focus();
    const range = document.createRange();
    range.selectNodeContents(p);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
    const until = performance.now() + ms;
    while (performance.now() < until) {
      /* the note still renders */
    }
    return p.textContent;
  }, busy);
const selected = () => app.browser.execute(() => window.getSelection().toString());

test("text selected right after a note opens stays selected, and Ctrl+J opens the inline AI bar", async () => {
  await openFromTree("Architektur");
  await app.waitFor(".pane.active > .pane-content:not([hidden]) .ProseMirror p");
  const text = await selectWhileBusy(60);
  await sleep(300);
  assert.equal(await selected(), text, "the selection is kept");
  await app.keys(["Control", "j"]);
  await app.waitFor(".ai-bar");
  // The bar has the keyboard (no AI set up here: its „KI einrichten“), not the assistant.
  await app.browser.waitUntil(() => app.browser.execute(() => !!document.activeElement?.closest(".ai-bar")), { timeoutMsg: "the bar has the focus" });
  await app.keys(["Escape"]);
});

test("no console errors", async () => {
  assert.deepEqual(await app.consoleErrors(), []);
});
