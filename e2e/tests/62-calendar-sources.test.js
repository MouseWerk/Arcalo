// Kalender sources (Settings → Kalender): the empty view leads to the settings, an ICS
// subscription served by a local server (its address with a token goes to the credential store,
// never into the settings), an .ics file and the Outlook source (script output from a fixture)
// sync and report their status; removing a source removes its appointments.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { launch, guarded } from "../lib/harness.js";
import { outlookEnv, serveTeam, writeFixtures } from "../lib/calendar-fixtures.js";

const test = guarded(nodeTest, () => app);
let app;
let fx;
let team;
before(async () => {
  fx = writeFixtures();
  team = await serveTeam();
  app = await launch({ env: outlookEnv(fx.outlook) });
});
after(async () => {
  await app?.close();
  team?.server.close();
  if (fx) fs.rmSync(fx.dir, { recursive: true, force: true });
});

const statusOf = async (id) => (await app.invoke("calendar_status")).sources.find((s) => s.id === id);

test("without a source the Kalender shows an empty state that opens its settings", async () => {
  await app.click(".ribbon-calendar-view");
  await app.waitText(".calv-empty .empty-title", /Noch kein Kalender verbunden/);
  await app.shot("62-calendar-empty");
  await app.click(".calv-empty .btn-primary");
  await app.waitFor('.settings-nav-item.active[data-section="calendar"]');
  await app.waitText(".settings-head h1", /^Kalender$/);
  // The Outlook group is offered (fixture), the source list is empty.
  await app.waitText(".set-group-head h2", /Outlook \(klassisch\)/);
  await app.waitText(".calset-empty", /Noch kein ICS-Kalender/);
});

test("an ICS subscription is added; its address is a secret", async () => {
  await app.click(".calset-add .btn:nth-child(1)");
  await app.waitFor(".dialog input");
  await app.type(team.url);
  const inputs = await app.$$(".dialog input");
  await inputs[1].click();
  await app.type("Team");
  await app.click(".dialog .btn-primary");
  await app.waitText(".calset-item .calset-name", /Team/);
  await app.browser.waitUntil(async () => (await statusOf("ics:s1"))?.status?.synced_at, { timeout: 15000, timeoutMsg: "Team not synced" });
  const st = await statusOf("ics:s1");
  assert.equal(st.kind, "url");
  assert.equal(st.address, "http://127.0.0.1/…", "only scheme and host are shown");
  assert.ok(st.status.events >= 8, `events: ${st.status.events}`);
  assert.ok(team.hits.includes("/team.ics?token=GEHEIM-e2e"), "fetched with the token");
  await app.waitText('.calset-item[data-source="ics:s1"] .set-status', /Termine · synchronisiert/);

  // Not in the settings (nor their export), but in the credential store (the private file on Linux).
  const view = await app.invoke("settings_get");
  assert.ok(!JSON.stringify(view).includes("GEHEIM"), "token not in the settings");
  assert.deepEqual(view.settings.calendar.sources.map((s) => [s.id, s.name, s.kind, s.path]), [["s1", "Team", "url", ""]]);
  const secrets = JSON.parse(fs.readFileSync(path.join(app.dataDir, "secrets.json"), "utf8"));
  assert.equal(secrets.calendar_ics_s1, team.url);
  assert.ok(!(await app.text(".settings-body")).includes("GEHEIM"), "not shown either");
});

test("an .ics file and the Outlook source sync and show their status", async () => {
  await app.click(".calset-add .btn:nth-child(2)");
  await app.waitFor(".dialog input");
  await app.type(fx.file);
  await app.click(".dialog .btn-primary");
  await app.waitText(".calset-item .calset-name", /Projektplan/);
  await app.browser.waitUntil(async () => (await statusOf("ics:s2"))?.status?.events === 2, { timeout: 15000, timeoutMsg: "file not synced" });

  // Outlook (the script's output comes from the fixture): switched on, it syncs at once.
  await app.click('[role="switch"][aria-label="Outlook-Kalender lesen"]');
  await app.browser.waitUntil(async () => (await statusOf("outlook"))?.status?.events === 3, { timeout: 15000, timeoutMsg: "Outlook not synced (declined meeting left out)" });
  await app.waitText(".calset-status .set-status", /3 Termine · synchronisiert/);

  // Privacy defaults: private appointments without details, no text.
  const cal = (await app.invoke("settings_get")).settings.calendar;
  assert.deepEqual([cal.private_details, cal.include_body, cal.meeting_links, cal.sync_minutes], [false, false, true, 15]);
  await app.shot("62-calendar-settings");
});

test("a failing source reports its error; removing a source removes its appointments", async () => {
  // A wrong token: the server answers 403, the status says so without the address.
  await app.invoke("calendar_source_update", { id: "ics:s1", name: null, color: null, enabled: null, url: team.url.replace("GEHEIM-e2e", "falsch"), path: null });
  await app.browser.waitUntil(async () => (await statusOf("ics:s1"))?.status?.error, { timeout: 15000, timeoutMsg: "no error recorded" });
  const err = (await statusOf("ics:s1")).status.error;
  assert.match(err, /403/);
  assert.ok(!err.includes("falsch") && !err.includes("token"), err);
  await app.waitText('.calset-item[data-source="ics:s1"] .set-status', /403/);
  // Back to the right address.
  await app.invoke("calendar_source_update", { id: "ics:s1", name: null, color: null, enabled: null, url: team.url, path: null });
  await app.browser.waitUntil(async () => !(await statusOf("ics:s1"))?.status?.error, { timeout: 15000, timeoutMsg: "error not cleared" });

  const range = { from: new Date(Date.now() - 40 * 86400e3).toISOString(), to: new Date(Date.now() + 40 * 86400e3).toISOString() };
  const before = await app.invoke("calendar_events", range);
  assert.ok(before.some((e) => e.source === "ics:s2"));
  await app.click('.calset-item[data-source="ics:s2"] [aria-label^="Aktionen"]');
  await app.waitText(".menu-item", /Entfernen/);
  await app.browser.execute(() => [...document.querySelectorAll(".menu-item")].find((b) => /Entfernen/.test(b.textContent)).click());
  await app.click(".dialog .btn-danger");
  await app.browser.waitUntil(async () => !(await app.invoke("calendar_status")).sources.some((s) => s.id === "ics:s2"), { timeoutMsg: "not removed" });
  const after = await app.invoke("calendar_events", range);
  assert.ok(!after.some((e) => e.source === "ics:s2"), "its appointments are gone");
  assert.ok(after.some((e) => e.source === "ics:s1") && after.some((e) => e.source === "outlook"));
});
