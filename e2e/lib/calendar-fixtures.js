// Calendar fixtures for the Kalender tests (62–64, 84–85): an ICS file, an ICS subscription served by a
// local HTTP server (with a secret token in its address) and the JSON the Outlook script would
// print, all relative to the current week in local time (the app reads floating times as local).

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const pad = (n) => String(n).padStart(2, "0");
export const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** Floating ICS time (local): 20260921T100000. */
const ics = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`;
const icsDate = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
const local = (d) => `${iso(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;

/** Monday 00:00 of the current week, and a day of it at a time. */
export function week(offsetWeeks = 0) {
  const now = new Date();
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7) + offsetWeeks * 7);
  const at = (day, h, m = 0) => new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + day, h, m);
  return { monday, at };
}

const { at } = week();
/** Tuesday: six short meetings (month overflow) and two overlapping ones. */
export const TUESDAY = at(1, 0);

/** The ICS file „Projektplan“: a review on Wednesday, an all-day release on Thursday (folded, with umlauts). */
export function icsFile() {
  const w = at(2, 14);
  const t = at(3, 0);
  const next = at(4, 0);
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Arcalo e2e//DE",
    "BEGIN:VEVENT",
    "UID:review-1@e2e",
    `DTSTART:${ics(w)}`,
    `DTEND:${ics(new Date(w.getTime() + 3600e3))}`,
    "SUMMARY:Sprint Review",
    "LOCATION:Raum Zürich",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:release-1@e2e",
    `DTSTART;VALUE=DATE:${icsDate(t)}`,
    `DTEND;VALUE=DATE:${icsDate(next)}`,
    // Folded in the middle of the text, as Outlook writes long lines.
    "SUMMARY:Release-Tag mit Übergabe an den Betri",
    " eb",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}

/** The subscription „Team“: a weekly Jour fixe on Monday 10:00 (series), Tuesday's crowd. */
export function icsTeam() {
  const start = week(-2).at(0, 10);
  const events = [
    [
      "BEGIN:VEVENT",
      "UID:jourfixe@e2e",
      `DTSTART:${ics(start)}`,
      `DTEND:${ics(new Date(start.getTime() + 3600e3))}`,
      "RRULE:FREQ=WEEKLY;COUNT=8",
      "SUMMARY:Jour fixe Änderungen",
      "ORGANIZER;CN=Anna Müller:mailto:anna@example.com",
      "ATTENDEE;CN=Jörg Weiß:mailto:j@example.com",
      "ATTENDEE;CN=Zoë Schmidt:mailto:z@example.com",
      "DESCRIPTION:Agenda\\n\\nMicrosoft Teams-Besprechung\\nhttps://teams.microsoft.com/l/meetup-join/19%3ae2e",
      "END:VEVENT",
    ],
  ];
  for (let i = 0; i < 6; i++) {
    const s = at(1, 8 + i, 0);
    events.push(["BEGIN:VEVENT", `UID:crowd-${i}@e2e`, `DTSTART:${ics(s)}`, `DTEND:${ics(new Date(s.getTime() + 30 * 60e3))}`, `SUMMARY:Abstimmung ${i + 1}`, "END:VEVENT"]);
  }
  const o1 = at(1, 15);
  const o2 = at(1, 15, 30);
  events.push(["BEGIN:VEVENT", "UID:overlap-a@e2e", `DTSTART:${ics(o1)}`, `DTEND:${ics(new Date(o1.getTime() + 3600e3))}`, "SUMMARY:Architektur", "END:VEVENT"]);
  events.push(["BEGIN:VEVENT", "UID:overlap-b@e2e", `DTSTART:${ics(o2)}`, `DTEND:${ics(new Date(o2.getTime() + 3600e3))}`, "SUMMARY:Budgetrunde", "END:VEVENT"]);
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Arcalo e2e//DE", ...events.flat(), "END:VCALENDAR", ""].join("\r\n");
}

/** What the Outlook script prints: a customer meeting on Friday, a private appointment, a standup early today. */
export function outlookJson() {
  const now = new Date();
  const f = at(4, 9);
  const fe = at(4, 10, 30);
  const p = at(2, 17);
  const pe = at(2, 18);
  const s = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 5);
  const se = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 20);
  const item = (id, subject, a, b, extra = {}) => ({
    entryId: id,
    globalId: `G-${id}`,
    subject,
    start: a.toISOString().replace(/\.\d{3}Z$/, "Z"),
    end: b.toISOString().replace(/\.\d{3}Z$/, "Z"),
    startLocal: local(a),
    endLocal: local(b),
    allDay: false,
    recurring: false,
    busy: 2,
    sensitivity: 0,
    responseStatus: 3,
    meetingStatus: 1,
    location: "",
    organizer: "",
    attendees: [],
    categories: "",
    body: null,
    urls: [],
    ...extra,
  });
  return JSON.stringify({
    ok: true,
    version: "16.0.0.0",
    mode: "restrict",
    items: [
      item("A1", "Kundentermin Müller", f, fe, {
        location: "Microsoft Teams-Besprechung",
        organizer: "Müller, Anna",
        attendees: ["Müller, Anna", "Weiß, Jörg"],
        categories: "Kunde",
        urls: ["https://teams.microsoft.com/l/meetup-join/19%3akunde"],
      }),
      item("P1", "Arzt", p, pe, { sensitivity: 2, busy: 3 }),
      item("S1", "Daily Standup", s, se),
      item("D1", "Abgelehnt", f, fe, { responseStatus: 4 }),
    ],
  });
}

/** Writes the ICS file and the Outlook fixture into a fresh folder. */
export function writeFixtures() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arcalo-cal-"));
  const file = path.join(dir, "Projektplan.ics");
  fs.writeFileSync(file, icsFile());
  const outlook = path.join(dir, "outlook.json");
  fs.writeFileSync(outlook, outlookJson());
  return { dir, file, outlook };
}

/** Serves the Team calendar at /team.ics?token=GEHEIM-e2e; other paths and tokens get 403. */
export async function serveTeam() {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    if (req.url !== "/team.ics?token=GEHEIM-e2e") {
      res.writeHead(403);
      res.end("nope");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/calendar; charset=utf-8" });
    res.end(icsTeam());
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/team.ics?token=GEHEIM-e2e`;
  return { server, url, hits };
}

/**
 * An .ics file with one meeting that started five minutes ago and runs for an hour (quick
 * capture offers it as „Jetzt: …“), plus one that is long over. Written into a fresh folder.
 */
export function writeMeetingNow(title = "Jour fixe Kunde X") {
  const now = new Date();
  const start = new Date(now.getTime() - 5 * 60e3);
  const old = new Date(now.getTime() - 3 * 3600e3);
  const ev = (uid, summary, a, minutes) => [
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTART:${ics(a)}`,
    `DTEND:${ics(new Date(a.getTime() + minutes * 60e3))}`,
    `SUMMARY:${summary}`,
    "ATTENDEE;CN=Anna Müller:mailto:anna@example.com",
    "END:VEVENT",
  ];
  const text = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Arcalo e2e//DE", ...ev("now@e2e", title, start, 60), ...ev("old@e2e", "Vorbei", old, 30), "END:VCALENDAR", ""].join("\r\n");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arcalo-cal-now-"));
  const file = path.join(dir, "Heute.ics");
  fs.writeFileSync(file, text);
  return { dir, file };
}

/** Environment for the Outlook fixture (only honored with the test switch). */
export const outlookEnv = (file) => ({ ARCALO_TEST_FIXTURES: "1", ARCALO_OUTLOOK_FIXTURE: file, ARCALO_CALENDAR_DELAY_SECS: "3600" });

// ---- Outlook calendar selection (tests 84–85)

/** One appointment as the Outlook script prints it. */
export function outlookItem(id, subject, a, b, extra = {}) {
  return {
    entryId: id,
    globalId: `G-${id}`,
    subject,
    start: a.toISOString().replace(/\.\d{3}Z$/, "Z"),
    end: b.toISOString().replace(/\.\d{3}Z$/, "Z"),
    startLocal: local(a),
    endLocal: local(b),
    allDay: false,
    recurring: false,
    busy: 2,
    sensitivity: 0,
    responseStatus: 3,
    meetingStatus: 1,
    location: "",
    organizer: "",
    attendees: [],
    categories: "",
    body: null,
    urls: [],
    ...extra,
  };
}

/** Discovery's view of one calendar folder. */
const folder = (entryId, name, extra = {}) => ({ entryId, storeId: "S-OWN", name, path: "", store: "maurice@firma.de", storeType: 0, filePath: "", default: false, nav: false, group: "", groupType: -1, owner: "maurice@firma.de", recipient: "", person: false, items: 4, freeBusy: false, error: "", message: "", ...extra });

/**
 * Several Outlook calendars: the default one (the items of `outlookJson`, plus the „Jour fixe
 * Vertrieb“ Anna's calendar has too), the own sub-calendar „Projekt X“, Anna Müller's calendar
 * shared with the user, Jörg Weiß's shared as free/busy only, a PST, a room, and the boss's
 * calendar that refuses access. Meetings in this week and in the last one (week proposal).
 */
export function outlookCalendarsJson() {
  const base = JSON.parse(outlookJson());
  const last = week(-1);
  const jf = [at(2, 11), at(2, 12)];
  base.items.push(outlookItem("JF", "Jour fixe Vertrieb", ...jf, { organizer: "Müller, Anna" }));
  base.items.push(outlookItem("PLAN", "Planung Rollout", last.at(0, 9), last.at(0, 10)));
  base.discovery = {
    ok: true,
    version: "16.0.0.0",
    navError: "",
    calendars: [
      folder("E-DEFAULT", "Kalender", { default: true, path: "\\\\maurice@firma.de\\Kalender", items: 412 }),
      folder("E-PROJ", "Projekt X", { path: "\\\\maurice@firma.de\\Kalender\\Projekt X", items: 12 }),
      folder("E-PST", "Kalender", { storeId: "S-PST", store: "Archiv 2025", owner: "Archiv 2025", storeType: 3, filePath: "C:\\Users\\m\\Archiv 2025.pst", path: "\\\\Archiv 2025\\Kalender", items: 0 }),
      folder("E-ANNA", "Kalender", { storeId: "S-ANNA", store: "Anna Müller", owner: "Anna Müller", recipient: "Anna Müller", storeType: 1, nav: true, group: "Freigegebene Kalender", groupType: 4, items: 55 }),
      folder("", "Chef", { storeId: "", store: "", owner: "Chef", recipient: "Chef", storeType: -1, nav: true, group: "Freigegebene Kalender", groupType: 4, items: -1, error: "denied", message: "Sie verfügen nicht über die erforderliche Berechtigung." }),
      folder("", "Jörg Weiß", { storeId: "", store: "", owner: "Jörg Weiß", recipient: "Jörg Weiß", storeType: -1, nav: true, group: "Freigegebene Kalender", groupType: 4, items: -1, freeBusy: true }),
      folder("E-ROOM", "Raum Zürich", { storeId: "S-ROOM", store: "Raum Zürich", owner: "Raum Zürich", recipient: "Raum Zürich", storeType: 1, nav: true, group: "Räume", groupType: 6, items: 3 }),
    ],
  };
  base.folders = {
    "E-PROJ": { items: [outlookItem("PS1", "Projekt-Sync", at(3, 13), at(3, 14)), outlookItem("PS0", "Projekt-Sync alt", last.at(1, 9), last.at(1, 10))] },
    "E-ANNA": {
      items: [
        // The same meeting as in the default calendar (same global id and start).
        outlookItem("JF-ANNA", "Jour fixe Vertrieb", ...jf, { globalId: "G-JF", organizer: "Müller, Anna" }),
        outlookItem("AV", "Anna: Vertriebsrunde", at(3, 15), at(3, 16)),
        outlookItem("KA", "Kundentermin Anna", last.at(2, 10), last.at(2, 11)),
      ],
    },
    "Jörg Weiß": { freeBusy: true, mode: "freebusy", items: [outlookItem("", "", at(1, 14), at(1, 15, 30), { globalId: "fb-joerg-1", freeBusy: true })] },
    "E-ROOM": { items: [] },
    "E-PST": { items: [] },
  };
  return JSON.stringify(base);
}
