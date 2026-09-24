// Settings redesign: the search filters rows across sections, narrow panes get a section
// dropdown instead of the menu (nothing sideways, nothing cut off), the Über/update row wraps
// its buttons instead of cutting them off and long paths shorten in the middle. Also the
// dropdown itself: keyboard, type-ahead and Escape.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, guarded } from "../lib/harness.js";
import { auditLayout } from "../lib/layout-audit.js";

const test = guarded(nodeTest, () => app);
let app, longDir;
before(async () => {
  // A data folder as deep as a real one (…\AppData\Roaming\app.annalo.desktop): the harness
  // creates it below the temporary folder.
  const tmp = process.env.TMPDIR;
  longDir = path.join(os.tmpdir(), "annalo-e2e-long", "Benutzer", "maurice.kleindienst", "AppData", "Roaming", "app.annalo.desktop");
  fs.mkdirSync(longDir, { recursive: true });
  process.env.TMPDIR = longDir;
  try {
    app = await launch();
  } finally {
    if (tmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = tmp;
  }
});
after(async () => app?.close());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Long dropdown values end in "…" on purpose.
const real = (problems) => problems.filter((p) => !p.startsWith("select too narrow"));

async function openSettings() {
  if (!(await app.browser.execute(() => !!document.querySelector(".pane.active .settings")))) await app.keys(["Control", ","]);
  await app.waitFor(".pane.active .settings");
}
const search = (q) =>
  app.browser.execute((v) => {
    // The visible search field (menu or top bar).
    const input = [...document.querySelectorAll(".pane.active .settings-search input")].find((i) => i.offsetParent !== null);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, v);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, q);
const visibleSections = () => app.browser.execute(() => [...document.querySelectorAll(".pane.active .settings-hit-section:not([hidden])")].map((s) => s.dataset.section));
const visibleRows = () =>
  app.browser.execute(() => [...document.querySelectorAll(".pane.active .settings-hit-section:not([hidden]) .set-group:not([hidden]) .set-row-label")].map((l) => l.textContent));

test("the search filters rows across all sections", async () => {
  await openSettings();
  await search("zeilen");
  await app.browser.waitUntil(async () => (await visibleSections()).length > 0, { timeoutMsg: "no hits" });
  const sections = await visibleSections();
  assert.ok(sections.includes("appearance"), sections.join());
  const rows = await visibleRows();
  assert.ok(rows.includes("Zeilenbreite"), rows.join());
  assert.ok(!rows.includes("Dichte"), "rows without the word are hidden");
  await app.waitText(".settings-search-head", /\d+ Treffer/);
  // The menu shows no section as open while searching.
  assert.equal(await app.browser.execute(() => document.querySelectorAll(".settings-nav-item.active").length), 0);
  await app.shot("settings-search");

  // Theme names are searchable; rows of other sections too (Über, Verwaltung).
  await search("nord");
  await app.browser.waitUntil(async () => (await visibleRows()).includes("Dunkles Thema"), { timeoutMsg: "theme name not found" });
  await search("updates");
  await app.browser.waitUntil(async () => (await visibleSections()).includes("about"), { timeoutMsg: "Über not searched" });
  // A section name shows the whole section.
  await search("netzwerk");
  await app.browser.waitUntil(async () => (await visibleSections()).includes("network"), { timeoutMsg: "section name" });
  assert.ok((await app.browser.execute(() => document.querySelectorAll('.settings-hit-section[data-section="network"] .set-row').length)) > 5);
  // Nothing found.
  await search("xyzzy-nichts");
  await app.waitText(".settings-search-head", /Nichts weiter gefunden für „xyzzy-nichts“/);
  assert.deepEqual(await visibleSections(), []);
  // Enter opens the first section with a hit; the search is cleared.
  await search("zeilenbreite");
  await app.browser.waitUntil(async () => (await visibleSections()).length > 0);
  await app.browser.execute(() => [...document.querySelectorAll(".pane.active .settings-search input")].find((i) => i.offsetParent !== null).focus());
  await app.keys(["Enter"]);
  await app.waitText(".settings-head h1", /Darstellung/);
  assert.equal(await app.browser.execute(() => document.querySelector(".settings-nav-item.active")?.dataset.section), "appearance");
  // Ctrl+F in the settings goes to the search; Escape clears it.
  // (Keyboard focus somewhere in the settings, here the menu.)
  await app.browser.execute(() => document.querySelector(".pane.active .settings-nav-item.active").focus());
  await app.keys(["Control", "f"]);
  await app.browser.waitUntil(async () => app.browser.execute(() => document.activeElement?.matches(".settings-search input")), { timeoutMsg: "Ctrl+F did not focus the search" });
  await app.type("sicher");
  await app.browser.waitUntil(async () => (await visibleSections()).length > 0, { timeoutMsg: "typed search" });
  await app.keys(["Escape"]);
  await app.browser.waitUntil(async () => (await app.browser.execute(() => document.querySelector(".pane.active .settings-search input").value)) === "", { timeoutMsg: "Escape did not clear" });
});

test("narrow panes: a section dropdown instead of the menu, nothing sideways or cut off", async () => {
  await openSettings();
  for (const [w, h] of [[900, 640], [1100, 760]]) {
    await app.browser.setWindowSize(w, h);
    await sleep(300);
    const layout = await app.browser.execute(() => {
      const settings = document.querySelector(".pane.active .settings");
      const shown = (el) => !!el && el.offsetParent !== null;
      return {
        nav: shown(settings.querySelector(".settings-nav")),
        topbar: shown(settings.querySelector(".settings-topbar")),
        dropdown: shown(settings.querySelector(".settings-section-select")),
        search: shown(settings.querySelector(".settings-topbar .settings-search")),
      };
    });
    assert.deepEqual(layout, { nav: false, topbar: true, dropdown: true, search: true }, `${w}px`);
    // Every section through the dropdown: no horizontal overflow, no clipped or overlapping controls.
    const sections = await app.browser.execute(() => [...document.querySelectorAll(".settings-nav-item")].map((b) => b.dataset.section));
    for (const s of sections) {
      await app.select(".pane.active .settings-section-select", s);
      await sleep(150);
      const problems = real(await app.browser.execute(auditLayout, ".pane.active .settings"));
      assert.deepEqual(problems, [], `${s} at ${w}px`);
      const sideways = await app.browser.execute(() => {
        const scroll = document.querySelector(".pane.active .settings-scroll");
        const settings = document.querySelector(".pane.active .settings");
        return [scroll.scrollWidth - scroll.clientWidth, settings.scrollWidth - settings.clientWidth, document.documentElement.scrollWidth - document.documentElement.clientWidth];
      });
      assert.deepEqual(sideways, [0, 0, 0], `${s} at ${w}px scrolls sideways`);
    }
    await app.select(".pane.active .settings-section-select", "appearance");
    if (w === 900) await app.shot("settings-narrow-appearance");
  }
  // Wide again: the menu is back, the dropdown gone.
  await app.browser.setWindowSize(1480, 920);
  await sleep(300);
  assert.equal(await app.browser.execute(() => document.querySelector(".pane.active .settings-nav").offsetParent !== null), true);
  assert.equal(await app.browser.execute(() => document.querySelector(".pane.active .settings-topbar").offsetParent === null), true);
});

test("Über: the update row wraps its buttons and long paths shorten in the middle", async () => {
  await openSettings();
  await app.browser.execute(() => document.querySelector('.settings-nav-item[data-section="about"]').click());
  await app.waitText(".settings-head h1", /Annalo/);
  // An available update (the test build has no update key, so the state is set directly).
  await app.browser.execute(() =>
    window.__annaloUpdates.setState({
      status: { enabled: true, current_version: "1.2.0", available: null },
      available: { version: "1.3.0", notes: "Neu", date: null, url: "https://example.invalid" },
      dismissed: "1.3.0",
    }),
  );
  await app.waitText(".update-state", /Version 1\.3\.0 ist verfügbar/);
  const dataDir = (await app.invoke("settings_get")).data_dir;
  assert.ok(dataDir.startsWith(longDir) && dataDir.length > 90, dataDir);
  for (const [w, h] of [[1480, 920], [1100, 760], [900, 640]]) {
    await app.browser.setWindowSize(w, h);
    await sleep(300);
    const r = await app.browser.execute((dir) => {
      const row = [...document.querySelectorAll(".pane.active .set-row")].find((x) => x.querySelector(".update-state"));
      const card = row.closest(".set-group-body").getBoundingClientRect();
      const buttons = [...row.querySelectorAll("button")].map((b) => {
        const box = b.getBoundingClientRect();
        return { text: b.textContent.trim(), inside: box.left >= card.left - 0.5 && box.right <= card.right + 0.5, whole: b.scrollWidth <= b.clientWidth + 1 };
      });
      const path = [...document.querySelectorAll(".pane.active .path-text")].find((p) => p.title === dir);
      const pbox = path.getBoundingClientRect();
      const pcard = path.closest(".set-group-body").getBoundingClientRect();
      const head = path.querySelector(".path-head");
      return {
        buttons,
        path: { inside: pbox.left >= pcard.left && pbox.right <= pcard.right + 0.5, tail: path.querySelector(".path-tail")?.textContent, cut: head.scrollWidth > head.clientWidth, text: path.textContent },
      };
    }, dataDir);
    assert.deepEqual(r.buttons.map((b) => b.text), ["Was ist neu?", "Installieren und neu starten", "Jetzt nach Updates suchen"]);
    for (const b of r.buttons) assert.ok(b.inside && b.whole, `${w}px: ${JSON.stringify(b)}`);
    assert.ok(r.path.inside, `${w}px: path outside its card`);
    // The end of the path (the data folder's own name) always stays visible.
    assert.equal(r.path.tail, dataDir.slice(dataDir.lastIndexOf("/")));
    assert.equal(r.path.text, dataDir, "the whole path is there to select and copy");
    if (w === 900) assert.ok(r.path.cut, "shortened in the middle when narrow");
    assert.deepEqual(real(await app.browser.execute(auditLayout, ".pane.active .settings")), [], `${w}px`);
    await app.shot(`settings-about-${w}`);
  }
  // The copy button confirms.
  await app.click(".pane.active .path-text.data-dir + button");
  await app.browser.waitUntil(async () => app.browser.execute(() => !!document.querySelector('.pane.active .path-value button[aria-label="Kopiert"]')), { timeoutMsg: "no copy feedback" });
  await app.browser.execute(() => window.__annaloUpdates.setState({ available: null, status: null }));
  await app.browser.setWindowSize(1480, 920);
});

test("the dropdown: keyboard, type-ahead, Escape and a click outside", async () => {
  await openSettings();
  await app.browser.execute(() => document.querySelector('.settings-nav-item[data-section="appearance"]').click());
  const scale = '.pane.active [role="combobox"][aria-label="Skalierung"]';
  await app.waitFor(scale);
  await app.browser.execute((s) => document.querySelector(s).scrollIntoView({ block: "center" }), scale);
  const value =() => app.browser.execute((s) => document.querySelector(s).dataset.value, scale);
  const open = () => app.browser.execute((s) => document.querySelector(s).getAttribute("aria-expanded") === "true", scale);
  const active = () => app.browser.execute((s) => document.getElementById(document.querySelector(s).getAttribute("aria-activedescendant") ?? "")?.textContent, scale);
  assert.equal(await value(), "100");
  await app.browser.execute((s) => document.querySelector(s).focus(), scale);
  await app.keys(["ArrowDown"]);
  await app.browser.waitUntil(open, { timeoutMsg: "ArrowDown did not open" });
  assert.equal(await active(), "100 %", "opens on the selected option");
  assert.equal(await app.browser.execute(() => document.querySelector('.select-pop [role="option"][aria-selected="true"]').textContent), "100 %");
  await app.shot("dropdown-open");
  await app.keys(["ArrowDown"]);
  assert.equal(await active(), "105 %");
  await app.keys(["End"]);
  assert.equal(await active(), "125 %");
  await app.keys(["Home"]);
  assert.equal(await active(), "90 %");
  // Escape closes without a change.
  await app.keys(["Escape"]);
  await app.browser.waitUntil(async () => !(await open()));
  assert.equal(await value(), "100");
  // Type-ahead: "1" goes to the next option starting with 1, again to the one after; Enter
  // chooses it (and saves: Darstellung saves immediately).
  await app.keys(["Enter"]);
  await app.browser.waitUntil(open);
  await app.type("11");
  assert.equal(await active(), "110 %");
  await app.keys(["Enter"]);
  await app.browser.waitUntil(async () => (await value()) === "110");
  await app.browser.waitUntil(async () => (await app.invoke("settings_get")).settings.appearance.ui_scale === 110, { timeoutMsg: "not saved" });
  // A click outside closes it.
  await app.keys([" "]);
  await app.browser.waitUntil(open);
  await app.click(".pane.active .settings-head h1");
  await app.browser.waitUntil(async () => !(await open()), { timeoutMsg: "click outside did not close" });
  // Back to 100 %: typing a whole label while closed picks it, like a native select.
  await app.browser.execute((s) => document.querySelector(s).focus(), scale);
  await app.type("100");
  await app.browser.waitUntil(async () => (await value()) === "100", { timeoutMsg: "typed while closed" });
  assert.equal(await open(), false);
  await app.browser.waitUntil(async () => (await app.invoke("settings_get")).settings.appearance.ui_scale === 100);
  assert.deepEqual(await app.consoleErrors(), []);
});
