// Captures every main screen in dark and light mode for visual review.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";
import { startFakeLiteLLM } from "../lib/fake-litellm.js";

const test = guarded(nodeTest, () => app);
let app, llm;
before(async () => {
  llm = await startFakeLiteLLM({ port: 4998 });
  app = await launch();
  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", {
    settings: { ...view.settings, litellm_base_url: llm.url, router: { ...view.settings.router, local_model: "firma-schnell", standard_model: "firma-standard", reasoning_model: "firma-reasoning" } },
  });
  await app.invoke("api_key_set", { key: llm.apiKey });
  await app.invoke("log_time", { line: "/zeit NP-8801/1020 3h #DEV Delta-Load Tests" });
  await app.invoke("log_time", { line: "/zeit NP-8801/1030 1.5h #DEV Review API @gestern @09:00" });
  await app.browser.refresh();
  await app.browser.waitUntil(async () => (await app.browser.execute(() => document.body.classList.contains("ready"))) === true, { timeout: 20000 });
});
after(async () => {
  await app?.close();
  await llm?.close();
});

const setTheme = async (theme) => {
  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", { settings: { ...view.settings, theme } });
  await app.browser.execute((t) => (document.documentElement.dataset.theme = t), theme);
};
const openTree = async (title) => {
  for (const r of await app.$$(".sidebar .tree-row")) if ((await app.textOf(r)) === title) return r.click();
};

for (const theme of ["dark", "light"]) {
  test(`screens in ${theme} mode`, async () => {
    await setTheme(theme);
    await app.browser.execute(() => {
      localStorage.removeItem("annalo.tabs");
    });
    await openTree("PRJ-2026-X Rollout");
    await app.waitFor(".ProseMirror table");
    await app.shot(`${theme}-01-page-table`);

    await openTree("Architektur");
    await app.waitFor(".ProseMirror h2");
    await app.shot(`${theme}-02-page`);

    // Assistant with an answer.
    const ta = await app.$(".composer textarea");
    await ta.setValue("Fasse die Seite zusammen");
    await app.keys(["Enter"]);
    await app.waitFor(".msg-meta");
    await app.shot(`${theme}-03-assistant`);

    await app.click('.panel-tab:nth-child(2)');
    await app.shot(`${theme}-04-outline`);
    await app.click('.panel-tab:nth-child(3)');
    await app.shot(`${theme}-05-links`);
    await app.click('.panel-tab:nth-child(1)');

    await app.click(".ribbon [aria-label=\"Zeiterfassung\"]");
    await app.waitFor(".week-grid");
    await app.shot(`${theme}-06-timesheet`);

    await app.click(".ribbon [aria-label=\"Projekte\"]");
    await app.waitFor(".vorgaenge");
    await app.shot(`${theme}-07-projects`);

    await app.keys(["Control", ","]);
    await app.waitText(".conn", /Verbunden/);
    await app.shot(`${theme}-08-settings`);

    await app.keys(["Control", "k"]);
    await app.waitFor(".palette");
    await app.shot(`${theme}-09-palette`);
    await app.keys(["Escape"]);

    await app.click(".ribbon [aria-label^=\"Heutige\"]");
    await app.waitFor(".page-subtitle");
    await app.shot(`${theme}-10-daily`);

    for (const t of await app.$$(".tab")) await app.browser.execute((e) => e.querySelector(".tab-close")?.click(), t);
    await app.waitFor(".home");
    await app.shot(`${theme}-11-home`);
  });
}

test("narrow window keeps everything usable", async () => {
  await app.browser.setWindowSize(1100, 760);
  await openTree("Architektur");
  await app.waitFor(".ProseMirror");
  await app.shot("narrow-page");
  await app.click(".ribbon [aria-label=\"Zeiterfassung\"]");
  await app.waitFor(".timer-form");
  await app.shot("narrow-timesheet");
  await app.browser.setWindowSize(1480, 920);
});

test("focus mode hides chrome", async () => {
  await openTree("Architektur");
  await app.keys(["Control", "."]);
  await app.browser.pause(250);
  assert.equal((await app.$$(".sidebar")).length, 0);
  await app.shot("focus-mode");
  await app.keys(["Escape"]);
});

test("no console errors", async () => {
  assert.deepEqual(await app.consoleErrors(), []);
});
