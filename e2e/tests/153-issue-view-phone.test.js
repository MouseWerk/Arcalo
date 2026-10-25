// The issue view on a phone: the full app on a phone-sized window of the Android app (simulated,
// „Oberfläche auf Android: Vollständig“) shows the issue as a full-screen sheet, one column, without
// sideways scrolling, with touch-sized controls; editing works there too. Screenshots light and dark.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";
import { startFakeJira } from "../lib/fake-jira.js";

const test = guarded(nodeTest, () => app);
let app;
let jira;
before(async () => {
  jira = await startFakeJira({ flavor: "cloud" });
  app = await launch({ width: 400, height: 820, env: { ARCALO_SIMULATE_ANDROID: "1", ARCALO_JIRA_DELAY_SECS: "600" } });
  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", { settings: { ...view.settings, appearance: { ...view.settings.appearance, android_interface: "full" } } });
  await app.invoke("jira_site_save", {
    site: { id: "", name: "Acme", color: "", kind: "cloud", url: jira.url, email: "mia@firma.de", enabled: true, log_work: false, allow_writes: false },
    token: "secret-token",
  });
  await app.invoke("jira_sync_now", { site: "acme" });
  await app.reload();
  await fullApp();
});

/** The phone-sized window first opened the phone app; with „Volle App“ chosen it goes over to the full one. */
async function fullApp() {
  await app.browser.waitUntil(
    async () => {
      try {
        return await app.browser.execute(() => window.innerWidth > 0 && !!document.querySelector(".ribbon") && document.body.classList.contains("ready"));
      } catch {
        return false; // between the pages
      }
    },
    { timeout: 20000, timeoutMsg: "the full app did not open" },
  );
}
after(async () => {
  await app?.close();
  await jira?.close();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const V = (sel = "") => `[data-issue-view="PROJ-123"] ${sel}`.trim();

async function open() {
  await app.keys(["Control", "k"]);
  await app.waitFor(".palette input");
  await app.type("PROJ-123");
  await app.browser.waitUntil(() => app.browser.execute(() => (document.querySelector(".pal-item.sel")?.textContent ?? "").includes("Issue PROJ-123 öffnen")), { timeoutMsg: "no issue item" });
  await app.keys(["Enter"]);
  await app.waitFor(V(".iv-summary"), 15000);
  await app.browser.waitUntil(() => app.browser.execute((s) => !document.querySelector(s), V(".iv-refreshing")), { timeout: 15000 });
}

test("a full-screen sheet, one column, no sideways scrolling", async () => {
  assert.equal(await app.browser.execute(() => window.innerWidth), 400, "the window is phone-sized");
  await open();
  await sleep(500);
  const box = await app.browser.execute(() => {
    const r = document.querySelector(".iv").getBoundingClientRect();
    const main = document.querySelector(".iv-main").getBoundingClientRect();
    const side = document.querySelector(".iv-side").getBoundingClientRect();
    return { x: r.x, y: r.y, w: Math.round(r.width), h: Math.round(r.height), vw: window.innerWidth, vh: window.innerHeight, wide: [".iv", ".iv-scroll", ".iv-main", ".iv-side"].some((s) => { const e = document.querySelector(s); return e.scrollWidth > e.clientWidth + 1; }), stacked: side.top >= main.bottom - 1 };
  });
  assert.deepEqual([box.x, box.y, box.w, box.h], [0, 0, box.vw, box.vh], JSON.stringify(box));
  assert.equal(box.wide, false, "no sideways scroll");
  assert.equal(box.stacked, true, "details below the description");
  // Touch-sized controls in the header.
  const small = await app.browser.execute(() => [...document.querySelectorAll(".iv-head-actions .icon-btn")].filter((b) => b.getBoundingClientRect().height < 44).length);
  assert.equal(small, 0, "header buttons at least 44 px");
  await app.dismissToasts();
  await app.shot("153-issue-view-phone");
  await app.browser.execute(() => (document.querySelector(".iv-scroll").scrollTop = 1400));
  await app.shot("153-issue-view-phone-details");
});

test("a field is edited in the sheet", async () => {
  await app.browser.execute((s) => document.querySelector(s)?.scrollIntoView(), V('.iv-field[data-field="customfield_10061"]'));
  await app.click(V('.iv-field[data-field="customfield_10061"] .iv-value.editable'));
  const field = await app.waitFor(V('.iv-field[data-field="customfield_10061"] input'));
  await field.click();
  await app.keys(["Control", "a"]);
  await app.type("ACME-1");
  await app.keys(["Enter"]);
  await app.waitText(V('.iv-field[data-field="customfield_10061"]'), /ACME-1$/, 10000);
  assert.equal(jira.issues.find((i) => i.key === "PROJ-123").customs.customfield_10061, "ACME-1");
  await app.keys(["Escape"]);
  await app.browser.waitUntil(async () => (await app.browser.execute(() => document.querySelectorAll(".iv").length)) === 0, { timeoutMsg: "still open" });
});

test("dark", async () => {
  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", { settings: { ...view.settings, theme: "dark" } });
  await app.reload();
  await fullApp();
  await open();
  await app.dismissToasts();
  await sleep(400);
  await app.shot("153-issue-view-phone-dark");
});
