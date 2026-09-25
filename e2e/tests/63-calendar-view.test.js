// The Kalender view: meetings from an ICS subscription, an .ics file and Outlook (fixture) in
// the work week with overlap layout, all-day row, booked time lane and the private appointment
// without details; a click books time with prefilled values (the WBS is remembered for the next
// meeting of the series), writes a meeting note or marks „nicht buchen“; month overflow, list,
// keyboard and the narrow and dark looks.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { launch, guarded } from "../lib/harness.js";
import { iso, outlookEnv, serveTeam, week, writeFixtures, TUESDAY } from "../lib/calendar-fixtures.js";

const test = guarded(nodeTest, () => app);
let app;
let fx;
let team;
const pad = (n) => String(n).padStart(2, "0");
const de = (d) => `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;

before(async () => {
  fx = writeFixtures();
  team = await serveTeam();
  app = await launch({ env: outlookEnv(fx.outlook) });
  await app.invoke("calendar_source_add", { name: "Team", url: team.url, path: null });
  await app.invoke("calendar_source_add", { name: "Projektplan", url: null, path: fx.file });
  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", { settings: { ...view.settings, calendar: { ...view.settings.calendar, outlook: true } } });
  await app.invoke("calendar_sync_now", { source: null });
  await app.browser.waitUntil(async () => (await app.invoke("calendar_status")).sources.every((s) => s.status?.synced_at && !s.syncing), { timeout: 20000, timeoutMsg: "sources not synced" });
});
after(async () => {
  await app?.close();
  team?.server.close();
  if (fx) fs.rmSync(fx.dir, { recursive: true, force: true });
});

/** The field value of the open dialog by its label. */
const field = (label) =>
  app.browser.execute((l) => {
    const f = [...document.querySelectorAll(".dialog .field")].find((x) => x.querySelector(".field-label")?.textContent === l);
    const input = f?.querySelector("input");
    return input ? input.value : (f?.querySelector("[data-value]")?.dataset.value ?? null);
  }, label);

const block = (title) => app.browser.execute((t) => [...document.querySelectorAll(".calv-ev")].find((b) => b.querySelector(".calv-ev-title")?.textContent === t)?.getAttribute("data-key") ?? null, title);
const clickEvent = async (title, index = 0) => {
  await app.waitText(".calv-ev .calv-ev-title, .calv-agenda-row .calv-ev-title", new RegExp(`^${title.replace(/[()]/g, ".")}$`)).catch(() => {});
  const ok = await app.browser.execute(
    (t, i) => {
      const all = [...document.querySelectorAll(".calv-ev, .calv-agenda-row")].filter((b) => b.querySelector(".calv-ev-title")?.textContent === t);
      all[i]?.click();
      return !!all[i];
    },
    title,
    index,
  );
  assert.ok(ok, `no block „${title}“`);
  await app.waitText(".calv-detail-title", new RegExp(title.replace(/[()]/g, ".")));
};

test("the work week shows meetings of all sources next to the booked time", async () => {
  await app.click(".ribbon-calendar-view");
  await app.waitFor(".calv-grid");
  const { monday, at } = week();
  // Work week of the demo settings: Monday to Friday, KW label, today marked.
  const heads = await app.browser.execute(() => [...document.querySelectorAll(".calv-dayhead")].map((h) => h.dataset.date));
  assert.deepEqual(heads, [0, 1, 2, 3, 4].map((i) => iso(new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i))));
  await app.waitText(".calv-kw", /^KW \d+$/);
  for (const t of ["Jour fixe Änderungen", "Sprint Review", "Kundentermin Müller", "Architektur", "Budgetrunde", "Abstimmung 1"]) await app.waitText(".calv-ev .calv-ev-title", new RegExp(`^${t}$`));
  // The declined meeting is left out, the private one keeps only its time.
  assert.equal(await block("Abgelehnt"), null);
  assert.equal(await block("Arzt"), null);
  assert.ok(await block("Privater Termin"));
  // All-day row: the release from the ICS file (the folded summary healed).
  await app.waitText(`.calv-allday-cell .calv-ev-title`, /^Release-Tag mit Übergabe an den Betrieb$/);
  // Overlapping meetings stand side by side.
  const [a, b] = await app.browser.execute(() =>
    ["Architektur", "Budgetrunde"].map((t) => {
      const el = [...document.querySelectorAll(".calv-ev")].find((x) => x.querySelector(".calv-ev-title")?.textContent === t);
      const r = el.getBoundingClientRect();
      const col = el.closest(".calv-col").getBoundingClientRect();
      return { left: r.left, right: r.right, width: r.width, col: col.width };
    }),
  );
  assert.ok(a.width < a.col * 0.5 && b.width < b.col * 0.5, `half width: ${JSON.stringify([a, b])}`);
  assert.ok(a.right <= b.left + 1 || b.right <= a.left + 1, "side by side, not on top of each other");
  // The meeting at 10:00 sits at 10 hours down the grid.
  const top = await app.browser.execute(() => {
    const el = [...document.querySelectorAll(".calv-ev")].find((x) => x.querySelector(".calv-ev-title")?.textContent === "Jour fixe Änderungen");
    return parseFloat(el.style.top);
  });
  assert.equal(top, 10 * 48);
  // Booked time lane (demo bookings) and the source colors.
  // (Demo entries may run past midnight: one entry can show on two days.)
  const lane = await app.browser.execute(() => [...new Set([...document.querySelectorAll(".calv-lane .calv-entry")].map((e) => e.dataset.entry))].sort());
  const entries = await app.invoke("time_entries", { from: new Date(monday.getTime() - 86400e3).toISOString(), to: at(5, 0).toISOString() });
  const expected = entries
    .filter((e) => e.status_flag !== "running" && e.duration_minutes)
    .filter((e) => new Date(e.start_time).getTime() + e.duration_minutes * 60e3 > monday.getTime())
    .map((e) => String(e.id))
    .sort();
  assert.deepEqual(lane, expected);
  const colors = await app.browser.execute(() => new Set([...document.querySelectorAll(".calv-ev")].map((b) => b.style.getPropertyValue("--ev"))).size);
  assert.ok(colors >= 3, `one color per source: ${colors}`);
  await app.shot("63-calendar-week");
});

let netzplan;
test("„Zeit buchen“ opens the entry dialog prefilled and links the entry", async () => {
  const { at } = week();
  const tree = await app.invoke("wbs_tree");
  netzplan = tree.flatMap((p) => p.netzplaene)[1];
  await clickEvent("Jour fixe Änderungen");
  await app.waitText(".calv-detail", /Anna Müller/);
  await app.waitText(".calv-detail", /Jörg Weiß · Zoë Schmidt/);
  await app.waitText(".calv-detail .calv-book-state", /Noch nicht gebucht/);
  await app.shot("63-calendar-detail");
  await app.click(".calv-detail-actions .btn-primary");
  await app.waitText(".dialog-title", /Zeit erfassen/);
  await app.waitText(".dialog .calv-book-note", /Aus dem Termin „Jour fixe Änderungen“/);
  assert.equal(await field("Datum"), de(at(0, 0)));
  assert.equal(await field("Beginn"), "10:00");
  assert.equal(await field("Dauer"), "1,00");
  assert.equal(await field("Beschreibung"), "Jour fixe Änderungen");
  await app.select('.dialog [aria-label="Netzplan"]', String(netzplan.id));
  await app.shot("63-calendar-book-dialog");
  await app.click(".dialog .btn-primary");
  await app.browser.waitUntil(async () => !(await (await app.$(".dialog")).isExisting()), { timeoutMsg: "dialog open" });

  const entries = await app.invoke("time_entries", { from: at(0, 0).toISOString(), to: at(1, 0).toISOString() });
  const booked = entries.find((e) => e.description === "Jour fixe Änderungen");
  assert.ok(booked, "entry created");
  assert.equal(booked.netzplan_id, netzplan.id);
  assert.equal(booked.duration_minutes, 60);
  assert.equal(new Date(booked.start_time).getTime(), at(0, 10).getTime());
  await app.waitText(".calv-detail .calv-book-state", new RegExp(`Gebucht: ${netzplan.netzplan_nr}`));
  await app.browser.waitUntil(async () => app.browser.execute(() => !!document.querySelector(".calv-ev.booked .calv-mark.booked")), { timeoutMsg: "no booked mark" });
  const key = await block("Jour fixe Änderungen");
  const ev = (await app.invoke("calendar_events", { from: at(0, 0).toISOString(), to: at(1, 0).toISOString() })).find((e) => e.key === key);
  assert.equal(ev.entry_id, booked.id, "linked to the appointment");
});

test("next week the same series suggests the WBS used last time", async () => {
  await app.click('.calv-nav [aria-label="Weiter (→)"]');
  const next = week(1);
  await app.waitFor(`.calv-dayhead[data-date="${iso(next.monday)}"]`);
  await clickEvent("Jour fixe Änderungen");
  await app.click(".calv-detail-actions .btn-primary");
  await app.waitText(".dialog .calv-book-note", /WBS wie beim letzten Mal/);
  assert.equal(await field("Netzplan"), String(netzplan.id));
  assert.equal(await field("Datum"), de(next.at(0, 0)));
  await app.keys(["Escape"]);
  await app.browser.waitUntil(async () => !(await (await app.$(".dialog")).isExisting()));
  await app.click('.calv-nav [aria-label="Datum wählen"]');
  await app.waitFor(".calendar");
  await app.keys(["Escape"]);
  // T: back to today.
  await app.click(".calv-heading h1");
  await app.keys(["t"]);
  await app.waitFor(`.calv-dayhead[data-date="${iso(week().monday)}"]`);
});

test("a meeting note is created from the appointment and opened", async () => {
  await clickEvent("Kundentermin Müller");
  await app.waitText(".calv-detail .btn", /Teams-Besprechung beitreten/);
  const btn = await app.browser.execute(() => [...document.querySelectorAll(".calv-detail-actions .btn")].find((b) => /Besprechungsnotiz/.test(b.textContent)).textContent);
  assert.equal(btn, "Besprechungsnotiz");
  await app.browser.execute(() => [...document.querySelectorAll(".calv-detail-actions .btn")].find((b) => /Besprechungsnotiz/.test(b.textContent)).click());
  const title = `Kundentermin Müller ${de(week().at(4, 0))}`;
  await app.browser.waitUntil(async () => (await (await app.$(".pane.active .page-title")).getValue().catch(() => "")) === title, { timeoutMsg: `note ${title} not opened` });
  const page = await app.invoke("page_resolve", { title, create: false });
  const doc = await app.invoke("page_get", { id: page.id });
  assert.match(doc.content, /^---\ndatum: \d{4}-\d{2}-\d{2}\nuhrzeit: "09:00–10:30"\nort: "Microsoft Teams-Besprechung"\norganisator: "Müller, Anna"\nteilnehmer: "Müller, Anna, Weiß, Jörg"/);
  assert.match(doc.content, /\[Besprechung beitreten\]\(https:\/\/teams\.microsoft\.com\/l\/meetup-join\/19%3akunde\)/);
  assert.match(doc.content, /## Teilnehmer\n\n- Müller, Anna\n- Weiß, Jörg\n/, "the demo template's attendee list is filled");
  const parent = (await app.invoke("workspace_tree")).find((n) => n.title === "Besprechungen");
  assert.ok(parent?.children.some((c) => c.id === page.id), "below „Besprechungen“");
  // Back in the Kalender the appointment opens its note.
  await app.click(".ribbon-calendar-view");
  await clickEvent("Kundentermin Müller");
  await app.waitText(".calv-detail-actions .btn", /Besprechungsnotiz öffnen/);
});

test("„Nicht buchen“ marks a meeting; the month folds a full day; the list and keys work", async () => {
  await clickEvent("Sprint Review");
  await app.browser.execute(() => [...document.querySelectorAll(".calv-detail-actions .btn")].find((b) => b.textContent === "Nicht buchen").click());
  await app.waitText(".calv-detail .calv-book-state", /nicht buchen/);
  await app.browser.waitUntil(async () => app.browser.execute(() => [...document.querySelectorAll(".calv-ev.skipped .calv-ev-title")].some((t) => t.textContent === "Sprint Review")), { timeoutMsg: "not marked" });
  await app.keys(["Escape"]);
  await app.browser.waitUntil(async () => !(await (await app.$(".calv-detail")).isExisting()), { timeoutMsg: "detail still open" });

  // M: month. Tuesday has eight meetings: three lines and „+5 weitere“.
  await app.keys(["m"]);
  await app.waitFor(".calv-month");
  const cell = `.calv-mcell[data-date="${iso(TUESDAY)}"]`;
  await app.waitText(`${cell} .calv-more`, /^\+5 weitere$/);
  assert.equal(await app.browser.execute((c) => document.querySelectorAll(`${c} .calv-mev`).length, cell), 3);
  await app.shot("63-calendar-month");
  await app.click(`${cell} .calv-more`);
  // The day view of that Tuesday with all of them.
  await app.waitFor(`.calv-dayhead[data-date="${iso(TUESDAY)}"]`);
  assert.equal(await app.browser.execute(() => document.querySelectorAll(".calv-dayhead").length), 1);
  assert.equal(await app.browser.execute(() => document.querySelectorAll(".calv-meetings .calv-ev").length), 8);

  // L: the list of the next 14 days.
  await app.keys(["l"]);
  await app.waitFor(".calv-agenda");
  await app.waitText(".calv-agenda-row .calv-ev-title", /Abstimmung 6/);
  await app.shot("63-calendar-list");
  await app.keys(["w"]);
  await app.waitFor(".calv-grid.days-7");
  await app.keys(["a"]);
  await app.waitFor(".calv-grid.days-5");
});

test("dark theme and a narrow split pane stay readable", async () => {
  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", { settings: { ...view.settings, theme: "dark" } });
  await app.browser.waitUntil(async () => (await app.browser.execute(() => document.documentElement.dataset.theme)) === "dark", { timeoutMsg: "not dark" });
  await clickEvent("Jour fixe Änderungen");
  await app.shot("63-calendar-dark");
  // A second pane next to the calendar: the view switcher becomes a dropdown, the detail an overlay.
  await app.browser.setWindowSize(1100, 820);
  await app.browser.execute(() => document.querySelector(".pane.active .tab.active")?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 300, clientY: 20 })));
  await app.waitText(".menu-item", /Rechts daneben öffnen/);
  await app.browser.execute(() => [...document.querySelectorAll(".menu-item")].find((b) => /Rechts daneben öffnen/.test(b.textContent)).click());
  await app.browser.waitUntil(async () => (await app.browser.execute(() => document.querySelectorAll(".pane").length)) === 2, { timeoutMsg: "no split" });
  await app.waitFor(".pane.active .calv-view-select");
  const overflow = await app.browser.execute(() => {
    const p = document.querySelector(".pane.active .calv");
    return p.scrollWidth - p.clientWidth;
  });
  assert.ok(overflow <= 1, `no sideways scrolling: ${overflow}`);
  await app.shot("63-calendar-narrow-dark");
  await app.invoke("settings_save", { settings: { ...(await app.invoke("settings_get")).settings, theme: "light" } });
  await app.browser.setWindowSize(1480, 920);
});
