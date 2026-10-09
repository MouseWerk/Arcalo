// Smart meeting work (1.10), German: „Besprechung vorbereiten“ from the briefing (last minutes of
// the series with decisions and open points, the open task, Jira issues named in the notes, of the
// project in the subject and of an attendee, notes about the attendees, „Worauf achten“ from the
// fake AI without page contents), refreshed from the calendar detail keeping the user's text;
// „Statusbericht“ from the Issues view (Jira project, this week) with PDF print, Markdown file and
// the start page widget; „Nachfass-Mail“ from the meeting note as an Outlook draft (the PowerShell
// fixture records To, subject and the HTML body with umlauts), never sent.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, guarded, daytimeZone } from "../lib/harness.js";
import { startFakeJira, defaultIssues } from "../lib/fake-jira.js";
import { startFakeOpenAI } from "../lib/fake-openai.js";
import { iso } from "../lib/calendar-fixtures.js";
import { OUTLOOK_MAILS, mailEnv } from "../lib/mail-fixtures.js";

const test = guarded(nodeTest, () => app);
let app, jira, cloud, local, dir, fixture, noteId, eventKey;
daytimeZone();
const today = iso(new Date());
const yesterday = iso(new Date(Date.now() - 86_400_000));
const tomorrow = iso(new Date(Date.now() + 86_400_000));
const pad = (n) => String(n).padStart(2, "0");
const icsTime = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00Z`;
/** A time `min` minutes from now (still today: see `daytimeZone`). */
const slot = (min) => new Date(Date.now() + min * 60_000);
const provider = (id, name, kind, base_url, isLocal) => ({ id, name, kind, base_url, local: isLocal, enabled: true, bypass_proxy: isLocal, api_version: "", models: [] });

/** „Jour fixe Portal“ every day since yesterday with three attendees (one is the user). */
function writeCalendar() {
  const jf = slot(50);
  const first = new Date(jf.getTime() - 86_400_000);
  const text = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Arcalo e2e//DE",
    "BEGIN:VEVENT",
    "UID:jf141@e2e",
    `DTSTART:${icsTime(first)}`,
    `DTEND:${icsTime(new Date(first.getTime() + 30 * 60_000))}`,
    "RRULE:FREQ=DAILY;COUNT=3",
    "SUMMARY:Jour fixe Portal",
    "ORGANIZER;CN=Mia Meyer:mailto:mia@firma.de",
    "ATTENDEE;CN=Anna Müller:mailto:anna@example.com",
    "ATTENDEE;CN=Jörg Weiß:mailto:joerg@example.com",
    "ATTENDEE;CN=Mia Meyer:mailto:mia@firma.de",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
  const file = path.join(dir, "Arbeit.ics");
  fs.writeFileSync(file, text);
  return file;
}

async function patchSettings(f) {
  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", { settings: f(structuredClone(view.settings)) });
  await app.browser.pause(400);
}
async function reload() {
  await app.browser.execute(() => location.reload());
  await app.browser.pause(300);
  await app.browser.waitUntil(() => app.browser.execute(() => document.body.classList.contains("ready")), { timeout: 20000, timeoutMsg: "not ready after reload" });
}
const paneText = () => app.browser.execute(() => document.querySelector(".pane.active .ProseMirror")?.innerText ?? "");
async function clickMenuItem(pattern) {
  await app.browser.waitUntil(() => app.browser.execute((p) => [...document.querySelectorAll(".menu-item")].some((m) => new RegExp(p).test(m.textContent)), pattern), { timeout: 4000, timeoutMsg: `menu item ${pattern}` });
  await app.browser.execute((p) => [...document.querySelectorAll(".menu-item")].find((m) => new RegExp(p).test(m.textContent)).click(), pattern);
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "arcalo-141-"));
  fixture = path.join(dir, "outlook-mail.json");
  fs.writeFileSync(fixture, JSON.stringify(OUTLOOK_MAILS));
  const issues = [
    ...defaultIssues(),
    { key: "OPS-9", summary: "Firewall-Freigabe für das Portal", type: "Task", status: "To Do", category: "new", priority: "High", assignee: "Jörg Weiß", project: "OPS", projectName: "Operations", due: null, sprint: "", description: "" },
  ];
  jira = await startFakeJira({ flavor: "cloud", issues });
  cloud = await startFakeOpenAI({
    port: 4971,
    kind: "openai",
    name: "Cloud",
    apiKey: "sk-meet-e2e",
    models: ["gpt-4o-mini"],
    // By the instruction: the report's summary, the mail's opening, or „Worauf achten“.
    respond: (_prompt, body) => {
      const system = body.messages[0]?.content ?? "";
      if (/Statusberichts/.test(system)) return "Der Login-Fehler ist in Arbeit, der Export wartet auf eine Entscheidung.";
      if (/Nachfass-Mail/.test(system)) return "Danke für die konstruktive Runde: Der Go-Live bleibt im November.";
      return "- Export (PROJ-125) mit Anna klären\n- Firewall-Freigabe bei Jörg nachfragen";
    },
  });
  local = await startFakeOpenAI({ port: 4972, kind: "ollama", name: "Ollama", models: ["llama3.2:latest"], respond: () => "- Lokal geschrieben" });
  app = await launch({ env: { ...mailEnv(fixture), ARCALO_JIRA_DELAY_SECS: "600" } });
  await app.invoke("provider_key_set", { id: "cloud", key: cloud.apiKey });
  await patchSettings((s) => ({
    ...s,
    workdays: [1, 2, 3, 4, 5, 6, 7],
    auto_route: false,
    providers: [provider("cloud", "Cloud", "openai", `${cloud.url}/v1`, false), provider("ollama", "Ollama", "ollama", local.url, true)],
    router: { ...s.router, local_provider: "ollama", local_model: "llama3.2:latest", standard_provider: "cloud", standard_model: "gpt-4o-mini", reasoning_provider: "cloud", reasoning_model: "gpt-4o-mini" },
  }));
  await app.invoke("jira_site_save", {
    site: { id: "", name: "Acme", color: "", kind: "cloud", url: jira.url, email: "mia@firma.de", enabled: true, log_work: false, allow_writes: false },
    token: "secret-token",
  });
  // A team search beside „mine“: issues of the other attendees are cached too.
  await patchSettings((s) => ({ ...s, jira: { ...s.jira, queries: [{ id: "team", site: "acme", name: "Team", jql: "statusCategory != Done" }] } }));
  await app.invoke("jira_sync_now", { site: "acme" });
  await app.invoke("calendar_source_add", { name: "Arbeit", url: null, path: writeCalendar() });
  await app.invoke("calendar_sync_now", { source: null });
  await app.browser.waitUntil(async () => (await app.invoke("calendar_status")).sources.every((s) => !s.enabled || (s.status?.synced_at && !s.syncing)), { timeout: 20000, timeoutMsg: "not synced" });
  // Yesterday's minutes of the series.
  const from = new Date(`${yesterday}T00:00:00`).toISOString();
  const to = new Date(`${today}T00:00:00`).toISOString();
  const old = (await app.invoke("calendar_events", { from, to })).find((e) => e.title === "Jour fixe Portal");
  assert.ok(old, "yesterday's Jour fixe");
  const note = await app.invoke("calendar_meeting_note", { key: old.key });
  noteId = note.page.id;
  await app.invoke("page_save", {
    id: noteId,
    content: `# Jour fixe Portal\n\n## Ergebnisse\n\n- Pilot läuft stabil, Rückmeldungen positiv\n\n## Entscheidungen\n\n- Go-Live im November\n\n## Offene Punkte\n\n- Export klären (PROJ-125)\n\n## Aufgaben\n\n- [ ] Angebot an Kunde schicken @Anna_Müller due:${tomorrow}\n- [x] Raum buchen @Jörg_Weiß\n`,
  });
  await app.invoke("page_create", { parentId: null, title: "Kunde Nordwind", icon: null, content: "# Kunde Nordwind\n\nAnsprechpartnerin ist Anna Müller.\n\nGeheimer Inhalt 141, der nie an die KI geht.\n" });
  const todays = (await app.invoke("calendar_events", { from: to, to: new Date(`${tomorrow}T00:00:00`).toISOString() })).find((e) => e.title === "Jour fixe Portal");
  eventKey = todays.key;
  await reload();
});
after(async () => {
  await app?.close();
  await jira?.close();
  await cloud?.close();
  await local?.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test("Besprechung vorbereiten: series, open points, Jira, attendees and „Worauf achten“", async () => {
  await app.click(".ribbon .ribbon-briefing");
  const row = '.pane.active .bf-card[data-section="meetings"] .bf-meeting';
  await app.waitText(`.pane.active .bf-card[data-section="meetings"]`, /Jour fixe Portal/, 15000);
  // The briefing may have written its own text already.
  const base = cloud.chats().length;
  await app.browser.execute((sel) => [...document.querySelectorAll(sel)].find((r) => /Jour fixe Portal/.test(r.textContent) && !r.classList.contains("past")).querySelector(".bf-prepare").click(), row);
  const shown = await app.browser
    .waitUntil(async () => /Letztes Protokoll/.test(await paneText()), { timeout: 20000 })
    .catch(() => false);
  if (!shown) assert.fail(`prep page not opened: ${await app.browser.execute(() => [...document.querySelectorAll(".toast")].map((t) => t.textContent).join(" | "))}`);
  const text = await paneText();
  for (const want of [
    /Worauf achten/,
    /Export \(\W*PROJ-125\W*(Audit log export)?\) mit Anna klären/,
    /Jour fixe Portal \d{2}\.\d{2}\.\d{4}.*gleiche Serie/,
    /Go-Live im November/,
    /Export klären \(\W*PROJ-125/,
    /Angebot an Kunde schicken/,
    /PROJ-125 Audit log export.*in den Notizen genannt/,
    /PROJ-123 Login fails on SSO.*Projekt im Betreff/,
    /OPS-9 Firewall-Freigabe für das Portal – To Do · Jörg Weiß \(einem Teilnehmer zugewiesen\)/,
    /Anna Müller/,
    /Erwähnt in: Kunde Nordwind/,
    /Jörg Weiß/,
  ]) assert.match(text, want);
  assert.doesNotMatch(text, /Raum buchen/, "done tasks are not open points");
  assert.doesNotMatch(text, /\*\*Mia Meyer\*\*|Mia Meyer\n\s*Erwähnt/, "the user is no attendee to prepare for");
  // The request: compact, the meeting's data, no page contents.
  assert.equal(cloud.chats().length, base + 1);
  const req = cloud.chats()[base].body;
  assert.match(req.messages[0].content, /Worauf achten/);
  const sent = JSON.stringify(req.messages);
  assert.match(sent, /Jour fixe Portal/);
  assert.match(sent, /PROJ-125/);
  assert.doesNotMatch(sent, /Geheimer Inhalt 141/);
  assert.ok(req.messages[1].content.length <= 2401, "within the budget");
  // Filed and remembered for the appointment.
  const prepId = await app.invoke("meeting_prep_page", { key: eventKey });
  assert.ok(prepId);
  assert.match((await app.invoke("page_get", { id: prepId })).content, /<!-- arcalo:auto -->/);
  await app.waitFor(".pane.active .md-managed.begin");
  await app.shot("141-prep-page");

  // The user writes below the generated part; „Aktualisieren“ from the calendar detail keeps it.
  await app.caretToEnd();
  await app.type("Eigene Frage an Jörg");
  await app.browser.pause(1200);
  await app.click(".ribbon .ribbon-briefing");
  await app.waitText(`.pane.active .bf-card[data-section="meetings"]`, /Vorbereitung/, 10000);
  await app.browser.execute((sel) => [...document.querySelectorAll(sel)].find((r) => /Jour fixe Portal/.test(r.textContent) && !r.classList.contains("past")).querySelector(".rv-title").click(), row);
  await app.waitFor(".pane.active .calv-detail .mw-prep-btn", 10000);
  assert.match(await app.text(".pane.active .calv-detail .mw-prep-btn"), /Vorbereitung aktualisieren/);
  await app.click(".pane.active .calv-detail .mw-prep-btn");
  await app.browser.waitUntil(async () => cloud.chats().length === base + 2, { timeout: 15000, timeoutMsg: "refreshed" });
  const after = (await app.invoke("page_get", { id: prepId })).content;
  assert.match(after, /Eigene Frage an Jörg/, "the user's text is saved");
  await app.browser.waitUntil(async () => /Eigene Frage an Jörg/.test(await paneText()), { timeout: 15000, timeoutMsg: "prep page in front again" });
  assert.equal(after.match(/<!-- arcalo:auto -->/g).length, 1, "one generated part");
  assert.match(after, /<!-- \/arcalo:auto -->[\s\S]*Eigene Frage an Jörg/, "the user's text stays below");
  assert.equal(await app.invoke("meeting_prep_page", { key: eventKey }), prepId, "the same page");
});

test("Statusbericht for a Jira project: page, PDF, Markdown and the start page widget", async () => {
  await app.invoke("dashboard_save", {
    dashboard: { version: 2, boards: [{ id: "sr", name: "Bericht", widgets: [{ id: "sr", kind: "statusreport", x: 0, y: 0, w: 4, h: 4, config: {} }] }], active: "sr", notes: {} },
  });
  await reload();
  await app.click(".ribbon .ribbon-issues");
  await app.waitFor(".pane.active .issues-report", 10000);
  await app.click(".pane.active .issues-report");
  await app.waitFor(".dialog .mw-sr-scope");
  await app.select(".dialog .mw-sr-scope", "jira:PROJ");
  await app.click('.dialog .mw-chip-toggle[data-section="deadlines"]');
  assert.equal(await app.browser.execute(() => document.querySelector('.dialog .mw-chip-toggle[data-section="deadlines"]').getAttribute("aria-pressed")), "false");
  await app.click(".dialog .mw-sr-save-template");
  await app.waitText(".toast", /Vorlage gespeichert/);
  assert.equal((await app.invoke("status_templates")).length, 1);
  await app.click(".dialog .mw-sr-create");
  await app.waitFor(".dialog .mw-sr-done", 20000);
  assert.match(await app.text(".dialog .mw-sr-done-title"), /Statusbericht PROJ Portal KW \d+\/\d{4}/);
  await app.shot("141-status-dialog");
  // PDF: the report opens and the pane is printed.
  await app.browser.execute(() => {
    window.__printed = null;
    window.print = () => (window.__printed = document.querySelector(".pane.active .ProseMirror")?.innerText ?? "");
  });
  await app.click(".dialog .mw-sr-pdf");
  await app.browser.waitUntil(() => app.browser.execute(() => window.__printed != null), { timeout: 10000, timeoutMsg: "printed" });
  const printed = await app.browser.execute(() => window.__printed);
  for (const want of [/Zusammenfassung/, /Login-Fehler ist in Arbeit/, /Jira-Fortschritt/, /In Arbeit: \d+/, /PROJ-123/, /Risiken und Blockaden/]) assert.match(printed, want);
  assert.doesNotMatch(printed, /Termine und Fristen/, "the section switched off");
  // Markdown without the markers.
  const last = await app.invoke("status_last");
  const md = path.join(dir, "bericht.md");
  await app.invoke("page_markdown_write", { pageId: last.page_id, path: md });
  const file = fs.readFileSync(md, "utf8");
  assert.match(file, /^# Statusbericht PROJ Portal/);
  assert.match(file, /## Jira-Fortschritt/);
  assert.doesNotMatch(file, /arcalo:auto/);
  // The widget: the last report and „Neu erstellen“ (same page).
  await app.keys(["Control", "t"]);
  await app.waitText('.pane.active .dw[data-widget="sr"] .dw-sr-title', /Statusbericht PROJ Portal/, 10000);
  await app.click('.pane.active .dw[data-widget="sr"] .dw-sr-again');
  await app.waitText(".toast", /Bericht aktualisiert/, 15000);
  assert.equal((await app.invoke("status_last")).page_id, last.page_id);
  await app.shot("141-status-widget");
});

test("Nachfass-Mail as an Outlook draft with attendees, subject and escaped body", async () => {
  await app.click(".ribbon .ribbon-briefing");
  await app.browser.waitUntil(() => app.browser.execute(() => !!document.querySelector('.pane.active .bf-card[data-section="meetings"] .bf-prep:not(.bf-prep-page)')), { timeout: 10000, timeoutMsg: "last time link" });
  await app.browser.execute(() => document.querySelector('.pane.active .bf-card[data-section="meetings"] .bf-prep:not(.bf-prep-page)').click());
  await app.browser.waitUntil(async () => /Go-Live im November/.test(await paneText()), { timeout: 10000, timeoutMsg: "note opened" });
  await app.click('.pane.active > .pane-content:not([hidden]) .vh [aria-label="Weitere Aktionen"]');
  await clickMenuItem("^Nachfass-Mail$");
  await app.waitFor(".dialog .mw-fu-preview", 10000);
  assert.match(await app.text(".dialog .mw-fu-subject"), /^Zusammenfassung: Jour fixe Portal \(\d{2}\.\d{2}\.\d{4}\)$/);
  assert.match(await app.text(".dialog .mw-fu-to"), /Anna Müller\s*Jörg Weiß/);
  const preview = await app.text(".dialog .mw-fu-preview");
  assert.match(preview, /Pilot läuft stabil/);
  assert.match(preview, /Go-Live im November/);
  assert.match(preview, /Angebot an Kunde schicken\s*Anna Müller/);
  // „Mit KI formulieren“: an opening paragraph.
  await app.click(".dialog .mw-fu-polish");
  await app.waitText(".dialog .mw-fu-intro.polished", /konstruktive Runde/, 15000);
  await app.shot("141-followup-dialog");
  await app.click(".dialog .mw-fu-outlook");
  await app.waitText(".toast", /Entwurf in Outlook geöffnet/);
  const drafts = fs.readFileSync(`${fixture}.drafts`, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(drafts.length, 1);
  const d = drafts[0];
  // Mia Meyer is the user (her Jira account): the mail does not go to herself.
  assert.deepEqual(d.to, ["Anna Müller <anna@example.com>", "Jörg Weiß <joerg@example.com>"]);
  assert.match(d.subject, /^Zusammenfassung: Jour fixe Portal \(\d{2}\.\d{2}\.\d{4}\)$/);
  assert.match(d.html, /<meta charset="utf-8">/);
  assert.match(d.html, /Hallo zusammen,/);
  assert.match(d.html, /Rückmeldungen positiv/, "umlauts as they are");
  assert.match(d.html, /<h3[^>]*>Entscheidungen<\/h3>/);
  assert.match(d.html, /<td[^>]*>Angebot an Kunde schicken<\/td><td[^>]*>Anna Müller<\/td>/);
  assert.match(d.html, /konstruktive Runde/);
  assert.match(d.html, /Raum buchen \(erledigt\)/);
});
