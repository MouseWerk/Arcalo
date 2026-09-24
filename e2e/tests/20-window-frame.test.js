// Windows with the app's own title bar: the window buttons sit top right and neither the side
// panel's tabs nor the last pane's tab bar run underneath them. (The shell only draws the frame on
// Windows; here the UI is switched into that mode by hand.)
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
before(async () => (app = await launch()));
after(async () => app?.close());

/** Right edge of the right-most visible control in the top row, and the window buttons' box. */
const layout = () =>
  app.browser.execute(() => {
    const controls = document.querySelector(".window-controls").getBoundingClientRect();
    const row = document.querySelector(".app > .panel") ? ".panel > .panel-tabs" : ".workspace > .pane:last-child .tabbar";
    const rights = [...document.querySelectorAll(`${row} button`)]
      .map((b) => b.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.top < controls.bottom)
      .map((r) => r.right);
    return { panel: !!document.querySelector(".app > .panel"), controls: { left: controls.left, right: controls.right, top: controls.top, height: controls.height }, maxRight: Math.max(...rights), width: innerWidth };
  });

test("own title bar: window buttons top right, the top row makes room for them", async () => {
  assert.equal(await app.browser.execute(() => getComputedStyle(document.querySelector(".window-controls")).display), "none", "hidden without the own title bar");
  await app.browser.execute(() => document.documentElement.classList.add("frame-custom"));
  assert.equal((await app.$$(".window-controls .win-btn")).length, 3);

  const first = await layout();
  assert.ok(Math.abs(first.controls.right - first.width) < 1 && first.controls.top === 0, `controls in the corner: ${JSON.stringify(first)}`);
  assert.ok(first.maxRight <= first.controls.left, `top row runs under the buttons: ${JSON.stringify(first)}`);
  await app.shot("titlebar-windows");

  // The other state of the side panel (open ↔ closed): the other row makes room.
  await app.browser.execute(() => document.querySelector(".workspace > .pane:last-child .tabbar > button:last-of-type").click());
  await app.browser.waitUntil(async () => (await layout()).panel !== first.panel, { timeoutMsg: "side panel did not toggle" });
  const second = await layout();
  assert.ok(second.maxRight <= second.controls.left, `top row runs under the buttons: ${JSON.stringify(second)}`);
  await app.browser.execute(() => document.querySelector(".workspace > .pane:last-child .tabbar > button:last-of-type").click());
});

// Taskbar jump list (Windows): its entries reach the main window as these events.
test("jump-list entries open today's note and a new page", async () => {
  const emit = (action) => app.browser.execute((a) => window.__TAURI__.event.emit("menu://action", a), action);
  const today = new Date();
  const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  await emit("today");
  await app.waitText(".pane.active .vh-title-text", new RegExp(iso));
  const before = await app.browser.execute(() => document.querySelectorAll(".pane.active .tab").length);
  await emit("new_page");
  await app.browser.waitUntil(async () => (await app.browser.execute(() => document.querySelectorAll(".pane.active .tab").length)) > before || !(await app.browser.execute(() => document.querySelector(".pane.active .vh-title-text")?.textContent ?? "")).includes(iso), { timeoutMsg: "no new page" });
  // Nothing pending: the shell's hand-over is a no-op.
  await app.invoke("jump_take", {});
});
