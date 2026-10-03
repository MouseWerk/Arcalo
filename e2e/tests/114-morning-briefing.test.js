// Morgen-Briefing (1.8): today's meetings with their preparation (the note of the last meeting of
// the series), join link and „Notiz anlegen“, Jira issues overdue, due or blocked (fake Jira),
// overdue and due tasks, the last workday against its target, and „Was heute wichtig ist“
// written by the assistant (fake provider): titles and counts only, cached for the day, a
// `#privat` task keeps it on the local model. Sections switched and moved with the gear; the
// first start of a workday opens it (not on a non-workday, an absence day or a second time); the
// start page widget. German, light and dark.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, guarded } from "../lib/harness.js";
import { startFakeJira, defaultIssues } from "../lib/fake-jira.js";
import { startFakeOpenAI } from "../lib/fake-openai.js";
import { iso } from "../lib/calendar-fixtures.js";

const test = guarded(nodeTest, () => app);
let app, jira, cloud, ollama, dir;
const today = iso(new Date());
const yesterday = iso(new Date(Date.now() - 86_400_000));
const pad = (n) => String(n).padStart(2, "0");
const icsTime = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00Z`;
/** A time `min` minutes from now; late in the evening fixed times today instead (never tomorrow). */
const slot = (min) => {
  const late = new Date();
  late.setHours(20, 0, 0, 0);
  return Date.now() < late.getTime() ? new Date(Date.now() + min * 60_000) : new Date(late.getTime() + min * 60_000);
};
const provider = (id, name, kind, base_url, local) => ({ id, name, kind, base_url, local, enabled: true, bypass_proxy: local, api_version: "", models: [] });

/** Jour fixe every day since yesterday at the same time, a review with a Teams link later today. */
function writeCalendar() {
  const jf = slot(45);
  const first = new Date(jf.getTime() - 86_400_000);
  const review = slot(150);
  const ev = (lines) => ["BEGIN:VEVENT", ...lines, "END:VEVENT"];
  const text = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Arcalo e2e//DE",
    ...ev(["UID:jf@e2e", `DTSTART:${icsTime(first)}`, `DTEND:${icsTime(new Date(first.getTime() + 30 * 60_000))}`, "RRULE:FREQ=DAILY;COUNT=3", "SUMMARY:Jour fixe Portal"]),
    ...ev([
      "UID:review@e2e",
      `DTSTART:${icsTime(review)}`,
      `DTEND:${icsTime(new Date(review.getTime() + 60 * 60_000))}`,
      "SUMMARY:Sprint Review",
      "LOCATION:Raum Elbe",
      "DESCRIPTION:Microsoft Teams-Besprechung\\nhttps://teams.microsoft.com/l/meetup-join/19%3abriefing",
    ]),
    "END:VCALENDAR",
    "",
  ].join("\r\n");
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "annalo-briefing-"));
  const file = path.join(dir, "Arbeit.ics");
  fs.writeFileSync(file, text);
  return file;
}

async function reload() {
  await app.browser.execute(() => location.reload());
  await app.browser.pause(300);
  await app.browser.waitUntil(() => app.browser.execute(() => document.body.classList.contains("ready")), { timeout: 20000, timeoutMsg: "not ready after reload" });
}
async function patchSettings(f) {
  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", { settings: f(structuredClone(view.settings)) });
  await app.browser.pause(400);
}
const texts = (sel) => app.browser.execute((s) => [...document.querySelectorAll(s)].map((e) => e.textContent.trim()), sel);
const sections = () => app.browser.execute(() => [...document.querySelectorAll(".pane.active .bf-grid > .bf-card")].map((e) => e.dataset.section));
const briefingTabs = () => app.browser.execute(() => [...document.querySelectorAll(".tab")].filter((t) => /Briefing/.test(t.textContent)).length);
async function closeBriefingTabs() {
  await app.browser.execute(() => {
    for (const t of [...document.querySelectorAll(".tab")].filter((x) => /Briefing/.test(x.textContent))) t.querySelector(".tab-close")?.click();
  });
  await app.browser.pause(200);
}
const openBriefing = async () => {
  await app.click(".ribbon .ribbon-briefing");
  await app.waitFor(".pane.active .bf-view .bf-grid", 15000);
};

before(async () => {
  const issues = [
    ...defaultIssues(),
    { key: "PROJ-130", summary: "Release notes 2.0", type: "Task", status: "To Do", category: "new", priority: "High", assignee: "Mia Meyer", project: "PROJ", projectName: "Portal", due: today, sprint: "Sprint 4", description: "" },
    { key: "PROJ-131", summary: "Payment provider switch", type: "Story", status: "Blocked", category: "indeterminate", priority: "High", assignee: "Mia Meyer", project: "PROJ", projectName: "Portal", due: null, sprint: "Sprint 4", description: "" },
  ];
  jira = await startFakeJira({ flavor: "cloud", issues });
  cloud = await startFakeOpenAI({ port: 4991, kind: "openai", name: "Cloud", apiKey: "sk-brief-e2e", models: ["gpt-4o-mini"], respond: () => "- Angebot an Kunde X heute verschicken\n- Jour fixe: Notizen vom letzten Mal lesen" });
  ollama = await startFakeOpenAI({ port: 4992, kind: "ollama", name: "Ollama", models: ["llama3.2:latest"], respond: () => "- Lokal geschrieben: Arzt anrufen" });
  app = await launch({ env: { ANNALO_JIRA_DELAY_SECS: "600" } });
  await app.invoke("provider_key_set", { id: "cloud", key: cloud.apiKey });
  await patchSettings((s) => ({
    ...s,
    workdays: [1, 2, 3, 4, 5, 6, 7],
    // No automatic routing: everything to the standard tier (the cloud) unless it is private.
    auto_route: false,
    providers: [provider("cloud", "Cloud", "openai", `${cloud.url}/v1`, false), provider("ollama", "Ollama", "ollama", ollama.url, true)],
    router: { ...s.router, local_provider: "ollama", local_model: "llama3.2:latest", standard_provider: "cloud", standard_model: "gpt-4o-mini", reasoning_provider: "cloud", reasoning_model: "gpt-4o-mini" },
  }));
  await app.invoke("jira_site_save", {
    site: { id: "", name: "Acme", color: "", kind: "cloud", url: jira.url, email: "mia@firma.de", enabled: true, log_work: false, allow_writes: false },
    token: "secret-token",
  });
  await app.invoke("jira_sync_now", { site: "acme" });
  await app.invoke("calendar_source_add", { name: "Arbeit", url: null, path: writeCalendar() });
  await app.invoke("calendar_sync_now", { source: null });
  await app.browser.waitUntil(async () => (await app.invoke("calendar_status")).sources.every((s) => !s.enabled || (s.status?.synced_at && !s.syncing)), { timeout: 20000, timeoutMsg: "not synced" });
  // Yesterday's Jour fixe got a note: today's is prepared with it.
  const from = new Date(`${yesterday}T00:00:00`).toISOString();
  const to = new Date(`${today}T00:00:00`).toISOString();
  const old = (await app.invoke("calendar_events", { from, to })).find((e) => e.title === "Jour fixe Portal");
  assert.ok(old, "yesterday's Jour fixe");
  await app.invoke("calendar_meeting_note", { key: old.key });
  await app.invoke("page_create", { parentId: null, title: "Angebote", icon: null, content: `# Angebote\n\n- [ ] Angebot an Kunde X schicken due:${yesterday}\n- [ ] Vertrag gegenlesen due:${today}\n- [ ] Später due:2099-01-01\n\nGeheimer Seiteninhalt, der nie an die KI geht.\n` });
  await reload();
});
after(async () => {
  await app?.close();
  await jira?.close();
  await cloud?.close();
  await ollama?.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test("the briefing: meetings with preparation, Jira, tasks, the last workday", async () => {
  await openBriefing();
  assert.match(await app.text(".pane.active .bf-view h1"), /Morgen-Briefing/);
  assert.deepEqual(await sections(), ["ai", "meetings", "tasks", "jira", "time"]);
  // Meetings: the Jour fixe with last time's note, the review with its Teams link.
  const meetings = '.pane.active .bf-card[data-section="meetings"]';
  await app.waitText(meetings, /Jour fixe Portal/);
  const rows = await texts(`${meetings} .bf-meeting`);
  const jf = rows.find((r) => /Jour fixe/.test(r));
  assert.match(jf, /Letztes Mal:\s*Jour fixe Portal/);
  const review = rows.find((r) => /Sprint Review/.test(r));
  assert.match(review, /Noch keine Notizen/);
  assert.match(review, /Beitreten/);
  assert.match(await app.text(`${meetings} .bf-meeting.next`), /Jour fixe Portal/);
  // „Notiz anlegen“ creates the review's note and opens it.
  await app.browser.execute(() => [...document.querySelectorAll(".pane.active .bf-meeting")].find((r) => /Sprint Review/.test(r.textContent))?.querySelector(".bf-note")?.click());
  await app.waitText(".toast-title", /Besprechungsnotiz angelegt|Notiz angelegt/);
  await app.waitFor(".pane.active .ProseMirror");
  await openBriefing();
  await app.waitText(meetings, /Notiz:\s*Sprint Review/);

  // Tasks: overdue and due today; the later one and the page text are not there.
  const tasks = await app.text('.pane.active .bf-card[data-section="tasks"]');
  assert.match(tasks, /Überfällig[\s\S]*Angebot an Kunde X schicken[\s\S]*Heute fällig[\s\S]*Vertrag gegenlesen/i);
  assert.doesNotMatch(tasks, /Später/);
  // Jira: overdue PROJ-123, due PROJ-130, blocked PROJ-131.
  const j = await app.text('.pane.active .bf-card[data-section="jira"]');
  assert.match(j, /Überfällig[\s\S]*PROJ-123[\s\S]*Heute fällig[\s\S]*PROJ-130[\s\S]*Blockiert[\s\S]*PROJ-131/i);
  assert.doesNotMatch(j, /PROJ-124|PROJ-100/);
  // The last workday with German hours and the way to the week proposal and the timesheet.
  const time = await app.text('.pane.active .bf-card[data-section="time"]');
  assert.match(time, /Letzter Arbeitstag:/);
  assert.match(time, /\d+(,\d+)? h von \d+(,\d+)? h|Soll erreicht|kein Soll/);
  assert.ok(await app.browser.execute(() => !!document.querySelector(".pane.active .bf-week") && !!document.querySelector(".pane.active .bf-sheet")));
  // The overview numbers.
  assert.equal(await app.text('.pane.active .bf-overview [data-section="tasks"] .rv-stat-value'), "2");
  assert.equal(await app.text('.pane.active .bf-overview [data-section="jira"] .rv-stat-value'), "3");
  assert.deepEqual(await app.consoleErrors(), []);
});

test("„Was heute wichtig ist“: titles and counts only, cached, private content stays local", async () => {
  await app.waitText(".pane.active .bf-ai-text", /Angebot an Kunde X heute verschicken/, 15000);
  assert.equal(cloud.chats().length, 1);
  assert.equal(ollama.chats().length, 0);
  const sent = JSON.stringify(cloud.chats()[0].body.messages);
  assert.match(sent, /Jour fixe Portal/);
  assert.match(sent, /Aufgaben überfällig: 1/);
  assert.match(sent, /PROJ-131 Payment provider switch/);
  assert.doesNotMatch(sent, /Geheimer Seiteninhalt|Raum Elbe|teams\.microsoft/);
  assert.match(await app.text(".pane.active .bf-ai-meta"), /gpt-4o-mini/);
  // Cached for the day: opening it again asks nobody.
  await reload();
  await openBriefing();
  await app.waitText(".pane.active .bf-ai-text", /Angebot an Kunde X/);
  assert.equal(cloud.chats().length, 1, "from the cache");
  // A #privat task: the text is written again by the local model only.
  await app.invoke("page_create", { parentId: null, title: "Privat", icon: null, content: `- [ ] Arzt anrufen #privat due:${today}\n` });
  await app.click(".pane.active .bf-ai-refresh");
  await app.waitText(".pane.active .bf-ai-text", /Lokal geschrieben/, 15000);
  assert.equal(cloud.chats().length, 1, "nothing private went to the cloud");
  assert.equal(ollama.chats().length, 1);
  assert.match(await app.text(".pane.active .bf-ai-meta"), /lokal · llama3\.2:latest/);
  await app.shot("114-briefing-light");
});

test("sections switched off and moved with the gear (saved in the settings)", async () => {
  await app.click(".pane.active .bf-gear");
  await app.waitFor(".pane.active .bf-customize .bf-section-item");
  await app.click('.pane.active .bf-customize .bf-section-item[data-section="meetings"] .switch');
  await app.browser.waitUntil(async () => !(await sections()).includes("meetings"), { timeoutMsg: "meetings still shown" });
  // Tasks one up: before the meetings' place, right after the text.
  await app.click('.pane.active .bf-customize .bf-section-item[data-section="jira"] button[aria-label="Nach oben"]');
  await app.browser.waitUntil(async () => (await sections()).join(",") === "ai,jira,tasks,time", { timeoutMsg: `order ${await sections()}` });
  const saved = (await app.invoke("settings_get")).settings.briefing.sections;
  assert.deepEqual(saved.map((s) => `${s.id}:${s.on}`), ["ai:true", "meetings:false", "jira:true", "tasks:true", "time:true"]);
  assert.equal(await app.browser.execute(() => !!document.querySelector('.pane.active .bf-overview [data-section="meetings"]')), false);
  await app.shot("114-briefing-customize");
  // Settings → Briefing shows the same list.
  await app.browser.execute(() => document.querySelector(".pane.active .bf-customize .bf-section-item")?.closest(".card")?.querySelector("button[aria-label='Schließen']")?.click());
  await app.keys(["Control", ","]);
  await app.waitFor(".settings-nav");
  await app.click('.settings-nav-item[data-section="briefing"]');
  await app.waitText(".settings-head h1", /Morgen-Briefing/);
  assert.deepEqual(await app.browser.execute(() => [...document.querySelectorAll(".bf-sections .bf-section-item")].map((e) => e.dataset.section)), ["ai", "meetings", "jira", "tasks", "time"]);
  // Back to all sections.
  await patchSettings((s) => ({ ...s, briefing: { ...s.briefing, sections: s.briefing.sections.map((x) => ({ ...x, on: true })) } }));
});

test("the first start of a workday opens it; not on an absence day, not twice", async () => {
  await closeBriefingTabs();
  // Off: nothing.
  assert.equal(await app.invoke("briefing_start"), "none");
  // An absence day today: no briefing either (and the day is not used up).
  await patchSettings((s) => ({ ...s, briefing: { ...s.briefing, mode: "start" } }));
  await app.invoke("absence_save", { from: today, to: today, kind: "vacation", half: false, note: "" });
  await reload();
  assert.equal(await briefingTabs(), 0, "no briefing on an absence day");
  await app.invoke("absence_remove", { from: today, to: today });
  // A workday: the first start opens it, the next one does not.
  await reload();
  await app.waitFor(".pane.active .bf-view", 15000);
  await closeBriefingTabs();
  await reload();
  await app.browser.pause(800);
  assert.equal(await briefingTabs(), 0, "only the first start of the day");
  assert.equal(await app.invoke("briefing_start"), "none");
  await patchSettings((s) => ({ ...s, briefing: { ...s.briefing, mode: "off" } }));
});

test("the start page widget: counts, the next meeting and the line of the text", async () => {
  await app.invoke("dashboard_save", {
    dashboard: { version: 2, active: "b", notes: {}, boards: [{ id: "b", name: "Start", widgets: [{ id: "briefing", kind: "briefing", x: 0, y: 0, w: 4, h: 6, config: {} }, { id: "today", kind: "today", x: 4, y: 0, w: 5, h: 9, config: {} }] }] },
  });
  await reload();
  await app.keys(["Control", "t"]);
  const w = '.pane.active [data-widget="briefing"]';
  await app.waitFor(`${w} .dw-bf-count`, 15000);
  const counts = await app.browser.execute((sel) => Object.fromEntries([...document.querySelectorAll(`${sel} .dw-bf-count`)].map((e) => [e.dataset.section, e.querySelector(".dw-bf-value").textContent])), w);
  assert.equal(counts.tasks, "3");
  assert.equal(counts.jira, "3");
  assert.match(await app.text(`${w} .dw-bf-next`), /Jour fixe Portal|Sprint Review|Heute keine Termine mehr/);
  assert.match(await app.text(`${w} .dw-bf-ai`), /Lokal geschrieben: Arzt anrufen/);
  await app.shot("114-briefing-widget");
  // Heute: „Briefing“ opens it.
  await app.click('.pane.active [data-widget="today"] .dw-briefing');
  await app.waitFor(".pane.active .bf-view", 15000);
  assert.deepEqual(await app.consoleErrors(), []);
});

test("dark theme", async () => {
  await patchSettings((s) => ({ ...s, theme: "dark" }));
  await app.browser.execute(() => (document.documentElement.dataset.theme = "dark"));
  await app.browser.pause(400);
  await app.shot("114-briefing-dark");
  await patchSettings((s) => ({ ...s, theme: "light" }));
});
