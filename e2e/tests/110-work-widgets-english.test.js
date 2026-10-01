// Start page 1.7 in English: the flagged Outlook mails from the fixture (gallery card, due
// flags, „open in Outlook“, „make task“ through the e-mail dialog), and every work and chart
// widget with sample data in English with English number notation (28.00 h) and no German
// left in what they show.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { guarded } from "../lib/harness.js";
import { germanLeftovers, launchEnglish } from "../lib/english.js";
import { enableTeamCalendars, writeWorkFixtures } from "../lib/work-fixtures.js";

const test = guarded(nodeTest, () => app);
let app;
let dataDir;
let fx;

const W = (id, kind, x, y, w, h, config = {}) => ({ id, kind, x, y, w, h, config });
const clickText = async (sel, text) => {
  await app.browser.waitUntil(
    () =>
      app.browser.execute(
        (s, t) => {
          const el = [...document.querySelectorAll(s)].find((b) => b.textContent.trim() === t && !b.disabled);
          el?.click();
          return !!el;
        },
        sel,
        text,
      ),
    { timeoutMsg: `no ${sel} „${text}“` },
  );
};
const reload = async () => {
  await app.browser.execute(() => location.reload());
  await app.browser.pause(300);
  await app.browser.waitUntil(() => app.browser.execute(() => document.body.classList.contains("ready")), { timeout: 20000, timeoutMsg: "not ready" });
};

before(async () => {
  fx = writeWorkFixtures({ en: true });
  ({ app, dataDir } = await launchEnglish({ env: fx.env }));
  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", {
    settings: {
      ...view.settings,
      time: { ...view.settings.time, balance: { weekday_hours: [8, 8, 8, 8, 6, 0, 0], start: `${new Date().getFullYear()}-01-01`, opening_hours: 3, vacation_days: 28, carry_over: 0, state: "NW" } },
    },
  });
  await enableTeamCalendars(app);
  await app.invoke("dashboard_save", { dashboard: { version: 2, active: "work", notes: {}, boards: [{ id: "work", name: "Work", widgets: [] }] } });
  await app.keys(["Control", "t"]);
  await reload();
});
after(async () => {
  await app?.close();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  if (fx) fs.rmSync(fx.dir, { recursive: true, force: true });
});

test("the gallery offers flagged e-mails where Outlook can be asked; the widget lists them", async () => {
  assert.equal(await app.invoke("mail_flagged_available"), true);
  await clickText(".pane.active .dash-bar button", "Customize");
  await app.waitFor(".pane.active .dash.editing");
  await clickText(".pane.active .dash-bar button", "Add widget");
  await app.waitFor(".dash-gallery");
  await app.waitFor('.dash-gallery-card[data-kind="mail_flags"]');
  for (const k of ["balance", "vacation", "deadlines", "next_meeting", "team", "chart", "heatmap", "kanban"]) assert.ok(await (await app.$(`.dash-gallery-card[data-kind="${k}"]`)).isExisting(), k);
  assert.match(await app.text(".dash-gallery"), /Charts & data/i);
  await app.click('.dash-gallery-card[data-kind="mail_flags"]');
  await clickText(".pane.active .dash-bar button", "Done");
  await app.waitFor('.pane.active [data-widget^="mail_flags"] .wm-row', 15000);
  const rows = await app.browser.execute(() => [...document.querySelectorAll('.pane.active [data-widget^="mail_flags"] .wm-row')].map((r) => r.textContent));
  assert.equal(rows.length, 3);
  assert.match(rows[0], /Approve the portal offer[\s\S]*Miller, Anna · Follow up[\s\S]*1 day overdue/);
  assert.match(rows[1], /Feedback on the specification[\s\S]*in 2 days/);
  assert.match(rows[2], /Travel expenses March/);
});

test("„open in Outlook“ asks Outlook for the mail, „make task“ opens the e-mail dialog with it", async () => {
  const opened = `${fx.flagged}.opened`;
  await app.click('.pane.active [data-widget^="mail_flags"] .wm-row [aria-label^="Open “Approve the portal offer”"]');
  await app.browser.waitUntil(() => fs.existsSync(opened) && fs.readFileSync(opened, "utf8").includes("00000000FL01\t0000000038A1BB10"), { timeout: 8000, timeoutMsg: "not opened" });
  await app.click('.pane.active [data-widget^="mail_flags"] .wm-row [aria-label^="Make a task of “Feedback on the specification”"]');
  await app.waitText(".dialog .mailx-subject", /Feedback on the specification/);
  assert.equal(await app.browser.execute(() => document.querySelector(".dialog .mailx-task-text")?.value), "Feedback on the specification");
  await app.shot("110-flagged-task-dialog");
  await app.keys(["Escape"]);
});

test("every work and chart widget in English with English numbers", async () => {
  const parent = await app.invoke("page_create", { parentId: null, title: "Projects", icon: null, content: "---\nproperties:\n  status: {type: select, options: {Open: gray, Doing: blue, Done: green}}\nview: board\n---\n# Projects\n" });
  for (const [title, status] of [["Website", "Open"], ["App", "Doing"], ["Intranet", "Open"]]) await app.invoke("page_create", { parentId: parent.id, title, icon: null, content: `---\nstatus: ${status}\n---\n# ${title}\n` });
  const due = new Date(Date.now() + 3 * 86_400_000);
  const iso = `${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, "0")}-${String(due.getDate()).padStart(2, "0")}`;
  await app.invoke("page_create", { parentId: null, title: "Release", icon: null, content: `# Release\n\n- [ ] Write the changelog due:${iso}\n` });
  const d = (await app.invoke("settings_get")).settings.dashboard;
  const flags = d.boards[0].widgets.find((w) => w.kind === "mail_flags");
  d.boards[0].widgets = [
    W("balance", "balance", 0, 0, 4, 7),
    W("vacation", "vacation", 4, 0, 4, 7),
    W("next_meeting", "next_meeting", 8, 0, 4, 7),
    W("deadlines", "deadlines", 0, 7, 4, 7),
    W("team", "team", 4, 7, 4, 7),
    { ...flags, x: 8, y: 7, w: 4, h: 7 },
    W("chart", "chart", 0, 14, 4, 8, { type: "bar", chart: { source: "bookings", group: "netzplan", weeks: 8 } }),
    W("pie", "chart", 4, 14, 4, 8, { type: "pie", chart: { source: "pages", page: parent.id, group: "status", value: "count", field: "", weeks: 12 } }),
    W("kanban", "kanban", 8, 14, 4, 8, { page: parent.id }),
    W("heatmap", "heatmap", 0, 22, 12, 6, { mode: "hours" }),
  ];
  await app.invoke("dashboard_save", { dashboard: d });
  await reload();
  await app.waitFor('.pane.active [data-widget="balance"] .wb-value', 15000);
  assert.match(await app.text('.pane.active [data-widget="balance"] .wb-value'), /^[+−±]\d+(,\d{3})*\.\d\d h$/);
  assert.match(await app.text('.pane.active [data-widget="balance"] .wb-today'), /Today[\s\S]*of \d\.\d\d h/);
  await app.waitText('.pane.active [data-widget="vacation"] .wv-dl', /Entitlement \d{4}\s*28/);
  await app.waitText('.pane.active [data-widget="deadlines"]', /Write the changelog[\s\S]*in 3 days/);
  await app.waitText('.pane.active [data-widget="next_meeting"] .wn-actions', /Join[\s\S]*Meeting note/, 15000);
  await app.waitText('.pane.active [data-widget="team"] .wt-list', /Out of office[\s\S]*Busy/, 15000);
  await app.waitFor('.pane.active [data-widget="chart"] .wc-bar', 15000);
  assert.match(await app.text('.pane.active [data-widget="chart"] .wc-top .dw-big'), /^\d+(,\d{3})*\.\d\d h$/);
  await app.waitText('.pane.active [data-widget="pie"] .wc-legend', /Open\s*2[\s\S]*Doing\s*1/);
  await app.waitText('.pane.active [data-widget="kanban"] .wk-cols', /Open\s*2[\s\S]*Website/);
  await app.waitText('.pane.active [data-widget="heatmap"] .wh-top', /\d+\.\d\d h on \d+ days/);
  // Nothing German: the fixtures' names of people and places aside.
  const left = await germanLeftovers(app, [/Müller|Weiß|Zürich|Kundentermin|Abstimmung|Vertriebsrunde|Kalender/]);
  assert.deepEqual(left, []);
  for (const theme of ["light", "dark"]) {
    const view = await app.invoke("settings_get");
    await app.invoke("settings_save", { settings: { ...view.settings, theme } });
    await app.browser.execute((t) => (document.documentElement.dataset.theme = t), theme);
    await app.browser.pause(400);
    await app.shot(`110-en-${theme}`);
  }
});
