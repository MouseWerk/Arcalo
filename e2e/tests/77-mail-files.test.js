// „E-Mail als Aufgabe / Notiz“ without Outlook: an .eml file dropped onto a note opens the
// dialog instead of being embedded (task and note, the .eml stored as the link target, its PDF
// attachment embedded); a pasted Outlook header block becomes a task in the daily note; the
// Markdown export writes the links as text.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, guarded } from "../lib/harness.js";
import { EML, dropFiles, setValue } from "../lib/mail-fixtures.js";

const test = guarded(nodeTest, () => app);
let app;
let page;
before(async () => (app = await launch()));
after(async () => app?.close());

const content = async (id) => (await app.invoke("page_get", { id })).content;

test("an .eml dropped onto a note opens the dialog instead of an embed", async () => {
  page = await app.invoke("page_create", { parentId: null, title: "Lieferung", icon: null, content: "Liefertermine\n" });
  await app.invoke("search_open", { target: { kind: "page", page_id: page.id, new_tab: false } });
  await app.waitText(".pane.active .ProseMirror", /Liefertermine/);
  await dropFiles(app, ".pane.active .ProseMirror", [{ name: "Rückfrage Liefertermin.eml", type: "message/rfc822", text: EML }]);
  await app.waitText(".mailx-subject", /Rückfrage Liefertermin/);
  const card = await app.text(".mailx-card");
  assert.match(card, /Jörg Weiß <joerg@example\.com>/);
  assert.match(card, /könnt ihr den Liefertermin bestätigen\?/);
  assert.match(card, /\.eml/);
  assert.match(await app.text(".mailx-files"), /Lieferplan\.pdf/);
  // Nothing was embedded into the note.
  assert.equal(await content(page.id), "Liefertermine\n");
  await app.shot("77-mail-dialog-eml");

  for (const b of await app.$$('.mailx-fields [aria-label="Übernehmen als"] button')) if ((await app.textOf(b)) === "Beides") await b.click();
  await app.waitFor('.mailx-group[aria-label="Notiz"]');
  await app.select(".mailx-target", "note");
  await app.click('.mailx-files input[type="checkbox"]');
  await setValue(app, 'input[aria-label="Vorgang"]', "NP-8801/1020");
  await app.click(".mailx-submit");
  await app.waitText(".toast", /Notiz angelegt/);

  const parent = (await app.invoke("workspace_tree")).find((n) => n.title === "E-Mails");
  const note = parent.children.find((n) => n.title === "Rückfrage Liefertermin");
  const md = await content(note.id);
  const id = /\(annalo-mail:\/\/([0-9a-z]{8})\)/.exec(md)?.[1];
  assert.ok(id, md);
  assert.match(md, /vorgang: NP-8801\/1020\n/);
  assert.match(md, /!\[\[Lieferplan\.pdf\]\]/);
  assert.match(md, /Original: \[\[Rückfrage Liefertermin\.eml\]\]/);
  assert.match(md, /## Notizen\n\n- \[ \] Rückfrage Liefertermin\n$/);
  const link = await app.invoke("mail_link_info", { id });
  assert.deepEqual([link.source, link.file, link.vorgang], ["eml", "Rückfrage Liefertermin.eml", "NP-8801/1020"], "eml link");
  assert.equal(fs.readFileSync(path.join(app.dataDir, "attachments", "Rückfrage Liefertermin.eml"), "utf8"), EML);
  assert.equal(fs.readFileSync(path.join(app.dataDir, "attachments", "Lieferplan.pdf"), "utf8"), "%PDF-1.4 lieferplan\n");
  // The staged copy is gone once stored.
  assert.deepEqual(fs.readdirSync(path.join(app.dataDir, "mail-temp")), []);
});

test("a pasted header block becomes a task in the daily note", async () => {
  await app.keys(["Control", "k"]);
  await app.waitFor(".palette");
  await app.type("E-Mail als Aufgabe");
  await app.waitText(".pal-item", /E-Mail als Aufgabe oder Notiz/);
  for (const it of await app.$$(".pal-item"))
    if (/E-Mail als Aufgabe oder Notiz/.test(await app.textOf(it))) {
      await it.click();
      break;
    }
  await app.waitFor(".mailx-sources");
  // The Outlook-drag hint points to „Aktuelle E-Mail übernehmen“.
  assert.match(await app.text(".mailx-paste-foot"), /virtuelle Dateien.*Aktuelle E-Mail übernehmen/s);
  await app.shot("77-mail-dialog-sources");
  const header = "-----Ursprüngliche Nachricht-----\nVon: Schmidt, Eva <eva.schmidt@example.com>\nGesendet: Mittwoch, 23. September 2026 16:45\nAn: Kleindienst, Maurice\nBetreff: WG: Zugang Testsystem\nWichtigkeit: Hoch\n\nBitte den Zugang bis Montag einrichten.";
  await setValue(app, ".mailx-paste", header);
  await app.click(".mailx-paste-foot .btn");
  await app.waitText(".mailx-subject", /WG: Zugang Testsystem/);
  assert.match(await app.text(".mailx-card"), /Schmidt, Eva <eva\.schmidt@example\.com>/);
  assert.equal(await (await app.$(".mailx-task-text")).getValue(), "Zugang Testsystem");
  // A pasted mail has nothing to store.
  assert.equal((await app.$$(".mailx-files")).length, 0);
  await app.select(".mailx-target", "daily");
  await app.click(".mailx-submit");
  await app.waitText(".toast", /Aufgabe angelegt/);
  const daily = await app.invoke("daily_note", { date: null });
  const md = await content(daily.id);
  assert.match(md, /- \[ \] Zugang Testsystem !!\n/);
  assert.doesNotMatch(md, /annalo-mail/, "a pasted mail has no link");
});

test("the Markdown export writes mail links as text", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "annalo-mail-export-"));
  try {
    await app.invoke("vault_export", { path: dir });
    const files = fs.readdirSync(path.join(dir, "E-Mails"));
    const md = fs.readFileSync(path.join(dir, "E-Mails", files.find((f) => f.startsWith("Rückfrage"))), "utf8");
    assert.match(md, /^E-Mail: Rückfrage Liefertermin \(Jörg Weiß, 22\.09\.2026\)$/m);
    assert.doesNotMatch(md, /\]\(annalo-mail:/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
