// Calendar fixtures for the Kalender tests (62–64): an ICS file, an ICS subscription served by a
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
    "PRODID:-//Annalo e2e//DE",
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
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Annalo e2e//DE", ...events.flat(), "END:VCALENDAR", ""].join("\r\n");
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "annalo-cal-"));
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

/** Environment for the Outlook fixture (only honored with the test switch). */
export const outlookEnv = (file) => ({ ANNALO_TEST_FIXTURES: "1", ANNALO_OUTLOOK_FIXTURE: file, ANNALO_CALENDAR_DELAY_SECS: "3600" });
