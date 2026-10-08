// Fixtures of the work widgets (1.7): Outlook with a meeting ahead (Teams link) and two
// colleagues' calendars (Anna in a meeting now, Jörg out of office, free/busy only), and the
// flagged mails of Outlook's To-Do list (ARCALO_OUTLOOK_FLAGGED_FIXTURE).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { outlookItem } from "./calendar-fixtures.js";

const pad = (n) => String(n).padStart(2, "0");
export const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const minutes = (n) => new Date(Date.now() + n * 60_000);

const folder = (entryId, name, extra = {}) => ({ entryId, storeId: "S-OWN", name, path: "", store: "maurice@firma.de", storeType: 0, filePath: "", default: false, nav: false, group: "", groupType: -1, owner: "maurice@firma.de", recipient: "", person: false, items: 4, freeBusy: false, error: "", message: "", ...extra });

/** Outlook: the default calendar, Anna's shared one and Jörg's as free/busy. */
export function teamOutlookJson() {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const tomorrow = new Date(midnight.getTime() + 86_400_000);
  return JSON.stringify({
    ok: true,
    version: "16.0.0.0",
    mode: "restrict",
    items: [
      outlookItem("K1", "Kundentermin Portal", minutes(40), minutes(100), { location: "Raum Zürich", urls: ["https://teams.microsoft.com/l/meetup-join/19%3aportal"] }),
      outlookItem("K2", "Abstimmung Rollout", minutes(180), minutes(210)),
    ],
    discovery: {
      ok: true,
      version: "16.0.0.0",
      navError: "",
      calendars: [
        folder("E-DEFAULT", "Kalender", { default: true, path: "\\\\maurice@firma.de\\Kalender", items: 2 }),
        folder("E-ANNA", "Kalender", { storeId: "S-ANNA", store: "Anna Müller", owner: "Anna Müller", recipient: "Anna Müller", storeType: 1, nav: true, group: "Freigegebene Kalender", groupType: 4, items: 2 }),
        folder("", "Jörg Weiß", { storeId: "", store: "", owner: "Jörg Weiß", recipient: "Jörg Weiß", storeType: -1, nav: true, group: "Freigegebene Kalender", groupType: 4, items: -1, freeBusy: true }),
      ],
    },
    folders: {
      "E-ANNA": { items: [outlookItem("AV", "Vertriebsrunde", minutes(-30), minutes(45))] },
      "Jörg Weiß": { freeBusy: true, mode: "freebusy", items: [outlookItem("", "", midnight, tomorrow, { globalId: "fb-joerg", freeBusy: true, busy: 3 })] },
    },
  });
}

/** Outlook on, discovery run, and Anna's and Jörg's calendars switched on (as in the settings). */
export async function enableTeamCalendars(app) {
  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", { settings: { ...view.settings, calendar: { ...view.settings.calendar, outlook: true } } });
  await app.invoke("calendar_outlook_discover");
  let rows = [];
  await app.browser.waitUntil(
    async () => {
      rows = (await app.invoke("calendar_status")).outlook_calendars ?? [];
      return ["Anna Müller", "Jörg Weiß"].every((o) => rows.some((r) => r.owner === o));
    },
    { timeout: 15000, timeoutMsg: "discovery found no colleagues" },
  );
  for (const owner of ["Anna Müller", "Jörg Weiß"]) await app.invoke("calendar_outlook_update", { id: rows.find((r) => r.owner === owner).id, enabled: true, color: null, booking: null });
  await app.invoke("calendar_sync_now", { source: null });
  await app.browser.waitUntil(async () => (await app.invoke("calendar_status")).sources.every((s) => !s.enabled || (s.status?.synced_at && !s.syncing)), { timeout: 20000, timeoutMsg: "not synced" });
  return Object.fromEntries(rows.filter((r) => r.owner !== "maurice@firma.de").map((r) => [r.owner, r.id]));
}

const mail = (entryId, subject, sender, email, due, request, extra = {}) => ({
  entryId,
  storeId: "0000000038A1BB10",
  subject,
  senderName: sender,
  senderEmail: email,
  to: "Kleindienst, Maurice",
  cc: "",
  received: new Date(Date.now() - 2 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z"),
  conversation: subject,
  importance: 1,
  categories: "",
  body: `Hallo Maurice,\r\n\r\n${subject}.\r\n\r\nGrüße`,
  truncated: false,
  attachments: [],
  flagDue: due,
  flagRequest: request,
  ...extra,
});

/** The script's `flagged` output: one overdue, one due in two days, one without a date. */
export function flaggedJson(en = false) {
  const day = (n) => isoDay(new Date(Date.now() + n * 86_400_000));
  const items = en
    ? [
        mail("00000000FL01", "Approve the portal offer", "Miller, Anna", "anna.miller@example.com", day(-1), "Follow up", { importance: 2 }),
        mail("00000000FL02", "Feedback on the specification", "White, George", "george.white@example.com", day(2), "Reply"),
        mail("00000000FL03", "Travel expenses March", "HR", "hr@example.com", "", "Follow up"),
      ]
    : [
        mail("00000000FL01", "Angebot Portal freigeben", "Müller, Anna", "anna.mueller@example.com", day(-1), "Zur Nachverfolgung", { importance: 2 }),
        mail("00000000FL02", "Rückmeldung Lastenheft", "Weiß, Jörg", "joerg.weiss@example.com", day(2), "Antworten"),
        mail("00000000FL03", "Reisekosten März", "Personalabteilung", "hr@example.com", "", "Zur Nachverfolgung"),
      ];
  return JSON.stringify({ ok: true, version: "16.0.0.17928", items });
}

/** A folder with the fixtures; `env` for `launch`. */
export function writeWorkFixtures({ en = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arcalo-work-"));
  const outlook = path.join(dir, "outlook.json");
  const flagged = path.join(dir, "flagged.json");
  fs.writeFileSync(outlook, teamOutlookJson());
  fs.writeFileSync(flagged, flaggedJson(en));
  return {
    dir,
    outlook,
    flagged,
    env: { ARCALO_TEST_FIXTURES: "1", ARCALO_OUTLOOK_FIXTURE: outlook, ARCALO_OUTLOOK_FLAGGED_FIXTURE: flagged, ARCALO_CALENDAR_DELAY_SECS: "3600" },
  };
}
