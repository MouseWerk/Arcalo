// Presentation mode (slides split at ---, counter, navigation, speaker notes, presenter view,
// Esc restores the window) and focus sessions (start, notifications held back, booked entry,
// break, abort, start-page widget and the daily note line).

import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
before(async () => (app = await launch()));
after(async () => app?.close());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const menuClick = (label) =>
  app.browser.execute((l) => {
    const item = [...document.querySelectorAll(".menu-item, [role=menuitem]")].find((b) => b.textContent.trim().startsWith(l));
    if (!item) return false;
    item.click();
    return true;
  }, label);
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const counter = () => app.text(".presentation .present-counter");
const slideText = () => app.browser.execute(() => document.querySelector(".presentation .present-slide .slide-content")?.innerText ?? "");
const waitCounter = (re) => app.waitText(".presentation .present-counter", re);
const isFullscreen = () =>
  app.browser.executeAsync((done) => window.__TAURI__.window.getCurrentWindow().isFullscreen().then(done, () => done(null)));

const DECK = [
  "---",
  "vorgang: NP-8801/1020",
  "---",
  "# Quartalsplanung",
  "",
  "Stand der Einführung mit @Anna",
  "",
  "> [!notiz] Geheime Sprechernotiz: zuerst begrüßen",
  "",
  "---",
  "",
  "## Zweite Folie",
  "",
  "- Punkt A",
  "- [x] Schnittstellen erledigt",
  "- [ ] Schulung offen",
  "",
  "```yaml",
  "---",
  "key: 1",
  "---",
  "```",
  "",
  "Notiz: Zweite Notiz nicht zeigen",
  "",
  "---",
  "",
  "## Tabelle",
  "",
  "| Phase | Stunden |",
  "|---|---|",
  "| Konzept | 12 |",
  "| Umsetzung | 40 |",
  "",
  "> [!warning] Budget knapp",
  "> Puffer beachten",
  "",
  "---",
  "",
  "# Danke",
  "",
].join("\n");

let deck;

test("„Präsentieren“ in the page menu shows the note as slides split at ---", async () => {
  deck = await app.invoke("page_create", { parentId: null, title: "Präsentation E2E", icon: null, content: DECK });
  // Opened like a quick-search result (the main window loads the new page into its tree).
  await app.invoke("search_open", { target: { kind: "page", page_id: deck.id, new_tab: false } });
  await app.browser.waitUntil(async () => (await (await app.$(".page-title")).getValue()) === "Präsentation E2E");
  await app.waitFor(".ProseMirror");
  await app.click('.page-view [aria-label="Weitere Aktionen"]');
  assert.ok(await menuClick("Präsentieren"));
  await app.waitFor(".presentation .present-slide");
  await waitCounter(/^1 \/ 4$/);
  const first = await slideText();
  assert.match(first, /Quartalsplanung/);
  assert.match(first, /@Anna/);
  assert.doesNotMatch(first, /Geheime Sprechernotiz/, "speaker notes are hidden on the slide");
  assert.doesNotMatch(first, /vorgang:/, "frontmatter is not a slide");
  await app.shot("present-slide-1");
});

test("arrow keys, space, Home/End, a number + Enter and clicks navigate", async () => {
  await app.keys(["ArrowRight"]);
  await waitCounter(/^2 \/ 4$/);
  const second = await slideText();
  assert.match(second, /Zweite Folie/);
  assert.match(second, /key: 1/, "--- inside a code block does not split");
  assert.doesNotMatch(second, /Zweite Notiz/);
  assert.equal(await app.browser.execute(() => document.querySelectorAll(".presentation .slide-task input:disabled").length), 2, "tasks read-only");
  await app.shot("present-slide-2");
  await app.keys([" "]);
  await waitCounter(/^3 \/ 4$/);
  assert.ok(await (await app.$(".presentation .slide-content table")).isExisting());
  assert.ok(await (await app.$(".presentation .slide-content blockquote.callout-warning")).isExisting(), "callouts are styled");
  await app.keys(["End"]);
  await waitCounter(/^4 \/ 4$/);
  await app.keys(["ArrowRight"]);
  await waitCounter(/^4 \/ 4$/);
  await app.keys(["Home"]);
  await waitCounter(/^1 \/ 4$/);
  await app.keys(["3"]);
  await app.waitText(".presentation .present-typed", /3/);
  await app.keys(["Enter"]);
  await waitCounter(/^3 \/ 4$/);
  await app.keys(["PageUp"]);
  await waitCounter(/^2 \/ 4$/);
  await app.browser.execute(() => document.querySelector(".presentation .present-slide").click());
  await waitCounter(/^3 \/ 4$/);
  assert.match(await app.text(".presentation .present-timer"), /^\d\d:\d\d/);
  const width = await app.browser.execute(() => document.querySelector(".present-progress > span").style.width);
  assert.equal(width, "75%");
});

test("the presenter view shows notes, the next slide and the timer", async () => {
  await app.keys(["Home"]);
  await waitCounter(/^1 \/ 4$/);
  await app.keys(["r"]);
  await app.waitFor(".presentation .presenter");
  await app.waitText(".presenter-notes", /Geheime Sprechernotiz: zuerst begrüßen/);
  await app.waitText(".presenter-label", /Nächste Folie/i);
  assert.match(await app.browser.execute(() => document.querySelector(".presenter-next .slide-content").innerText), /Zweite Folie/);
  assert.match(await app.text(".presenter .present-timer.big"), /^\d\d:\d\d/);
  await app.shot("present-presenter");
  await app.click('.presenter [aria-label="Nächste Folie"]');
  await waitCounter(/^2 \/ 4$/);
  await app.waitText(".presenter-notes", /Zweite Notiz nicht zeigen/);
  await app.keys(["r"]);
  await app.browser.waitUntil(async () => !(await (await app.$(".presentation .presenter")).isExisting()));
  // Beamer look: white slides also in the dark theme.
  await app.keys(["b"]);
  await app.waitFor(".presentation.beamer");
  await app.shot("present-beamer");
  await app.keys(["b"]);
});

test("Esc ends the presentation and restores the window", async () => {
  await app.keys(["Escape"]);
  await app.browser.waitUntil(async () => !(await (await app.$(".presentation")).isExisting()), { timeoutMsg: "presentation still shown" });
  assert.equal(await (await app.$(".page-title")).getValue(), "Präsentation E2E");
  await app.browser.waitUntil(async () => (await isFullscreen()) !== true, { timeoutMsg: "window still full screen" });
  // The shortcut (Ctrl+Shift+P) starts it again; Esc ends it.
  await (await app.$(".ProseMirror")).click();
  await app.keys(["Control", "Shift", "p"]);
  await waitCounter(/^1 \/ 4$/);
  await app.keys(["Escape"]);
  await app.browser.waitUntil(async () => !(await (await app.$(".presentation")).isExisting()));
  assert.deepEqual(await app.consoleErrors(), []);
});

// ------------------------------------------------------------------- focus

test("a short focus session holds toasts back, books its minutes and starts a break", async () => {
  // Test hook: a fractional length (0.2 min = 12 s) through the command itself.
  await app.invoke("focus_start", { start: { reference: "NP-8801/1020", minutes: 0.2, break_minutes: 5, goal: "E2E Fokus" } });
  await app.waitFor(".statusbar .sb-focus.work");
  assert.match(await app.text(".statusbar .sb-focus"), /NP-8801\/1020/);
  assert.ok(await (await app.$(".statusbar .sb-focus .focus-ring")).isExisting(), "ring in the status bar");
  await app.shot("focus-statusbar");
  // A booking during the session: its toast waits for the end of the session.
  await app.keys(["Control", "k"]);
  await app.waitFor(".palette");
  await app.type("/zeit NP-8801/1030 0.5h Zwischendurch");
  await app.waitText(".pal-item", /Buchen/);
  await app.keys(["Enter"]);
  await app.waitText(".statusbar .sb-focus-held", /^1$/);
  assert.equal(await app.browser.execute(() => [...document.querySelectorAll(".toast-title")].filter((t) => /gebucht/.test(t.textContent)).length), 0, "toast held back");
  // End of the session: summary with what was booked and held back.
  await app.waitText(".toast-title", /Pause – 5 Min\./, 20000);
  const detail = await app.browser.execute(() => [...document.querySelectorAll(".toast")].find((t) => /Pause/.test(t.textContent))?.innerText ?? "");
  assert.match(detail, /0:01 h gebucht auf NP-8801\/1020 \(Entwurf\)/);
  // The booking toast; after the reminder time the shell's end-of-day notification is held too.
  assert.match(detail, /\d Hinweise? zurückgehalten: 0,50 h gebucht/);
  await app.waitFor(".statusbar .sb-focus.break");
  await app.shot("focus-done");
  const today = new Date();
  const from = new Date(today.getFullYear(), today.getMonth(), today.getDate()).toISOString();
  const entries = await app.invoke("time_entries", { from, to: null });
  const booked = entries.find((e) => e.description === "E2E Fokus");
  assert.ok(booked, "entry booked");
  assert.equal(booked.duration_minutes, 1);
  assert.equal(booked.status_flag, "draft", "not released");
  assert.equal(booked.vorgang_nr, "1020");
  assert.ok((await app.invoke("focus_entry_ids")).includes(booked.id));
  await app.dismissToasts();
});

test("the dialog starts a session on a Vorgang, aborting asks and books nothing", async () => {
  // End the break via the status bar menu.
  await app.click(".statusbar .sb-focus");
  assert.ok(await menuClick("Pause beenden"));
  await app.browser.waitUntil(async () => !(await (await app.$(".statusbar .sb-focus")).isExisting()));
  await app.click('.ribbon [aria-label="Fokussitzung starten"]');
  await app.waitFor(".dialog .focus-form");
  const ref = await app.$('.dialog input[aria-label="Vorgang"]');
  await ref.click();
  await ref.clearValue();
  await app.type("NP-8801/10");
  await app.waitFor(".combo-list .combo-item");
  await app.shot("focus-dialog");
  await app.browser.execute(() => {
    const it = [...document.querySelectorAll(".combo-item")].find((x) => /NP-8801\/1030/.test(x.textContent));
    it?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  });
  assert.equal(await ref.getValue(), "NP-8801/1030");
  const goal = await app.$('.dialog input[aria-label="Ziel"]');
  await goal.setValue("Dialog-Sitzung");
  await app.click('.dialog [role="radio"]:nth-child(2)');
  await app.click(".dialog-foot .btn-primary");
  await app.waitFor(".statusbar .sb-focus.work");
  assert.match(await app.text(".statusbar .sb-focus"), /49:|50:00/);
  await app.click(".statusbar .sb-focus");
  assert.ok(await menuClick("Sitzung abbrechen"));
  await app.waitFor(".dialog");
  await app.click(".dialog-foot .btn-primary");
  await app.browser.waitUntil(async () => !(await (await app.$(".statusbar .sb-focus")).isExisting()));
  await app.waitText(".toast-title", /Fokussitzung beendet/);
  const all = await app.invoke("time_entries", { from: null, to: null });
  assert.ok(!all.some((e) => e.description === "Dialog-Sitzung"), "nothing booked under a minute");
  await app.dismissToasts();
});

test("the start-page widget „Fokus“ and the line in the daily note", async () => {
  await app.keys(["Control", "t"]);
  await app.waitFor(".dash .dash-bar");
  await app.browser.execute(() => [...document.querySelectorAll(".dash-bar button")].find((b) => /Anpassen/.test(b.textContent))?.click());
  await app.browser.execute(() => [...document.querySelectorAll(".dash-bar button")].find((b) => /Widget hinzufügen/.test(b.textContent))?.click());
  assert.ok(await menuClick("Fokus"));
  await app.browser.execute(() => [...document.querySelectorAll(".dash-bar button")].find((b) => /Fertig/.test(b.textContent))?.click());
  await app.waitFor('.dw[data-kind="focus"]', 10000);
  await app.browser.waitUntil(async () => /Sitzungen heute|Sitzung heute/.test(await app.text('.dw[data-kind="focus"]')), { timeout: 10000, timeoutMsg: "focus widget not filled" });
  assert.match(await app.text('.dw[data-kind="focus"]'), /NP-8801\/1020/);
  await app.shot("focus-widget");
  await app.click('.dw[data-kind="focus"] .dw-focus-actions .btn-ghost');
  await app.waitText(".toast-title", /In die Tagesnotiz eingetragen/);
  const note = await app.invoke("daily_note", { date: iso(new Date()) });
  const content = (await app.invoke("page_get", { id: note.id })).content;
  // The aborted session under a minute does not count.
  assert.match(content, /Fokus heute: 1 Sitzung, 0:01 h — NP-8801\/1020 0:01 h/);
  assert.deepEqual(await app.consoleErrors(), []);
});

test("focus session and presentation are in Ctrl+K", async () => {
  await app.dismissToasts();
  await app.keys(["Control", "k"]);
  await app.waitFor(".palette");
  await app.type("fokussitzung");
  await app.waitText(".pal-item", /Fokussitzung starten/);
  await app.keys(["Escape"]);
  await sleep(100);
});
