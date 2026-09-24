// Notes linked to a Vorgang: property editor, work card, /zeit without reference, timer.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
let pageId;
before(async () => (app = await launch()));
after(async () => app?.close());

const content = async () => (await app.invoke("page_get", { id: pageId })).content;
const entries = () => app.invoke("time_entries", { from: null, to: null });
const row = (key) => `.pane.active .properties [data-prop-key="${key}"]`;
const focused = (sel) =>
  app.browser.waitUntil(() => app.browser.execute((s) => document.activeElement?.matches(s) ?? false, sel), { timeoutMsg: `${sel} not focused` });
const saved = (pattern, msg) =>
  app.browser.waitUntil(async () => pattern.test(await content()), { timeout: 5000, timeoutMsg: `${msg}: ${pattern}` }).catch(async (e) => {
    throw new Error(`${e.message}\n${await content()}`);
  });

/** Adds a property through the editor UI and focuses its value. */
const addProperty = async (key) => {
  const add = (await (await app.$(".pane.active .properties .prop-add")).isExisting()) ? ".pane.active .properties .prop-add" : ".pane.active .props .prop-add";
  await app.click(add);
  await focused('input[aria-label="Name der neuen Eigenschaft"]');
  await app.type(key);
  await app.keys(["Enter"]);
  await focused(`${row(key)} .prop-value-input`);
};

test("a property links the page to a Vorgang and shows its work card", async () => {
  await app.keys(["Control", "n"]);
  await app.browser.waitUntil(() => app.browser.execute(() => document.activeElement?.classList.contains("page-title") && document.activeElement.selectionEnd > 0));
  await app.type("Vorgangsnotiz");
  await app.keys(["Enter"]);
  await focused(".pane.active .ProseMirror");
  await app.type("Notizen zum Vorgang");
  pageId = (await app.invoke("page_resolve", { title: "Vorgangsnotiz", create: false })).id;

  await addProperty("vorgang");
  await app.type("NP-8801/1020");
  await app.keys(["Enter"]);
  await saved(/^---\nvorgang: NP-8801\/1020\n---\n[\s\S]*Notizen zum Vorgang/, "frontmatter not saved");

  await app.waitText(".pane.active .work-card .work-title", /NP-8801\/1020 · Systemintegration/);
  assert.match(await app.text(".pane.active .work-card .work-stats"), /\/ 40,00 h gebucht/);
  assert.match(await app.text(".pane.active .work-card .work-stats"), /ETC/);
  await app.shot("page-work-card");
});

test("/zeit without reference books on the page's Vorgang", async () => {
  await app.caretToEnd();
  await app.keys(["Enter"]);
  await app.type("/zeit 0.5h Abstimmung");
  await app.keys(["Escape"]);
  await app.keys(["Enter"]);
  await app.waitFor(".pane.active .ProseMirror .time-chip");
  await app.waitText(".toast-title", /0,50 h gebucht/);

  const e = (await entries()).find((x) => x.description === "Abstimmung");
  assert.ok(e, "entry booked");
  assert.equal(e.netzplan_nr, "NP-8801");
  assert.equal(e.vorgang_nr, "1020");
  assert.equal(e.duration_minutes, 30);
  assert.equal(e.page_id, pageId);
  await saved(/<time-entry id="\d+" hours="0,50" target="NP-8801\/1020">Abstimmung<\/time-entry>/, "chip not saved");

  await app.waitText(".pane.active .work-card .work-stats", /0,50 h von dieser Seite/);
  await app.click(".pane.active .work-card .work-toggle");
  await app.waitText(".pane.active .work-entries li.own", /0,50 h\s*Abstimmung/);
  const work = await app.invoke("page_work", { pageId });
  assert.equal(work.label, "NP-8801/1020");
  assert.equal(work.page_hours, 0.5);
  assert.equal(work.entries[0].description, "Abstimmung");
});

test("properties are edited in the editor UI and saved with the note", async () => {
  await app.dismissToasts();
  await addProperty("tags");
  await app.type("kunde");
  await app.keys(["Enter"]);
  await app.waitText(`${row("tags")} .prop-chip`, /#\s*kunde/);
  // The tags property shows its chips; the meta line does not repeat them.
  await app.browser.waitUntil(async () => !(await (await app.$(".pane.active .props .tag-chip")).isExisting()), { timeoutMsg: "tag shown twice" });

  await addProperty("status");
  await app.type("aktiv");
  await app.keys(["Enter"]);
  await saved(/^---\nvorgang: NP-8801\/1020\ntags: \[kunde\]\nstatus: aktiv\n---\n/, "new properties not saved");

  // Invalid names are rejected with a hint.
  await app.keys(["Control", ";"]);
  await focused('input[aria-label="Name der neuen Eigenschaft"]');
  await app.type("#x");
  await app.waitText(".pane.active .properties .prop-key-hint", /Ungültiger Name/);
  await app.keys(["Enter"]);
  assert.ok(await (await app.$('input[aria-label="Name der neuen Eigenschaft"]')).isExisting(), "invalid name not taken");
  await app.keys(["Escape"]);
  assert.doesNotMatch(await content(), /#x/);

  // Rename a key.
  const key = await app.$(`${row("status")} .prop-key`);
  await key.click();
  await app.keys(["Control", "a"]);
  await app.type("phase");
  await app.keys(["Enter"]);
  await saved(/\nphase: aktiv\n---\n/, "rename not saved");

  // Body edits afterwards keep the properties (one save path).
  await app.caretToEnd();
  await app.type(" Ende");
  await saved(/^---\nvorgang: NP-8801\/1020\ntags: \[kunde\]\nphase: aktiv\n---\n[\s\S]*Abstimmung[\s\S]*Ende/, "body edit lost properties");
  const doc = await app.invoke("page_get", { id: pageId });
  assert.ok(doc.tags.includes("kunde"), "frontmatter tags are indexed");

  // Remove a property.
  await app.browser.execute((s) => document.querySelector(s)?.click(), `${row("phase")} .prop-remove`);
  await saved(/^---\nvorgang: NP-8801\/1020\ntags: \[kunde\]\n---\n/, "removal not saved");
  await app.shot("page-properties");
});

test("the Vorgang field suggests references (↓ Enter)", async () => {
  const input = `${row("vorgang")} .prop-value-input`;
  await app.click(input);
  await app.keys(["Control", "a"]);
  await app.type("Anforderung");
  await app.waitText(".pane.active .prop-sugg .sugg-item.sel", /NP-8801\/1010 · Anforderungsanalyse/);
  await app.keys(["Enter"]);
  await saved(/^---\nvorgang: NP-8801\/1010\n/, "suggested Vorgang not saved");
  // Esc closes the list and keeps the value.
  await app.keys(["Escape"]);
  assert.equal(await (await app.$(".pane.active .prop-sugg")).isExisting(), false);
  await app.waitText(".pane.active .work-card .work-title", /NP-8801\/1010/);
});

test("the Vorgang picker rewrites the reference and the card follows", async () => {
  await app.click(`${row("vorgang")} [aria-label="Vorgang wählen"]`);
  await app.waitFor(".pane.active .prop-picker");
  await app.select('.pane.active .prop-picker [role="combobox"][aria-label="Vorgang"]', "1030");
  await saved(/^---\nvorgang: NP-8801\/1030\n/, "picked Vorgang not saved");
  await app.waitText(".pane.active .work-card .work-title", /NP-8801\/1030 · Schnittstellen-Design/);
});

test("the work card starts a timer on the Vorgang", async () => {
  await app.dismissToasts();
  await app.click(".pane.active .work-card .btn");
  await app.waitText(".toast-title", /Timer gestartet/);
  const t = await app.invoke("timer_status");
  assert.equal(t.entry.vorgang_nr, "1030");
  assert.equal(t.entry.description, "Vorgangsnotiz");
  await app.waitText(".pane.active .work-card .btn", /Timer läuft/);
  await app.invoke("timer_discard");
});
