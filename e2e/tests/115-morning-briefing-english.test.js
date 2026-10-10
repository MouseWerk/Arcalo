// Morning briefing in English (1.8): opened from the command palette, English text and number
// format, no AI connected (a hint instead of the summary), Jira not configured and time tracking
// off (their sections are left out and the gear says why), Settings → Briefing, the widget.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { guarded } from "../lib/harness.js";
import { germanLeftovers, launchEnglish } from "../lib/english.js";
import { iso } from "../lib/calendar-fixtures.js";

const test = guarded(nodeTest, () => app);
let app, dataDir;
const today = iso(new Date());
const yesterday = iso(new Date(Date.now() - 86_400_000));

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
const sections = () => app.browser.execute(() => [...document.querySelectorAll(".pane.active > .pane-content:not([hidden]) .bf-grid > .bf-card")].map((e) => e.dataset.section));
const ALLOW = [/Müller|Weiß|Zürich|Kundentermin|Abstimmung|Vertriebsrunde/];

before(async () => {
  ({ app, dataDir } = await launchEnglish());
  await patchSettings((s) => ({ ...s, workdays: [1, 2, 3, 4, 5, 6, 7] }));
  await app.invoke("page_create", { parentId: null, title: "Offers", icon: null, content: `# Offers\n\n- [ ] Send the offer to client X due:${yesterday}\n- [ ] Review the contract due:${today}\n` });
  await reload();
});
after(async () => {
  await app?.close();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

test("opened from the palette, in English with English numbers", async () => {
  await app.keys(["Control", "k"]);
  await app.waitFor(".palette input");
  await app.type("Morning briefing");
  await app.browser.pause(250);
  await app.keys(["Enter"]);
  await app.waitFor(".pane.active > .pane-content:not([hidden]) .bf-view .bf-grid", 15000);
  assert.match(await app.text(".pane.active > .pane-content:not([hidden]) .bf-view h1"), /Morning briefing/);
  assert.match(await app.text(".pane.active .tab.active"), /Briefing/);
  // No Jira site: no Jira section.
  assert.deepEqual(await sections(), ["ai", "meetings", "tasks", "time"]);
  const tasks = await app.text('.pane.active > .pane-content:not([hidden]) .bf-card[data-section="tasks"]');
  assert.match(tasks, /Overdue[\s\S]*Send the offer to client X[\s\S]*Due today[\s\S]*Review the contract/i);
  // No AI connected: a hint and the way to the settings.
  assert.match(await app.text('.pane.active > .pane-content:not([hidden]) .bf-card[data-section="ai"]'), /No AI is connected/);
  assert.ok(await app.browser.execute(() => !document.querySelector(".pane.active > .pane-content:not([hidden]) .bf-ai-refresh")));
  // Hours with a decimal point.
  const time = await app.text('.pane.active > .pane-content:not([hidden]) .bf-card[data-section="time"]');
  assert.match(time, /Last workday:/);
  assert.doesNotMatch(time, /\d,\d+ h/);
  assert.deepEqual(await germanLeftovers(app, ALLOW), []);
  await app.shot("115-briefing-en");
});

test("time tracking off leaves the hours out; the gear says why", async () => {
  await patchSettings((s) => ({ ...s, time: { ...s.time, enabled: false } }));
  await app.browser.waitUntil(async () => (await sections()).join(",") === "ai,meetings,tasks", { timeoutMsg: `sections ${await sections()}` });
  await app.click(".pane.active > .pane-content:not([hidden]) .bf-gear");
  await app.waitFor('.pane.active > .pane-content:not([hidden]) .bf-section-item[data-section="time"]');
  assert.match(await app.text('.pane.active > .pane-content:not([hidden]) .bf-section-item[data-section="time"]'), /time tracking off/);
  assert.match(await app.text('.pane.active > .pane-content:not([hidden]) .bf-section-item[data-section="jira"]'), /Jira not set up/);
  // Switched off here: gone at once.
  await app.click('.pane.active > .pane-content:not([hidden]) .bf-section-item[data-section="ai"] .switch');
  await app.browser.waitUntil(async () => (await sections()).join(",") === "meetings,tasks", { timeoutMsg: `sections ${await sections()}` });
  assert.deepEqual(await germanLeftovers(app, ALLOW), []);
  await app.shot("115-briefing-en-customize");
  await patchSettings((s) => ({ ...s, time: { ...s.time, enabled: true }, briefing: { ...s.briefing, sections: s.briefing.sections.map((x) => ({ ...x, on: true })) } }));
});

test("Settings → Briefing: mode and notification time", async () => {
  await app.keys(["Control", ","]);
  await app.waitFor(".settings-nav");
  await app.click('.settings-nav-item[data-section="briefing"]');
  await app.waitText(".settings-head h1", /Morning briefing/);
  await app.browser.execute(() => [...document.querySelectorAll(".segmented button")].find((b) => b.textContent.trim() === "Notification")?.click());
  await app.waitFor(".bf-notify-time");
  assert.deepEqual(await germanLeftovers(app, ALLOW), []);
  await app.shot("115-briefing-settings-en");
});

test("the widget in English", async () => {
  await app.invoke("dashboard_save", {
    dashboard: { version: 2, active: "b", notes: {}, boards: [{ id: "b", name: "Start", widgets: [{ id: "briefing", kind: "briefing", x: 0, y: 0, w: 4, h: 6, config: {} }] }] },
  });
  await reload();
  await app.keys(["Control", "t"]);
  const w = '.pane.active > .pane-content:not([hidden]) [data-widget="briefing"]';
  await app.waitFor(`${w} .dw-bf-count`, 15000);
  assert.match(await app.text(w), /tasks due/);
  assert.match(await app.text(`${w} .dw-bf-ai`), /No AI connected/);
  assert.deepEqual(await germanLeftovers(app, ALLOW), []);
  assert.deepEqual(await app.consoleErrors(), []);
});
