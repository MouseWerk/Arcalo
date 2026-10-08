// The old name „Annalo“ (renamed to Arcalo in 1.7) is nowhere in what the app shows: the start-up
// animation, every intro scene and setup step (German and English), the window title, Settings
// and the developer log. Only the notice „Annalo heißt jetzt Arcalo“ for upgraders may say it
// (e2e/tests/113-rebrand-arcalo.test.js); the sources are checked by ui/src/lib/branding.test.ts.
// Since 1.15 the internal names follow (storage keys, globals, the log), in any spelling.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
// A data folder of its own: the harness's default name would show up in the paths the setup and
// Settings display.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "arcalo-e2e-250-"));
before(async () => (app = await launch({ demo: false, onboarding: true, dataDir })));
after(async () => {
  await app?.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const SCENES = ["welcome", "notes", "meetings", "time", "local"];
const STEPS = ["language", "theme", "ai", "work", "calendar", "workspace", "done"];

/** Every text node and every attribute a user or a screen reader gets that names Annalo. */
function oldName() {
  return app.browser.execute(() => {
    const OLD = /annalo/i;
    const NOTICE = /Annalo (heißt jetzt|is now) Arcalo/;
    const hits = [];
    if (OLD.test(document.title)) hits.push(`title: ${document.title}`);
    const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    for (let n = walker.currentNode; n; n = walker.nextNode()) {
      if (n.nodeType === Node.TEXT_NODE) {
        const el = n.parentElement;
        if (!el || el.closest("script, style") || !OLD.test(n.data)) continue;
        if (NOTICE.test(el.closest(".toast")?.textContent ?? "")) continue;
        hits.push(`text in <${el.tagName.toLowerCase()} class="${el.className}">: ${n.data.trim()}`);
      } else {
        for (const a of ["title", "aria-label", "aria-description", "aria-roledescription", "placeholder", "alt", "data-tooltip", "value"]) {
          const v = n.getAttribute(a);
          if (v && OLD.test(v)) hits.push(`${a} of <${n.tagName.toLowerCase()}>: ${v}`);
        }
      }
    }
    return hits;
  });
}

async function language(lang) {
  const s = (await app.invoke("settings_get")).settings;
  await app.invoke("settings_save", { settings: { ...s, locale: { ...s.locale, language: lang } } });
  await app.browser.waitUntil(async () => (await app.browser.execute(() => document.documentElement.lang)) === lang, { timeoutMsg: `${lang} not applied` });
}

test("the start-up animation spells Arcalo", async () => {
  await app.browser.execute(() => localStorage.setItem("arcalo.splash-test", "1"));
  await app.browser.refresh();
  const word = await app.browser.execute(() => document.querySelector("#splash .splash-word")?.textContent ?? null);
  assert.equal(word, "Arcalo");
  // The mark draws itself, then the name comes in letter by letter.
  await app.shot("250-splash-1-mark");
  await app.browser.pause(700);
  await app.shot("250-splash-2-name");
  assert.deepEqual(await oldName(), []);
  await app.browser.waitUntil(async () => !(await app.browser.execute(() => !!document.getElementById("splash"))), { timeout: 8000, timeoutMsg: "splash stays" });
  await app.browser.execute(() => localStorage.removeItem("arcalo.splash-test"));
});

for (const lang of ["de", "en"]) {
  test(`every intro scene and setup step, ${lang}`, async () => {
    if (!(await app.browser.execute(() => !!document.querySelector(".fr-intro")))) {
      if (await app.browser.execute(() => !!document.querySelector(".fr-close"))) await app.click(".fr-close");
      await app.browser.waitUntil(async () => !(await app.browser.execute(() => !!document.querySelector(".fr-overlay"))));
      await app.keys(["Control", "k"]);
      await app.waitFor(".palette input");
      await app.type((await app.browser.execute(() => document.documentElement.lang)) === "de" ? "Einführung erneut" : "Replay the intro");
      await app.browser.pause(200);
      await app.keys(["Enter"]);
      await app.waitFor(".fr-intro");
    }
    await language(lang);
    const brand = await app.browser.execute(() => document.querySelector(".fr-brand")?.textContent.trim());
    assert.equal(brand, "Arcalo");
    for (const [i, id] of SCENES.entries()) {
      await app.click(`.fr-seg:nth-child(${i + 1})`);
      await app.browser.waitUntil(async () => (await app.browser.execute(() => document.querySelector(".fr-intro")?.dataset.scene)) === id);
      // The visual's entrance (texts typed in, cards popping up) is done.
      await app.browser.pause(1800);
      assert.deepEqual(await oldName(), [], `scene ${id}`);
    }
    await app.shot(`250-intro-${lang}-local`);
    await app.click(".fr-setup");
    await app.waitFor(".fr-intake");
    for (const id of STEPS) {
      await app.click(`.fr-rail-item[data-step="${id}"]`);
      await app.waitFor(`.fr-step-${id}`);
      await app.browser.pause(300);
      assert.deepEqual(await oldName(), [], `step ${id}`);
    }
    await app.shot(`250-setup-${lang}-done`);
  });
}

test("window title, Settings and the developer log say Arcalo", async () => {
  await language("de");
  if (await app.browser.execute(() => !!document.querySelector(".fr-close"))) await app.click(".fr-close");
  await app.browser.waitUntil(async () => !(await app.browser.execute(() => !!document.querySelector(".fr-overlay"))));
  const native = await app.browser.execute(() => window.__TAURI_INTERNALS__.invoke("plugin:window|title", { label: "main" }));
  assert.match(native, /(^| – )Arcalo$/);
  assert.deepEqual(await oldName(), [], "home");

  await app.keys(["Control", ","]);
  await app.waitFor(".pane.active .settings");
  // Every section once (the Über section names the app, Protokoll its log file).
  const sections = await app.browser.execute(() => [...document.querySelectorAll(".settings-nav-item[data-section]")].map((b) => b.dataset.section));
  assert.ok(sections.includes("about"), sections.join());
  for (const s of sections) {
    await app.browser.execute((id) => document.querySelector(`.settings-nav-item[data-section="${id}"]`).click(), s);
    await app.browser.pause(250);
    assert.deepEqual(await oldName(), [], `settings ${s}`);
  }
  await app.browser.execute(() => document.querySelector('.settings-nav-item[data-section="about"]').click());
  await app.waitText(".settings-head h1", /^Arcalo$/);
  await app.shot("250-about");

  // The log file carries the new name; the start line too.
  const logs = path.join(app.dataDir, "logs");
  assert.ok(fs.existsSync(path.join(logs, "arcalo.log")), fs.readdirSync(logs).join());
  assert.ok(!fs.existsSync(path.join(logs, "annalo.log")));
  assert.doesNotMatch(fs.readFileSync(path.join(logs, "arcalo.log"), "utf8"), /annalo/i);
  assert.deepEqual(await app.consoleErrors(), []);
});

test("internal names in the page use the new name too (1.15): storage keys, globals, data folder", async () => {
  const internal = await app.browser.execute(() => ({
    keys: Object.keys(localStorage).filter((k) => /annalo/i.test(k)),
    ours: Object.keys(localStorage).filter((k) => /^arcalo\./.test(k)).length,
    globals: Object.keys(window).filter((k) => /annalo/i.test(k)),
    html: /annalo/i.test(document.documentElement.outerHTML),
  }));
  assert.deepEqual(internal.keys, [], "no storage key of the old name");
  assert.ok(internal.ours > 0, "the app's own keys are arcalo.*");
  assert.deepEqual(internal.globals, []);
  assert.equal(internal.html, false, "no class, id, attribute or link with the old name");
  const status = await app.invoke("data_dir_status");
  assert.doesNotMatch(status.data_dir, /annalo/i);
});
