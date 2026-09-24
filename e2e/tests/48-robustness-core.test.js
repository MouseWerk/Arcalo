// Robustness of the core (1.4): page titles keep links working ([ ] | # ^ are replaced while
// typing, with a hint), exported bookings cannot be deleted (the menu says why), German error
// texts without technical prefixes, and a vault import with progress, an old Windows encoding
// and same-named files in two folders.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
let base;
before(async () => {
  app = await launch();
  base = fs.mkdtempSync(path.join(os.tmpdir(), "annalo-e2e-robust-"));
});
after(async () => {
  await app?.close();
  if (base) fs.rmSync(base, { recursive: true, force: true });
});

const pageId = async (title) => (await app.invoke("page_resolve", { title, create: false })).id;

test("a title with link characters is shown with the replacement and keeps its links", async () => {
  const target = { id: await pageId("Architektur") };
  const source = await app.invoke("page_create", { title: "Linkquelle", parentId: null, icon: null, content: "Siehe [[Architektur]]\n\n`[[Architektur]]` im Code" });
  for (const r of await app.$$(".sidebar .tree-row")) if ((await app.textOf(r)) === "Architektur") await r.click();
  await app.browser.waitUntil(async () => (await (await app.$(".pane.active .page-title")).getValue()) === "Architektur", { timeoutMsg: "Architektur not open" });
  const title = await app.waitFor(".pane.active .page-title");
  await title.click();
  await app.keys(["End"]);
  await app.type(" C# [Teil|1]");
  await app.waitText(".pane.active .page-title-hint", /\[ \] \| # \^ gehören zur Link-Schreibweise/);
  assert.equal(await title.getValue(), "Architektur C＃ (Teil｜1)");
  await app.shot("48-title-rule");
  await app.keys(["Enter"]);
  await app.browser.waitUntil(async () => (await app.invoke("page_get", { id: target.id })).title === "Architektur C＃ (Teil｜1)", { timeoutMsg: "not renamed" });
  const src = await app.invoke("page_get", { id: source.id });
  assert.equal(src.content, "Siehe [[Architektur C＃ (Teil｜1)]]\n\n`[[Architektur]]` im Code", "the link follows, code stays");
  assert.deepEqual(src.unresolved_links, []);
  // Created through the backend, the same rule applies.
  const direct = await app.invoke("page_create", { title: "Frage #1 ^", parentId: null, icon: null, content: null });
  assert.equal(direct.title, "Frage ＃1 ＾");
  await app.dismissToasts();
});

test("an exported booking cannot be deleted; errors read as plain German", async () => {
  const out = await app.invoke("log_time", { line: "/zeit NP-8801 1h Exportiert-Test" });
  await app.invoke("set_entry_status", { ids: [out.entry.id], status: "exported" });
  const err = await app.invoke("delete_time_entry", { id: out.entry.id }).then(
    () => "",
    (e) => String(e).replace(/^Error: /, ""),
  );
  assert.match(err, /^Exportierte Einträge können nicht gelöscht werden/);
  const parse = await app.invoke("log_time", { line: "/zeit NP-8801 viel Arbeit" }).then(
    () => "",
    (e) => String(e).replace(/^Error: /, ""),
  );
  assert.match(parse, /^Eingabe nicht verstanden: Ungültige Dauer „viel“/);
  const missing = await app.invoke("log_time", { line: "/zeit NP-0000 1h x" }).then(
    () => "",
    (e) => String(e).replace(/^Error: /, ""),
  );
  assert.equal(missing, "Netzplan „NP-0000“ nicht gefunden");

  await app.click('.ribbon [aria-label="Zeiterfassung"]');
  await app.waitText(".view-header h1", /Zeiterfassung/);
  let row;
  await app.browser.waitUntil(
    async () => {
      for (const r of await app.$$(".entry")) if (/Exportiert-Test/.test(await app.textOf(r))) row = r;
      return !!row;
    },
    { timeoutMsg: "entry not listed" },
  );
  await app.dismissToasts();
  await (await row.$('[aria-label="Aktionen"]')).click();
  await app.waitFor(".menu");
  let item;
  for (const m of await app.$$(".menu-item")) if (/Löschen/.test(await app.textOf(m))) item = m;
  assert.match(await app.textOf(item), /Löschen nicht möglich – bereits exportiert/);
  assert.ok((await item.getAttribute("disabled")) != null || (await item.getAttribute("aria-disabled")) === "true", "disabled");
  await app.shot("48-exported-entry-menu");
  await app.keys(["Escape"]);
  assert.ok((await app.invoke("time_entries", { from: null, to: null })).some((e) => e.id === out.entry.id), "still there");
});

test("a vault import reports progress, reads Windows-1252 and keeps same-named files apart", async () => {
  const vault = path.join(base, "Altes Vault");
  for (const [folder, bytes] of [["Projekt A", "a"], ["Projekt B", "b"]]) {
    fs.mkdirSync(path.join(vault, folder, "assets"), { recursive: true });
    fs.writeFileSync(path.join(vault, folder, "assets", "plan.png"), bytes);
    fs.writeFileSync(path.join(vault, folder, `${folder} Notiz.md`), "![[plan.png]]");
  }
  fs.writeFileSync(path.join(vault, "Ansi.md"), Buffer.from([0x47, 0x72, 0xfc, 0xdf, 0x65, 0x20, 0x80]));
  for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(vault, `Notiz ${i}.md`), `Nummer ${i}`);

  await app.keys(["Control", ","]);
  await app.click('.settings-nav-item[data-section="notes"]');
  const input = await app.$('input[aria-label="Vault-Pfad"]');
  await input.setValue(vault);
  for (const r of await app.$$(".set-row"))
    if (/Pfad direkt angeben/.test(await app.textOf(r))) {
      await (await r.$(".btn-secondary")).click();
      break;
    }
  await app.waitText(".toast-title", /Vault importiert/, 20000);
  await app.waitText(".toast-title", /Hinweise zum Import/);
  await app.waitText(".toast", /Ansi\.md: kein UTF-8, als Windows-1252 gelesen/);
  assert.match((await app.invoke("page_get", { id: await pageId("Ansi") })).content, /^Grüße €/);
  const a = (await app.invoke("page_get", { id: await pageId("Projekt A Notiz") })).content;
  const b = (await app.invoke("page_get", { id: await pageId("Projekt B Notiz") })).content;
  assert.notEqual(a, b, "each folder keeps its own picture");
  assert.match(a + b, /plan 2\.png/);
  await app.shot("48-vault-import");
  await app.dismissToasts();
  await app.keys(["Escape"]);
});
