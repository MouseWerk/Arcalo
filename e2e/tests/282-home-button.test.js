// The home button at the left of each pane's tab bar (1.14): it shows the start page of its pane, focusing
// the start page tab when one is open there and opening one otherwise, and it is marked while the start
// page is the active tab.
import { test as nodeTest, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "annalo-home-"));
after(async () => {
  await app?.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const home = ".pane.active .tabbar-home";
const tabCount = () => app.browser.execute(() => document.querySelectorAll(".pane.active .tab").length);
const homeActive = () => app.browser.execute((s) => document.querySelector(s)?.classList.contains("active"), home);

test("the home button shows the start page: its tab when open, a new one otherwise", async () => {
  app = await launch({ width: 1280, height: 800, dataDir: path.join(dir, "data") });
  const ids = [];
  for (const title of ["Home Alpha", "Home Beta"]) ids.push((await app.invoke("page_create", { parentId: null, title, icon: null, content: "x\n" })).id);
  await app.invoke("search_open", { target: { kind: "page", page_id: ids[0], new_tab: false } });
  await app.invoke("search_open", { target: { kind: "page", page_id: ids[1], new_tab: true } });
  await app.waitText(".pane.active .tab.active", /Home Beta/);
  assert.equal(await app.browser.execute((s) => document.querySelector(s)?.getAttribute("aria-label"), home), "Startseite");
  assert.equal(await homeActive(), false);

  // No start page tab open: a new tab with the start page.
  const before = await tabCount();
  await app.click(home);
  await app.waitFor(".pane.active .dash-grid");
  assert.equal(await tabCount(), before + 1);
  assert.equal(await homeActive(), true);

  // Back on a page, the button focuses the start page tab instead of opening another one.
  await app.invoke("search_open", { target: { kind: "page", page_id: ids[0], new_tab: false } });
  await app.waitText(".pane.active .tab.active", /Home Alpha/);
  const open = await tabCount();
  await app.click(home);
  await app.waitFor(".pane.active .dash-grid");
  assert.equal(await tabCount(), open);
  assert.equal(await homeActive(), true);
});

test("the home button is a quiet icon button", async () => {
  const look = await app.browser.execute((s) => {
    const st = getComputedStyle(document.querySelector(s));
    return { outline: st.outlineStyle, shadow: st.boxShadow, bg: st.backgroundColor };
  }, home);
  // Active is shown by a neutral background, not by a colored ring or bar.
  assert.equal(look.outline, "none");
  assert.equal(look.shadow, "none");
  assert.notEqual(look.bg, "rgba(0, 0, 0, 0)", "the active state has a background");
  await app.shot("282-home");
});
