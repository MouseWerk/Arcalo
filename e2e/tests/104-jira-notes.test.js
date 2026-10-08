// Jira in notes (1.7): an issue key of a synced project becomes a live chip (type, key, status,
// title; `ISO-9001` stays text), hovering shows the issue's card, a click opens the issue's note
// („PROJ-123 Summary“ with `jira: PROJ-123`) and the issue lists the pages naming it. A task
// becomes a Jira issue from its context menu (the key is appended); „Als Aufgabe übernehmen“
// puts an issue into the daily note, and that task is ticked once the issue is done in Jira.
// With Jira stopped, the Issues page and the chips keep showing the cached issues.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";
import { startFakeJira } from "../lib/fake-jira.js";

const test = guarded(nodeTest, () => app);
let app;
let jira;
let pageId;
before(async () => {
  jira = await startFakeJira({ flavor: "cloud" });
  app = await launch({ env: { ARCALO_JIRA_DELAY_SECS: "600" } });
  await app.invoke("jira_site_save", {
    site: { id: "", name: "Acme", color: "", kind: "cloud", url: jira.url, email: "mia@firma.de", enabled: true, log_work: false, allow_writes: false },
    token: "secret-token",
  });
  await app.invoke("jira_sync_now", { site: "acme" });
  const page = await app.invoke("page_create", { title: "Sprint-Planung", parentId: null });
  pageId = page.id;
  await app.invoke("page_save", { id: pageId, content: "Heute PROJ-123 besprechen, nicht ISO-9001 und nicht UTF-8.\n\n- [ ] Fix SSO für Kunde\n" });
  await reload();
});
after(async () => {
  await app?.close();
  await jira?.close();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const count = (sel) => app.browser.execute((s) => document.querySelectorAll(s).length, sel);
async function reload() {
  await app.browser.execute(() => location.reload());
  await app.browser.pause(300);
  await app.browser.waitUntil(() => app.browser.execute(() => document.body.classList.contains("ready")), { timeout: 20000, timeoutMsg: "not ready after reload" });
}
const clickText = async (sel, pattern) => {
  await app.browser.waitUntil(
    () =>
      app.browser.execute(
        (s, src) => {
          const el = [...document.querySelectorAll(s)].find((b) => new RegExp(src).test(b.textContent.trim()) && !b.disabled);
          el?.click();
          return !!el;
        },
        sel,
        pattern.source,
      ),
    { timeoutMsg: `no ${sel} ${pattern}` },
  );
  await app.browser.pause(150);
};
async function setTheme(mode) {
  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", { settings: { ...view.settings, theme: mode } });
  await reload();
}
async function hoverChip(key) {
  await app.browser.execute(() => document.querySelector(".issue-preview") && document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
  const chip = await app.waitFor(`.pane.active .ProseMirror .issue-chip[data-issue="${key}"]`);
  await chip.moveTo();
  await app.waitFor(".issue-preview", 6000);
}

test("an issue key becomes a live chip with a hover card", async () => {
  await clickText(".sidebar .tree-row", /^Sprint-Planung/);
  await app.waitFor('.pane.active .ProseMirror .issue-chip[data-issue="PROJ-123"]', 10000);
  assert.equal(await count(".pane.active .ProseMirror .issue-chip"), 1, "ISO-9001 and UTF-8 stay text");
  assert.match(await app.text('.pane.active .ProseMirror .issue-chip-tail[data-issue="PROJ-123"]'), /Login fails on SSO/i);
  assert.equal(await app.browser.execute(() => document.querySelector('.pane.active .ProseMirror .issue-chip-tail[data-issue="PROJ-123"] .issue-chip-dot.cat-indeterminate')?.getAttribute("aria-label")), "In Progress");
  assert.ok(await (await app.$('.pane.active .ProseMirror .issue-chip-head.issue-type-bug')).isExisting(), "bug icon");
  // The Markdown keeps the plain key.
  assert.match((await app.invoke("page_get", { id: pageId })).content, /^Heute PROJ-123 besprechen/);
  await hoverChip("PROJ-123");
  const card = await app.text(".issue-preview");
  assert.match(card, /PROJ-123[\s\S]*Login fails on SSO[\s\S]*Mia Meyer[\s\S]*Steps: open login/i);
  await app.shot("104-chip-light");
  await setTheme("dark");
  await clickText(".sidebar .tree-row", /^Sprint-Planung/);
  await hoverChip("PROJ-123");
  await app.shot("104-chip-dark");
  await setTheme("light");
});

const CHIPS = [
  "PROJ-125 am Anfang, mitten PROJ-124 im Satz und am Ende OPS-7",
  "Zeile ohne Chip",
  "Zeile mit OPS-7 Chip",
  "Ein längerer Absatz, der umbricht: zuerst etwas Text, dann OPS-7 und noch mehr Text danach, bis die Zeile voll ist und PROJ-124 auf die nächste rutscht.",
  "## Überschrift mit PROJ-125",
  "- Liste mit OPS-8\n- [ ] Aufgabe zu PROJ-125",
  "| Issue | Notiz |\n| --- | --- |\n| PROJ-124 | offen |",
  "Unbekannt: PROJ-999 bleibt gestrichelt.",
].join("\n\n");

/** Positions and boxes of the chips in the open note. */
const chipInfo = () =>
  app.browser.execute(() => {
    const ed = document.querySelector(".pane.active .ProseMirror").editor;
    return [...document.querySelectorAll(".pane.active .ProseMirror .issue-chip")].map((k) => {
      const head = k.previousElementSibling?.matches(".issue-chip-head") ? k.previousElementSibling : null;
      const tail = k.nextElementSibling?.matches(".issue-chip-tail") ? k.nextElementSibling : null;
      const from = ed.view.posAtDOM(k.firstChild, 0);
      const box = (el) => el && (({ top, bottom, left, right }) => ({ top, bottom, left, right }))(el.getBoundingClientRect());
      return { key: k.dataset.issue, from, to: from + k.textContent.length, rects: k.getClientRects().length, head: box(head), keyBox: box(k), tail: box(tail) };
    });
  });

test("a chip is one pill on the text line: no break, caret outside, plain copy", async () => {
  const page = await app.invoke("page_create", { title: "Chip-Layout", parentId: null });
  await app.invoke("page_save", { id: page.id, content: CHIPS + "\n" });
  await reload();
  await clickText(".sidebar .tree-row", /^Chip-Layout/);
  await app.browser.waitUntil(async () => (await count(".pane.active .ProseMirror .issue-chip")) === 11, { timeout: 10000, timeoutMsg: "chips not drawn" });
  const chips = await chipInfo();
  // Keys without a synced issue (OPS-8 is someone else's) are the key alone.
  assert.deepEqual(chips.filter((c) => !c.head && !c.tail).map((c) => c.key), ["OPS-8", "PROJ-999"]);
  assert.equal(await count(".pane.active .ProseMirror .issue-chip.unknown"), 2);
  for (const c of chips.filter((c) => c.head)) {
    assert.ok(c.tail, `${c.key}: tail`);
    assert.ok(Math.abs(c.head.top - c.keyBox.top) < 1 && Math.abs(c.tail.top - c.keyBox.top) < 1, `${c.key}: head, key and tail on one line`);
    assert.ok(c.head.right <= c.keyBox.left + 1 && c.keyBox.right <= c.tail.left + 1, `${c.key}: one pill`);
  }
  // No line-height jump: a line with a chip is as tall as one without.
  const heights = await app.browser.execute(() => [...document.querySelectorAll(".pane.active .ProseMirror > p")].slice(1, 3).map((p) => p.getBoundingClientRect().height));
  assert.ok(Math.abs(heights[0] - heights[1]) < 0.5, `line heights ${heights}`);
  await app.shot("104-chips-light");

  // At any width the pill moves to the next line as a whole.
  const broken = await app.browser.execute(() => {
    const host = document.querySelector(".pane.active .ProseMirror");
    const out = [];
    for (let w = 260; w <= 760; w += 3) {
      host.style.maxWidth = `${w}px`;
      for (const k of host.querySelectorAll(".issue-chip:not(.unknown)")) {
        const tops = [k.previousElementSibling, k, k.nextElementSibling].map((e) => Math.round(e.getBoundingClientRect().top));
        if ([...tops.keys()].some((i) => [k.previousElementSibling, k, k.nextElementSibling][i].getClientRects().length !== 1) || new Set(tops).size !== 1) out.push(`${k.dataset.issue}@${w}`);
      }
    }
    host.style.maxWidth = "";
    return out;
  });
  assert.deepEqual(broken, [], "chips broken across lines");

  // The caret stands before and after the pill, and the arrow keys walk the key one step at a time.
  const mid = (await chipInfo()).find((c) => c.key === "PROJ-124");
  const caret = (pos) =>
    app.browser.execute((p) => {
      const ed = document.querySelector(".pane.active .ProseMirror").editor;
      ed.commands.focus();
      ed.commands.setTextSelection(p);
      // Where the browser put the caret: -1 before the pill, 1 after it, 0 inside.
      const r = getSelection().getRangeAt(0);
      const head = document.querySelector('.pane.active .ProseMirror .issue-chip-head[data-issue="PROJ-124"]');
      const tail = document.querySelector('.pane.active .ProseMirror .issue-chip-tail[data-issue="PROJ-124"]');
      const at = (fn) => {
        const t = document.createRange();
        fn(t);
        return r.compareBoundaryPoints(Range.START_TO_START, t);
      };
      return at((t) => t.setStartBefore(head)) <= 0 ? -1 : at((t) => t.setStartAfter(tail)) >= 0 ? 1 : 0;
    }, pos);
  assert.equal(await caret(mid.from), -1, "caret before the chip");
  assert.equal(await caret(mid.to), 1, "caret after the chip");
  await caret(mid.from - 1);
  // The browser moves the caret; the editor reads it from the selectionchange event that follows,
  // a moment later on a slow machine: wait for each step to arrive (a key that moves nothing
  // keeps the old position and fails below).
  const selFrom = () => app.browser.execute(() => document.querySelector(".pane.active .ProseMirror").editor.state.selection.from);
  const press = async (key) => {
    const was = await selFrom();
    await app.browser.keys([key]);
    let now = was;
    await app.browser.waitUntil(async () => (now = await selFrom()) !== was, { timeout: 2000, interval: 25 }).catch(() => {});
    return now;
  };
  const steps = [];
  for (let i = 0; i < 10; i++) steps.push(await press("ArrowRight"));
  assert.deepEqual(steps, Array.from({ length: 10 }, (_, i) => mid.from + i), "ArrowRight over the chip");
  for (let i = 0; i < 10; i++) await press("ArrowLeft");
  assert.equal(await selFrom(), mid.from - 1, "ArrowLeft back");

  // Copying a selection over a chip gives the plain text.
  const copied = await app.browser.execute(
    (from, to) => {
      const ed = document.querySelector(".pane.active .ProseMirror").editor;
      ed.commands.setTextSelection({ from, to });
      const dt = new DataTransfer();
      let ev = new ClipboardEvent("copy", { clipboardData: dt, bubbles: true, cancelable: true });
      if (!ev.clipboardData) {
        ev = new Event("copy", { bubbles: true, cancelable: true });
        Object.defineProperty(ev, "clipboardData", { value: dt });
      }
      ed.view.dom.dispatchEvent(ev);
      return dt.getData("text/plain");
    },
    mid.from - 7,
    mid.to + 3,
  );
  assert.equal(copied, "mitten PROJ-124 im");
  await app.shot("104-chip-selection");

  // Typing right after a chip stays plain text.
  const end = (await chipInfo()).find((c) => c.key === "OPS-7");
  await caret(end.to);
  await app.browser.keys([..."; gut"]);
  await app.browser.waitUntil(() => app.browser.execute(() => document.querySelector(".pane.active .ProseMirror > p").textContent.includes("; gut")), { timeoutMsg: "typed text missing" });
  const after = await app.browser.execute(() => {
    const k = document.querySelector('.pane.active .ProseMirror .issue-chip[data-issue="OPS-7"]');
    return { key: k.textContent, inChip: !!getSelection().anchorNode?.parentElement?.closest(".issue-chip, .issue-chip-tail") };
  });
  assert.deepEqual(after, { key: "OPS-7", inChip: false });

  // The hover card sits right under the pill.
  await hoverChip("PROJ-124");
  const pos = await app.browser.execute(() => {
    const card = document.querySelector(".issue-preview").getBoundingClientRect();
    const head = document.querySelector('.pane.active .ProseMirror .issue-chip-head[data-issue="PROJ-124"]').getBoundingClientRect();
    const tail = document.querySelector('.pane.active .ProseMirror .issue-chip-tail[data-issue="PROJ-124"]').getBoundingClientRect();
    return { dx: card.left - head.left, below: card.top - tail.bottom };
  });
  assert.ok(Math.abs(pos.dx) < 2 && pos.below >= 0 && pos.below < 12, `card at ${JSON.stringify(pos)}`);

  // A new sync draws the same chips in place: nothing moves.
  const before = await chipInfo();
  await app.browser.execute(() => document.querySelectorAll(".issue-chip-head").forEach((h) => (h.dataset.mark = "1")));
  await app.invoke("jira_sync_now", { site: "acme" });
  await sleep(800);
  assert.deepEqual(await chipInfo(), before, "chips moved after a sync");
  assert.equal(await count(".pane.active .issue-chip-head:not([data-mark])"), 0, "chips drawn anew");

  await setTheme("dark");
  await clickText(".sidebar .tree-row", /^Chip-Layout/);
  await app.waitFor(".pane.active .ProseMirror .issue-chip-head");
  await app.shot("104-chips-dark");
  await setTheme("light");
});

test("a click on the chip opens the issue's note; the issue lists the pages naming it", async () => {
  await clickText(".sidebar .tree-row", /^Sprint-Planung/);
  const chip = await app.waitFor('.pane.active .ProseMirror .issue-chip-tail[data-issue="PROJ-123"]');
  await chip.click();
  await app.browser.waitUntil(async () => (await app.browser.execute(() => document.querySelector(".pane.active .tab.active")?.textContent ?? "")).includes("PROJ-123 Login fails on SSO"), { timeout: 10000, timeoutMsg: "issue note not opened" });
  const view = await app.invoke("jira_issue_view", { key: "PROJ-123" });
  assert.ok(view.note_page_id, "note page created");
  assert.match((await app.invoke("page_get", { id: view.note_page_id })).content, /^---\njira: PROJ-123\n---/);
  assert.deepEqual(view.backlinks.map((b) => [b.title, b.note]), [["PROJ-123 Login fails on SSO", true], ["Sprint-Planung", false]]);
  // A second click opens the same note.
  const again = await app.invoke("jira_issue_note", { key: "PROJ-123" });
  assert.equal(again.created, false);
  assert.equal(again.page.id, view.note_page_id);
});

test("a task becomes a Jira issue from its context menu", async () => {
  await clickText(".sidebar .tree-row", /^Sprint-Planung/);
  const task = await app.waitFor(".pane.active .ProseMirror li[data-checked]");
  await task.click({ button: "right" });
  await clickText(".menu [role^='menuitem'], .menu button", /Jira-Issue anlegen/);
  await app.waitFor(".dialog");
  assert.equal(await app.browser.execute(() => document.querySelector('.dialog input[aria-label="Titel"]').value), "Fix SSO für Kunde");
  await app.browser.waitUntil(async () => !(await app.browser.execute(() => document.querySelector('.dialog [aria-label="Typ"]')?.getAttribute("aria-disabled") === "true" || document.querySelector('.dialog [aria-label="Typ"]')?.disabled)), { timeoutMsg: "types not loaded" });
  await sleep(300);
  await clickText(".dialog button", /Issue anlegen/);
  await app.waitFor('.pane.active .ProseMirror .issue-chip[data-issue="PROJ-126"]', 10000);
  const created = jira.issues.find((i) => i.key === "PROJ-126");
  assert.equal(created.summary, "Fix SSO für Kunde");
  assert.match(created.description, /Angelegt aus der Notiz „Sprint-Planung“ in Arcalo/);
  await sleep(1200);
  assert.match((await app.invoke("page_get", { id: pageId })).content, /- \[ \] Fix SSO für Kunde PROJ-126/);
});

test("„Als Aufgabe übernehmen“ and ticking it when the issue is done", async () => {
  await app.click(".ribbon-issues");
  await app.click('[data-issue-row="OPS-7"] .issue-row-main');
  await clickText('[data-issue-row="OPS-7"] .issue-detail-side button', /Als Aufgabe übernehmen/);
  await app.browser.waitUntil(async () => (await app.invoke("tasks_list", { filter: { status: "open" } })).some((t) => t.text === "OPS-7 Nightly backup job"), { timeoutMsg: "task not added" });
  // Done in Jira: the next sync ticks the task.
  Object.assign(jira.issues.find((i) => i.key === "OPS-7"), { status: "Done", category: "done" });
  await app.invoke("jira_sync_now", { site: "acme" });
  const tasks = await app.invoke("tasks_list", { filter: { status: "all" } });
  assert.equal(tasks.find((t) => t.text === "OPS-7 Nightly backup job")?.done, true, "ticked");
});

test("offline: the cached issues stay readable", async () => {
  await jira.stop();
  await assert.rejects(app.invoke("jira_sync_now", { site: "acme" }), /nicht erreichbar/);
  await app.click(".ribbon-issues");
  await app.waitText(".issues-banner", /nicht erreichbar/);
  assert.ok((await count("[data-issue-row]")) >= 3, "issues still listed");
  await app.dismissToasts();
  await app.shot("104-issues-offline");
  await clickText(".sidebar .tree-row", /^Sprint-Planung/);
  await hoverChip("PROJ-123");
  assert.match(await app.text(".issue-preview"), /Login fails on SSO/);
  await jira.start();
});
