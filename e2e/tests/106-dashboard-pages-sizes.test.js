// Start page 1.7, the framework: a 1.6 layout opens unchanged on the board used last (a widget
// of an unknown kind survives); preset sizes from the keys, the size buttons and the widget menu
// reflow without overlaps and are saved; start pages from a template are renamed, reordered,
// reopened and deleted; a board file leaves out secrets, and an import names the widgets it
// leaves out and refuses a file of a newer version.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
let tmp;
before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "annalo-106-"));
  app = await launch();
});
after(async () => {
  await app?.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

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
const menuItem = (label) => clickText(".menu [role^=menuitem]", label);
const saved = async () => (await app.invoke("settings_get")).settings.dashboard;
const tabs = () => app.browser.execute(() => [...document.querySelectorAll(".pane.active .dash-tab")].map((t) => t.textContent.trim()));
const activeTab = () => app.browser.execute(() => document.querySelector('.pane.active .dash-tab[aria-selected="true"]')?.textContent.trim());
const board = async (name) => (await saved()).boards.find((b) => b.name === name);
const place = async (name, id) => (await board(name))?.widgets.find((w) => w.id === id);
const noOverlaps = (ws) => {
  for (const a of ws) for (const b of ws) if (a !== b) assert.ok(!(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h), `${a.id} overlaps ${b.id}`);
};
const shownIds = () => app.browser.execute(() => [...document.querySelectorAll(".pane.active .dash-grid .dw")].map((el) => el.dataset.widget));

const W = (id, kind, x, y, w, h, config = {}) => ({ id, kind, x, y, w, h, config });
// As 1.6 saved it: two boards, a note's text, „Projekte“ used last, and a widget of a kind
// this version does not know (from a newer version).
const V16 = {
  version: 2,
  active: "projekte",
  notes: { note: "Merkzettel aus 1.6" },
  boards: [
    { id: "heute", name: "Heute", widgets: [W("today", "today", 0, 0, 8, 13, { blocks: { timeline: true } }), W("note", "note", 8, 0, 4, 13, { mode: "text", page: null })] },
    {
      id: "projekte",
      name: "Projekte",
      widgets: [W("clock", "clock", 0, 0, 4, 7, { seconds: false, week: true }), W("recent", "recent", 4, 0, 4, 7, { limit: 6 }), W("zukunft", "aus-der-zukunft", 8, 0, 4, 7, { a: 1 }), W("favorites", "favorites", 0, 7, 4, 6)],
    },
  ],
};

test("a 1.6 layout opens unchanged on the board used last", async () => {
  await app.invoke("dashboard_save", { dashboard: V16 });
  await reload();
  await app.keys(["Control", "t"]);
  await app.waitFor('.pane.active .dw[data-widget="clock"]');
  assert.equal(await activeTab(), "Projekte");
  assert.deepEqual((await shownIds()).sort(), ["clock", "favorites", "recent"], "the unknown widget is hidden");
  // Stored as it was, the unknown widget included.
  assert.deepEqual((await saved()).boards, V16.boards);
  await clickText(".pane.active .dash-tab", "Heute");
  await app.waitFor('.pane.active .dw[data-widget="note"] textarea');
  assert.equal(await (await app.$('.pane.active .dw[data-widget="note"] textarea')).getValue(), "Merkzettel aus 1.6");
  // The switch is saved in the format of 1.7, nothing lost.
  await app.browser.waitUntil(async () => (await saved()).active === "heute", { timeoutMsg: "tab not saved" });
  const d = await saved();
  assert.equal(d.version, 3);
  assert.deepEqual(d.boards, V16.boards);
  assert.deepEqual(d.notes, V16.notes);
  await clickText(".pane.active .dash-tab", "Projekte");
});

test("preset sizes from the keys, the size buttons and the widget menu", async () => {
  await clickText(".pane.active .dash-bar button", "Anpassen");
  await app.waitFor(".pane.active .dash.editing");
  // Keyboard: 3 = wide, 5 = wide and tall, 1 = small.
  await app.browser.execute(() => document.querySelector('.pane.active .dw[data-widget="clock"]').focus());
  for (const [key, w, h] of [
    ["3", 8, 7],
    ["5", 8, 14],
    ["1", 3, 4],
  ]) {
    await app.keys([key]);
    await app.browser.waitUntil(
      () => app.browser.execute((ww, hh) => document.querySelector('.pane.active .dw[data-widget="clock"]').style.gridColumn.endsWith(`span ${ww}`) && document.querySelector('.pane.active .dw[data-widget="clock"]').style.gridRow.endsWith(`span ${hh}`), w, h),
      { timeoutMsg: `key ${key} did not resize` },
    );
  }
  assert.match(await app.text(".pane.active .dash > .sr-only[aria-live]"), /Uhr: Spalte \d+, Zeile \d+, 3 × 4/);
  // The size buttons of a wide widget (drawn to scale): „Hoch“.
  await app.keys(["2"]);
  await app.browser.pause(150);
  await app.click('.pane.active .dw[data-widget="recent"] [aria-label="Widget-Optionen"]');
  await menuItem("Größe: Breit");
  await app.waitFor('.pane.active .dw[data-widget="recent"] .dw-sizes [aria-label="Größe: Hoch"]');
  assert.equal(await (await app.$$('.pane.active .dw[data-widget="recent"] .dw-sizes button')).length, 5);
  await app.click('.pane.active .dw[data-widget="recent"] .dw-sizes [aria-label="Größe: Hoch"]');
  await app.shot("106-sizes-editing");
  await clickText(".pane.active .dash-bar button", "Fertig");
  await app.browser.waitUntil(async () => !(await (await app.$(".pane.active .dash.editing")).isExisting()));
  let p = await board("Projekte");
  assert.deepEqual([p.widgets.find((w) => w.id === "recent").w, p.widgets.find((w) => w.id === "recent").h], [4, 14]);
  noOverlaps(p.widgets);
  // Outside edit mode: the widget menu has the sizes; the change is saved at once.
  await app.browser.execute(() => document.querySelector('.pane.active .dw[data-widget="favorites"] .dw-menu').click());
  await menuItem("Größe");
  await menuItem("Größe: Breit und hoch");
  await app.browser.waitUntil(async () => (await place("Projekte", "favorites"))?.w === 8, { timeoutMsg: "menu size not saved" });
  p = await board("Projekte");
  assert.equal(p.widgets.find((w) => w.id === "favorites").h, 14);
  noOverlaps(p.widgets);
  assert.ok(p.widgets.some((w) => w.id === "zukunft"), "the unknown widget stays on the board");
  await app.shot("106-sizes");
});

test("start pages: from a template, renamed, reordered, reopened and deleted", async () => {
  await app.click('.pane.active .dash-tabs [aria-label="Board hinzufügen"]');
  await menuItem("Persönlich");
  await app.waitFor(".pane.active .dash-tab-input");
  await app.browser.waitUntil(() => app.browser.execute(() => document.activeElement?.classList.contains("dash-tab-input")), { timeoutMsg: "rename field not focused" });
  await app.keys(["Control", "a"]);
  await app.type("Privat");
  await app.keys(["Enter"]);
  await app.browser.waitUntil(async () => (await tabs()).includes("Privat"), { timeoutMsg: "start page not added" });
  assert.equal(await activeTab(), "Privat");
  const kinds = (await board("Privat")).widgets.map((w) => w.kind);
  for (const k of ["scratchpad", "inbox", "resurface", "writing", "checklist"]) assert.ok(kinds.includes(k), `${k} in „Persönlich“: ${kinds}`);
  await app.waitFor('.pane.active .dw[data-kind="resurface"]');
  // Renamed with F2, moved left with Alt+←.
  await app.browser.execute(() => [...document.querySelectorAll(".pane.active .dash-tab")].find((b) => b.textContent.trim() === "Privat").focus());
  await app.keys(["F2"]);
  await app.waitFor(".pane.active .dash-tab-input");
  await app.keys(["Control", "a"]);
  await app.type("Persönliches");
  await app.keys(["Enter"]);
  await app.browser.waitUntil(async () => (await tabs()).includes("Persönliches"), { timeoutMsg: "not renamed" });
  await app.browser.execute(() => [...document.querySelectorAll(".pane.active .dash-tab")].find((b) => b.textContent.trim() === "Persönliches").focus());
  await app.keys(["Alt", "ArrowLeft"]);
  await app.browser.waitUntil(async () => (await tabs()).join() === "Heute,Persönliches,Projekte", { timeoutMsg: `not moved: ${await tabs()}` });
  await app.browser.waitUntil(async () => (await saved()).boards.map((b) => b.name).join() === "Heute,Persönliches,Projekte");
  // The one used last opens after a restart of the window.
  await reload();
  await app.keys(["Control", "t"]);
  await app.waitFor(".pane.active .dash-tab");
  assert.equal(await activeTab(), "Persönliches");
  await app.shot("106-tabs");
  // Deleted from its menu.
  await app.browser.execute(() => {
    const t = [...document.querySelectorAll(".pane.active .dash-tab")].find((b) => b.textContent.trim() === "Persönliches");
    t.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 300, clientY: 120 }));
  });
  await menuItem("Board löschen");
  await clickText(".dialog-foot button", "Board löschen");
  await app.browser.waitUntil(async () => !(await tabs()).includes("Persönliches"), { timeoutMsg: "not deleted" });
  await app.browser.waitUntil(async () => (await saved()).boards.length === 2);
});

test("a board file leaves out secrets; an import checks it and names what it leaves out", async () => {
  // A widget whose settings hold something that looks like a credential.
  const d = await saved();
  const boards = d.boards.map((b) => (b.id === "projekte" ? { ...b, widgets: b.widgets.map((w) => (w.id === "clock" ? { ...w, config: { ...w.config, zones: ["Asia/Tokyo"], apiToken: "geheim-123", account: { password: "pw-456" } } } : w)) } : b));
  await app.invoke("dashboard_save", { dashboard: { ...d, boards, active: "projekte" } });
  await reload();
  await app.keys(["Control", "t"]);
  await app.waitFor('.pane.active .dw[data-widget="clock"] .dw-zones');
  const file = path.join(tmp, "projekte.dashboard.json");
  await app.browser.execute((p) => window.dispatchEvent(new CustomEvent("annalo:dashboard-export", { detail: { board: "projekte", path: p } })), file);
  await app.browser.waitUntil(async () => fs.existsSync(file), { timeoutMsg: "not exported" });
  const text = fs.readFileSync(file, "utf8");
  assert.doesNotMatch(text, /geheim-123|pw-456|apiToken|password/);
  const json = JSON.parse(text);
  assert.equal(json.format, "annalo-dashboard");
  assert.equal(json.version, 2);
  assert.deepEqual(json.board.widgets.find((w) => w.id === "clock").config.zones, ["Asia/Tokyo"]);
  // Imported again with a widget this version does not know (and a token put back in).
  json.board.name = "Projekte (Kopie)";
  json.board.widgets.push({ id: "jira", kind: "jira-sprint-board", x: 0, y: 30, w: 4, h: 6, config: {} });
  json.board.widgets.find((w) => w.id === "recent").config.token = "nicht-uebernehmen";
  await app.dismissToasts();
  await app.browser.execute((j) => window.dispatchEvent(new CustomEvent("annalo:dashboard-import", { detail: j })), JSON.stringify(json));
  // The hidden widget of the newer version went into the file too; both are named.
  await app.waitText(".toast", /Projekte \(Kopie\)[\s\S]*2 unbekannte Widgets ausgelassen: aus-der-zukunft, jira-sprint-board/);
  await app.browser.waitUntil(async () => !!(await board("Projekte (Kopie)")), { timeoutMsg: "not imported" });
  const copy = await board("Projekte (Kopie)");
  assert.ok(!copy.widgets.some((w) => w.kind === "jira-sprint-board"));
  assert.ok(!JSON.stringify(copy).includes("nicht-uebernehmen"), "no secret imported");
  assert.equal(await activeTab(), "Projekte (Kopie)");
  // A file of a newer version is refused.
  await app.dismissToasts();
  await app.browser.execute((j) => window.dispatchEvent(new CustomEvent("annalo:dashboard-import", { detail: j })), JSON.stringify({ ...json, version: 99 }));
  await app.waitText(".toast", /neueren Version/);
  await app.dismissToasts();
});
