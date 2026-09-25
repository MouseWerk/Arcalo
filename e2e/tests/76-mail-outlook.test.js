// „E-Mail als Aufgabe / Notiz“ from Outlook (the script's output comes from a fixture):
// „Aktuelle E-Mail übernehmen“ in the palette reads two selected mails; the first becomes a task
// on the open page with a due date and priority, the second a note with its attachment. The
// link chip in the note and in the task list opens the mail again (the fixture's open hook).
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { launch, guarded } from "../lib/harness.js";
import { mailEnv, writeMailFixtures } from "../lib/mail-fixtures.js";

const test = guarded(nodeTest, () => app);
let app;
let fx;
let page;
before(async () => {
  fx = writeMailFixtures();
  app = await launch({ env: mailEnv(fx.outlook) });
});
after(async () => {
  await app?.close();
  if (fx) fs.rmSync(fx.dir, { recursive: true, force: true });
});

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const tomorrow = iso(new Date(Date.now() + 86400000));
const content = async (id) => (await app.invoke("page_get", { id })).content;

async function palette(text, item) {
  await app.keys(["Control", "k"]);
  await app.waitFor(".palette");
  await app.type(text);
  await app.waitText(".pal-item", item);
  for (const it of await app.$$(".pal-item"))
    if (item.test(await app.textOf(it))) {
      await it.click();
      return;
    }
}

test("„Aktuelle E-Mail übernehmen“ reads the selected Outlook mails", async () => {
  page = await app.invoke("page_create", { parentId: null, title: "Projekt Portal", icon: null, content: "# Portal\n\n## Aufgaben\n\n- [ ] Kickoff vorbereiten\n\n## Notizen\n\nText\n" });
  await app.invoke("search_open", { target: { kind: "page", page_id: page.id, new_tab: false } });
  await app.waitText(".pane.active .ProseMirror", /Kickoff vorbereiten/);

  await palette("Aktuelle E-Mail", /Aktuelle E-Mail übernehmen/);
  await app.waitText(".dialog .dialog-title", /E-Mail übernehmen \(1 von 2\)/);
  await app.waitText(".mailx-subject", /AW: Angebot für das Portal/);
  const card = await app.text(".mailx-card");
  assert.match(card, /Müller, Anna <anna\.mueller@example\.com>/);
  assert.match(card, /Kleindienst, Maurice; Weiß, Jörg/);
  assert.match(card, /bitte prüfe das Angebot bis Freitag/);
  assert.match(card, /Wichtig/);
  // Defaults: the subject without „AW:“, the open page, priority from the importance.
  assert.equal(await (await app.$(".mailx-task-text")).getValue(), "Angebot für das Portal");
  assert.match(await app.text(".mailx-target"), /Aktuelle Seite: Projekt Portal/);
  assert.equal(await app.browser.execute(() => document.querySelector('.mailx-fields [role="radiogroup"][aria-label="Priorität"] [aria-checked="true"]')?.textContent), "Hoch");
  // Inline images are hidden until asked for; nothing is ticked by default.
  assert.equal((await app.$$(".mailx-files li")).length, 1);
  assert.equal(await app.browser.execute(() => document.querySelectorAll(".mailx-files input:checked").length), 0);
  // No local model: „Aufgabe vorschlagen“ is there but disabled with a hint.
  const suggest = await app.browser.execute(() => {
    const b = [...document.querySelectorAll(".mailx .btn")].find((x) => /Aufgabe vorschlagen/.test(x.textContent));
    return b ? { disabled: b.disabled, title: b.title } : null;
  });
  assert.ok(suggest?.disabled && /lokalen KI-Modell/.test(suggest.title), JSON.stringify(suggest));
  await app.shot("76-mail-dialog-task");
});

test("the first mail becomes a task on the open page with due date and link", async () => {
  for (const b of await app.$$(".mailx-chip")) if ((await app.textOf(b)) === "Morgen") await b.click();
  await app.waitFor(".mailx-chip.on");
  await app.click(".mailx-submit");
  // The next mail of the selection follows.
  await app.waitText(".dialog .dialog-title", /E-Mail übernehmen \(2 von 2\)/);
  const md = await content(page.id);
  const m = /- \[ \] Kickoff vorbereiten\n- \[ \] Angebot für das Portal \[E-Mail: AW: Angebot für das Portal \(Müller, Anna, 24\.09\.2026\)\]\(annalo-mail:\/\/([0-9a-z]{8})\) due:(\S+) !!\n/.exec(md);
  assert.ok(m, md);
  assert.equal(m[2], tomorrow);
  const link = await app.invoke("mail_link_info", { id: m[1] });
  assert.equal(link.source, "outlook");
  assert.equal(link.subject, "AW: Angebot für das Portal");
  const tasks = await app.invoke("tasks_list", { filter: { page_id: page.id } });
  assert.deepEqual(tasks.map((t) => [t.due, t.priority]).sort(), [[null, 0], [tomorrow, 2]].sort());
});

test("the second mail becomes a note with its attachment", async () => {
  await app.waitText(".mailx-subject", /Protokoll Lenkungskreis/);
  // The X.500 sender without an address shows the name only.
  assert.match(await app.text(".mailx-meta"), /Weiß, Jörg/);
  assert.doesNotMatch(await app.text(".mailx-meta"), /EXCHANGELABS/);
  for (const b of await app.$$('.mailx-fields [aria-label="Übernehmen als"] button')) if ((await app.textOf(b)) === "Notiz") await b.click();
  await app.waitFor('.mailx-group[aria-label="Notiz"]');
  assert.equal(await (await app.$('input[aria-label="Übergeordnete Seite"]')).getValue(), "E-Mails");
  await app.click('.mailx-files input[type="checkbox"]');
  await app.shot("76-mail-dialog-note");
  await app.click(".mailx-submit");
  await app.browser.waitUntil(async () => (await app.$$(".dialog .mailx")).length === 0, { timeoutMsg: "dialog still open" });
  await app.waitText(".toast", /Notiz angelegt/);

  const tree = await app.invoke("workspace_tree");
  const parent = tree.find((n) => n.title === "E-Mails");
  assert.ok(parent, "parent page created");
  const note = parent.children.find((n) => n.title === "Protokoll Lenkungskreis");
  assert.ok(note, JSON.stringify(parent.children.map((c) => c.title)));
  const md = await content(note.id);
  assert.match(md, /^---\nvon: "Weiß, Jörg"\nan: "Kleindienst, Maurice"\ndatum: 2026-09-23 \d\d:05\nbetreff: "Protokoll Lenkungskreis"\ne-mail: annalo-mail:\/\/[0-9a-z]{8}\ntags: \[e-mail, privat\]\n---\n/);
  assert.match(md, /> Anbei das Protokoll\.\n>\n> - Entscheidung: Go-Live im November\n/);
  assert.match(md, /## Anhänge\n\n!\[\[Protokoll\.pdf\]\]/);
  assert.equal(fs.readFileSync(path.join(app.dataDir, "attachments", "Protokoll.pdf"), "utf8"), "%PDF-1.4 protokoll\n");
  // The temp folder of the save is gone.
  assert.deepEqual(fs.readdirSync(path.join(app.dataDir, "mail-temp")).filter((f) => f.startsWith("outlook-")), []);
});

test("the link chip opens the mail again in Outlook", async () => {
  const note = (await app.invoke("workspace_tree")).find((n) => n.title === "E-Mails").children[0];
  await app.invoke("search_open", { target: { kind: "page", page_id: note.id, new_tab: false } });
  const chip = await app.waitFor('.pane.active .ProseMirror a[href^="annalo-mail:"]');
  assert.match(await app.textOf(chip), /E-Mail: Protokoll Lenkungskreis \(Weiß, Jörg, 23\.09\.2026\)/);
  await app.shot("76-mail-note");
  await app.dismissToasts();
  await chip.click();
  await app.waitText(".toast", /E-Mail in Outlook geöffnet/);
  await app.browser.waitUntil(async () => fs.existsSync(fx.opened), { timeoutMsg: "open hook not called" });
  assert.equal(fs.readFileSync(fx.opened, "utf8"), "00000000CD34\t0000000038A1BB10\n");

  // The task list shows the link as a chip that opens the mail too.
  await app.keys(["Control", "Shift", "a"]);
  await app.waitFor(".tasks-view");
  const row = `.tasks-view .task-row[data-page="${page.id}"]`;
  await app.waitText(row, /Angebot für das Portal/);
  const taskChip = await app.$(`${row} .mail-chip`);
  assert.ok(await taskChip.isExisting(), "mail chip in the task list");
  assert.doesNotMatch(await app.text(row + " .task-text"), /annalo-mail/);
  await app.shot("76-mail-tasks");
  await app.dismissToasts();
  await taskChip.click();
  await app.browser.waitUntil(async () => fs.readFileSync(fx.opened, "utf8").includes("00000000AB12"), { timeoutMsg: "task chip did not open" });
});
