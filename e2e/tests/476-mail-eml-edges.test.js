// q124 round 2, H5: an .eml with what mail programs really send (an encoded subject with brackets,
// `#` and `|`, a sender name with a comma, an attachment whose name has spaces and umlauts, a body
// with Markdown characters) becomes a note and a task whose Markdown stays a link and a task, the
// mail's text quoted, with the attachment embedded under its name.

import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
before(async () => (app = await launch({ demo: false })));
after(async () => app?.close());

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const EML = [
  "From: \"Müller, Anna\" <anna.mueller@example.com>",
  "To: Team <team@example.com>",
  `Subject: =?UTF-8?B?${b64("[EXT] Re: Angebot #42 | Phase [2] – Übersicht")}?=`,
  "Date: Thu, 24 Sep 2026 14:32:00 +0200",
  "Message-ID: <abc@example.com>",
  "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="XX"',
  "",
  "--XX",
  "Content-Type: text/plain; charset=utf-8",
  "Content-Transfer-Encoding: quoted-printable",
  "",
  "Hallo,",
  "",
  "# keine =C3=9Cberschrift",
  "- [ ] kein Haken",
  "*nicht fett* und [[kein Link]]",
  "",
  "--XX",
  'Content-Type: application/pdf; name="=?UTF-8?Q?Angebot_Phase_2_=C3=BCbersicht.pdf?="',
  'Content-Disposition: attachment; filename*=UTF-8\'\'Angebot%20Phase%202%20%C3%BCbersicht.pdf',
  "Content-Transfer-Encoding: base64",
  "",
  b64("%PDF-1.4\n%%EOF\n"),
  "--XX--",
  "",
].join("\r\n");

test("an .eml with brackets in its subject becomes a note and a task that stay Markdown", async () => {
  const mail = await app.browser.executeAsync(
    (text, done) => {
      const bytes = new TextEncoder().encode(text);
      window.__TAURI_INTERNALS__.invoke("mail_parse_file", bytes, { headers: { "x-arcalo-name": encodeURIComponent("Re Angebot.eml") } }).then(
        (r) => done(r),
        (e) => done({ error: String(e) }),
      );
    },
    EML,
  );
  assert.ok(!mail.error, mail.error);
  assert.equal(mail.subject, "[EXT] Re: Angebot #42 | Phase [2] – Übersicht");
  assert.equal(mail.attachments.length, 1);
  assert.equal(mail.attachments[0].name, "Angebot Phase 2 übersicht.pdf");
  const created = await app.invoke("mail_import", {
    request: { mail, task: { target: { kind: "daily" }, text: "Angebot prüfen", due: "2026-09-30", priority: 2 }, note: { parent: "", title: "" }, vorgang: "", tags: [], attachments: [mail.attachments[0].index] },
  });
  const note = (await app.invoke("page_get", { id: created.note_page.id })).content;
  // The task in the daily note is one task line with the mail's link, the note, due date and priority.
  const daily = (await app.invoke("page_get", { id: created.task_page.id })).content;
  const tasks = daily.split("\n").filter((l) => l.startsWith("- [") && l.includes("Angebot"));
  assert.equal(tasks.length, 1, daily);
  assert.match(tasks[0], /^- \[ \] Angebot prüfen \[E-Mail: [^\]\[|#]+\]\(arcalo-mail:\/\/[a-z0-9]+\) \[\[[^\]]+\]\] due:2026-09-30 !!$/);
  assert.equal(note.split("\n").filter((l) => l.startsWith("- [")).length, 0, "the note has no task of the mail's text");
  // The mail's text is quoted line by line (its Markdown is read as such: listed as low in r2-editor-export.md).
  assert.match(note, /^> .*keine Überschrift/m);
  assert.match(note, /^> .*kein Haken/m);
  // The attachment is embedded under its name and stored.
  assert.match(note, /!\[\[Angebot Phase 2 übersicht\.pdf\]\]/);
  assert.ok((await app.invoke("attachment_size", { name: "Angebot Phase 2 übersicht.pdf" })) > 0);
});
