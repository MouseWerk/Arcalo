// Start page 1.7, the new widgets with sample data, in German and in English: Notizzettel (a page
// of its own, checkboxes), Posteingang (file an entry into a page, tick one off), Vor einem Jahr
// (last year's daily note), Per Git-Sync geändert (hint while sync is off), Schreiben, the clock
// with more time zones, Fokus-Timer (the focus session), Checkliste, Sicherung & Sync
// („Jetzt sichern“) and Seite einbetten with „Öffnen“. Hours follow the language (28.00 h in
// English). Screenshots of the board with its tabs in light and dark.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { launch, guarded } from "../lib/harness.js";
import { launchEnglish, germanLeftovers } from "../lib/english.js";

const test = guarded(nodeTest, () => app);
let app;
let enDir;
before(async () => {
  app = await launch({ width: 1480, height: 1000 });
});
after(async () => {
  await app?.close();
  if (enDir) fs.rmSync(enDir, { recursive: true, force: true });
});

const pad = (n) => String(n).padStart(2, "0");
const reload = async () => {
  await app.browser.execute(() => location.reload());
  await app.browser.pause(300);
  await app.browser.waitUntil(() => app.browser.execute(() => document.body.classList.contains("ready")), { timeout: 20000, timeoutMsg: "not ready after reload" });
};
const clickText = async (sel, text) => {
  await app.browser.waitUntil(
    () =>
      app.browser.execute(
        (s, t) => {
          const el = [...document.querySelectorAll(s)].find((b) => b.textContent.trim() === t && !b.disabled);
          el?.click();
          return !!el;
        },
        sel,
        text,
      ),
    { timeoutMsg: `no ${sel} „${text}“` },
  );
  await app.browser.pause(80);
};
const saved = async () => (await app.invoke("settings_get")).settings.dashboard;
const W = (id, kind, x, y, w, h, config = {}) => ({ id, kind, x, y, w, h, config });
const KINDS = ["scratchpad", "inbox", "resurface", "writing", "pomodoro", "clock", "checklist", "status", "synced", "embed", "week"];
const widgetText = (kind) => app.browser.execute((k) => document.querySelector(`.pane.active .dw[data-kind="${k}"]`)?.innerText ?? "", kind);
// Scrolls the start page (not the window) so the widget is in view.
const into = (kind) =>
  app.browser.execute((k) => {
    const home = document.querySelector(".pane.active .home");
    const el = document.querySelector(`.pane.active .dw[data-kind="${k}"]`);
    if (home && el) home.scrollTop += el.getBoundingClientRect().top - home.getBoundingClientRect().top - 80;
  }, kind);
const setTheme = async (theme) => {
  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", { settings: { ...view.settings, theme } });
  await app.browser.execute((t) => (document.documentElement.dataset.theme = t), theme);
};

/** Sample data and a board with every new widget (and the week's hours). */
async function prepare(lang) {
  const de = lang === "de";
  const now = new Date();
  await app.invoke("capture_submit", { text: de ? "Idee: Review-Termin verschieben" : "Idea: move the review", target: { kind: "inbox" } });
  await app.invoke("capture_submit", { text: de ? "- Angebot an Müller nachfassen" : "- Follow up the offer to Miller", target: { kind: "inbox" } });
  const lastYear = await app.invoke("daily_note", { date: `${now.getFullYear() - 1}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` });
  await app.invoke("page_save", { id: lastYear.id, content: de ? "# Rückblick\n\n- Kickoff mit dem Kunden" : "# Look back\n\n- Kickoff with the customer" });
  const status = await app.invoke("page_create", { parentId: null, title: de ? "Projektstatus" : "Project status", icon: "file-text", content: de ? "# Status\n\n- [x] Konzept\n- [ ] Umsetzung\n" : "# Status\n\n- [x] Concept\n- [ ] Build\n" });
  // A booking this week, so the week widget shows hours with decimals.
  const tree = await app.invoke("wbs_tree");
  const np = tree[0].netzplaene[0];
  await app.invoke("time_entry_create", { netzplanId: np.id, vorgangNr: np.vorgaenge[0]?.vorgang_nr ?? null, leistungsart: null, startTime: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 7, 0).toISOString(), durationMinutes: 45, description: "Review" });
  const items = de
    ? [{ id: "a", text: "Sprint-Review vorbereiten", done: true }, { id: "b", text: "Release-Notes schreiben", done: false }]
    : [{ id: "a", text: "Prepare the sprint review", done: true }, { id: "b", text: "Write the release notes", done: false }];
  const board = {
    id: "mine",
    name: de ? "Persönlich" : "Personal",
    widgets: [
      W("scratchpad", "scratchpad", 0, 0, 4, 8, { page: null }),
      W("inbox", "inbox", 4, 0, 4, 8),
      W("resurface", "resurface", 8, 0, 4, 8),
      W("writing", "writing", 0, 8, 8, 7, { days: 14 }),
      W("pomodoro", "pomodoro", 8, 8, 4, 7),
      W("clock", "clock", 0, 15, 4, 7, { zones: ["America/New_York", "Asia/Tokyo"], week: true }),
      W("checklist", "checklist", 4, 15, 4, 7, { items }),
      W("status", "status", 8, 15, 4, 7),
      W("synced", "synced", 0, 22, 4, 7),
      W("embed", "embed", 4, 22, 4, 7, { page: status.id }),
      W("week", "week", 8, 22, 4, 7, { mode: "day" }),
    ],
  };
  const d = await saved();
  await app.invoke("dashboard_save", { dashboard: { version: 3, boards: [...(d.boards?.length ? d.boards : []), board], active: "mine", notes: {} } });
  await reload();
  await app.keys(["Control", "t"]);
  await app.waitFor('.pane.active .dw[data-kind="scratchpad"]');
  // Every widget renders without an error once it is in view.
  for (const k of KINDS) {
    await into(k);
    await app.browser.waitUntil(() => app.browser.execute((kk) => (() => { const b = document.querySelector(`.pane.active .dw[data-kind="${kk}"] .dw-body`); return !!b?.firstElementChild && !b.querySelector(".dw-skel") && (!!b.innerText.trim() || !!b.querySelector("textarea")); })(), k), { timeout: 15000, timeoutMsg: `${k} stays empty` });
    assert.equal(await (await app.$(`.pane.active .dw[data-kind="${k}"] .dw-error`)).isExisting(), false, `${k} shows an error`);
  }
  await app.browser.execute(() => (document.querySelector(".pane.active .home").scrollTo(0, 0), window.scrollTo(0, 0)));
  return { status };
}

test("the new widgets with sample data (German)", async () => {
  await prepare("de");
  // Notizzettel: the first words create a page of its own; a checkbox ticks the task there.
  await app.click('.pane.active .dw[data-kind="scratchpad"] textarea');
  await app.type("Einkauf");
  await app.keys(["Enter"]);
  await app.type("- [ ] Milch");
  await app.keys(["Enter"]);
  await app.type("- [ ] Brot");
  await app.browser.waitUntil(async () => typeof (await saved()).boards.find((b) => b.id === "mine").widgets.find((w) => w.id === "scratchpad").config.page === "number", { timeout: 10000, timeoutMsg: "scratchpad page not created" });
  const pageId = (await saved()).boards.find((b) => b.id === "mine").widgets.find((w) => w.id === "scratchpad").config.page;
  await app.browser.waitUntil(async () => (await app.invoke("page_get", { id: pageId })).content.includes("- [ ] Brot"), { timeoutMsg: "scratchpad not saved" });
  assert.equal((await app.invoke("page_get", { id: pageId })).title, "Notizzettel");
  await app.browser.execute(() => document.querySelector('.pane.active .dw[data-kind="scratchpad"] [aria-label="Ansicht mit Checkboxen"]').click());
  await app.waitFor('.pane.active .dw[data-kind="scratchpad"] input[data-task="0"]');
  await app.browser.execute(() => document.querySelector('.pane.active .dw[data-kind="scratchpad"] input[data-task="0"]').click());
  await app.browser.waitUntil(async () => (await app.invoke("page_get", { id: pageId })).content.includes("- [x] Milch"), { timeoutMsg: "checkbox not saved" });

  // Posteingang: two captures, newest first; one filed into a page, the other ticked off.
  assert.match(await widgetText("inbox"), /Angebot an Müller nachfassen[\s\S]*Review-Termin verschieben/);
  await app.browser.execute(() => document.querySelector('.pane.active .dw[data-kind="inbox"] [aria-label="Ablegen in …"]').click());
  await app.waitFor(".dialog .dws-picker input");
  await (await app.$(".dialog .dws-picker input")).setValue("Projektstatus");
  await clickText(".dialog .dws-hits [role=option]", "Projektstatus");
  await app.waitText(".toast", /In „Projektstatus“ abgelegt/);
  const status = (await app.invoke("page_resolve", { title: "Projektstatus", create: false })).id;
  assert.match((await app.invoke("page_get", { id: status })).content, /Angebot an Müller nachfassen/);
  await app.browser.waitUntil(async () => !/Angebot an Müller/.test(await widgetText("inbox")), { timeoutMsg: "entry still in the inbox" });
  await app.browser.execute(() => document.querySelector('.pane.active .dw[data-kind="inbox"] [aria-label="Erledigt"]').click());
  await app.browser.waitUntil(async () => /Nichts im Posteingang/.test(await widgetText("inbox")), { timeoutMsg: "inbox not empty" });
  await app.dismissToasts();

  // Vor einem Jahr: last year's daily note on this day.
  assert.match(await widgetText("resurface"), new RegExp(`${new Date().getFullYear() - 1}[\\s\\S]*vor einem Jahr[\\s\\S]*Tagesnotiz`));
  assert.match(await widgetText("resurface"), /Zufällige Notiz/i);
  // Schreiben: 14 days, today with the scratchpad's words.
  assert.equal((await app.$$('.pane.active .dw[data-kind="writing"] .dw-writing-bar')).length, 14);
  assert.match(await widgetText("writing"), /Wörter in 14 Tagen/);
  // Fokus-Timer: starts a focus session (the same as in the status bar) and ends it.
  await clickText('.pane.active .dw[data-kind="pomodoro"] button', "25 Min.");
  await app.waitFor('.pane.active .dw[data-kind="pomodoro"] .dw-pomo.work');
  assert.match(await widgetText("pomodoro"), /2[45]:\d\d[\s\S]*Fokus/);
  assert.ok(await app.invoke("focus_state"), "a focus session runs");
  // Uhr with two more zones, Checkliste, Git sync off, „Öffnen“ of the embedded page.
  assert.match(await widgetText("clock"), /New York[\s\S]*Tokyo/);
  assert.equal((await app.$$('.pane.active .dw[data-kind="clock"] .dw-zones li')).length, 2);
  assert.match(await widgetText("checklist"), /1 von 2 erledigt/);
  await (await app.$('.pane.active .dw[data-kind="checklist"] .dw-check-add input')).setValue("Retro planen");
  await app.keys(["Enter"]);
  await app.browser.waitUntil(async () => (await saved()).boards.find((b) => b.id === "mine").widgets.find((w) => w.id === "checklist").config.items.length === 3, { timeoutMsg: "item not saved" });
  await app.browser.execute(() => document.querySelector('.pane.active .dw[data-kind="checklist"] [role=checkbox][aria-checked="false"]').click());
  await app.waitText('.pane.active .dw[data-kind="checklist"] .dw-check-foot', /2 von 3 erledigt/);
  assert.match(await widgetText("synced"), /Git-Sync ist aus/);
  assert.match(await widgetText("embed"), /Projektstatus[\s\S]*Umsetzung/);
  assert.ok(await (await app.$('.pane.active .dw[data-kind="embed"] .dw-embed-head [aria-label="Öffnen"]')).isExisting(), "open button");
  // Sicherung & Sync: „Jetzt sichern“ writes a backup and the widget says so.
  await into("status");
  await clickText('.pane.active .dw[data-kind="status"] button', "Jetzt sichern");
  await app.browser.waitUntil(async () => /Letzte Sicherung/.test(await widgetText("status")), { timeout: 20000, timeoutMsg: "no last backup" });
  assert.ok((await app.invoke("backup_list")).length > 0, "a backup was written");
  assert.match(await widgetText("status"), /Git-Sync[\s\S]*Git-Sync ist aus/);
  // German hours with a decimal comma.
  assert.match(await widgetText("week"), /\d,\d+ h/);
  await app.dismissToasts();
  await app.browser.execute(() => (document.querySelector(".pane.active .home").scrollTo(0, 0), window.scrollTo(0, 0)));
  for (const theme of ["light", "dark"]) {
    await setTheme(theme);
    await app.browser.pause(300);
    await app.shot(`107-notes-board-${theme}`);
  }
  await setTheme("light");
  await app.invoke("focus_abort", { book: false });
});

test("the new widgets in English, hours with a decimal point", async () => {
  await app.close();
  ({ app, dataDir: enDir } = await launchEnglish({ width: 1480, height: 1000 }));
  await prepare("en");
  const titles = await app.browser.execute(() => [...document.querySelectorAll(".pane.active .dw .dw-head h2")].map((h) => h.textContent.trim()));
  for (const name of ["Scratchpad", "Inbox", "A year ago", "Writing", "Focus timer", "Checklist", "Backup & sync", "Changed by Git sync"]) assert.ok(titles.includes(name), `${name} in ${titles}`);
  assert.match(await widgetText("inbox"), /Follow up the offer to Miller/);
  assert.match(await widgetText("resurface"), /a year ago[\s\S]*Daily note/);
  assert.match(await widgetText("writing"), /words in 14 days/);
  assert.match(await widgetText("pomodoro"), /25 min/);
  assert.match(await widgetText("checklist"), /1 of 2 done/);
  assert.match(await widgetText("synced"), /Git sync is off/);
  assert.match(await widgetText("status"), /Back up now[\s\S]*Git sync[\s\S]*Set up/);
  // Hours with a decimal point, never the German comma.
  const week = await widgetText("week");
  assert.match(week, /\d\.\d+ h/);
  assert.doesNotMatch(week, /\d,\d+ h/);
  const all = await app.browser.execute(() => document.body.innerText);
  assert.doesNotMatch(all, /\d,\d+ h\b/);
  // No German left on the start page (the sample content is English too).
  const left = (await germanLeftovers(app)).filter((h) => !/Müller/.test(h));
  assert.deepEqual(left, []);
  await app.browser.execute(() => (document.querySelector(".pane.active .home").scrollTo(0, 0), window.scrollTo(0, 0)));
  await app.shot("107-notes-board-en");
});
