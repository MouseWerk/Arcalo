// q124 round 2, H1: undo in a note that another writer changed while it was open (the command
// line, a task ticked off elsewhere) takes back only what was typed here: the other writer's text
// stays in the editor and in the file, also after more typing and redo.

import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { launch, guarded, APP } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
before(async () => (app = await launch({ width: 1280, height: 860 })));
after(async () => app?.close());

const ED = ".pane.active > .pane-content:not([hidden]) .ProseMirror";
const cli = (...args) =>
  JSON.parse(
    execFileSync(APP, ["--json", ...args], {
      env: { ...process.env, ARCALO_DATA_DIR: app.dataDir, ARCALO_LOCALE: "de-DE" },
      encoding: "utf8",
      timeout: 30000,
    }),
  );
const stored = async (id) => (await app.invoke("page_get", { id })).content;
const editorText = () => app.browser.execute((sel) => document.querySelector(sel)?.editor.getText({ blockSeparator: "\n" }) ?? "", ED);

async function openPage(title, md) {
  const page = (await app.invoke("page_create", { parentId: null, title, icon: "file-text", content: md })).id;
  await app.invoke("search_open", { target: { kind: "page", page_id: page, new_tab: false } });
  await app.browser.waitUntil(() => app.browser.execute((sel, t) => document.querySelector(".pane.active .page-title")?.value === t && !!document.querySelector(sel), ED, title), { timeout: 8000 });
  return page;
}

async function caretToEnd() {
  await app.browser.execute((sel) => {
    const ed = document.querySelector(sel).editor;
    ed.commands.focus("end");
  }, ED);
  await app.browser.pause(80);
}

test("undo after the command line appended text takes back only the typing", async () => {
  const id = await openPage("Undo Extern", "# Undo Extern\n\nErste Zeile\n");
  await caretToEnd();
  await app.type(" getippt");
  await app.browser.waitUntil(async () => (await stored(id)).includes("getippt"), { timeout: 8000, timeoutMsg: "typing not saved" });
  cli("pages", "append", `id:${id}`, "Vom Terminal");
  await app.browser.waitUntil(async () => (await editorText()).includes("Vom Terminal"), { timeout: 8000, timeoutMsg: "the open note did not take the append" });
  await caretToEnd();
  await app.keys(["Control", "z"]);
  await app.browser.pause(200);
  await app.keys(["Control", "z"]);
  await app.browser.pause(900);
  const text = await editorText();
  assert.match(text, /Vom Terminal/, "the appended text stays in the editor after undo");
  await app.browser.waitUntil(async () => !(await stored(id)).includes("getippt"), { timeout: 8000, timeoutMsg: "the undo was not saved" });
  assert.match(await stored(id), /Vom Terminal/, "the appended text stays in the file after undo");
  // Redo brings the typing back, the appended text still there.
  await app.keys(["Control", "Shift", "z"]);
  await app.keys(["Control", "Shift", "z"]);
  await app.browser.waitUntil(async () => (await stored(id)).includes("getippt"), { timeout: 8000, timeoutMsg: "redo not saved" });
  assert.match(await stored(id), /Vom Terminal/);
});

test("undo after a task was ticked off elsewhere keeps the tick", async () => {
  const id = await openPage("Undo Haken", "# Undo Haken\n\n- [ ] Rückruf\n\nNotiz\n");
  await app.browser.execute((sel) => document.querySelector(sel).editor.commands.focus("end"), ED);
  await app.type(" mehr");
  await app.browser.waitUntil(async () => (await stored(id)).includes("Notiz mehr"), { timeout: 8000, timeoutMsg: "typing not saved" });
  cli("tasks", "done", `id:${id}`, "0");
  await app.browser.waitUntil(() => app.browser.execute((sel) => !!document.querySelector(`${sel} li[data-checked="true"]`), ED), { timeout: 8000, timeoutMsg: "tick not shown" });
  await app.browser.execute((sel) => document.querySelector(sel).editor.commands.focus("end"), ED);
  for (let i = 0; i < 3; i++) await app.keys(["Control", "z"]);
  await app.browser.pause(900);
  await app.browser.waitUntil(async () => !(await stored(id)).includes("Notiz mehr"), { timeout: 8000, timeoutMsg: "the undo was not saved" });
  assert.match(await stored(id), /- \[x\] Rückruf/, "the tick from elsewhere stays");
});

test("no console errors", async () => {
  assert.deepEqual(await app.consoleErrors(), []);
});
