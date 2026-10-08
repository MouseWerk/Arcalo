// Data safety under failure: a save that fails (full disk) keeps the edits even when the editor
// is closed, and killing the app while it writes leaves an intact database with the last save.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { APP, launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "arcalo-e2e-safety-"));
before(async () => (app = await launch({ dataDir })));
after(async () => {
  await app?.close();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const DISK_FULL = () => path.join(dataDir, "test-disk-full");
const pageId = async (title) => (await app.invoke("page_resolve", { title, create: false })).id;
const content = async (title) => (await app.invoke("page_get", { id: await pageId(title) })).content;
const open = async (title) => {
  await app.invoke("search_open", { target: { kind: "page", page_id: await pageId(title), new_tab: false } });
  await app.browser.waitUntil(async () => (await app.text(".pane.active .tab.active .tab-title")) === title, { timeoutMsg: `${title} not open` });
  await app.waitFor(".pane.active .ProseMirror");
};

test("edits whose save failed survive closing the editor and are saved once the disk has room", async () => {
  await open("Architektur");
  await app.caretToEnd();
  await app.keys(["Enter"]);
  await app.type("Gespeichert vorher");
  await app.browser.waitUntil(async () => /Gespeichert vorher/.test(await content("Architektur")), { timeoutMsg: "first edit not saved" });

  fs.writeFileSync(DISK_FULL(), "");
  await app.keys(["Enter"]);
  await app.type("Nach dem vollen Datentraeger");
  // The error says what happened and what to do, once.
  await app.waitText(".toast-title", /Speichern fehlgeschlagen/);
  await app.waitText(".toast", /Datenträger ist voll.*Gib Speicherplatz frei/s);
  await app.shot("data-save-failed");
  assert.doesNotMatch(await content("Architektur"), /vollen Datentraeger/);

  // Another page in the same tab: the editor with the unsaved text is gone.
  await open("Jour fixe 22.09.");
  await app.browser.pause(600);
  // Back again before the disk has room: the editor shows the kept text, nothing is lost.
  await open("Architektur");
  await app.browser.waitUntil(async () => /Nach dem vollen Datentraeger/.test(await app.text(".pane.active .ProseMirror")), {
    timeoutMsg: "the kept text is not shown again",
  });
  await open("Jour fixe 22.09.");

  fs.rmSync(DISK_FULL());
  await app.browser.waitUntil(async () => /Nach dem vollen Datentraeger/.test(await content("Architektur")), {
    timeout: 12000,
    timeoutMsg: "kept edits were not saved after the disk had room",
  });
  assert.match(await content("Architektur"), /Gespeichert vorher[\s\S]*Nach dem vollen Datentraeger/);
});

test("a quit while edits cannot be saved asks first", async () => {
  await open("Architektur");
  fs.writeFileSync(DISK_FULL(), "");
  await app.caretToEnd();
  await app.keys(["Enter"]);
  await app.type("Nicht gespeichert beim Beenden");
  await app.waitText(".toast-title", /Speichern fehlgeschlagen/);
  await open("Jour fixe 22.09.");
  await app.browser.pause(600);
  // „Beenden“ from the tray: the kept edits make it ask instead of quitting.
  await app.browser.executeAsync((done) =>
    window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "app://quit-requested", payload: null }).then(done, done),
  );
  await app.waitText(".dialog", /Nicht gespeicherte Änderungen/, 10000);
  await app.shot("data-quit-unsaved");
  await app.browser.execute(() => [...document.querySelectorAll(".dialog .btn")].find((b) => b.textContent.trim() === "Abbrechen")?.click());
  await app.browser.waitUntil(async () => (await app.$$(".dialog")).length === 0, { timeoutMsg: "dialog still open" });
  fs.rmSync(DISK_FULL());
  await app.browser.waitUntil(async () => /Nicht gespeichert beim Beenden/.test(await content("Architektur")), {
    timeout: 12000,
    timeoutMsg: "kept edits were not saved",
  });
});

test("killing the app in the middle of saves leaves an intact database with a complete last save", async () => {
  const id = await pageId("Architektur");
  const before = await content("Architektur");
  // Saves of 200 KB each, back to back; the process is killed while they run.
  const big = (n) => `Lauf ${n}\n\n${"Absatz mit Umlauten äöü und Text. ".repeat(6000)}`;
  await app.browser.execute((pid, text) => {
    window.__bulk = 0;
    const run = async (n) => {
      for (let i = n; i < n + 400; i++) {
        await window.__TAURI_INTERNALS__.invoke("page_save", { id: pid, content: text.replace("Lauf 0", `Lauf ${i}`) });
        window.__bulk = i;
      }
    };
    run(1).catch((e) => (window.__bulkError = String(e)));
  }, id, big(0));
  await app.browser.waitUntil(
    async () => {
      const [n, err] = await app.browser.execute(() => [window.__bulk, window.__bulkError]);
      if (err) throw new Error(err);
      return n >= 3;
    },
    { timeout: 20000, timeoutMsg: "bulk saves did not start" },
  );
  const acknowledged = await app.browser.execute(() => window.__bulk);
  try {
    execSync(`pkill -9 -f "${APP}"`);
  } catch {
    /* pkill also hits the shell that runs it */
  }
  await app.close();

  const db = path.join(dataDir, "workspace.db");
  const check = execSync(`python3 -c "import sqlite3,sys; print(sqlite3.connect(sys.argv[1]).execute('pragma integrity_check').fetchone()[0])" "${db}"`).toString().trim();
  assert.equal(check, "ok");

  app = await launch({ dataDir });
  const after = await content("Architektur");
  const m = /^Lauf (\d+)\n/.exec(after);
  assert.ok(m, `the page holds one complete save (starts with ${JSON.stringify(after.slice(0, 40))}, before: ${before.length} chars)`);
  assert.ok(Number(m[1]) >= acknowledged, `the last acknowledged save (${acknowledged}) survived, found ${m[1]}`);
  assert.equal(after, big(0).replace("Lauf 0", `Lauf ${m[1]}`), "the save is complete, not cut off");
  // The app keeps working on it.
  await app.invoke("page_save", { id, content: before });
  assert.equal(await content("Architektur"), before);
});
