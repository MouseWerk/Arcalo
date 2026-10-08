// The pictures of „Neu in Arcalo“ (docs/releases/highlights/img), one per language, from the
// demo data: run by hand when a release's highlights change (not part of the e2e suite).
//   ARCALO_APP=… node --test e2e/highlight-shots.test.js
// Each picture is a 336 × 210 crop of the window at 125 % UI scale.
import { test, after } from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch } from "./lib/harness.js";
import { launchEnglish } from "./lib/english.js";

const OUT = path.resolve(import.meta.dirname, "../docs/releases/highlights/img");
const W = 336;
const H = 210;
let app;
after(async () => app?.close());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, "0");

const TEXT = {
  de: {
    meeting: "Jour fixe Kunde X",
    diagram: "flowchart LR\n  A[Angebot] --> B{Freigabe}\n  B -- ja --> C[Auftrag]\n  B -- nein --> D[Ablage]",
    page: "Ablauf Angebot",
  },
  en: {
    meeting: "Client X weekly",
    diagram: "flowchart LR\n  A[Offer] --> B{Approval}\n  B -- yes --> C[Order]\n  B -- no --> D[Archive]",
    page: "Offer process",
  },
};

/** Crops the window at the top left of `rect` (+ offset) to W × H and writes `name`. */
async function crop(name, rect, dx = -8, dy = -6, box = null) {
  const tmp = path.join(os.tmpdir(), `arcalo-hl-${name}`);
  await app.browser.saveScreenshot(tmp);
  // The UI scale zooms the web view: page coordinates times the zoom are screenshot pixels.
  const css = await app.browser.execute(() => innerWidth);
  const py = [
    "from PIL import Image",
    `im=Image.open(${JSON.stringify(tmp)}).convert("RGB")`,
    `f=im.width/${css}`,
    `x=max(0,round((${rect.left}+${dx})*f)); y=max(0,round((${rect.top}+${dy})*f))`,
    // `box` (page px): a larger area scaled down to the picture.
    box ? `im=im.crop((x,y,x+round(${box?.w}*f),y+round(${box?.h}*f))).resize((${W},${H}), Image.LANCZOS)` : `im=im.crop((x,y,x+${W},y+${H}))`,
    `im.save(${JSON.stringify(path.join(OUT, name))}, optimize=True)`,
  ].join("\n");
  execFileSync("python3", ["-c", py]);
  fs.rmSync(tmp, { force: true });
}
const rectOf = (sel) => app.browser.execute((s) => {
  const r = document.querySelector(s).getBoundingClientRect();
  return { left: r.left, top: r.top };
}, sel);
const rowRect = (title) => app.browser.execute((t) => {
  const r = [...document.querySelectorAll(".sidebar .tree-row")].find((x) => x.querySelector(".tree-label")?.textContent === t);
  if (!r) return null;
  const b = r.getBoundingClientRect();
  return { left: b.left, top: b.top };
}, title);
async function expand(title) {
  await app.browser.waitUntil(async () => !!(await rowRect(title)), { timeout: 8000, timeoutMsg: `no row ${title}` });
  await app.browser.execute((t) => {
    const r = [...document.querySelectorAll(".sidebar .tree-row")].find((x) => x.querySelector(".tree-label")?.textContent === t);
    if (r.getAttribute("aria-expanded") === "false") r.querySelector(".tree-twisty").click();
  }, title);
  await sleep(250);
}

async function shoot(lang) {
  const tx = TEXT[lang];
  const s = (await app.invoke("settings_get")).settings;
  await app.invoke("settings_save", { settings: { ...s, theme: "dark", appearance: { ...s.appearance, ui_scale: 125 } } });
  await sleep(600);

  // Filing: a meeting of today files itself into Besprechungen / year / month.
  const now = new Date();
  const d = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const ics = path.join(app.dataDir, "plan.ics");
  fs.writeFileSync(ics, ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//arcalo//shots//DE", "BEGIN:VEVENT", `UID:shot-${lang}@arcalo`, "DTSTAMP:20260101T000000Z", `DTSTART:${d}T100000`, `DTEND:${d}T110000`, `SUMMARY:${tx.meeting}`, "END:VEVENT", "END:VCALENDAR", ""].join("\r\n"));
  await app.invoke("calendar_source_add", { name: "Plan", url: null, path: ics });
  await app.invoke("calendar_sync_now", { source: null });
  await app.browser.waitUntil(async () => (await app.invoke("calendar_status")).sources.every((x) => x.status?.synced_at && !x.syncing), { timeout: 20000 });
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
  const ev = (await app.invoke("calendar_events", { from, to })).find((e) => (e.event?.title ?? e.title) === tx.meeting);
  await app.invoke("calendar_meeting_note", { key: ev.key });
  await app.browser.execute(() => location.reload());
  await app.browser.waitUntil(() => app.browser.execute(() => document.body.classList.contains("ready")), { timeout: 20000 });
  await sleep(500);
  const meetings = lang === "de" ? "Besprechungen" : "Meetings";
  await expand(meetings);
  await expand(String(now.getFullYear()));
  const month = await app.browser.execute((m) => [...document.querySelectorAll(".sidebar .tree-row .tree-label")].map((l) => l.textContent).find((t) => t.startsWith(m)), `${pad(now.getMonth() + 1)} `);
  await expand(month);
  await sleep(300);
  await crop(`1.9.0-filing-${lang}.png`, await rowRect(meetings), -8, -34);

  // Smart folders above the tree, with „Zuletzt bearbeitet“ open.
  await app.browser.execute(() => {
    const head = document.querySelector(".sidebar .smart-head");
    if (head?.getAttribute("aria-expanded") === "false") head.click();
  });
  await sleep(250);
  await app.browser.execute(() => {
    const k = document.querySelector('.sidebar .smart-folder[data-kind="recent"] .smart-kind');
    if (k?.getAttribute("aria-expanded") === "false") k.click();
  });
  await sleep(400);
  await crop(`1.9.0-smart-folders-${lang}.png`, await rectOf(".sidebar .smart-head"));

  // A diagram in a note.
  const page = await app.invoke("page_create", { title: tx.page, parentId: null, content: "```mermaid\n" + tx.diagram + "\n```\n" });
  await app.browser.execute(() => location.reload());
  await app.browser.waitUntil(() => app.browser.execute(() => document.body.classList.contains("ready")), { timeout: 20000 });
  await app.browser.waitUntil(async () => !!(await rowRect(tx.page)), { timeout: 8000, timeoutMsg: `no row ${page.title}` });
  await app.browser.execute((t) => {
    const r = [...document.querySelectorAll(".sidebar .tree-row")].find((x) => x.querySelector(".tree-label")?.textContent === t);
    r?.click();
  }, tx.page);
  await app.browser.waitUntil(() => app.browser.execute(() => !!document.querySelector(".pane.active .ProseMirror :is(.rich-mermaid, .mmd-view) svg")), { timeout: 15000, timeoutMsg: "no diagram" });
  // Out of the editor: the diagram shows without its source.
  await app.browser.execute(() => {
    document.activeElement?.blur();
    window.getSelection()?.removeAllRanges();
  });
  await sleep(800);
  const svg = await app.browser.execute(() => {
    const b = document.querySelector(".pane.active .ProseMirror :is(.rich-mermaid, .mmd-view) svg").getBoundingClientRect();
    // The whole diagram with a margin, in the picture's proportions.
    const w = Math.max(b.width + 32, (b.height + 32) * 1.6);
    return { left: b.left + b.width / 2 - w / 2, top: b.top + b.height / 2 - w / 3.2, w, h: w / 1.6 };
  });
  await crop(`1.9.0-embeds-${lang}.png`, svg, 0, 0, svg);
}

test("German pictures", async () => {
  app = await launch();
  await shoot("de");
  await app.close();
  app = null;
});

test("English pictures", async () => {
  const en = await launchEnglish();
  app = en.app;
  await shoot("en");
  await app.close();
  app = null;
  fs.rmSync(en.dataDir, { recursive: true, force: true });
});
