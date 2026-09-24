// Performance of 1.4 in large workspaces: a long note opens quickly and comes back unchanged,
// the sidebar and the task list render only the rows in view (keyboard, clicks and hover still
// work), a page does not reload itself after its own save, hidden assistant suggestions do no
// work on page switches, and code in rarer languages is highlighted once its grammar is loaded.

import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
before(async () => {
  app = await launch();
  await app.browser.setTimeout({ script: 120_000 });
});
after(async () => app?.close());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const create = (title, content, parentId = null) => app.invoke("page_create", { parentId, title, icon: null, content });
async function open(page) {
  await app.invoke("search_open", { target: { kind: "page", page_id: page.id, new_tab: false } });
  await app.browser.waitUntil(async () => (await app.browser.execute(() => document.querySelector(".pane.active .page-title")?.value)) === page.title, {
    timeout: 30000,
    timeoutMsg: `${page.title} not open`,
  });
  await sleep(400);
}

/** Counts IPC commands from now on (the app talks to the backend through fetch). */
const countCalls = () =>
  app.browser.execute(() => {
    if (!window.__calls) {
      window.__calls = [];
      const orig = window.fetch.bind(window);
      window.fetch = (url, init) => {
        const u = String(url);
        if (/^(ipc:|http:\/\/ipc\.)/.test(u)) window.__calls.push(decodeURIComponent(u.replace(/^.*localhost\//, "").split("?")[0]));
        return orig(url, init);
      };
    }
    window.__calls.length = 0;
  });
const calls = () => app.browser.execute(() => [...window.__calls]);

// One section with every construct that spans blank lines (lists, code, columns, callouts).
const section = (i) =>
  [
    `## Abschnitt ${i}`,
    `Absatz ${i} mit [[Seite ${i}]], #thema${i % 7} und Fußnote[^${i}].`,
    "- eins\n- zwei\n  - tiefer",
    "- [ ] offen\n- [x] erledigt",
    "```ts\nconst a = 1;\n\nconst b = 2;\n```",
    "| A   | B   |\n| --- | --- |\n| 1   | 2   |",
    `> [!note] Hinweis ${i}\n> Callout-Text`,
    "> [!tip]- Eingeklappt\n> Versteckt",
    "<!-- spalten -->\n\nLinks\n\nmit Absatz\n\n<!-- spalte -->\n\nRechts\n\n<!-- /spalten -->",
  ].join("\n\n");
const SECTIONS = 120;
const LONG = `[TOC]\n\n${Array.from({ length: SECTIONS }, (_, i) => section(i)).join("\n\n")}\n\nLetzter Absatz.\n\n${Array.from({ length: SECTIONS }, (_, i) => `[^${i}]: Fußnote ${i}.`).join("\n")}\n`;

test("a long note opens quickly, with every block, and saves back unchanged", async () => {
  assert.ok(LONG.split("\n").length > 4000, "a long note");
  const page = await create("Lange Notiz", LONG);
  const t0 = Date.now();
  await open(page);
  await app.waitText(".pane.active .ProseMirror", /Letzter Absatz/, 30000);
  const ms = Date.now() - t0;
  // Lexed as a whole this note took far longer; in pieces it is a matter of a few seconds at most.
  assert.ok(ms < 15000, `opened in ${ms} ms`);
  const counts = await app.browser.execute(() => {
    const pm = document.querySelector(".pane.active .ProseMirror");
    return {
      h2: pm.querySelectorAll("h2").length,
      tables: pm.querySelectorAll("table").length,
      code: pm.querySelectorAll("pre code").length,
      callouts: pm.querySelectorAll("blockquote.callout").length,
      folded: pm.querySelectorAll("blockquote.callout.is-folded").length,
      columns: pm.querySelectorAll("div.columns").length,
      tasks: pm.querySelectorAll("ul[data-type='taskList'] > li").length,
      footnotes: pm.querySelectorAll(".footnote-def").length,
      refs: pm.querySelectorAll(".footnote-ref").length,
      toc: pm.querySelectorAll(".toc-block").length,
      tags: pm.querySelectorAll(".tag").length,
    };
  });
  assert.deepEqual(counts, { h2: SECTIONS, tables: SECTIONS, code: SECTIONS, callouts: 2 * SECTIONS, folded: SECTIONS, columns: SECTIONS, tasks: 2 * SECTIONS, footnotes: SECTIONS, refs: SECTIONS, toc: 1, tags: SECTIONS });

  // An edit at the end: the stored note is the original plus that edit.
  await app.browser.execute(() => {
    const ed = document.querySelector(".pane.active .ProseMirror").editor;
    let pos = null;
    ed.state.doc.descendants((n, p) => {
      if (n.isTextblock && n.textContent === "Letzter Absatz.") pos = p + n.nodeSize - 1;
      return pos == null;
    });
    ed.chain().focus().setTextSelection(pos).run();
  });
  await app.type(" Ende");
  await app.browser.waitUntil(async () => (await app.invoke("page_get", { id: page.id })).content.includes("Letzter Absatz. Ende"), { timeout: 15000, timeoutMsg: "edit not saved" });
  assert.equal((await app.invoke("page_get", { id: page.id })).content, LONG.replace("Letzter Absatz.", "Letzter Absatz. Ende"));
  await app.shot("perf-long-note");
});

test("typing in the long note keeps tags, callouts and footnotes decorated", async () => {
  await app.browser.execute(() => {
    const ed = document.querySelector(".pane.active .ProseMirror").editor;
    let pos = null;
    ed.state.doc.descendants((n, p) => {
      if (n.isTextblock && n.textContent.startsWith("Absatz 60 ")) pos = p + n.nodeSize - 1;
      return pos == null;
    });
    ed.chain().focus().setTextSelection(pos).scrollIntoView().run();
  });
  await app.type(" #neu");
  await app.browser.waitUntil(async () => app.browser.execute(() => !!document.querySelector('.pane.active .ProseMirror .tag[data-tag="neu"]')), { timeout: 5000, timeoutMsg: "new tag not highlighted" });
  const counts = await app.browser.execute(() => {
    const pm = document.querySelector(".pane.active .ProseMirror");
    return { tags: pm.querySelectorAll(".tag").length, callouts: pm.querySelectorAll("blockquote.callout").length, refs: pm.querySelectorAll(".footnote-ref[data-num]").length };
  });
  assert.deepEqual(counts, { tags: SECTIONS + 1, callouts: 2 * SECTIONS, refs: SECTIONS });
});

test("a page does not fetch itself again after its own save", async () => {
  const page = await create("Eigenes Speichern", "Anfang");
  await open(page);
  await app.caretToEnd();
  await countCalls();
  await app.type(" und mehr");
  await app.browser.waitUntil(async () => (await calls()).includes("page_save"), { timeout: 8000, timeoutMsg: "not saved" });
  await app.waitFor('.pane.active .editor-wrap[data-save-status="saved"]');
  await sleep(1200);
  const seen = await calls();
  assert.match((await app.invoke("page_get", { id: page.id })).content, /Anfang und mehr/);
  assert.equal(seen.filter((c) => c === "page_get").length, 0, `no reload after the own save: ${seen.join(", ")}`);
  // The status bar still counts the words of the saved text.
  await app.waitText(".statusbar .sb-static", /3 Wörter/);
});

test("the sidebar renders only the rows in view of a large tree; keyboard, hover and clicks work", async () => {
  const ids = await app.browser.executeAsync((done) => {
    (async () => {
      const inv = window.__TAURI_INTERNALS__.invoke;
      const root = await inv("page_create", { parentId: null, title: "Großer Ordner", icon: null, content: "" });
      const out = [root.id];
      for (let i = 0; i < 400; i++) out.push((await inv("page_create", { parentId: root.id, title: `Unterseite ${String(i).padStart(3, "0")}`, icon: null, content: "" })).id);
      done(out);
    })();
  });
  await app.browser.refresh();
  await app.waitFor(".sidebar .tree [role=treeitem]", 20000);
  const dom = await app.browser.execute(() => ({ rows: document.querySelectorAll(".sidebar .tree [role=treeitem]").length, virtual: !!document.querySelector(".sidebar .tree.is-virtual"), actions: document.querySelectorAll(".sidebar .tree-row-actions").length }));
  assert.ok(dom.virtual, "virtualized");
  assert.ok(dom.rows < 150, `${dom.rows} rows in the DOM`);
  assert.equal(dom.actions, 0, "row buttons exist only on hover or focus");

  // Hover shows the row's buttons.
  const first = await app.$(".sidebar .tree-row[aria-level='1']");
  await first.moveTo();
  await app.waitFor(".sidebar .tree-row:hover .tree-row-actions button");

  // Keyboard: End goes to the last row (out of view at first), Up to the one before.
  const last = ids[ids.length - 1];
  await app.browser.execute(() => document.querySelector(".sidebar .tree-row[tabindex='0']").focus());
  await app.keys(["End"]);
  await app.browser.waitUntil(async () => (await app.browser.execute(() => document.activeElement?.dataset.id)) === String(last), { timeout: 5000, timeoutMsg: "End did not reach the last row" });
  await app.keys(["ArrowUp"]);
  assert.equal(await app.browser.execute(() => document.activeElement?.dataset.id), String(ids[ids.length - 2]));
  await app.keys(["Home"]);
  await app.browser.waitUntil(async () => app.browser.execute(() => document.activeElement?.getAttribute("aria-level") === "1" && document.activeElement === document.querySelector(".sidebar .tree [role=treeitem]")), { timeout: 5000, timeoutMsg: "Home did not reach the first row" });

  // Scrolled to the end, the last page is there and opens with a click.
  await app.browser.execute(() => {
    const sc = document.querySelector(".sidebar .sidebar-scroll");
    sc.scrollTop = sc.scrollHeight;
  });
  await app.waitFor(`.sidebar .tree-row[data-id="${last}"]`);
  await app.click(`.sidebar .tree-row[data-id="${last}"]`);
  await app.browser.waitUntil(async () => (await app.browser.execute(() => document.querySelector(".pane.active .page-title")?.value)) === "Unterseite 399", { timeout: 8000, timeoutMsg: "click did not open the page" });
  assert.ok((await app.browser.execute(() => document.querySelectorAll(".sidebar .tree [role=treeitem]").length)) < 150);
  await app.shot("perf-sidebar-virtual");

  // Context menu on a row far down works as before.
  await (await app.$(`.sidebar .tree-row[data-id="${ids[ids.length - 3]}"]`)).click({ button: "right" });
  await app.waitText(".menu", /Umbenennen/);
  await app.keys(["Escape"]);
});

test("the task list renders only the rows in view of a long list; ticking one far down works", async () => {
  const tasks = Array.from({ length: 700 }, (_, i) => `- [ ] Aufgabe ${String(i).padStart(3, "0")}`).join("\n");
  const page = await create("Viele Aufgaben", `${tasks}\n`);
  await app.browser.execute(() => document.querySelector('.ribbon [aria-label^="Aufgaben"]').click());
  await app.waitFor(".tasks-view .task-row", 15000);
  await sleep(500);
  const rows = await app.browser.execute(() => document.querySelectorAll(".tasks-view .task-row").length);
  assert.ok(rows > 5 && rows < 200, `${rows} rows in the DOM`);
  // Scroll to the end: the last task appears and can be ticked.
  const lastRow = `.tasks-view .task-row[data-page="${page.id}"][data-ordinal="699"]`;
  await app.browser.waitUntil(
    async () =>
      app.browser.execute((sel) => {
        const sc = document.querySelector(".tasks-view").closest(".view-scroll");
        sc.scrollTop = sc.scrollHeight;
        return !!document.querySelector(sel);
      }, lastRow),
    { timeout: 10000, timeoutMsg: "last task not rendered" },
  );
  await app.click(`${lastRow} .task-check`);
  await app.browser.waitUntil(async () => (await app.invoke("page_get", { id: page.id })).content.includes("- [x] Aufgabe 699"), { timeout: 8000, timeoutMsg: "task not ticked" });
  await app.shot("perf-tasks-virtual");
});

test("hidden assistant suggestions do no work on page switches", async () => {
  const a = await create("Wechsel A", "A");
  const b = await create("Wechsel B", "B");
  await open(a);
  // Right panel on the outline: switching pages loads nothing for the suggestions.
  await app.browser.execute(() => {
    if (!document.querySelector(".panel")) document.querySelector('.ribbon [aria-label^="Seitenpanel"], [aria-label^="Seitenpanel"]')?.click();
  });
  await app.waitFor(".panel .panel-tab");
  await app.browser.execute(() => [...document.querySelectorAll(".panel .panel-tab")].find((t) => t.textContent.includes("Gliederung")).click());
  await countCalls();
  for (const p of [b, a, b, a]) await open(p);
  await sleep(800);
  const hidden = (await calls()).filter((c) => /^(daily_overview|wbs_tree|budget)$/.test(c));
  assert.deepEqual(hidden, []);
  // Shown: they load (once the page settles).
  await app.browser.execute(() => [...document.querySelectorAll(".panel .panel-tab")].find((t) => t.textContent.includes("Assistent")).click());
  await app.browser.waitUntil(async () => (await calls()).includes("daily_overview"), { timeout: 5000, timeoutMsg: "suggestions not loaded when shown" });
  await app.waitText(".ai-suggestion", /„Wechsel A“/);
});

test("code in a language loaded on demand is highlighted, without a save", async () => {
  const page = await create("Rust-Code", "```rust\nfn main() {\n    let x = 1;\n}\n```\n\n```ts\nconst y = 2;\n```\n");
  const before = (await app.invoke("page_get", { id: page.id })).updated_at;
  await countCalls();
  await open(page);
  await app.waitFor(".pane.active pre code .hljs-keyword");
  await app.browser.waitUntil(
    async () => app.browser.execute(() => [...document.querySelectorAll(".pane.active pre")][0]?.querySelector(".hljs-keyword")?.textContent === "fn"),
    { timeout: 8000, timeoutMsg: "rust not highlighted" },
  );
  await sleep(1200);
  assert.equal(await app.browser.execute(() => document.querySelector(".pane.active .editor-wrap")?.dataset.saveStatus), "saved");
  assert.ok(!(await calls()).includes("page_save"), "loading a grammar saves nothing");
  assert.equal((await app.invoke("page_get", { id: page.id })).updated_at, before);
});
