// Integration errors say what happened and how to fix it (1.12): a refused Jira login is not
// worded as an AI server error and names the token of the site's kind, an untrusted certificate
// (company CA) points to Settings → Netzwerk, a gateway error says to try again later, a saved
// JQL search that Jira rejects shows its error under the search in Settings → Jira, an address
// copied from the browser is cut to the site's base, an ICS subscription that answers with a
// web page says to copy the ICS link, and a calendar file in Windows-1252 keeps its umlauts.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { guarded, launch } from "../lib/harness.js";
import { startFakeJira } from "../lib/fake-jira.js";
import { startTls } from "../lib/fake-network.js";

const test = guarded(nodeTest, () => app);
let app;
let jira;
let tls;
let page;
let dir;
const site = (p = {}) => ({ id: "", name: "Firmen-Jira", color: "", kind: "server", url: "", email: "", enabled: true, log_work: false, allow_writes: false, ...p });

before(async () => {
  jira = await startFakeJira({ flavor: "server", token: "pat-123" });
  tls = await startTls("jira.firma.test");
  // A sharing page instead of the calendar's ICS link.
  page = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<!DOCTYPE html><html><head><title>Anmelden</title></head><body>Bitte anmelden</body></html>");
  });
  await new Promise((r) => page.listen(0, "127.0.0.1", r));
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "arcalo-e2e-ics-"));
  app = await launch({ env: { ARCALO_JIRA_DELAY_SECS: "600", ARCALO_CALENDAR_DELAY_SECS: "600" } });
});
after(async () => {
  await app?.close();
  await jira?.close();
  await tls?.close();
  page?.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

const status = () => app.invoke("jira_status");
async function openSettings(section) {
  await app.click('button[aria-label^="Einstellungen"]');
  await app.waitFor(".pane.active .settings");
  const wide = await app.browser.execute((s) => !!document.querySelector(`.settings-nav-item[data-section="${s}"]`)?.offsetParent, section);
  if (wide) await app.click(`.settings-nav-item[data-section="${section}"]`);
  else await app.select(".settings-section-select", section);
}

test("Jira errors name what happened and the fix, never the AI server", async () => {
  const wrong = await app.invoke("jira_test", { site: site({ url: jira.url }), token: "wrong" }).then(() => "", (e) => e.message);
  assert.match(wrong, /^Jira hat die Anmeldung abgelehnt \(401\)\. Das persönliche Zugriffstoken prüfen/);
  assert.doesNotMatch(wrong, /KI-Server/);
  // A self-signed certificate (company CA not added): Settings → Netzwerk.
  const cert = await app.invoke("jira_test", { site: site({ url: tls.url }), token: "pat-123" }).then(() => "", (e) => e.message);
  assert.match(cert, /Zertifikat der Jira-Site wird nicht anerkannt.*Einstellungen → Netzwerk/);
  // Nothing listens there.
  await jira.stop();
  const offline = await app.invoke("jira_test", { site: site({ url: jira.url }), token: "pat-123" }).then(() => "", (e) => e.message);
  assert.match(offline, /Jira ist nicht erreichbar/);
  await jira.start();
  // A gateway error: try again later.
  jira.state.fail = { status: 502, times: 1 };
  const gateway = await app.invoke("jira_test", { site: site({ url: jira.url }), token: "pat-123" }).then(() => "", (e) => e.message);
  assert.match(gateway, /Problem auf seiner Seite \(Fehler 502\).*In ein paar Minuten erneut versuchen/);
});

test("an address copied from the browser is cut to the site; a rejected search shows its error", async () => {
  const saved = await app.invoke("jira_site_save", { site: site({ url: `${jira.url}/browse/PROJ-123?focusedId=1` }), token: "pat-123" });
  const s = saved.sites[0];
  assert.equal(s.url, jira.url, "only the site's base is kept");
  const view = await app.invoke("settings_get");
  view.settings.jira.queries = [
    { id: "", site: s.id, name: "Tippfehler", jql: "projekt = PROJ AND sprint in openSprints()" },
    { id: "", site: s.id, name: "Portal", jql: "project = PROJ" },
  ];
  await app.invoke("settings_save", { settings: view.settings });
  await app.invoke("jira_sync_now", { site: s.id });
  const st = await status();
  assert.equal(st.sites[0].sync.error, null, "the site itself synced");
  const queries = (await app.invoke("settings_get")).settings.jira.queries;
  const typo = queries.find((q) => q.name === "Tippfehler");
  assert.match(st.query_errors[typo.id], /Jira hat die Anfrage abgelehnt \(400\)/);
  assert.equal(st.query_errors[queries.find((q) => q.name === "Portal").id], undefined);

  await openSettings("jira");
  const shown = await app.waitFor(`.jira-query[data-query="${typo.id}"] .jira-query-error`);
  assert.match(await app.textOf(shown), /Beim letzten Abgleich fehlgeschlagen: .*400.* Die JQL in der Jira-Suche prüfen/);
  assert.equal(await app.browser.execute(() => document.querySelectorAll(".jira-query-error").length), 1);
  assert.match(await app.text(".pane.active .settings-body"), /Alle Jira-Sites jetzt abgleichen/, "not the calendars' label");
  await app.browser.execute(() => document.querySelector(".jira-queries")?.scrollIntoView({ block: "center" }));
  await app.shot("160-jira-query-error");

  // The search fixed: the next sync clears its error.
  const fixed = (await app.invoke("settings_get")).settings;
  fixed.jira.queries = fixed.jira.queries.map((q) => (q.id === typo.id ? { ...q, jql: "project = OPS" } : q));
  await app.invoke("settings_save", { settings: fixed });
  await app.invoke("jira_sync_now", { site: s.id });
  assert.deepEqual((await status()).query_errors, {});
  await app.browser.waitUntil(() => app.browser.execute(() => !document.querySelector(".jira-query-error")), { timeout: 8000, timeoutMsg: "error still shown" });
});

test("the site dialog takes intranet names and shows a failed test with its fix", async () => {
  await app.browser.execute(() => [...document.querySelectorAll(".calset-add button")].find((b) => /Jira-Site verbinden/.test(b.textContent))?.click());
  await app.waitFor(".dialog");
  const url = await app.$('.dialog input[aria-label="Adresse"]');
  await url.click();
  await app.type("http://jira:8080");
  await app.$('.dialog input[aria-label="Persönliches Zugriffstoken"]').then((e) => e.click());
  await app.type("pat-123");
  const enabled = () => app.browser.execute(() => !document.querySelector(".dialog .jira-test")?.disabled);
  assert.equal(await enabled(), true, "an intranet name without a dot is an address");
  await url.click();
  await app.keys(["Control", "a"]);
  await app.type(tls.url);
  await app.browser.execute(() => document.querySelector(".dialog .jira-test")?.click());
  const result = await app.waitFor(".jira-test-result.bad svg", 15000);
  assert.ok(result);
  assert.match(await app.text(".jira-test-result.bad"), /Zertifikat/);
  await app.shot("160-jira-dialog-certificate");
  await app.keys(["Escape"]);
});

test("calendar sources: a web page instead of the ICS link, a Windows-1252 file", async () => {
  const pageUrl = `http://127.0.0.1:${page.address().port}/owa/calendar/published`;
  await app.invoke("calendar_source_add", { name: "Team (Web)", url: pageUrl, path: null });
  await app.browser.waitUntil(async () => (await app.invoke("calendar_status")).sources.some((x) => x.status?.error), { timeout: 15000, timeoutMsg: "no error recorded" });
  const err = (await app.invoke("calendar_status")).sources.find((x) => x.status?.error).status.error;
  assert.match(err, /Webseite statt eines Kalenders.*ICS-Link/);
  assert.doesNotMatch(err, /Eingabe nicht verstanden/);

  // Windows-1252: „Prüfung“ with typographic quotes and €.
  const day = new Date(Date.now() + 86400e3).toISOString().slice(0, 10).replace(/-/g, "");
  const head = Buffer.from(["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Alt//DE", "BEGIN:VEVENT", "UID:cp1252@e2e", `DTSTART:${day}T080000Z`, `DTEND:${day}T090000Z`, "SUMMARY:"].join("\r\n"), "ascii");
  const title = Buffer.from([0x84, 0x50, 0x72, 0xfc, 0x66, 0x75, 0x6e, 0x67, 0x93, 0x20, 0x80]);
  const tail = Buffer.from(["", "END:VEVENT", "END:VCALENDAR", ""].join("\r\n"), "ascii");
  const file = path.join(dir, "alt.ics");
  fs.writeFileSync(file, Buffer.concat([head, title, tail]));
  await app.invoke("calendar_source_add", { name: "Altes Outlook", url: null, path: file });
  const range = { from: new Date(Date.now() - 86400e3).toISOString(), to: new Date(Date.now() + 3 * 86400e3).toISOString() };
  await app.browser.waitUntil(async () => (await app.invoke("calendar_events", range)).some((e) => e.uid === "cp1252@e2e"), { timeout: 15000, timeoutMsg: "file not synced" });
  const ev = (await app.invoke("calendar_events", range)).find((e) => e.uid === "cp1252@e2e");
  assert.equal(ev.title, "„Prüfung“ €");

  await openSettings("calendar");
  await app.waitText(".calset-item .set-status", /Webseite statt eines Kalenders/);
  await app.browser.execute(() => document.querySelector(".calset-item")?.scrollIntoView({ block: "center" }));
  await app.shot("160-calendar-web-page");
});
