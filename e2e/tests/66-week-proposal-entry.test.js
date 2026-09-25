// „Woche vorschlagen“ from everywhere: the palette (this week), the „Termine übernehmen“ card
// (one flow with the proposal), the gap row of the week grid, the reminder's return to the app;
// the dark theme and a narrow window; the reminder switch in Settings → Benachrichtigungen.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";
import { serveTeam } from "../lib/calendar-fixtures.js";

const test = guarded(nodeTest, () => app);
let app;
let team;

const kw = (d) => {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  return Math.ceil(((t - Date.UTC(t.getUTCFullYear(), 0, 1)) / 86400000 + 1) / 7);
};
const dialogOpen = () => app.browser.execute(() => !!document.querySelector(".dialog .wp"));
const closeDialog = async () => {
  await app.keys(["Escape"]);
  await app.browser.waitUntil(async () => !(await dialogOpen()), { timeoutMsg: "dialog still open" });
};

before(async () => {
  team = await serveTeam();
  app = await launch();
  for (const e of await app.invoke("time_entries", { from: null, to: null })) await app.invoke("delete_time_entry", { id: e.id });
  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", { settings: { ...view.settings, theme: "dark" } });
  await app.invoke("calendar_source_add", { name: "Team", url: team.url, path: null });
  await app.invoke("calendar_sync_now", { source: null });
  await app.browser.waitUntil(async () => (await app.invoke("calendar_status")).sources.every((s) => s.status?.synced_at && !s.syncing), { timeout: 20000, timeoutMsg: "not synced" });
});
after(async () => {
  await app?.close();
  team?.server.close();
});

test("the palette opens the proposal of this week", async () => {
  await app.keys(["Control", "k"]);
  await app.waitFor(".palette");
  await app.type("Woche vorschlagen");
  await app.waitText(".pal-item.sel", /Woche vorschlagen/);
  await app.keys(["Enter"]);
  await app.waitFor(".dialog .wp");
  assert.match(await app.text(".dialog .dialog-desc"), new RegExp(`^KW ${kw(new Date())} ·`));
  // This week: today's meetings still to come can be included.
  await app.waitText(".dialog .wp-rest", /Heutige Termine bis Tagesende einbeziehen/);
  assert.equal(await app.text(".pane.active .tab.active .tab-title"), "Zeiterfassung");
  await closeDialog();
});

test("the meeting card and the gap row lead into the same review", async () => {
  await app.click(".pane.active .week-nav .icon-btn[aria-label='Vorherige Woche']");
  // Last week's Jour fixe of the Team series is not booked: the card offers it.
  await app.waitText(".pane.active .ts-meetings .ts-meeting-title", /Jour fixe Änderungen/);
  await app.browser.execute(() => [...document.querySelectorAll(".pane.active .ts-meetings .card-head .btn")].find((b) => /Alle übernehmen/.test(b.textContent)).click());
  await app.waitFor(".dialog .wp-days");
  const texts = await app.browser.execute(() => [...document.querySelectorAll(".wp-row .wp-text .input")].map((i) => i.value));
  assert.deepEqual(texts, ["Jour fixe Änderungen"]);
  // Nothing on the other workdays: one line says so.
  await app.waitText(".dialog .wp-bare", /Ohne Vorschlag: Di/);
  await app.shot("66-week-proposal-dark");
  await closeDialog();
  await app.browser.execute(() => [...document.querySelectorAll(".pane.active .week-gaps .btn")].find((b) => /Lücken füllen/.test(b.textContent)).click());
  await app.waitFor(".dialog .wp-days");
  await closeDialog();
});

test("in a narrow window the rows stack; keyboard focus stays in the list", async () => {
  await app.browser.setWindowSize(900, 760);
  await app.click(".pane.active .wp-open");
  await app.waitFor(".dialog .wp-days");
  const layout = await app.browser.execute(() => {
    const row = document.querySelector(".wp-row");
    const text = row.querySelector(".wp-text").getBoundingClientRect();
    const time = row.querySelector(".wp-time").getBoundingClientRect();
    const dialog = document.querySelector(".dialog").getBoundingClientRect();
    return { stacked: text.top > time.bottom - 1, overflow: row.scrollWidth > row.clientWidth + 1, fits: dialog.right <= window.innerWidth };
  });
  assert.deepEqual(layout, { stacked: true, overflow: false, fits: true });
  await app.browser.execute(() => document.querySelector(".wp-row").focus());
  await app.keys([" "]);
  assert.equal(await app.browser.execute(() => document.querySelector(".wp-row .wp-row-check").checked), false, "no WBS: stays unchecked");
  await app.shot("66-week-proposal-narrow");
  await closeDialog();
  await app.browser.setWindowSize(1480, 920);
});

test("coming back after the reminder opens the proposal; the reminder can be switched off", async () => {
  await app.keys(["Control", "t"]);
  await app.waitFor(".pane.active .dash");
  await app.browser.executeAsync((done) => window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "nav://week-proposal", payload: null }).then(done, done));
  await app.waitFor(".dialog .wp");
  assert.equal(await app.text(".pane.active .tab.active .tab-title"), "Zeiterfassung");
  await closeDialog();

  assert.equal((await app.invoke("settings_get")).settings.notifications.week_proposal, true, "on by default");
  await app.keys(["Control", ","]);
  await app.click('.settings-nav-item[data-section="notifications"]');
  await app.click('.switch[aria-label="Woche vorschlagen"]');
  await app.waitFor(".savebar");
  await app.click(".savebar .btn-primary");
  await app.browser.waitUntil(async () => (await app.invoke("settings_get")).settings.notifications.week_proposal === false, { timeoutMsg: "not saved" });
});
