// Fixtures of „E-Mail als Aufgabe / Notiz“: the Outlook script's output for two selected
// mails (ANNALO_OUTLOOK_MAIL_FIXTURE; attachments carry their bytes as base64 for „save“) and
// an .eml file with a German subject and a PDF attachment.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

export const OUTLOOK_MAILS = {
  ok: true,
  version: "16.0.0.17928",
  source: "selection",
  items: [
    {
      entryId: "00000000AB12",
      storeId: "0000000038A1BB10",
      subject: "AW: Angebot für das Portal",
      senderName: "Müller, Anna",
      senderEmail: "anna.mueller@example.com",
      to: "Kleindienst, Maurice; Weiß, Jörg",
      cc: "",
      received: "2026-09-24T12:32:00Z",
      conversation: "Angebot für das Portal",
      importance: 2,
      categories: "Projekt X",
      body: "Hallo Maurice,\r\n\r\nbitte prüfe das Angebot bis Freitag und gib mir kurz Bescheid.\r\n\r\nGrüße\r\nAnna",
      truncated: false,
      attachments: [
        { index: 1, name: "Angebot Portal.pdf", size: 18, type: 1, inline: false, data: b64("%PDF-1.4 angebot\n") },
        { index: 2, name: "image001.png", size: 70, type: 1, inline: true, data: "" },
      ],
    },
    {
      entryId: "00000000CD34",
      storeId: "0000000038A1BB10",
      subject: "Protokoll Lenkungskreis",
      senderName: "Weiß, Jörg",
      senderEmail: "/O=EXCHANGELABS/OU=EXCHANGE ADMINISTRATIVE GROUP/CN=RECIPIENTS/CN=WEISS",
      to: "Kleindienst, Maurice",
      received: "2026-09-23T07:05:00Z",
      importance: 1,
      categories: "",
      body: "Anbei das Protokoll.\r\n\r\n- Entscheidung: Go-Live im November",
      attachments: [{ index: 1, name: "Protokoll.pdf", size: 19, inline: false, data: b64("%PDF-1.4 protokoll\n") }],
    },
  ],
};

export const EML = [
  "From: =?utf-8?Q?J=C3=B6rg_Wei=C3=9F?= <joerg@example.com>",
  "To: Maurice <maurice@example.com>",
  "Subject: =?utf-8?B?UsO8Y2tmcmFnZSBMaWVmZXJ0ZXJtaW4=?=",
  "Date: Tue, 22 Sep 2026 09:15:00 +0200",
  "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="B1"',
  "",
  "--B1",
  "Content-Type: text/plain; charset=utf-8",
  "Content-Transfer-Encoding: quoted-printable",
  "",
  "Hallo,",
  "",
  "k=C3=B6nnt ihr den Liefertermin best=C3=A4tigen?",
  "",
  "--B1",
  'Content-Type: application/pdf; name="Lieferplan.pdf"',
  'Content-Disposition: attachment; filename="Lieferplan.pdf"',
  "Content-Transfer-Encoding: base64",
  "",
  b64("%PDF-1.4 lieferplan\n"),
  "--B1--",
  "",
].join("\r\n");

export function writeMailFixtures() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "annalo-mail-fx-"));
  const outlook = path.join(dir, "outlook-mail.json");
  fs.writeFileSync(outlook, JSON.stringify(OUTLOOK_MAILS));
  return { dir, outlook, opened: `${outlook}.opened` };
}

export const mailEnv = (file) => ({ ANNALO_TEST_FIXTURES: "1", ANNALO_OUTLOOK_MAIL_FIXTURE: file, ANNALO_CALENDAR_DELAY_SECS: "3600" });

/** Drops files onto `selector` the way WebView2 delivers a drop from the file manager. */
export async function dropFiles(app, selector, files) {
  await app.browser.execute(
    (sel, list) => {
      const target = document.querySelector(sel);
      const dt = new DataTransfer();
      for (const f of list) dt.items.add(new File([f.text], f.name, { type: f.type }));
      const opts = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: 400, clientY: 300 };
      target.dispatchEvent(new DragEvent("dragenter", opts));
      target.dispatchEvent(new DragEvent("dragover", opts));
      target.dispatchEvent(new DragEvent("drop", opts));
    },
    selector,
    files,
  );
}

/** Sets the value of a React-controlled text field and fires the input event. */
export async function setValue(app, selector, value) {
  await app.browser.execute(
    (sel, v) => {
      const el = document.querySelector(sel);
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    },
    selector,
    value,
  );
}
