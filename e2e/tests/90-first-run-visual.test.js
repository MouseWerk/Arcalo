// The intro and the setup in German and English, light and dark (a screenshot of every scene and
// step), in a 900 px window and a short one (nothing cut off, no horizontal scrolling), and with
// reduced motion (static slides).
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
before(async () => (app = await launch({ demo: false, onboarding: true })));
after(async () => app?.close());

const SCENES = ["welcome", "notes", "meetings", "time", "local"];
const STEPS = ["language", "theme", "ai", "work", "calendar", "workspace", "done"];

async function look(lang, theme, extra = {}) {
  const view = await app.invoke("settings_get");
  const s = view.settings;
  await app.invoke("settings_save", { settings: { ...s, theme, locale: { ...s.locale, language: lang }, appearance: { ...s.appearance, ...extra } } });
  await app.browser.waitUntil(async () => (await app.browser.execute(() => [document.documentElement.dataset.theme, document.documentElement.lang])).join() === `${theme},${lang}`, {
    timeoutMsg: `${lang}/${theme} not applied`,
  });
}

/** Closes the setup if it is open and starts it again from the palette. */
async function rerun() {
  if (await app.browser.execute(() => !!document.querySelector(".fr-close"))) await app.click(".fr-close");
  if (await app.browser.execute(() => !!document.querySelector(".fr-intro"))) {
    await app.keys(["Escape"]);
    await app.click(".fr-close");
  }
  await app.browser.waitUntil(async () => !(await app.browser.execute(() => !!document.querySelector(".fr-overlay"))));
  await app.keys(["Control", "k"]);
  await app.waitFor(".palette input");
  const de = (await app.browser.execute(() => document.documentElement.lang)) === "de";
  await app.type(de ? "Einführung erneut" : "Replay the intro");
  await app.browser.pause(200);
  await app.keys(["Enter"]);
  await app.waitFor(".fr-intro");
}

/** Nothing sticks out sideways; the buttons at the bottom are inside the window. */
async function fits(where) {
  const r = await app.browser.execute(() => {
    const o = document.querySelector(".fr-overlay");
    const body = document.querySelector(".fr-body");
    const btn = document.querySelector(".fr-next, .fr-setup");
    const b = btn?.getBoundingClientRect();
    return {
      over: o.scrollWidth - o.clientWidth,
      bodyOver: body ? body.scrollWidth - body.clientWidth : 0,
      btnIn: !!b && b.bottom <= window.innerHeight && b.right <= window.innerWidth && b.top >= 0,
      title: !!document.querySelector(".fr-title, .fr-step-title"),
    };
  });
  assert.ok(r.over <= 1 && r.bodyOver <= 1, `${where}: horizontal overflow ${JSON.stringify(r)}`);
  assert.ok(r.btnIn, `${where}: primary button outside the window`);
  assert.ok(r.title, `${where}: no title`);
}

for (const [lang, theme] of [
  ["de", "light"],
  ["de", "dark"],
  ["en", "light"],
  ["en", "dark"],
]) {
  test(`every scene and step, ${lang} ${theme}`, async () => {
    if (!(await app.browser.execute(() => !!document.querySelector(".fr-intro")))) await rerun();
    await look(lang, theme);
    for (const [i, id] of SCENES.entries()) {
      await app.click(`.fr-seg:nth-child(${i + 1})`);
      await app.browser.waitUntil(async () => (await app.browser.execute(() => document.querySelector(".fr-intro")?.dataset.scene)) === id);
      // Most of the scene's motion is done after 3.3 s (it moves on at about 5 s).
      await app.browser.pause(3300);
      await app.shot(`firstrun-${lang}-${theme}-scene-${i + 1}-${id}`);
      await fits(`scene ${id}`);
    }
    await app.click(".fr-setup");
    await app.waitFor(".fr-intake");
    for (const [i, id] of STEPS.entries()) {
      await app.click(`.fr-rail-item[data-step="${id}"]`);
      await app.waitFor(`.fr-step-${id}`);
      await app.browser.pause(450);
      await app.shot(`firstrun-${lang}-${theme}-step-${String(i + 1).padStart(2, "0")}-${id}`);
      await fits(`step ${id}`);
    }
    assert.deepEqual(await app.consoleErrors(), []);
  });
}

test("a 900 px window and a short one: nothing is cut off", async () => {
  await look("de", "light");
  for (const [w, h] of [
    [900, 700],
    [1000, 560],
  ]) {
    await app.browser.setWindowSize(w, h);
    await rerun();
    await app.browser.pause(400);
    for (const [i, id] of SCENES.entries()) {
      await app.click(`.fr-seg:nth-child(${i + 1})`);
      await app.browser.pause(400);
      await fits(`${w}x${h} scene ${id}`);
    }
    await app.shot(`firstrun-${w}x${h}-scene`);
    await app.click(".fr-setup");
    await app.waitFor(".fr-intake");
    // The step list becomes a compact line.
    assert.equal(await app.browser.execute(() => getComputedStyle(document.querySelector(".fr-rail")).display), w <= 1000 ? "none" : "block");
    for (const id of STEPS) {
      // Without the list: Weiter walks through the steps.
      if (id !== "language") await app.click(".fr-next");
      await app.waitFor(`.fr-step-${id}`);
      await app.browser.pause(300);
      await fits(`${w}x${h} step ${id}`);
      if (["work", "ai", "done"].includes(id)) await app.shot(`firstrun-${w}x${h}-step-${id}`);
      // The step is named once: the compact line replaces the step's own eyebrow.
      if (w <= 1000) assert.equal(await app.browser.execute(() => getComputedStyle(document.querySelector(".fr-step-count")).display), "none");
    }
  }
  await app.browser.setWindowSize(1480, 920);
});

test("reduced motion shows static slides", async () => {
  await look("en", "dark", { reduce_motion: true });
  await rerun();
  assert.equal(await app.browser.execute(() => document.querySelector(".fr-intro").classList.contains("fr-reduced")), true);
  await app.click(".fr-seg:nth-child(3)");
  await app.browser.pause(300);
  const anim = await app.browser.execute(() => [...document.querySelectorAll(".fr-scene .frv-in, .fr-scene .frv-pop, .fr-scene .frv-type")].map((e) => getComputedStyle(e).animationName));
  assert.ok(anim.length > 0 && anim.every((a) => a === "none"), anim.join());
  await app.shot("firstrun-reduced-time");
  await look("en", "dark", { reduce_motion: false });
});
