// „Lesezeichen importieren“: fake browser profiles (Chrome with two profiles, Firefox) below a
// temp home folder (ANNALO_TEST_HOME, honored by debug builds). Imports a folder as a group and
// two links, skips duplicates on a second import, puts what does not fit a group into a page,
// undoes an import, and reads an HTML export dropped onto the dialog.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launch, guarded } from "../lib/harness.js";
import { setValue } from "../lib/mail-fixtures.js";

const test = guarded(nodeTest, () => app);
let app;
const home = fs.mkdtempSync(path.join(os.tmpdir(), "annalo-bm-home-"));
const log = path.join(home, "opened.txt");

// WebKit time (microseconds since 1601) of 2024-01-01.
const T = "13348540800000000";
const url = (name, u) => ({ type: "url", name, url: u, date_added: T });
const dir = (name, children) => ({ type: "folder", name, children, date_added: T });
const chrome = path.join(home, ".config/google-chrome");

function fakeProfiles() {
  const big = Array.from({ length: 65 }, (_, i) => url(`Doku ${i + 1}`, `https://doku.firma.de/seite/${i + 1}`));
  const arbeit = {
    roots: {
      bookmark_bar: dir("Lesezeichenleiste", [
        url("Jira", "https://jira.firma.de/"),
        dir("Werkzeuge", [url("Wiki – Übersicht", "https://wiki.firma.de/"), url("Grafana", "https://grafana.firma.de/"), dir("Tief", [url("Kibana", "https://kibana.firma.de/")])]),
        url("Nachrichten", "https://www.tagesschau.de/"),
        url("Übersetzen", "javascript:void(0)"),
        dir("Riesig", big),
      ]),
      other: dir("Weitere Lesezeichen", [url("Handbuch", "file:///srv/handbuch.pdf"), url("Flags", "chrome://flags/")]),
      synced: dir("Mobile Lesezeichen", []),
    },
    version: 1,
  };
  const privat = { roots: { bookmark_bar: dir("Lesezeichenleiste", [url("Bank", "https://bank.de/")]), other: dir("Weitere Lesezeichen", []) }, version: 1 };
  fs.mkdirSync(path.join(chrome, "Default"), { recursive: true });
  fs.mkdirSync(path.join(chrome, "Profile 1"), { recursive: true });
  fs.writeFileSync(path.join(chrome, "Local State"), JSON.stringify({ profile: { info_cache: { Default: { name: "Arbeit" }, "Profile 1": { name: "Privat" } } } }));
  fs.writeFileSync(path.join(chrome, "Default/Bookmarks"), JSON.stringify(arbeit));
  fs.writeFileSync(path.join(chrome, "Profile 1/Bookmarks"), JSON.stringify(privat));

  // Firefox: profiles.ini and a places.sqlite with Firefox's tables.
  const ff = path.join(home, ".mozilla/firefox");
  fs.mkdirSync(path.join(ff, "Profiles/abc.default-release"), { recursive: true });
  fs.writeFileSync(path.join(ff, "profiles.ini"), "[Profile0]\nName=default-release\nIsRelative=1\nPath=Profiles/abc.default-release\nDefault=1\n");
  const db = new DatabaseSync(path.join(ff, "Profiles/abc.default-release/places.sqlite"));
  db.exec(`CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url LONGVARCHAR, title LONGVARCHAR);
    CREATE TABLE moz_bookmarks (id INTEGER PRIMARY KEY, type INTEGER, fk INTEGER, parent INTEGER, position INTEGER, title LONGVARCHAR, dateAdded INTEGER, guid TEXT);
    INSERT INTO moz_bookmarks VALUES (1, 2, NULL, 0, 0, '', 0, 'root________');
    INSERT INTO moz_bookmarks VALUES (2, 2, NULL, 1, 0, 'toolbar', 0, 'toolbar_____');
    INSERT INTO moz_bookmarks VALUES (3, 2, NULL, 1, 1, 'menu', 0, 'menu________');
    INSERT INTO moz_places VALUES (1, 'https://gitlab.firma.de/', 'GitLab');
    INSERT INTO moz_places VALUES (2, 'https://mail.firma.de/', 'Mail');
    INSERT INTO moz_bookmarks VALUES (10, 1, 1, 2, 0, 'GitLab', 1704067200000000, 'b1');
    INSERT INTO moz_bookmarks VALUES (11, 1, 2, 3, 0, 'Webmail', 1704067200000000, 'b2');`);
  db.close();
}

const EDGE_HTML = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3 ADD_DATE="1704067200" PERSONAL_TOOLBAR_FOLDER="true">Favoritenleiste</H3>
    <DL><p>
        <DT><A HREF="https://portal.azure.com/" ADD_DATE="1704067200">Microsoft Azure</A>
        <DT><H3 ADD_DATE="1704067200">SAP</H3>
        <DL><p>
            <DT><A HREF="https://s4.firma.de/sap/bc/ui2/flp?sap-client=100&amp;sap-language=DE" ADD_DATE="1704067200">S/4HANA Fiori</A>
        </DL><p>
    </DL><p>
</DL><p>
`;

before(async () => {
  fakeProfiles();
  app = await launch({ env: { ANNALO_TEST_HOME: home, ANNALO_TEST_OPEN_LOG: log } });
});
after(async () => {
  await app?.close();
  fs.rmSync(home, { recursive: true, force: true });
});

const links = async () => (await app.invoke("settings_get")).settings.quick_links;
const opened = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []);
const dialogOpen = () => app.browser.execute(() => !!document.querySelector(".dialog .bm-import"));
const rowsText = () => app.browser.execute(() => [...document.querySelectorAll(".bm-tree .bm-row .bm-row-title")].map((r) => r.textContent));
/** Clicks the tree row with this title. */
const clickRow = (title) =>
  app.browser.execute((t) => [...document.querySelectorAll(".bm-tree .bm-row")].find((r) => r.querySelector(".bm-row-title").textContent === t).click(), title);
const selected = () => app.text(".bm-selected");
const units = () =>
  app.browser.execute(() => [...document.querySelectorAll(".bm-unit")].map((u) => `${u.querySelector(".bm-unit-name").textContent} | ${u.querySelector(".bm-unit-meta").textContent}`));
async function chooseSource(browser, profile) {
  await app.waitFor(".bm-source");
  await app.browser.execute(
    (b, p) => [...document.querySelectorAll(".bm-source")].find((s) => s.dataset.browser === b && s.querySelector(".bm-source-profile").textContent.startsWith(p)).click(),
    browser,
    profile,
  );
  await app.waitFor(".bm-tree .bm-row");
}
async function importNow() {
  await app.click(".dialog .bm-do-import");
  await app.browser.waitUntil(async () => !(await dialogOpen()), { timeoutMsg: "dialog did not close" });
}
const openFromPalette = async () => {
  await app.browser.execute(() => document.querySelector('.ribbon [aria-label^="Befehlspalette"]')?.click());
  const input = await app.waitFor(".palette input");
  await input.setValue("Lesezeichen imp");
  await app.waitText(".palette .pal-item", /Lesezeichen importieren/);
  await app.browser.execute(() => [...document.querySelectorAll(".palette .pal-item")].find((i) => i.textContent.includes("Lesezeichen importieren")).click());
  await app.waitFor(".dialog .bm-import");
};

test("„App / Link hinzufügen“ leads to the import, which lists the profiles with counts", async () => {
  await app.waitFor(".ribbon .quick-links");
  assert.deepEqual(await links(), []);
  await app.click(".ribbon .quick-link-add");
  await app.waitFor(".dialog .link-import-bookmarks");
  await app.click(".dialog .link-import-bookmarks");
  await app.waitFor(".dialog .bm-import");
  await app.waitFor(".bm-source");
  const sources = await app.browser.execute(() =>
    [...document.querySelectorAll(".bm-source")].map((s) => `${s.dataset.browser} | ${s.querySelector(".bm-source-profile").textContent} | ${s.querySelector(".bm-source-count")?.textContent}`),
  );
  assert.deepEqual(sources, ["chrome | Arbeit · Default | 71 Lesezeichen", "chrome | Privat · Profile 1 | 1 Lesezeichen", "firefox | default-release · abc.default-release | 2 Lesezeichen"]);
  await app.shot("bookmarks-1-sources");
});

test("a folder becomes a group, two bar links ribbon links", async () => {
  await chooseSource("chrome", "Arbeit");
  // The bookmarks bar is preselected; start from nothing.
  assert.match(await selected(), /^70 von 71 ausgewählt$/);
  assert.match(await app.text(".bm-skipped"), /2 übersprungen/);
  await app.click(".bm-none");
  assert.match(await selected(), /^0 von 71/);
  assert.deepEqual((await rowsText()).slice(0, 4), ["Lesezeichenleiste", "Jira", "Werkzeuge", "Nachrichten"]);
  await clickRow("Werkzeuge");
  await clickRow("Jira");
  // Keyboard: arrows move, Space ticks.
  await app.browser.execute(() => [...document.querySelectorAll(".bm-tree .bm-row")].find((r) => r.textContent.includes("Werkzeuge")).focus());
  await app.keys(["ArrowDown"]);
  assert.equal(await app.browser.execute(() => document.activeElement.querySelector(".bm-row-title")?.textContent), "Nachrichten");
  await app.keys([" "]);
  assert.match(await selected(), /^5 von 71/);
  const state = await app.browser.execute(() => document.querySelector(".bm-tree .bm-row[data-id='0']").getAttribute("aria-checked"));
  assert.equal(state, "mixed", "the bar is partly chosen");
  // Search shows the hit with its folders.
  await setValue(app, ".bm-search input", "kibana");
  await app.browser.waitUntil(async () => (await rowsText()).length === 4);
  assert.deepEqual(await rowsText(), ["Lesezeichenleiste", "Werkzeuge", "Tief", "Kibana"]);
  await app.shot("bookmarks-2-tree-search");
  await setValue(app, ".bm-search input", "");
  await app.browser.waitUntil(async () => (await rowsText()).length > 4);
  await app.shot("bookmarks-2-tree");

  await app.click(".dialog .bm-next");
  await app.waitFor(".bm-unit");
  assert.deepEqual(await units(), ["Lesezeichenleiste | 2 Links direkt in der Leiste", "Werkzeuge | Gruppe mit 3 Links"]);
  assert.equal(await app.text(".bm-preview-slots"), "3 von 40");
  assert.equal((await app.$$(".bm-preview-icon.new")).length, 3);
  await app.shot("bookmarks-3-target");
  await importNow();
  assert.deepEqual(await links(), [
    { name: "Jira", url: "https://jira.firma.de/", icon: "ticket" },
    { name: "Nachrichten", url: "https://www.tagesschau.de/", icon: "newspaper" },
    {
      name: "Werkzeuge",
      url: "",
      icon: "folder",
      kind: "group",
      items: [
        { name: "Wiki – Übersicht", url: "https://wiki.firma.de/", icon: "book-open" },
        { name: "Grafana", url: "https://grafana.firma.de/", icon: "chart" },
        { name: "Tief / Kibana", url: "https://kibana.firma.de/", icon: "chart" },
      ],
    },
  ]);
  await app.waitText(".toast", /5 Lesezeichen importiert/);
  await app.dismissToasts();
  // The imported links open like any other.
  await app.click('.ribbon .quick-link[aria-label="Jira"]');
  await app.browser.waitUntil(async () => opened().length === 1);
  assert.deepEqual(opened(), ["url\thttps://jira.firma.de/"]);
});

test("a second import skips what is already in the ribbon", async () => {
  await openFromPalette();
  await chooseSource("chrome", "Arbeit");
  await app.click(".bm-none");
  for (const r of ["Werkzeuge", "Jira", "Nachrichten"]) await clickRow(r);
  await app.click(".dialog .bm-next");
  await app.waitFor(".bm-unit");
  assert.match(await app.text(".bm-summary"), /Nichts Neues/);
  assert.match(await app.text(".bm-summary"), /5 schon in der Leiste, übersprungen/);
  assert.equal(await app.browser.execute(() => document.querySelector(".dialog .bm-do-import").disabled), true);
  // Back, add the manual from „Weitere Lesezeichen“: it becomes a group of that name.
  await app.browser.execute(() => [...document.querySelectorAll(".dialog-foot button")].find((b) => b.textContent === "Zurück").click());
  await app.waitFor(".bm-tree");
  await clickRow("Handbuch");
  await app.click(".dialog .bm-next");
  await app.waitFor(".bm-unit");
  assert.deepEqual(await units(), ["Lesezeichenleiste | 0 Links direkt in der Leiste2 schon da", "Werkzeuge | 0 Links in die vorhandene Gruppe3 schon da", "Weitere Lesezeichen | Gruppe mit 1 Link"]);
  await importNow();
  const l = await links();
  assert.equal(l.length, 4);
  assert.deepEqual(l[3], { name: "Weitere Lesezeichen", url: "", icon: "folder", kind: "group", items: [{ name: "Handbuch", url: "file:///srv/handbuch.pdf", icon: "folder" }] });
  await app.dismissToasts();
});

test("a folder over the group limit: 60 in the group, the rest on a page; undo", async () => {
  const before = await links();
  await openFromPalette();
  await chooseSource("chrome", "Arbeit");
  await app.click(".bm-none");
  await clickRow("Riesig");
  await app.click(".dialog .bm-next");
  await app.waitFor(".bm-unit");
  assert.match(await app.text(".bm-note.warn"), /5 Lesezeichen kommen auf Seiten/);
  assert.deepEqual(await units(), ["Riesig | Gruppe mit 60 Links5 auf Seite"]);
  await app.shot("bookmarks-4-overflow");
  await importNow();
  const l = await links();
  assert.equal(l.length, 5);
  assert.equal(l[4].name, "Riesig");
  assert.equal(l[4].items.length, 60);
  const page = await app.invoke("page_resolve", { title: "Riesig", create: false });
  assert.ok(page, "page created");
  const doc = await app.invoke("page_get", { id: page.id });
  const lines = doc.content.split("\n").filter((x) => x.startsWith("- ["));
  assert.deepEqual(lines, [61, 62, 63, 64, 65].map((n) => `- [Doku ${n}](https://doku.firma.de/seite/${n})`));
  assert.match(doc.content, /^Importiert aus Google Chrome · Arbeit am \d\d\.\d\d\.\d{4}\./);
  const parent = await app.invoke("page_resolve", { title: "Lesezeichen", create: false });
  assert.equal(page.parent_id, parent.id);

  // „Rückgängig“ in the toast: the ribbon as before, the pages gone.
  await app.waitText(".toast", /65 Lesezeichen importiert/);
  await app.browser.execute(() => [...document.querySelectorAll(".toast button")].find((b) => b.textContent === "Rückgängig").click());
  await app.browser.waitUntil(async () => (await links()).length === 4, { timeoutMsg: "not undone" });
  assert.deepEqual(await links(), before);
  await app.browser.waitUntil(async () => !(await app.invoke("page_resolve", { title: "Riesig", create: false })), { timeoutMsg: "page still there" });
  assert.equal(await app.invoke("page_resolve", { title: "Lesezeichen", create: false }), null);
  await app.waitText(".toast", /Import rückgängig gemacht/);
  await app.dismissToasts();
});

test("an HTML export dropped onto the dialog (opened from the ribbon menu)", async () => {
  await app.browser.execute(() => {
    const b = document.querySelector(".ribbon .quick-link-add");
    const r = b.getBoundingClientRect();
    b.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: r.left + 5, clientY: r.top + 5 }));
  });
  await app.browser.waitUntil(async () => app.browser.execute(() => !!document.querySelector(".menu")));
  await app.browser.execute(() => [...document.querySelectorAll(".menu-item")].find((b) => b.textContent.includes("Lesezeichen importieren")).click());
  await app.waitFor(".bm-drop");
  // Not a bookmarks file: a clear error.
  await app.browser.execute(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(["x"], "notiz.txt", { type: "text/plain" }));
    document.querySelector(".bm-drop").dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
  });
  await app.waitText(".bm-error", /keine Lesezeichen-Datei/);
  await app.browser.execute((html) => {
    const dt = new DataTransfer();
    dt.items.add(new File([html], "favoriten_01.10.26.html", { type: "text/html" }));
    const el = document.querySelector(".bm-drop");
    for (const type of ["dragenter", "dragover", "drop"]) el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, EDGE_HTML);
  await app.waitFor(".bm-tree .bm-row");
  assert.equal(await app.text(".bm-select-label"), "favoriten_01.10.26.html");
  assert.match(await selected(), /^2 von 2/);
  await app.click(".dialog .bm-next");
  await app.waitFor(".bm-unit");
  await importNow();
  const l = await links();
  assert.equal(l.length, 6);
  assert.deepEqual(l.slice(4), [
    { name: "Microsoft Azure", url: "https://portal.azure.com/", icon: "cloud" },
    { name: "SAP", url: "", icon: "folder", kind: "group", items: [{ name: "S/4HANA Fiori", url: "https://s4.firma.de/sap/bc/ui2/flp?sap-client=100&sap-language=DE", icon: "briefcase" }] },
  ]);
  await app.dismissToasts();
});

test("settings and Firefox; dark theme and 900 px", async () => {
  await app.browser.execute(() => document.querySelector('.ribbon [aria-label^="Einstellungen"]')?.click());
  await app.waitFor(".settings-nav");
  await app.browser.execute(() => [...document.querySelectorAll(".settings-nav-item")].find((b) => b.textContent.trim() === "Start")?.click());
  await app.waitFor(".set-bookmarks-import");
  await app.click(".set-bookmarks-import");
  await app.waitFor(".dialog .bm-import");
  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", { settings: { ...view.settings, theme: "dark" } });
  await app.browser.execute(() => (document.documentElement.dataset.theme = "dark"));
  await app.browser.setWindowSize(900, 760);
  await chooseSource("firefox", "default-release");
  assert.deepEqual(await rowsText(), ["Lesezeichen-Symbolleiste", "GitLab", "Lesezeichen-Menü", "Webmail"]);
  await app.shot("bookmarks-5-firefox-dark-900");
  await clickRow("Lesezeichen-Menü");
  await app.click(".dialog .bm-next");
  await app.waitFor(".bm-unit");
  // Send the menu's group to a page instead.
  await app.browser.execute(() => [...document.querySelectorAll(".bm-unit")].find((u) => u.textContent.includes("Lesezeichen-Menü")).querySelector('[role="radio"]:last-child').click());
  await app.browser.waitUntil(async () => (await units()).some((u) => /Lesezeichen-Menü \| Seite mit 1 Link$/.test(u)));
  const box = await app.browser.execute(() => {
    const d = document.querySelector(".dialog").getBoundingClientRect();
    return { right: d.right, w: innerWidth, overflow: document.querySelector(".bm-target").scrollWidth > document.querySelector(".bm-target").clientWidth };
  });
  assert.ok(box.right <= box.w, "the dialog fits the window");
  assert.equal(box.overflow, false);
  await app.shot("bookmarks-6-target-dark-900");
  await app.keys(["Escape"]);
  await app.browser.waitUntil(async () => !(await dialogOpen()));
  await app.browser.setWindowSize(1480, 920);
  assert.deepEqual(await app.consoleErrors(), []);
});
