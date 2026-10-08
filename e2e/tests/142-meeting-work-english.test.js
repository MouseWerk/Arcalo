// Smart meeting work (1.10), English, no Jira, no AI and no Outlook: the prep page of a meeting
// series written in English from the palette (no Jira section, no „What to watch for“), the
// follow-up mail of an English note through the mail program (`mailto:` with the attendees'
// addresses, subject and plain text) and „Copy as text“, the status report of a Netzplan with
// its hours from the Projects view, and no German left in what the window shows.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { guarded } from "../lib/harness.js";
import { germanLeftovers, launchEnglish } from "../lib/english.js";
import { iso } from "../lib/calendar-fixtures.js";

const test = guarded(nodeTest, () => app);
let app, dataDir, dir, noteId;
const today = iso(new Date());
const yesterday = iso(new Date(Date.now() - 86_400_000));
const tomorrow = iso(new Date(Date.now() + 86_400_000));
const pad = (n) => String(n).padStart(2, "0");
const icsTime = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00Z`;
const slot = (min) => {
  const late = new Date();
  late.setHours(20, 0, 0, 0);
  return Date.now() < late.getTime() ? new Date(Date.now() + min * 60_000) : new Date(late.getTime() + min * 60_000);
};
const ALLOW = [/Müller|Weiß|Zürich|Kundentermin|Abstimmung|Vertriebsrunde/];
const paneText = () => app.browser.execute(() => document.querySelector(".pane.active .ProseMirror")?.innerText ?? "");

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
async function palette(text) {
  await app.keys(["Control", "k"]);
  await app.waitFor(".palette input");
  await app.type(text);
  await app.browser.pause(300);
  await app.keys(["Enter"]);
}

before(async () => {
  ({ app, dataDir } = await launchEnglish());
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "arcalo-142-"));
  await patchSettings((s) => ({ ...s, workdays: [1, 2, 3, 4, 5, 6, 7] }));
  const jf = slot(40);
  const first = new Date(jf.getTime() - 86_400_000);
  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Arcalo e2e//EN",
    "BEGIN:VEVENT",
    "UID:weekly142@e2e",
    `DTSTART:${icsTime(first)}`,
    `DTEND:${icsTime(new Date(first.getTime() + 30 * 60_000))}`,
    "RRULE:FREQ=DAILY;COUNT=3",
    "SUMMARY:Weekly sync",
    "ATTENDEE;CN=ben@example.com:mailto:ben@example.com",
    "ATTENDEE;CN=Clara Jones:mailto:clara@example.com",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
  const file = path.join(dir, "Work.ics");
  fs.writeFileSync(file, ics);
  await app.invoke("calendar_source_add", { name: "Work", url: null, path: file });
  await app.invoke("calendar_sync_now", { source: null });
  await app.browser.waitUntil(async () => (await app.invoke("calendar_status")).sources.every((s) => !s.enabled || (s.status?.synced_at && !s.syncing)), { timeout: 20000, timeoutMsg: "not synced" });
  const old = (await app.invoke("calendar_events", { from: new Date(`${yesterday}T00:00:00`).toISOString(), to: new Date(`${today}T00:00:00`).toISOString() })).find((e) => e.title === "Weekly sync");
  noteId = (await app.invoke("calendar_meeting_note", { key: old.key })).page.id;
  await app.invoke("page_save", {
    id: noteId,
    content: `## Results\n\n- The pilot is live & stable\n\n## Decisions\n\n- We ship on Friday\n\n## Open points\n\n- Pricing for the export\n\n## Action items\n\n- [ ] Write the release notes @Clara_Jones due:${tomorrow}\n- [ ] Book the launch room\n`,
  });
  await reload();
});
after(async () => {
  await app?.close();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test("Prepare meeting from the palette, in English, without Jira and AI", async () => {
  await palette("Prepare meeting");
  await app.browser.waitUntil(async () => /Last minutes/.test(await paneText()), { timeout: 20000, timeoutMsg: "prep page opened" });
  const text = await paneText();
  assert.match(text, /Weekly sync \d{4}-\d{2}-\d{2} \(\d{4}-\d{2}-\d{2}, same series\)/);
  assert.match(text, /We ship on Friday/);
  assert.match(text, /Pricing for the export/);
  assert.match(text, /Write the release notes/);
  assert.match(text, /Clara Jones/);
  assert.doesNotMatch(text, /What to watch for/, "no AI connected: no paragraph");
  assert.doesNotMatch(text, /\nJira\n/, "no Jira site: no Jira section");
  assert.match(await app.text(".pane.active .tab.active"), /Prep Weekly sync/);
  assert.deepEqual(await germanLeftovers(app, ALLOW), []);
});

test("Follow-up mail through the mail program, and copy as text", async () => {
  await app.click(".ribbon .ribbon-briefing");
  await app.browser.waitUntil(() => app.browser.execute(() => !!document.querySelector('.pane.active .bf-card[data-section="meetings"] .bf-prep:not(.bf-prep-page)')), { timeout: 10000, timeoutMsg: "last time link" });
  await app.browser.execute(() => document.querySelector('.pane.active .bf-card[data-section="meetings"] .bf-prep:not(.bf-prep-page)').click());
  await app.browser.waitUntil(async () => /We ship on Friday/.test(await paneText()) && !/Last minutes/.test(await paneText()), { timeout: 10000, timeoutMsg: "minutes opened" });
  await palette("Follow-up mail");
  await app.waitFor(".dialog .mw-fu-preview", 10000);
  assert.match(await app.text(".dialog .mw-fu-subject"), /^Summary: Weekly sync \(\d{4}-\d{2}-\d{2}\)$/);
  assert.match(await app.text(".dialog .mw-fu-note"), /mail app/);
  assert.equal(await app.browser.execute(() => !!document.querySelector(".dialog .mw-fu-outlook")), false, "no Outlook here");
  const href = await app.browser.execute(() => document.querySelector(".dialog .mw-fu-mailto").dataset.href);
  assert.match(href, /^mailto:ben%40example\.com,clara%40example\.com\?subject=Summary%3A%20Weekly%20sync%20%28\d{4}-\d{2}-\d{2}%29&body=Hello%20all%2C/);
  const body = decodeURIComponent(href.split("&body=")[1]);
  assert.match(body, /The pilot is live & stable/);
  assert.match(body, /- Write the release notes \(Owner: Clara Jones\) – Due: \d{4}-\d{2}-\d{2}/);
  assert.match(body, /Best regards/);
  await app.browser.execute(() => {
    window.__copied = null;
    navigator.clipboard.writeText = async (t) => void (window.__copied = t);
  });
  await app.click(".dialog .mw-fu-copy-text");
  await app.browser.waitUntil(() => app.browser.execute(() => window.__copied != null), { timeout: 4000, timeoutMsg: "copied" });
  assert.match(await app.browser.execute(() => window.__copied), /Decisions\n- We ship on Friday/);
  assert.deepEqual(await germanLeftovers(app, ALLOW), []);
  await app.shot("142-followup-mailto");
  await app.keys(["Escape"]);
});

test("Status report of a network from the Projects view", async () => {
  await palette("Open projects");
  await app.waitFor(".pane.active .projects-report", 10000);
  await app.click(".pane.active .projects-report");
  await app.waitFor(".dialog .mw-sr-create");
  assert.match(await app.text(".dialog .mw-sr-scope"), /NP-/);
  // No AI: the summary switch still works, the report is written without it.
  await app.click(".dialog .mw-sr-create");
  await app.waitFor(".dialog .mw-sr-done", 20000);
  assert.match(await app.text(".dialog .mw-sr-done-title"), /Status report NP-\S+ .* Week \d+ \d{4}/);
  assert.deepEqual(await germanLeftovers(app, ALLOW), []);
  await app.click(".dialog .mw-sr-open");
  await app.browser.waitUntil(async () => /Hours booked/.test(await paneText()), { timeout: 10000, timeoutMsg: "report opened" });
  const text = await paneText();
  assert.match(text, /Hours booked|No bookings in the period/);
  assert.match(text, /Notes and decisions/);
  assert.match(text, /Milestones and deadlines/);
  assert.doesNotMatch(text, /Jira progress/, "no Jira site");
  await app.shot("142-status-report");
});
