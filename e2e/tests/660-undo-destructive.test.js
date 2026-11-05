// q124 round 5, hunt C: undo and every destructive action. „Beispieldaten entfernen“ keeps the
// user's own pages that share a sample's title and puts the samples into the trash (it deleted
// both for good); „Rückgängig“ after deleting a focus block brings it back with its booking and
// its Netzplan/Vorgang (it came back as a new, unbooked block); a deleted PDF highlight comes back
// with its note and id; a page typed into and deleted right away comes back with the typing.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded, EDITOR } from "../lib/harness.js";
import { helpers, makePdf } from "../lib/linking-flows.js";

const test = guarded(nodeTest, () => app);
let app;
before(async () => (app = await launch({ width: 1480, height: 920 })));
after(async () => app?.close());

/** Clicks „Rückgängig“ in the toast whose text contains `title`. */
const undoIn = (title) =>
  app.browser.waitUntil(
    () =>
      app.browser.execute((t) => {
        const toast = [...document.querySelectorAll(".toast")].find((x) => x.textContent.includes(t));
        const b = toast && [...toast.querySelectorAll("button")].find((x) => x.textContent.trim() === "Rückgängig");
        b?.click();
        return !!b;
      }, title),
    { timeout: 8000, timeoutMsg: `no „Rückgängig“ in a toast with „${title}“` },
  );

test("removing the samples keeps the user's pages with a sample's title; the samples go to the trash", async () => {
  const mine = await app.invoke("page_create", { parentId: null, title: "Besprechung", icon: null, content: "Meine Notizen zur Besprechung\n" });
  const sample = Number(
    await app.browser.execute(() => [...document.querySelectorAll(".sidebar .tree-row")].find((r) => r.querySelector(".tree-label")?.textContent.trim() === "Willkommen")?.dataset.id),
  );
  assert.ok(sample, "the samples are there");
  await app.invoke("page_save", { id: sample, content: "Meine Gedanken\n" });
  await app.invoke("demo_remove");
  const kept = await app.invoke("page_get", { id: mine.id }).catch((e) => ({ content: String(e) }));
  assert.equal(kept.content, "Meine Notizen zur Besprechung\n", "the user's page was deleted");
  assert.ok(!kept.deleted_at);
  const trash = await app.invoke("trash_list");
  assert.ok(trash.some((e) => e.id === sample), "the sample is not in the trash");
  await app.invoke("page_restore", { id: sample });
  assert.equal((await app.invoke("page_get", { id: sample })).content, "Meine Gedanken\n");
});

test("„Rückgängig“ after deleting a focus block brings it back booked, with its Vorgang", async () => {
  const np = (await app.invoke("wbs_tree")).flatMap((p) => p.netzplaene).find((n) => n.netzplan_nr === "NP-8801");
  assert.ok(np, "sample Netzplan");
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 6, 0);
  const end = new Date(start.getTime() + 3600e3);
  const b = await app.invoke("block_create", { block: { title: "Konzept Rückgängig", start: start.toISOString(), end: end.toISOString(), link: { kind: "none" }, reference: "NP-8801/1020" } });
  // Booked by „Woche vorschlagen“.
  const applied = await app.invoke("week_proposal_apply", {
    items: [{ start: start.toISOString(), minutes: 60, text: "Konzept Rückgängig", netzplan_id: np.id, vorgang_nr: "1020", sources: [{ kind: "block", id: String(b.id), label: b.title }] }],
  });
  const range = { from: new Date(start.getTime() - 86400e3).toISOString(), to: new Date(start.getTime() + 86400e3).toISOString() };
  const find = async () => (await app.invoke("blocks_list", range)).find((x) => x.title === "Konzept Rückgängig");
  assert.equal((await find()).entry_id, applied.entry_ids[0]);

  await app.browser.execute(() => localStorage.setItem("arcalo.calendar.view", "day"));
  await app.click(".ribbon-calendar-view");
  await app.waitFor(`.calv-block[data-block="${b.id}"]`, 10000);
  await app.browser.execute((id) => document.querySelector(`.calv-block[data-block="${id}"]`).click(), b.id);
  await app.click(".calv-block-delete");
  await app.browser.waitUntil(async () => !(await find()), { timeout: 8000, timeoutMsg: "block not deleted" });
  await undoIn("Konzept Rückgängig");
  await app.browser.waitUntil(async () => !!(await find()), { timeout: 8000, timeoutMsg: "block not back" });
  const back = await find();
  assert.deepEqual(
    [back.start, back.end, back.reference, back.entry_id],
    [b.start, b.end, "NP-8801/1020", applied.entry_ids[0]],
    "the block came back unbooked (and „Woche vorschlagen“ would book it again)",
  );
  // It is not proposed again.
  const monday = new Date(start);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const proposal = await app.invoke("week_proposal", { weekStart: iso(monday), restOfToday: false });
  assert.ok(!JSON.stringify(proposal).includes(`"id":"${back.id}"`), "the restored block is proposed for booking again");
});

test("a deleted PDF highlight comes back with its note and its id", async () => {
  const h = helpers(app);
  await h.store("Undo.pdf", makePdf(["Erste Seite Undo", "Zweite Seite Undo"]));
  const hl = await app.invoke("pdf_highlight_add", { highlight: { attachment: "Undo.pdf", page: 2, rects: [[0.1, 0.17, 0.5, 0.03]], text: "Zweite Seite Undo", color: "green", note: "" } });
  await app.invoke("pdf_highlight_update", { id: hl.id, color: null, note: "Mit Team klären" });
  const page = await h.create("PDF Rückgängig", "Lesen: [[Undo.pdf]]\n");
  await h.open(page.id, "PDF Rückgängig");
  await app.click('.pane.active > .pane-content:not([hidden]) .ProseMirror .wikilink.file-link[data-file-link="Undo.pdf"]');
  await app.waitFor('.pdf-overlay .pdf-page[data-page="2"] .pdf-mark.is-green', 15000);
  await app.browser.execute(() => document.querySelector('.pdf-overlay .pdf-page[data-page="2"]').scrollIntoView({ block: "center" }));
  await app.click(".pdf-overlay .pdf-mark.is-green");
  await app.click(".pdf-hl-pop .pdf-hl-delete");
  await app.browser.waitUntil(async () => (await app.invoke("pdf_highlights_list", { name: "Undo.pdf" })).length === 0, { timeoutMsg: "not deleted" });
  await undoIn("Mit Team klären");
  await app.browser.waitUntil(async () => (await app.invoke("pdf_highlights_list", { name: "Undo.pdf" })).length === 1, { timeoutMsg: "not back" });
  const [back] = await app.invoke("pdf_highlights_list", { name: "Undo.pdf" });
  assert.deepEqual([back.id, back.note, back.color, back.page], [hl.id, "Mit Team klären", "green", 2]);
  await app.waitFor('.pdf-overlay .pdf-page[data-page="2"] .pdf-mark.is-green');
  await app.keys(["Escape"]);
});

test("a page typed into and deleted right away comes back with the typing and its tab", async () => {
  const page = await app.invoke("page_create", { parentId: null, title: "Gleich weg", icon: null, content: "Erste Zeile\n" });
  await app.invoke("search_open", { target: { kind: "page", page_id: page.id, new_tab: true } });
  await app.waitFor(EDITOR);
  await app.caretToEnd();
  await app.type("Neu getippt");
  const row = await app.$(`.sidebar .tree-row[data-id="${page.id}"]`);
  await row.scrollIntoView({ block: "center" });
  await app.browser.execute((id) => document.querySelector(`.sidebar .tree-row[data-id="${id}"]`).focus(), page.id);
  await app.keys(["Delete"]);
  await app.browser.waitUntil(async () => !!(await app.invoke("page_get", { id: page.id })).deleted_at, { timeout: 8000, timeoutMsg: "not deleted" });
  await undoIn("Gleich weg");
  await app.browser.waitUntil(async () => !(await app.invoke("page_get", { id: page.id })).deleted_at, { timeout: 8000, timeoutMsg: "not restored" });
  await app.browser.waitUntil(async () => (await app.invoke("page_get", { id: page.id })).content.includes("Neu getippt"), {
    timeout: 8000,
    timeoutMsg: `typing lost: ${JSON.stringify((await app.invoke("page_get", { id: page.id })).content)}`,
  });
  await app.browser.waitUntil(() => app.browser.execute(() => document.querySelector(".pane.active > .pane-content:not([hidden]) .page-title")?.value === "Gleich weg"), {
    timeout: 8000,
    timeoutMsg: "the tab did not come back",
  });
});
