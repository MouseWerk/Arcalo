// Screenshots of the 1.5 features for the README and the website (not part of the test suite):
// a realistic week of SAP project work (meetings, bookings, focus sessions, page editing), taken
// in the default light and dark themes. Run after building the app:
//   ANNALO_SHOTS=/tmp/shots ANNALO_APP=../target/debug/annalo node --test readme-shots-15.test.js
// ANNALO_SCALE (default 2) is the device scale factor (GDK_SCALE); at 2 the X display must be at
// least 2960x1840. ANNALO_SCENES=week,calendar,… takes only some scenes. The week is the current
// one, so the pictures tell their story best on a Friday (the day review shows Thursday).
import { test, before, after } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launch } from "./lib/harness.js";
import { week } from "./lib/calendar-fixtures.js";
import { openCapture } from "./lib/capture.js";
import { startFakeLiteLLM } from "./lib/fake-litellm.js";

const SCALE = process.env.ANNALO_SCALE ?? "2";
const ONLY = process.env.ANNALO_SCENES?.split(",") ?? null;
const want = (name) => !ONLY || ONLY.includes(name);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, "0");
const ics = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`;
const utc = (d) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

const cur = week(0);
const prev = week(-1);
const prev2 = week(-2);
const at = cur.at;

let app, llm, dir;

// ---------------------------------------------------------------- fixtures

function event(uid, start, minutes, summary, extra = []) {
  return ["BEGIN:VEVENT", `UID:${uid}`, `DTSTART:${ics(start)}`, `DTEND:${ics(new Date(start.getTime() + minutes * 60e3))}`, `SUMMARY:${summary}`, ...extra, "END:VEVENT"];
}

/** The work calendar: a weekly Jour fixe (series) and the week's meetings. */
function calendar() {
  const jf = prev2.at(0, 10);
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Annalo readme//DE",
    ...event("jourfixe@readme", jf, 60, "Jour fixe Änderungen", [
      "RRULE:FREQ=WEEKLY;COUNT=10",
      "ORGANIZER;CN=Anna Müller:mailto:anna.mueller@example.com",
      "ATTENDEE;CN=Jörg Weiß:mailto:joerg.weiss@example.com",
      "DESCRIPTION:Microsoft Teams-Besprechung\\nhttps://teams.microsoft.com/l/meetup-join/19%3areadme",
    ]),
    ...event("review@readme", at(1, 14), 60, "Schnittstellen-Review", ["LOCATION:Raum Zürich"]),
    ...event("runde@readme", at(2, 11), 60, "Architektur-Runde"),
    ...event("kunde@readme", at(3, 13), 90, "Kundentermin Müller", ["LOCATION:Microsoft Teams-Besprechung"]),
    ...event("kunde-alt@readme", prev2.at(3, 13), 60, "Kundentermin Müller"),
    ...event("sprint@readme", at(4, 14), 60, "Sprint Review"),
    ...event("release@readme", at(4, 16), 30, "Go-Live-Checkliste"),
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}

/** The mail selected in Outlook (the script's output). */
const MAIL = {
  ok: true,
  version: "16.0.0.17928",
  source: "selection",
  items: [
    {
      entryId: "00000000AB12",
      storeId: "0000000038A1BB10",
      subject: "AW: Testdaten für den Integrationstest",
      senderName: "Müller, Anna",
      senderEmail: "anna.mueller@example.com",
      to: "Projektteam Auftragsportal",
      cc: "Weiß, Jörg",
      received: utc(at(4, 8, 42)),
      conversation: "Testdaten für den Integrationstest",
      importance: 2,
      categories: "Projekt X",
      body:
        "Hallo zusammen,\r\n\r\ndie Testdaten für die Bestellungen liegen jetzt im Q-System. Bitte prüft bis Dienstag, ob die Sonderfälle (Teillieferung, Storno) abgedeckt sind, und gebt mir kurz Bescheid.\r\n\r\nViele Grüße\r\nAnna",
      truncated: false,
      attachments: [
        { index: 1, name: "Testdaten Bestellungen.xlsx", size: 48213, type: 1, inline: false, data: "" },
        { index: 2, name: "Testfälle Integrationstest.pdf", size: 132870, type: 1, inline: false, data: "" },
        { index: 3, name: "image001.png", size: 70, type: 1, inline: true, data: "" },
      ],
    },
  ],
};

const KONZEPT = `---
vorgang: NP-8801/1030
---
Das Auftragsportal übergibt Bestellungen per IDoc an SAP; Status und Lieferdaten kommen per Delta-Load zurück.

## Schnittstellen

- Bestellungen: ORDERS05 mit Erweiterung ZORD
- Lieferstatus: Delta-Load alle 15 Minuten
- Stammdaten: Materialstamm aus MATMAS

## Offene Punkte

- [x] Mapping-Tabelle an Anna schicken
- [ ] Freigabeprozess für Stammdaten klären due:${iso(at(3, 0))}
`;

const TESTKONZEPT = `---
vorgang: NP-8801/1040
---
Integrationstest der Bestellstrecke Portal → Middleware → SAP.

## Testfälle

- [x] Testfälle Bestellungen anlegen
- [ ] Testdaten mit dem Fachbereich abstimmen due:${iso(at(7, 0))}
- [ ] Sonderfall Teillieferung prüfen due:${iso(at(1, 0))}
`;

const PROTOKOLL = `---
datum: ${iso(at(3, 0))}
teilnehmer: [Anna Müller, Jörg Weiß]
---
## Ergebnisse

- Go-Live bleibt Ende Oktober
- Retouren folgen in Phase 3

## Aufgaben

- [ ] Angebot Phase 3 prüfen @Jörg due:${iso(at(9, 0))}
`;

function iso(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ---------------------------------------------------------------- helpers

const ready = () => app.browser.waitUntil(async () => app.browser.execute(() => document.body.classList.contains("ready")), { timeout: 20000 });
const openTree = async (title) => {
  for (const r of await app.$$(".sidebar .tree-row")) if ((await app.textOf(r)) === title) return r.click();
  throw new Error(`no ${title}`);
};
const panel = (open) =>
  app.browser.execute((o) => {
    if (!!document.querySelector(".app > .panel") !== o) document.querySelector(".workspace > .pane:last-child .tabbar > button:last-of-type").click();
  }, open);
/** No caret, selection, hover state or toast in the picture. */
const settle = async (x = 5, y = 900) => {
  await app.browser.execute(() => {
    document.activeElement?.blur?.();
    getSelection()?.removeAllRanges();
  });
  await app.dismissToasts();
  await app.browser.performActions([{ type: "pointer", id: "m", parameters: { pointerType: "mouse" }, actions: [{ type: "pointerMove", x, y }] }]).catch(() => {});
  await app.browser.releaseActions().catch(() => {});
  await sleep(500);
};
/** Shows or hides the page tree. */
const sidebar = (open) =>
  app.browser.execute((o) => {
    if (!!document.querySelector(".sidebar") !== o) document.querySelector(".ribbon .icon-btn")?.click();
  }, open);
const setTheme = async (theme) => {
  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", { settings: { ...view.settings, theme } });
  await app.browser.refresh();
  await ready();
  await sleep(800);
};
const closeTabs = () =>
  app.browser.execute(() => {
    for (const b of [...document.querySelectorAll(".tabbar .tab .tab-close, .tabbar .tab [aria-label^='Schließen'], .tabbar .tab [aria-label^='Tab schließen']")]) b.click();
  });
const dialogGone = () => app.browser.waitUntil(async () => !(await app.browser.execute(() => !!document.querySelector(".dialog"))), { timeout: 8000 });

async function palette(text, item) {
  await app.keys(["Control", "k"]);
  await app.waitFor(".palette");
  await app.type(text);
  await app.waitText(".pal-item", item);
  for (const it of await app.$$(".pal-item"))
    if (item.test(await app.textOf(it))) {
      await it.click();
      return;
    }
}

// ---------------------------------------------------------------- seed

let ids = {};

async function seed() {
  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", {
    settings: {
      ...view.settings,
      theme: "light",
      time: { ...view.settings.time, rounding: { step_minutes: 15, mode: "up", min_minutes: 0 } },
      litellm_base_url: llm.url,
      router: { ...view.settings.router, local_model: "firma-schnell", standard_model: "firma-standard", reasoning_model: "firma-reasoning" },
    },
  });
  await app.invoke("api_key_set", { key: llm.apiKey });
  await app.invoke("quick_links_save", { links: [
        {
          name: "SAP",
          url: "",
          icon: "briefcase",
          kind: "group",
          color: "blau",
          items: [
            { name: "Fiori Launchpad", url: "https://fiori.example.com/launchpad", icon: "globe" },
            { name: "CATS Zeiterfassung", url: "https://fiori.example.com/cats", icon: "clipboard-list" },
            { name: "Solution Manager", url: "https://solman.example.com", icon: "wrench" },
            { name: "SAP Logon", url: "C:\\Program Files\\SAP\\FrontEnd\\SAPGUI\\saplogon.exe", icon: "app-window", kind: "app" },
          ],
        },
        { name: "Jira", url: "https://jira.example.com/projects/PORTAL", icon: "ticket" },
        { name: "Confluence", url: "https://confluence.example.com/display/PORTAL", icon: "book-open" },
      ] });

  // Only this week's story counts: no demo bookings.
  for (const e of await app.invoke("time_entries", { from: null, to: null })) await app.invoke("delete_time_entry", { id: e.id });
  const tree = await app.invoke("wbs_tree");
  const np = (nr) => tree.flatMap((p) => p.netzplaene).find((n) => n.netzplan_nr === nr).id;
  ids = { np8801: np("NP-8801"), np8802: np("NP-8802") };

  const walk = (nodes, t) => {
    for (const n of nodes) {
      if (n.title === t) return n;
      const hit = walk(n.children ?? [], t);
      if (hit) return hit;
    }
    return null;
  };
  const project = walk(await app.invoke("workspace_tree"), "PRJ-2026-X Rollout");
  const konzept = await app.invoke("page_create", { parentId: project.id, title: "Konzept Auftragsportal", icon: "book-open", content: KONZEPT });
  const testk = await app.invoke("page_create", { parentId: project.id, title: "Testkonzept Integrationstest", icon: "list-checks", content: TESTKONZEPT });
  const proto = await app.invoke("page_create", { parentId: project.id, title: "Kundentermin Müller 24.09.", icon: "users", content: PROTOKOLL });
  ids.konzept = konzept.id;
  ids.arch = walk(await app.invoke("workspace_tree"), "Architektur").id;

  // Bookings of the week (and two earlier ones Annalo learns from).
  const book = (np, vorgang, la, start, minutes, description) =>
    app.invoke("time_entry_create", { netzplanId: np, vorgangNr: vorgang, leistungsart: la, startTime: start.toISOString(), durationMinutes: minutes, description });
  const { np8801: a, np8802: b } = ids;
  await book(a, "1020", "DEV", at(0, 8), 120, "IDoc-Mapping Materialstamm");
  await book(a, "1030", "DEV", at(0, 12, 30), 240, "REST-Schnittstelle Auftragsdaten");
  await book(a, "1020", "DEV", at(1, 8), 240, "Fehleranalyse Queue-Verarbeitung");
  await book(a, "1020", "DEV", at(1, 12, 30), 90, "Delta-Load Lieferstatus");
  await book(a, "1020", "DEV", at(1, 15), 90, "Code-Review Mapping");
  await book(a, "1030", "DEV", at(2, 8), 180, "OpenAPI-Spezifikation");
  await book(a, "1040", "TEST", at(2, 14, 30), 150, "Testfälle Bestellungen");
  await book(a, "1020", "DEV", at(3, 8), 270, "Systemintegration Delta-Load");
  await book(a, "1040", "TEST", at(3, 14, 30), 120, "Testkonzept Integrationstest");
  await book(a, "1020", "DEV", at(4, 8), 120, "Retry der Fehlerqueue");
  // Last week's Jour fixe, booked from the calendar: the series is remembered.
  const jf = await book(a, "1010", "PM", prev.at(0, 10), 60, "Jour fixe Änderungen");
  await book(b, "2010", "PM", prev2.at(3, 13), 60, "Kundentermin Müller");

  // Calendar.
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "annalo-readme-"));
  const file = path.join(dir, "Kalender.ics");
  fs.writeFileSync(file, calendar());
  await app.invoke("calendar_source_add", { name: "Kalender", url: null, path: file });
  await app.invoke("calendar_sync_now", { source: null });
  await app.browser.waitUntil(async () => (await app.invoke("calendar_status")).sources.every((s) => s.status?.synced_at && !s.syncing), { timeout: 20000, timeoutMsg: "not synced" });
  const events = await app.invoke("calendar_events", { from: prev2.monday.toISOString(), to: week(1).monday.toISOString() });
  const lastJf = events.find((e) => e.title === "Jour fixe Änderungen" && new Date(e.start).getTime() === prev.at(0, 10).getTime());
  await app.invoke("calendar_link_entry", { key: lastJf.key, entryId: jf.entry.id });

  // Journal rows: page editing, tasks and files; a focus session on Wednesday.
  const db = new DatabaseSync(path.join(app.dataDir, "workspace.db"));
  db.exec("PRAGMA busy_timeout = 5000");
  const act = db.prepare("INSERT INTO activity (at, kind, page_id, title, detail, amount, count) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const edit = (d, page, title, count, chars = 900) => act.run(utc(d), "page_edited", page, title, "", chars, count);
  // Monday 11:00–12:00 on the concept (not booked yet).
  edit(at(0, 11, 58), konzept.id, "Konzept Auftragsportal", 30);
  // Thursday: the concept in the morning (booked), the meeting note, the test concept.
  edit(at(3, 10, 40), konzept.id, "Konzept Auftragsportal", 9, 300);
  act.run(utc(at(3, 13, 2)), "page_created", proto.id, "Kundentermin Müller 24.09.", "", 640, 12);
  edit(at(3, 15, 50), testk.id, "Testkonzept Integrationstest", 26, 1400);
  edit(at(3, 16, 25), testk.id, "Testkonzept Integrationstest", 11, 500);
  act.run(utc(at(3, 10, 12)), "task_done", konzept.id, "Mapping-Tabelle an Anna schicken", "", 0, 1);
  act.run(utc(at(3, 15, 40)), "task_done", testk.id, "Testfälle Bestellungen anlegen", "", 0, 1);
  act.run(utc(at(3, 14, 20)), "task_added", proto.id, "Angebot Phase 3 prüfen", "", 0, 1);
  act.run(utc(at(3, 15, 55)), "task_added", testk.id, "Testdaten mit dem Fachbereich abstimmen", "", 0, 1);
  act.run(utc(at(3, 14, 5)), "file_added", null, "Lieferplan KW 40.xlsx", "Datei", 0, 1);
  const focus = db.prepare(
    `INSERT INTO focus_sessions (netzplan_id, vorgang_nr, reference, goal, started_at, planned_minutes, ended_at, status, worked_minutes)
     VALUES (?, ?, ?, ?, ?, 50, ?, 'done', 50)`,
  );
  focus.run(a, "1020", "NP-8801/1020", "Mapping ORDERS05", utc(at(2, 13)), utc(at(2, 13, 50)));
  focus.run(a, "1020", "NP-8801/1020", "Delta-Load Fehlerfälle", utc(at(3, 9)), utc(at(3, 9, 50)));
  db.close();

  await app.browser.refresh();
  await ready();
}

// ---------------------------------------------------------------- scenes

async function weekProposal(theme) {
  await closeTabs();
  await panel(false);
  await app.click(".ribbon .icon-btn[aria-label='Zeiterfassung']");
  await app.waitFor(".pane.active .wp-open");
  await app.click(".pane.active .wp-open");
  await app.waitFor(".dialog .wp-days");
  await sleep(400);
  // Wednesday's Architektur-Runde has no Vorgang yet: choose one (shown as „Gewählt“).
  await app.browser.execute(() => {
    const r = [...document.querySelectorAll(".wp-row")].find((x) => x.querySelector(".wp-text .input").value === "Architektur-Runde");
    if (r) r.dataset.e2e = "runde";
  });
  if (await app.browser.execute(() => !!document.querySelector('.wp-row[data-e2e="runde"]'))) {
    await app.select('.wp-row[data-e2e="runde"] .wp-wbs [aria-label="Netzplan"]', String(ids.np8801));
    await app.select('.wp-row[data-e2e="runde"] .wp-wbs [aria-label="Vorgang"]', "1030");
  }
  await settle();
  await app.browser.execute(() => document.querySelector(".dialog .wp-days")?.scrollTo?.(0, 0));
  await app.shot(`week-proposal-${theme}`);
  await app.keys(["Escape"]);
  await dialogGone();
}

async function calendarWeek(theme) {
  await closeTabs();
  await panel(false);
  await sidebar(false);
  await app.click(".ribbon .ribbon-calendar-view");
  await app.waitFor(".pane.active .calv-head");
  await app.browser.execute(() => [...document.querySelectorAll(".pane.active .calv-views button")].find((b) => b.innerText.trim() === "Arbeitswoche")?.click());
  await sleep(600);
  // Start of the day at the top.
  await app.browser.execute(() => {
    const s = document.querySelector(".pane.active .calv-scroll, .pane.active .calv-body, .pane.active .calv-grid");
    const row = [...document.querySelectorAll(".pane.active .calv-hour, .pane.active .calv-time")].find((e) => e.innerText.trim() === "08:00");
    if (s && row) s.scrollTop = row.offsetTop - 8;
  });
  await settle();
  await app.shot(`calendar-week-${theme}`);
  await sidebar(true);
}

async function dayReview(theme) {
  await closeTabs();
  await panel(false);
  await app.click(".ribbon .ribbon-review");
  await app.waitFor(".pane.active .rv-view .rv-stats");
  await app.browser.execute(() => document.activeElement?.blur());
  await app.browser.execute(() => document.querySelector(".pane.active .rv-view")?.focus());
  await app.keys(["ArrowLeft"]);
  await app.waitText(".rv-date", /Gestern|Donnerstag/);
  await sleep(600);
  await settle();
  await app.shot(`day-review-${theme}`);
}

async function mail(theme) {
  await closeTabs();
  await panel(false);
  await openTree("Testkonzept Integrationstest");
  await app.waitFor(".pane.active .ProseMirror");
  await palette("Aktuelle E-Mail", /Aktuelle E-Mail übernehmen/);
  await app.waitFor(".dialog .mailx-card");
  await sleep(400);
  for (const b of await app.$$(".mailx-chip")) if ((await app.textOf(b)) === "Nächste Woche") {
    await b.click();
    break;
  }
  await app.browser.execute(() => {
    const box = [...document.querySelectorAll(".mailx-files input[type=checkbox]")][0];
    if (box && !box.checked) box.click();
  });
  await settle();
  await app.shot(`mail-dialog-${theme}`);
  await app.keys(["Escape"]);
  await dialogGone();
}

async function linkGroup(theme) {
  await closeTabs();
  await panel(false);
  await openTree("Konzept Auftragsportal");
  await app.waitFor(".pane.active .ProseMirror");
  await settle();
  await app.click(".ribbon .quick-group");
  await app.waitFor(".link-pop");
  await sleep(400);
  await app.shot(`link-group-${theme}`);
  await app.keys(["Escape"]);
  await sleep(300);
}

async function zeit(theme) {
  await closeTabs();
  await panel(false);
  const page = await app.invoke("page_resolve", { title: "Jour fixe 22.09.", create: false });
  const original = (await app.invoke("page_get", { id: page.id })).content;
  await openTree("Jour fixe 22.09.");
  await app.waitFor(".pane.active .ProseMirror");
  await app.caretToEnd();
  await app.keys(["Enter"]);
  await app.type("/zeit NP-88");
  await app.browser.waitUntil(async () => app.browser.execute(() => [...document.querySelectorAll(".sugg-host .sugg-item")].some((e) => e.offsetParent)), { timeout: 8000 });
  await sleep(500);
  await app.shot(`zeit-suggest-${theme}`);
  await app.keys(["Escape"]);
  for (let i = 0; i < 11; i++) await app.keys(["Backspace"]);
  await app.type("/zeit 1h Mapping Workshop");
  await app.keys(["Escape"]);
  await app.keys(["Enter"]);
  await app.waitFor(".zeit-confirm .zeit-confirm-target", 15000);
  await sleep(500);
  await app.shot(`smart-zeit-${theme}`);
  await app.keys(["Escape"]);
  await sleep(300);
  await app.invoke("page_save", { id: page.id, content: original });
  await closeTabs();
}

async function linkPreview(theme) {
  await closeTabs();
  await panel(false);
  await openTree("PRJ-2026-X Rollout");
  await app.waitFor(".pane.active .ProseMirror");
  await settle();
  await app.browser.execute(() => {
    const el = [...document.querySelectorAll(".pane.active .ProseMirror a, .pane.active .ProseMirror .wikilink, .pane.active .ProseMirror [data-wikilink]")].find((a) => a.innerText.trim() === "Architektur");
    if (el) el.dataset.e2e = "arch";
  });
  await (await app.$('[data-e2e="arch"]')).moveTo();
  await app.waitFor(".link-preview, .page-preview, .hover-card", 8000).catch(() => {});
  await sleep(900);
  await app.shot(`link-preview-${theme}`);
}

async function note(theme) {
  await closeTabs();
  await panel(false);
  await openTree("Architektur");
  await app.waitFor(".pane.active .ProseMirror");
  await settle();
  await app.shot(`note-${theme}`);
}

/** The note in the left of two panes of a narrow window, for the phone crop of the website. */
async function narrow(theme) {
  await closeTabs();
  await panel(false);
  await app.browser.setWindowSize(900, 920);
  await sleep(800);
  await openTree("PRJ-2026-X Rollout");
  await app.waitFor(".pane.active .ProseMirror");
  // „Rechts daneben öffnen“ from the tree's context menu.
  await app.browser.execute(() => {
    const r = [...document.querySelectorAll(".sidebar .tree-row")].find((x) => x.innerText.trim() === "Architektur");
    const b = r.getBoundingClientRect();
    r.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: b.left + 20, clientY: b.top + 5 }));
  });
  await app.browser.waitUntil(async () => app.browser.execute(() => !!document.querySelector(".menu")));
  await app.browser.execute(() => [...document.querySelectorAll(".menu-item")].find((b) => b.textContent.includes("Rechts daneben öffnen")).click());
  await sleep(800);
  await sidebar(false);
  await sleep(600);
  await settle(5, 5);
  await app.shot(`note-narrow-${theme}`);
  await closeTabs();
  await closeTabs();
  await app.browser.setWindowSize(1480, 920);
  await sleep(800);
  await sidebar(true);
}

const SCENES = { week: weekProposal, calendar: calendarWeek, review: dayReview, mail, links: linkGroup, preview: linkPreview, note, narrow };

// ---------------------------------------------------------------- run

before(async () => {
  llm = await startFakeLiteLLM({ port: 4700 + Math.floor(Math.random() * 200) });
  const mailFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "annalo-readme-mail-")), "outlook-mail.json");
  fs.writeFileSync(mailFile, JSON.stringify(MAIL));
  app = await launch({ env: { GDK_SCALE: SCALE, ANNALO_TEST_FIXTURES: "1", ANNALO_OUTLOOK_MAIL_FIXTURE: mailFile, ANNALO_CALENDAR_DELAY_SECS: "3600" } });
  await seed();
});
after(async () => {
  await app?.close();
  await llm?.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

for (const theme of ["light", "dark"]) {
  test(`1.5 screenshots (${theme})`, async () => {
    await setTheme(theme);
    for (const [name, scene] of Object.entries(SCENES)) if (want(name)) await scene(theme);
  });
}

// Last: the assistant's answer statistics stay in the status bar afterwards.
test("/zeit", { skip: !want("zeit") }, async () => {
  for (const theme of ["light", "dark"]) {
    await setTheme(theme);
    await zeit(theme);
  }
});

test("quick capture", { skip: !want("capture") }, async () => {
  for (const theme of ["light", "dark"]) {
    await setTheme(theme);
    const w = await openCapture(app);
    await app.browser.refresh();
    await app.browser.waitUntil(() => app.browser.execute(() => document.body.classList.contains("ready")), { timeout: 10000 });
    await app.type(">konz");
    await app.waitText(".capture-picker .sugg-item.sel", /Konzept Auftragsportal/);
    await sleep(400);
    await app.shot(`capture-picker-${theme}`);
    await app.keys(["Enter"]);
    await app.type("Rückfragen aus dem Review");
    await app.keys(["Shift", "Enter"]);
    await app.keys(["Shift"]);
    await app.type("todo Mapping für Teillieferungen ergänzen bis Fr");
    await sleep(600);
    await app.shot(`capture-task-${theme}`);
    await app.browser.execute(() => {
      const el = document.querySelector(".capture-input");
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set ?? Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      set.call(el, "");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await app.keys(["Escape"]);
    await w.toMain();
  }
});
