// Daily-note calendar (palette, dots, booked hours, open a day) and the Markdown mirror written with each backup.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
before(async () => (app = await launch()));
after(async () => app?.close());

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const today = new Date();
const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);

const openCalendarFromPalette = async () => {
  await app.keys(["Control", "k"]);
  await app.waitFor(".palette");
  await app.type("Tagesnotiz eines Tages");
  await app.waitText(".pal-item.sel", /Tagesnotiz eines Tages öffnen/);
  await app.keys(["Enter"]);
  await app.waitFor(".calendar");
};

test("the palette opens the calendar with today and the demo daily note", async () => {
  await openCalendarFromPalette();
  const cell = await app.waitFor(`.cal-day[data-date="${iso(today)}"]`);
  const cls = await cell.getAttribute("class");
  assert.match(cls, /\btoday\b/);
  assert.match(cls, /\bhas-note\b/, "demo daily note shows a dot");
  assert.ok(await app.$(`.cal-day[data-date="${iso(today)}"] .cal-dot`).then((e) => e.isExisting()));
  // KW column and weekday header.
  await app.waitText(".cal-wd", /^Mo$/);
  assert.match(await app.text(".cal-row:not(.cal-weekdays) .cal-kw"), /^\d{1,2}$/);

  // Booked hours from the demo entries appear in their cells.
  const from = await (await app.$(".cal-row:not(.cal-weekdays) .cal-day")).getAttribute("data-date");
  const days = await app.invoke("daily_overview", { from, to: iso(today) });
  const booked = days.find((d) => d.booked_minutes > 0);
  assert.ok(booked, "demo bookings in the visible weeks");
  const hours = await app.text(`.cal-day[data-date="${booked.date}"] .cal-hours`);
  assert.equal(hours, (booked.booked_minutes / 60).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  await app.shot("calendar");

  // Escape closes it.
  await app.keys(["Escape"]);
  await app.browser.waitUntil(async () => !(await (await app.$(".calendar")).isExisting()), { timeoutMsg: "calendar still open" });
});

test("clicking yesterday opens (and creates) yesterday's daily note", async () => {
  const before = await app.invoke("daily_overview", { from: iso(yesterday), to: iso(yesterday) });
  assert.equal(before[0].has_note, false);
  await openCalendarFromPalette();
  const cell = await app.$(`.cal-day[data-date="${iso(yesterday)}"]`);
  if (await cell.isExisting()) await cell.click();
  else await app.keys(["ArrowLeft", "Enter"]); // today is the first cell of the grid
  await app.browser.waitUntil(async () => (await (await app.$(".page-title")).getValue()) === iso(yesterday), {
    timeoutMsg: "daily note for yesterday not opened",
  });
  const after = await app.invoke("daily_overview", { from: iso(yesterday), to: iso(yesterday) });
  assert.equal(after[0].has_note, true);
  assert.ok(!(await (await app.$(".calendar")).isExisting()), "calendar closes after opening a day");
});

test("the daily note header opens the calendar; keyboard moves and opens a day", async () => {
  await app.click('.pane.active [aria-label^="Kalender"]');
  await app.waitFor(".calendar");
  // Opened on the note's day (yesterday); → moves to today, Enter opens it.
  await app.browser.waitUntil(async () => (await (await app.$(".cal-day.focus")).getAttribute("data-date")) === iso(yesterday));
  await app.keys(["ArrowRight"]);
  await app.browser.waitUntil(async () => (await (await app.$(".cal-day.focus")).getAttribute("data-date")) === iso(today));
  await app.keys(["PageDown"]);
  await app.browser.waitUntil(async () => !(await (await app.$(`.cal-day[data-date="${iso(today)}"].focus`)).isExisting()));
  await app.keys(["Home"]); // back to today
  await app.keys(["Enter"]);
  await app.browser.waitUntil(async () => (await (await app.$(".page-title")).getValue()) === iso(today), { timeoutMsg: "today not opened" });
});

const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));

test("each backup refreshes the Markdown mirror with pages and time entries as CSV", async () => {
  await app.invoke("backup_now");
  await app.invoke("backup_now"); // second run replaces the folder in place
  const status = await app.invoke("mirror_status");
  assert.equal(status.enabled, true);
  assert.equal(status.error, null);
  assert.ok(status.last_at, "last mirror time recorded");
  assert.equal(status.path, path.join(app.dataDir, "backups", "markdown"));

  const files = walk(status.path).map((f) => path.relative(status.path, f));
  assert.ok(files.includes("README.txt"), "README at the root");
  assert.match(fs.readFileSync(path.join(status.path, "README.txt"), "utf8"), /Markdown-Kopie/);
  const arch = files.find((f) => path.basename(f) === "Architektur.md");
  assert.ok(arch, `Architektur.md in ${files.join(", ")}`);
  assert.match(fs.readFileSync(path.join(status.path, arch), "utf8"), /Middleware/i);
  assert.ok(files.some((f) => f.endsWith(`${iso(yesterday)}.md`)), "the new daily note is mirrored");

  const csvs = files.filter((f) => f.startsWith(`Zeiterfassung${path.sep}`) && f.endsWith(".csv"));
  assert.ok(csvs.length >= 1, "monthly CSV files");
  const csv = fs.readFileSync(path.join(status.path, csvs[csvs.length - 1]), "utf8");
  assert.ok(csv.startsWith("﻿Datum;Beginn;Ende;Stunden;"), "BOM and German header");
  assert.match(csv, /\d{2}\.\d{2}\.\d{4};\d{2}:\d{2};\d{2}:\d{2};\d+,\d{2};PRJ/);

  // No staging or old folders are left next to the mirror.
  const siblings = fs.readdirSync(path.dirname(status.path)).filter((n) => n.includes("markdown"));
  assert.deepEqual(siblings, ["markdown"]);

  await app.keys(["Control", ","]);
  await app.waitFor(".settings-nav");
  for (const el of await app.$$(".settings-nav-item")) if ((await app.textOf(el)) === "Sicherung") await el.click();
  await app.waitText(".set-row-label", /Markdown-Kopie bei jeder Sicherung/);
  await app.waitFor('[role="switch"][aria-label="Markdown-Kopie bei jeder Sicherung"][aria-checked="true"]');
  await app.waitText(".mirror-last", /gerade eben|vor/);
  await app.waitText(".mirror-path", /markdown/);
  await app.shot("settings-mirror");
});
