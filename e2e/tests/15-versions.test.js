// Robustness: page versions (snapshot, diff, restore), the table toolbar, configurable
// global palette shortcut and the data folder status.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
before(async () => (app = await launch()));
after(async () => app?.close());

const pageId = async (title) => (await app.invoke("page_resolve", { title, create: false })).id;
const content = async (title) => (await app.invoke("page_get", { id: await pageId(title) })).content;
const openFromTree = async (title) => {
  for (const r of await app.$$(".sidebar .tree-row")) if ((await app.textOf(r)) === title) return r.click();
  throw new Error(`tree row ${title} not found`);
};
const clickText = async (sel, pattern) => {
  for (const el of await app.$$(sel)) if (pattern.test(await app.textOf(el))) return el.click();
  throw new Error(`no ${sel} matching ${pattern}`);
};
/** Column count of the first Markdown table in `md`. */
const tableColumns = (md) => {
  const line = md.split("\n").find((l) => l.trim().startsWith("|"));
  return line ? line.trim().replace(/^\||\|$/g, "").split("|").length : 0;
};
const tableRows = (md) => md.split("\n").filter((l) => l.trim().startsWith("|") && !/^\|(\s*:?-+:?\s*\|)+$/.test(l.trim())).length;

test("versions: snapshot, diff against now and restore", async () => {
  await openFromTree("Architektur");
  await app.waitFor(".ProseMirror h2");
  const id = await pageId("Architektur");
  const original = await content("Architektur");
  // The first version: what the page looked like before the edit.
  assert.ok(await app.invoke("page_snapshot", { pageId: id }), "snapshot taken");
  assert.equal(await app.invoke("page_snapshot", { pageId: id }), null, "unchanged content is not stored twice");

  await app.caretToEnd();
  await app.keys(["Enter"]);
  await app.type("Zweiter Stand der Seite");
  await app.browser.pause(900);
  assert.match(await content("Architektur"), /Zweiter Stand der Seite/);

  await app.click('.pane.active [aria-label="Weitere Aktionen"]');
  await app.waitFor(".menu");
  await clickText(".menu-item", /Versionen/);
  await app.waitFor(".versions-item");
  assert.equal((await app.$$(".versions-item")).length, 1);

  // „Jetzt Version sichern“ stores the edited state as a second version.
  await app.click(".versions-snapshot");
  await app.waitText(".toast-title", /Version gesichert/);
  await app.browser.waitUntil(async () => (await app.$$(".versions-item")).length === 2, { timeoutMsg: "second version not listed" });
  await app.dismissToasts();

  // The older version: preview without the new line, diff shows it as removed.
  const items = await app.$$(".versions-item");
  await items[1].click();
  await app.browser.waitUntil(async () => {
    const t = await app.text(".versions-pre");
    return t.length > 0 && !/Zweiter Stand/.test(t);
  }, { timeoutMsg: "old version not previewed" });
  await clickText(".versions-preview .segmented button", /Unterschiede/);
  await app.waitText(".versions-diff .diff-del", /Zweiter Stand der Seite/);
  await app.shot("versions-diff");

  await clickText(".dialog-foot .btn-primary", /Wiederherstellen/);
  // The confirm dialog opens above the versions dialog.
  await app.browser.waitUntil(async () => (await app.$$(".dialog")).length === 2, { timeoutMsg: "no confirm" });
  const confirms = await app.$$(".dialog .dialog-foot .btn-primary");
  await confirms[confirms.length - 1].click();
  await app.waitText(".toast-title", /Version wiederhergestellt/);
  assert.equal(await content("Architektur"), original);
  await app.browser.waitUntil(async () => !/Zweiter Stand/.test(await (await app.$(".pane.active .ProseMirror")).getHTML()), {
    timeoutMsg: "editor still shows the replaced text",
  });
  // The replaced state is still available as a version.
  const versions = await app.invoke("page_versions", { pageId: id });
  const texts = await Promise.all(versions.map((v) => app.invoke("page_version_content", { versionId: v.id })));
  assert.ok(texts.some((t) => /Zweiter Stand/.test(t)), "replaced content kept");
});

test("table toolbar adds a column; the slash menu offers row commands inside tables", async () => {
  await app.dismissToasts();
  await app.keys(["Control", "n"]);
  await app.browser.waitUntil(async () => (await (await app.$(".pane.active .page-title")).getValue()) === "Unbenannt", { timeoutMsg: "no new page" });
  await app.browser.waitUntil(() => app.browser.execute(() => document.activeElement?.classList.contains("page-title") && document.activeElement.selectionEnd > 0));
  await app.type("Tabellenseite");
  await app.keys(["Enter"]);
  await app.browser.pause(300);
  await app.type("/tabelle");
  await app.waitText(".sugg-item.sel", /Tabelle/);
  await app.keys(["Enter"]);
  await app.waitFor(".pane.active .ProseMirror table");
  await app.type("Kopf");
  await app.browser.pause(900);
  assert.equal(tableColumns(await content("Tabellenseite")), 3);

  await app.waitFor(".table-toolbar");
  await app.shot("table-toolbar");
  await app.click('.table-toolbar [data-action="col-right"]');
  await app.browser.pause(900);
  const md = await content("Tabellenseite");
  assert.equal(tableColumns(md), 4, md);
  const rows = tableRows(md);

  await app.type(" /darunter");
  await app.waitText(".sugg-item.sel", /Zeile darunter/);
  await app.keys(["Enter"]);
  await app.browser.pause(900);
  assert.equal(tableRows(await content("Tabellenseite")), rows + 1);
});

test("palette shortcut is validated and saved; the data folder is not flagged", async () => {
  const view = await app.invoke("settings_get");
  assert.equal(view.settings.palette_shortcut, null, "off by default");
  const saved = await app.invoke("settings_save", { settings: { ...view.settings, palette_shortcut: "Ctrl+Shift+K" } });
  assert.equal(saved.settings.palette_shortcut, "Ctrl+Shift+K");
  await assert.rejects(app.invoke("settings_save", { settings: { ...view.settings, palette_shortcut: "Strg+Foo" } }), /ungültig/);
  await assert.rejects(app.invoke("settings_save", { settings: { ...view.settings, palette_shortcut: "Ctrl+Alt+K" } }), /AltGr/);
  // Swapping the two shortcuts works (both stay registered, only their roles change).
  const swapped = await app.invoke("settings_save", { settings: { ...saved.settings, palette_shortcut: saved.settings.capture_shortcut, capture_shortcut: "Ctrl+Shift+K" } });
  assert.equal(swapped.settings.capture_shortcut, "Ctrl+Shift+K");
  const back = await app.invoke("settings_save", { settings: { ...swapped.settings, palette_shortcut: "Ctrl+Shift+K", capture_shortcut: swapped.settings.palette_shortcut } });
  assert.equal(back.settings.palette_shortcut, "Ctrl+Shift+K");
  const off = await app.invoke("settings_save", { settings: { ...view.settings, palette_shortcut: "" } });
  assert.equal(off.settings.palette_shortcut, null);

  await app.keys(["Control", ","]);
  await clickText(".settings-nav-item", /Desktop/);
  await app.waitFor('input[aria-label="Tastenkürzel Befehlspalette"]');

  const status = await app.invoke("data_dir_status");
  assert.equal(status.synced, false);
  assert.equal(status.data_dir, app.dataDir);
  assert.equal(status.pending_move, null);
  assert.equal(status.notice, null);
  // Under ANNALO_DATA_DIR the folder cannot be changed; nothing is recorded.
  await assert.rejects(app.invoke("data_dir_set", { path: `${app.dataDir}-neu`, useExisting: false }), /ANNALO_DATA_DIR/);
});
