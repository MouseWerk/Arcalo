// „E-Mail (Outlook)“ in Settings → Kalender: the global shortcut is off by default and checked
// like the other global shortcuts (AltGr combinations and duplicates are refused), the parent
// page of mail notes is used by the dialog; the dialog in dark mode and at 900 px.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { launch, guarded } from "../lib/harness.js";
import { mailEnv, writeMailFixtures } from "../lib/mail-fixtures.js";

const test = guarded(nodeTest, () => app);
let app;
let fx;
before(async () => {
  fx = writeMailFixtures();
  app = await launch({ env: mailEnv(fx.outlook) });
});
after(async () => {
  await app?.close();
  if (fx) fs.rmSync(fx.dir, { recursive: true, force: true });
});

async function saveWith(patch) {
  const view = await app.invoke("settings_get");
  return app.invoke("settings_save", { settings: { ...view.settings, ...patch(view.settings) } });
}

test("the mail settings live in Settings → Kalender", async () => {
  const view = await app.invoke("settings_get");
  assert.deepEqual(view.settings.mail, { notes_parent: "E-Mails", shortcut: "", save_attachments: false, private_notes: true, default_action: "task" });
  await app.keys(["Control", ","]);
  await app.waitFor(".settings-body");
  await app.click('.settings-nav-item[data-section="calendar"]');
  await app.waitText(".set-group-head h2", /E-Mail \(Outlook\)/);
  await app.waitFor('input[aria-label="Tastenkürzel E-Mail übernehmen"]');
  const group = await app.browser.execute(() => [...document.querySelectorAll(".set-group")].find((g) => /E-Mail \(Outlook\)/.test(g.textContent))?.innerText ?? "");
  assert.match(group, /Tastenkürzel \(global\)/);
  assert.match(group, /Notizen ablegen unter/);
  assert.match(group, /Anhänge vorauswählen/);
  assert.match(group, /#privat/);
  await app.browser.execute(() => [...document.querySelectorAll(".set-group")].find((g) => /E-Mail \(Outlook\)/.test(g.textContent))?.scrollIntoView({ block: "start" }));
  await app.shot("78-mail-settings");
});

test("the global shortcut is validated like the others", async () => {
  await assert.rejects(saveWith((s) => ({ mail: { ...s.mail, shortcut: "Ctrl+Alt+M" } })), /AltGr/);
  await assert.rejects(saveWith((s) => ({ mail: { ...s.mail, shortcut: s.search_shortcut } })), /Schnellsuche und E-Mail übernehmen/);
  const saved = await saveWith((s) => ({ mail: { ...s.mail, shortcut: " Ctrl+Shift+J ", notes_parent: "Posteingang", save_attachments: true } }));
  assert.equal(saved.settings.mail.shortcut, "Ctrl+Shift+J");
  const info = await app.invoke("desktop_info");
  assert.equal(typeof info.mail_shortcut_active, "boolean");
  // Switched off again.
  const off = await saveWith((s) => ({ mail: { ...s.mail, shortcut: "" } }));
  assert.equal(off.settings.mail.shortcut, "");
  assert.equal((await app.invoke("desktop_info")).mail_shortcut_active, false);
});

test("the dialog follows the settings, in dark mode and at 900 px", async () => {
  await saveWith(() => ({ theme: "dark" }));
  await app.browser.waitUntil(async () => (await app.browser.execute(() => document.documentElement.dataset.theme)) === "dark", { timeoutMsg: "dark mode" });
  await app.browser.setWindowSize(900, 820);
  await app.keys(["Control", "k"]);
  await app.waitFor(".palette");
  await app.type("Aktuelle E-Mail");
  await app.waitText(".pal-item", /Aktuelle E-Mail übernehmen/);
  await app.keys(["Enter"]);
  await app.waitText(".mailx-subject", /Angebot für das Portal/);
  // Settings: attachments ticked (not the inline image), notes below „Posteingang“.
  assert.equal(await app.browser.execute(() => document.querySelectorAll(".mailx-files input:checked").length), 1);
  for (const b of await app.$$('.mailx-fields [aria-label="Übernehmen als"] button')) if ((await app.textOf(b)) === "Beides") await b.click();
  assert.equal(await (await app.$('input[aria-label="Übergeordnete Seite"]')).getValue(), "Posteingang");
  // Nothing sticks out of the dialog.
  const overflow = await app.browser.execute(() => {
    const d = document.querySelector(".dialog");
    const r = d.getBoundingClientRect();
    return [...d.querySelectorAll(".mailx *")].filter((el) => {
      const b = el.getBoundingClientRect();
      return b.width > 0 && (b.right > r.right + 1 || b.left < r.left - 1);
    }).map((el) => el.className);
  });
  assert.deepEqual(overflow, []);
  await app.shot("78-mail-dialog-dark-900");
  await app.keys(["Escape"]);
  await app.browser.waitUntil(async () => (await app.$$(".mailx")).length === 0, { timeoutMsg: "dialog not closed" });
  await app.browser.setWindowSize(1480, 920);
  await saveWith(() => ({ theme: "light" }));
});
