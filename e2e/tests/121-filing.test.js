// Ordner & Ablage (1.9), German, light: new meeting, voice and Jira notes land in their year/month
// and project folders; a rule from Settings → Ordner & Ablage („Seite testen“) decides on create;
// „Aufräumen …“ shows the moves as a dry run, applies the chosen ones and „Rückgängig“ puts them
// back; a folder sorts its children by name and folders first.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, guarded } from "../lib/harness.js";
import { settingsSettled } from "../lib/settings.js";
import { voiceFixtures } from "../lib/voice.js";

const test = guarded(nodeTest, () => app);
let app, fx, icsDir;

const pad = (n) => String(n).padStart(2, "0");
const now = new Date();
const year = String(now.getFullYear());
const month = `${pad(now.getMonth() + 1)} – ${new Intl.DateTimeFormat("de-DE", { month: "long" }).format(now)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const flat = (nodes) => nodes.flatMap((n) => [n, ...flat(n.children ?? [])]);
async function pathOf(id) {
  const pages = flat(await app.invoke("workspace_tree"));
  const byId = new Map(pages.map((p) => [p.id, p]));
  const parts = [];
  let p = byId.get(byId.get(id)?.parent_id);
  while (p) {
    parts.unshift(p.title);
    p = byId.get(p.parent_id);
  }
  return parts.join(" / ");
}
async function reload() {
  await app.browser.execute(() => location.reload());
  await app.browser.pause(300);
  await app.browser.waitUntil(() => app.browser.execute(() => document.body.classList.contains("ready")), { timeout: 20000, timeoutMsg: "not ready after reload" });
}
// The row itself, found and scrolled into view in one step: an index taken in one call and used
// in the next can name another row once the tree re-renders (a large tree renders only the rows
// in view, and moving into view re-renders it).
const findRow = (title) =>
  app.browser.execute((t) => {
    const r = [...document.querySelectorAll(".sidebar .tree-row")].find((x) => x.querySelector(".tree-label")?.textContent === t);
    r?.scrollIntoView({ block: "nearest" });
    return r ?? null;
  }, title);
async function row(title) {
  let el = null;
  await app.browser.waitUntil(async () => (el = await findRow(title)) != null, { timeout: 8000, timeoutMsg: `no tree row ${title}` });
  // After the scroll the rows in view may render anew: the element of this title now.
  await app.browser.pause(50);
  return app.browser.$(await findRow(title));
}
async function expand(title) {
  const r = await row(title);
  if ((await r.getAttribute("aria-expanded")) === "false") await (await r.$(".tree-twisty")).click();
}
const menuClick = (label) =>
  app.browser.execute((l) => {
    const item = [...document.querySelectorAll(".menu-item, [role^=menuitem]")].find((b) => b.textContent.trim().startsWith(l));
    item?.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    item?.click();
    return !!item;
  }, label);
const childrenOf = (title) =>
  app.browser.execute((t) => {
    const rows = [...document.querySelectorAll(".sidebar .tree-row")];
    const i = rows.findIndex((r) => r.querySelector(".tree-label")?.textContent === t);
    const level = Number(rows[i].getAttribute("aria-level"));
    const out = [];
    for (const r of rows.slice(i + 1)) {
      const l = Number(r.getAttribute("aria-level"));
      if (l <= level) break;
      if (l === level + 1) out.push(r.querySelector(".tree-label").textContent);
    }
    return out;
  }, title);
async function palette(text) {
  await app.keys(["Control", "k"]);
  await app.waitFor(".palette input");
  await app.type(text);
  await app.browser.pause(250);
  await app.keys(["Enter"]);
}
const toastButton = (label) =>
  app.browser.execute((l) => {
    const b = [...document.querySelectorAll(".toast button")].find((x) => x.textContent.trim() === l);
    b?.click();
    return !!b;
  }, label);

before(async () => {
  fx = voiceFixtures("[00:00] Kurze Notiz zur Ablage.\n");
  icsDir = fs.mkdtempSync(path.join(os.tmpdir(), "arcalo-filing-"));
  const d = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const ics = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//e2e//filing//DE",
    "BEGIN:VEVENT", "UID:filing-1@e2e", "DTSTAMP:20260101T000000Z", `DTSTART:${d}T100000`, `DTEND:${d}T110000`, "SUMMARY:Jour fixe Ablage", "END:VEVENT",
    "END:VCALENDAR", "",
  ].join("\r\n");
  fs.writeFileSync(path.join(icsDir, "plan.ics"), ics);
  app = await launch({ env: fx.env });
  await app.invoke("calendar_source_add", { name: "Plan", url: null, path: path.join(icsDir, "plan.ics") });
  await app.invoke("calendar_sync_now", { source: null });
  await app.browser.waitUntil(async () => (await app.invoke("calendar_status")).sources.every((s) => s.status?.synced_at && !s.syncing), { timeout: 20000, timeoutMsg: "not synced" });
});
after(async () => {
  await app?.close();
  for (const d of [fx?.dir, icsDir]) if (d) fs.rmSync(d, { recursive: true, force: true });
});

test("new meeting, voice and Jira notes land in year/month and project folders", async () => {
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
  const ev = (await app.invoke("calendar_events", { from, to })).find((e) => (e.event?.title ?? e.title) === "Jour fixe Ablage");
  assert.ok(ev, "meeting synced");
  const meeting = await app.invoke("calendar_meeting_note", { key: ev.key });
  assert.equal(await pathOf(meeting.page.id), `Besprechungen / ${year} / ${month}`);

  await app.invoke("voice_start", { pageId: null, meetingKey: null });
  await sleep(1200);
  const stopped = await app.invoke("voice_stop");
  assert.equal(await pathOf(stopped.page_id), `Sprachnotizen / ${year} / ${month}`);

  const jira = await app.invoke("jira_issue_note", { key: "ABC-12" });
  assert.equal(await pathOf(jira.page.id), "Jira / ABC");

  // The daily note of today too.
  const daily = flat(await app.invoke("workspace_tree")).find((p) => p.daily_date === `${year}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`);
  if (daily) assert.equal(await pathOf(daily.id), `Journal / ${year} / ${month}`);

  await reload();
  await expand("Besprechungen");
  await expand(year);
  assert.ok((await childrenOf("Besprechungen")).includes(year));
  assert.ok((await findRow(month)) != null, "month folder shown");
  await app.shot("121-filing-tree-light");
});

test("rules: settings section, test a page, the first matching rule decides on create", async () => {
  await app.keys(["Control", ","]);
  await app.waitFor(".settings-body");
  await app.click('.settings-nav-item[data-section="filing"]');
  await app.waitText(".set-group-head h2", /Wohin neue Seiten kommen/);
  await app.waitText(".set-row-desc", new RegExp(`Beispiel: Sprachnotizen / ${year} / ${month}`));
  await app.waitText(".set-row-desc", /Beispiel: Jira \/ ABC Portal/);
  await app.click(".filing-add");
  const key = await app.waitFor(".filing-rule-key");
  await key.click();
  await app.type("kunde-x");
  await app.keys(["Enter"]);
  const folder = await app.$(".filing-rule-folder");
  await folder.click();
  await app.type("Kunden/X");
  await app.keys(["Enter"]);
  await settingsSettled(app);
  await app.browser.waitUntil(async () => (await app.invoke("settings_get")).settings.filing?.rules?.length === 1, { timeoutMsg: "rule not saved" });
  const view = await app.invoke("settings_get");
  assert.deepEqual(
    view.settings.filing.rules.map((r) => [r.kind, r.key, r.folder, r.enabled]),
    [["tag", "kunde-x", "Kunden/X", true]],
  );
  // A second rule: Jira project ABC → Projekte/ABC.
  await app.invoke("settings_save", {
    settings: { ...view.settings, filing: { ...view.settings.filing, rules: [...view.settings.filing.rules, { id: "", kind: "jira", key: "ABC", value: "", folder: "Projekte/ABC", enabled: true }] } },
  });

  // „Seite testen“ with a page tagged #kunde-x.
  const page = await app.invoke("page_create", { title: "Kundennotiz", parentId: null, content: "Termin mit #kunde-x" });
  await reload();
  await app.keys(["Control", ","]);
  await app.click('.settings-nav-item[data-section="filing"]');
  await app.waitFor(".filing-rule");
  assert.equal((await app.$$(".filing-rule")).length, 2);
  const probe = await app.$('.filing-test input');
  await probe.click();
  await app.type("Kundennotiz");
  await app.keys(["Enter"]);
  await app.waitText(".filing-result", /Kommt nach Kunden \/ X durch Regel 1 · Jetzt: Oberste Ebene/);
  await app.browser.execute(() => document.querySelector(".filing-rules")?.scrollIntoView({ block: "center" }));
  await app.shot("121-filing-settings-light");

  // On create: the Jira rule wins over the type's folder.
  const jira = await app.invoke("jira_issue_note", { key: "ABC-13" });
  assert.equal(await pathOf(jira.page.id), "Projekte / ABC");
  assert.equal(await pathOf(page.id), "", "existing pages are not moved by a new rule");
});

test("tidy-up: preview, choose, apply, undo", async () => {
  const pages = flat(await app.invoke("workspace_tree"));
  const meetings = pages.find((p) => p.title === "Besprechungen" && p.parent_id == null);
  const old1 = await app.invoke("page_create", { title: "Altes Protokoll 1", parentId: meetings.id });
  const old2 = await app.invoke("page_create", { title: "Altes Protokoll 2", parentId: meetings.id });
  const project = await app.invoke("page_create", { title: "Projekt Y", parentId: null });
  const tagged = await app.invoke("page_create", { title: "Notiz Y", parentId: project.id, content: "Für #kunde-x" });
  const stays = await app.invoke("page_create", { title: "Bleibt", parentId: project.id, content: "Eigene Ablage" });
  await reload();

  // The folder's own tidy-up lists only its pages.
  await expand("Besprechungen");
  await (await row("Besprechungen")).click({ button: "right" });
  assert.ok(await menuClick("Aufräumen"));
  await app.waitText(".dialog-title", /„Besprechungen“ aufräumen/);
  await app.waitFor(".tidy-row");
  const scoped = await app.browser.execute(() => [...document.querySelectorAll(".tidy-title")].map((e) => e.textContent));
  assert.deepEqual(scoped.sort(), ["Altes Protokoll 1", "Altes Protokoll 2"]);
  await app.keys(["Escape"]);
  await app.browser.waitUntil(async () => (await app.$$(".dialog")).length === 0);

  await palette("Aufräumen");
  await app.waitFor(".tidy-row");
  const rows = await app.browser.execute(() =>
    [...document.querySelectorAll(".tidy-row")].map((r) => ({ title: r.querySelector(".tidy-title").textContent, to: r.querySelector(".tidy-to").textContent, from: r.querySelector(".tidy-from").textContent })),
  );
  const titles = rows.map((r) => r.title);
  assert.ok(titles.includes("Altes Protokoll 1") && titles.includes("Notiz Y"), JSON.stringify(rows));
  assert.ok(!titles.includes("Bleibt"), "a page in the user's folder stays");
  assert.deepEqual(rows.find((r) => r.title === "Notiz Y"), { title: "Notiz Y", from: "Projekt Y", to: "Kunden / X" });
  assert.equal(rows.find((r) => r.title === "Altes Protokoll 1").to, `Besprechungen / ${year} / ${month}`);
  await app.shot("121-tidy-preview-light");
  // Leave one out.
  await app.browser.execute(() => [...document.querySelectorAll(".tidy-row")].find((r) => r.textContent.includes("Altes Protokoll 2"))?.querySelector("input")?.click());
  const apply = await app.text(".tidy-apply");
  assert.match(apply, new RegExp(`${rows.length - 1} Seiten? verschieben`));
  await app.click(".tidy-apply");
  await app.waitText(".toast-title", new RegExp(`${rows.length - 1} Seiten? verschoben`));
  assert.equal(await pathOf(old1.id), `Besprechungen / ${year} / ${month}`);
  assert.equal(await pathOf(old2.id), "Besprechungen");
  assert.equal(await pathOf(tagged.id), "Kunden / X");
  assert.equal(await pathOf(stays.id), "Projekt Y");

  assert.ok(await toastButton("Rückgängig"));
  await app.waitText(".toast-title", /zurückverschoben/);
  assert.equal(await pathOf(old1.id), "Besprechungen");
  assert.equal(await pathOf(tagged.id), "Projekt Y");
  assert.ok(!flat(await app.invoke("workspace_tree")).some((p) => p.title === "Kunden"), "the created folder is gone again");

  await palette("Letztes Aufräumen");
  await app.waitText(".toast-title", /Nichts rückgängig zu machen/);
});

test("sorting per folder: by name, folders first", async () => {
  const folder = await app.invoke("page_create", { title: "Sortierordner", parentId: null });
  for (const t of ["b-Seite", "C-Seite", "Unterordner", "a-Seite"]) await app.invoke("page_create", { title: t, parentId: folder.id });
  const sub = flat(await app.invoke("workspace_tree")).find((p) => p.title === "Unterordner");
  await app.invoke("page_create", { title: "Darin", parentId: sub.id });
  await reload();
  await expand("Sortierordner");
  assert.deepEqual(await childrenOf("Sortierordner"), ["b-Seite", "C-Seite", "Unterordner", "a-Seite"]);
  await (await row("Sortierordner")).click({ button: "right" });
  assert.ok(await menuClick("Sortieren"));
  assert.ok(await menuClick("Name"));
  await app.browser.waitUntil(async () => (await childrenOf("Sortierordner"))[0] === "a-Seite", { timeoutMsg: "not sorted by name" });
  assert.deepEqual(await childrenOf("Sortierordner"), ["a-Seite", "b-Seite", "C-Seite", "Unterordner"]);
  await (await row("Sortierordner")).click({ button: "right" });
  assert.ok(await menuClick("Sortieren"));
  assert.ok(await menuClick("Ordner zuerst"));
  await app.browser.waitUntil(async () => (await childrenOf("Sortierordner"))[0] === "Unterordner", { timeoutMsg: "folders not first" });
  assert.deepEqual(await app.invoke("folder_style_get", { pageId: folder.id }), { sort: "name", folders_first: true, color: null });
  // A color for the folder's icon.
  await (await row("Sortierordner")).click({ button: "right" });
  assert.ok(await menuClick("Farbe"));
  assert.ok(await menuClick("Grün"));
  await app.browser.waitUntil(async () => (await app.$$(".tree-row .tint-success")).length === 1, { timeoutMsg: "no color" });
  await app.shot("121-sort-color-light");
});
