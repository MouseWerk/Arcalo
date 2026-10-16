// App-Sperre with the drawing editor or the PDF viewer open: both are overlays with their own React
// root on <body>, outside what the lock screen replaces. The lock saves the drawing's last strokes
// first, then closes both, so the PIN can be typed. Quitting saves the last strokes too.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, guarded } from "../lib/harness.js";
import { makePdf } from "../lib/linking-flows.js";

let app;
const test = guarded(nodeTest, () => app);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "arcalo-e2e-lock-overlays-"));
const ENV = { ARCALO_BACKUP_DELAY_SECS: "3600", ARCALO_SECRET_STORE: "file" };
const PIN = "8642";

before(async () => {
  app = await launch({ demo: true, dataDir, env: ENV });
  const s = await app.invoke("applock_status");
  await app.invoke("applock_configure", { config: { ...s.config, mode: "start" }, pin: PIN });
});
after(async () => {
  await app?.close();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const EMBED = ".pane.active > .pane-content:not([hidden])";
const appShown = () => app.browser.execute(() => !!document.querySelector(".sidebar, .side-tabs"));
const rectangles = async (name) => JSON.parse(await app.invoke("drawing_read", { name })).elements.filter((e) => e.type === "rectangle" && !e.isDeleted).length;

async function openPage(title, content) {
  const page = await app.invoke("page_create", { title, parentId: null, content });
  await app.invoke("search_open", { target: { kind: "page", page_id: page.id, new_tab: false } });
  await app.browser.waitUntil(async () => (await app.browser.execute(() => document.querySelector(".pane.active > .pane-content:not([hidden]) .page-title")?.value)) === title, {
    timeoutMsg: `${title} not open`,
  });
}

/** Draws a rectangle on the Excalidraw canvas (relative to its center). */
async function rectangle(x1, y1, x2, y2) {
  await app.keys(["r"]);
  const canvas = await app.$(".drawing-overlay canvas.excalidraw__canvas.interactive");
  await app.browser.performActions([
    {
      type: "pointer",
      id: "mouse",
      parameters: { pointerType: "mouse" },
      actions: [
        { type: "pointerMove", origin: canvas, x: x1, y: y1 },
        { type: "pointerDown", button: 0 },
        { type: "pointerMove", origin: canvas, x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2), duration: 80 },
        { type: "pointerMove", origin: canvas, x: x2, y: y2, duration: 80 },
        { type: "pointerUp", button: 0 },
      ],
    },
  ]);
  await app.browser.releaseActions();
}

/** Locks now and unlocks by typing the PIN into the lock screen like a user. */
async function lockAndUnlock() {
  await app.invoke("applock_lock_now");
  await app.waitFor(".lock-screen", 8000);
  await app.click(".lock-pin");
  await app.type(PIN);
  assert.equal(await app.browser.execute(() => document.querySelector(".lock-pin").value), PIN, "the PIN reached the field");
  await app.keys(["Enter"]);
  await app.browser.waitUntil(appShown, { timeout: 10000, timeoutMsg: "not unlocked" });
}

test("locking with the drawing editor open saves the last strokes and the PIN can be typed", async () => {
  const { name } = await app.invoke("drawing_create", { title: "Sperrskizze" });
  await openPage("Skizze vor der Sperre", `![[${name}]]\n`);
  await app.click(`${EMBED} .drawing-embed`);
  await app.waitFor(".drawing-overlay canvas.excalidraw__canvas.interactive", 20000);
  await app.browser.pause(300);
  await rectangle(-160, -90, 120, 80);
  // Locked at once, before the drawing's own save would run.
  await lockAndUnlock();
  assert.equal(await rectangles(name), 1, "the rectangle drawn right before the lock was saved");
  assert.equal((await app.$$(".drawing-overlay")).length, 0, "the drawing editor was closed by the lock");
  assert.deepEqual(await app.consoleErrors(), []);
});

test("locking with the PDF viewer open closes it and the PIN can be typed", async () => {
  const pdf = makePdf(["Seite eins", "Seite zwei"]);
  const stored = await app.browser.executeAsync(
    (b64, done) => {
      const data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      window.__TAURI_INTERNALS__.invoke("attachment_store", data, { headers: { "x-arcalo-name": encodeURIComponent("Sperre.pdf") } }).then(done, (e) => done({ err: String(e) }));
    },
    pdf.toString("base64"),
  );
  assert.ok(!stored.err, stored.err);
  await openPage("PDF vor der Sperre", `${stored.markdown}\n`);
  const card = `${EMBED} .pdf-embed`;
  await app.browser.waitUntil(() => app.browser.execute((s) => document.querySelector(s)?.classList.contains("is-ready"), card), { timeout: 20000, timeoutMsg: "PDF card not ready" });
  await app.click(card);
  await app.waitFor(".pdf-overlay .pdf-page canvas", 20000);
  await lockAndUnlock();
  assert.equal((await app.$$(".pdf-overlay")).length, 0, "the PDF viewer was closed by the lock");
});

test("quitting with the drawing editor open saves the last strokes", async () => {
  const { name } = await app.invoke("drawing_create", { title: "Beendenskizze" });
  await openPage("Skizze vor dem Beenden", `![[${name}]]\n`);
  await app.click(`${EMBED} .drawing-embed`);
  await app.waitFor(".drawing-overlay canvas.excalidraw__canvas.interactive", 20000);
  await app.browser.pause(300);
  await rectangle(-100, -60, 100, 60);
  // „Beenden“ from the tray right after drawing: the app saves the drawing before it goes.
  await app.browser.execute(() => void window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "app://quit-requested", payload: null }).catch(() => {}));
  const file = path.join(dataDir, "attachments", name);
  const saved = () => {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8")).elements.filter((e) => e.type === "rectangle" && !e.isDeleted).length;
    } catch {
      return -1;
    }
  };
  // The window goes away with the app; the file on disk tells what was saved.
  const deadline = Date.now() + 10000;
  while (saved() !== 1 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
  assert.equal(saved(), 1, "the rectangle drawn right before quitting was saved");
  // And the app did quit (not just save later by its own timer).
  await app.browser.waitUntil(async () => (await app.browser.execute(() => 1).catch(() => null)) === null, { timeout: 10000, timeoutMsg: "the app did not quit" });
});
