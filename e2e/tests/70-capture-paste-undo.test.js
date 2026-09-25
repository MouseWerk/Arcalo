// Quick capture content and safety: a pasted image and a dropped file become attachments embedded
// in the text, a pasted address becomes a Markdown link with the page's title, the clipboard is
// offered as „Zwischenablage einfügen“, Ctrl+Z takes the last capture back (and a new page to the
// trash), and a capture the database cannot take waits in a queue and is stored later.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { launch, guarded } from "../lib/harness.js";
import { captureVisible, dailyContent, findPage, openCapture } from "../lib/capture.js";

const test = guarded(nodeTest, () => app);
let app;
let server;
before(async () => {
  // The first capture fails as if the database were locked (test builds only).
  app = await launch({ env: { ANNALO_TEST_CAPTURE_BUSY: "1" } });
  server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end("<html><head><title>Release-Plan [Q4] | Wiki</title></head><body></body></html>");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  await app.browser.pause(1800);
});
after(async () => {
  await app?.close();
  server?.close();
});

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGM4YWMDRAwQCgAlPgUBdJmUYAAAAABJRU5ErkJggg==";
const value = () => app.browser.execute(() => document.querySelector(".capture-input")?.value ?? null);
const hidden = () => app.browser.waitUntil(async () => (await captureVisible(app)) === false, { timeout: 6000, timeoutMsg: "window not hidden" });

test("a capture the database cannot take waits in the queue and is stored later", async () => {
  const w = await openCapture(app);
  await app.type("Wartet kurz auf die Datenbank");
  await app.keys(["Enter"]);
  await app.waitText(".capture-foot.done .capture-hint", /Wartet auf die Datenbank/);
  assert.equal(await value(), "", "the text is safe in the queue");
  const queue = path.join(app.dataDir, "capture-queue.json");
  assert.ok(fs.existsSync(queue), "queue file written");
  assert.equal(JSON.parse(fs.readFileSync(queue, "utf8"))[0].text, "Wartet kurz auf die Datenbank");
  await hidden();
  await w.toMain();
  await app.waitText(".toast", /Schnellerfassung wartet/);
  // Retried a few seconds later: stored, reported, queue gone.
  await app.browser.waitUntil(async () => (await dailyContent(app)).includes("- Wartet kurz auf die Datenbank\n"), { timeout: 15000, timeoutMsg: "queued capture not stored" });
  await app.waitText(".toast", /nachträglich gespeichert/);
  await app.shot("70-capture-queue-toast");
  assert.ok(!fs.existsSync(queue), "queue emptied");
  await app.dismissToasts();
});

test("a pasted image is stored as attachment and embedded", async () => {
  await openCapture(app);
  await app.type("Skizze vom Whiteboard");
  const handled = await app.browser.execute((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes, new Uint8Array([7])], "image.png", { type: "image/png" }));
    const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    document.querySelector(".capture-input").dispatchEvent(ev);
    return ev.defaultPrevented;
  }, PNG);
  assert.ok(handled, "paste handled");
  await app.browser.waitUntil(async () => /^Skizze vom Whiteboard\n!\[\[[^\]]+\.png\]\]$/.test(await value()), { timeoutMsg: "image not embedded" });
  await app.waitText(".capture-pill", /1 Anhang/);
  await app.shot("70-capture-image");
  const name = (await value()).match(/!\[\[([^\]]+)\]\]/)[1];
  assert.ok((await app.invoke("attachment_size", { name })) > 0, "stored in the attachments folder");
  await app.keys(["Enter"]);
  await app.browser.waitUntil(async () => (await dailyContent(app)).includes(`- Skizze vom Whiteboard\n\n![[${name}]]\n`), { timeoutMsg: "embed not in the daily note" });
  await hidden();
});

test("a dropped file is stored and embedded; a pasted address becomes a titled link", async () => {
  await openCapture(app);
  await app.browser.execute(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(["Protokoll"], "Protokoll Kickoff.txt", { type: "text/plain" }));
    document.querySelector(".capture").dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await app.browser.waitUntil(async () => /^!\[\[Protokoll Kickoff[^\]]*\.txt\]\]$/.test(await value()), { timeoutMsg: "dropped file not embedded" });
  const url = `http://127.0.0.1:${server.address().port}/plan`;
  await app.keys(["End"]);
  await app.keys(["Shift", "Enter"]);
  await app.browser.execute((u) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", u);
    document.querySelector(".capture-input").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, url);
  // The title as the page names it, brackets escaped for Markdown.
  await app.browser.waitUntil(async () => (await value()).endsWith(`](${url})`), { timeout: 8000, timeoutMsg: "no titled link" });
  const link = (await value()).split("\n").pop();
  assert.match(link, /^\[Release-Plan \\\[Q4\\\]/);
  await app.shot("70-capture-link");
  await app.keys(["Enter"]);
  await app.browser.waitUntil(async () => (await dailyContent(app)).includes(`- ${link}\n`), { timeoutMsg: "link not stored" });
  await hidden();
});

test("Ctrl+Z takes the last capture back and puts the text back into the field", async () => {
  await openCapture(app);
  await app.type("Versehentlich erfasst");
  await app.keys(["Enter"]);
  await app.waitText(".capture-foot.done .capture-hint", /Gespeichert in/);
  assert.ok((await dailyContent(app)).includes("- Versehentlich erfasst\n"));
  await app.keys(["Control", "z"]);
  await app.waitText(".capture-hint", /Rückgängig gemacht: Versehentlich erfasst/);
  assert.equal(await value(), "Versehentlich erfasst");
  assert.ok(!(await dailyContent(app)).includes("Versehentlich erfasst"), "removed from the daily note");
  await app.shot("70-capture-undo");

  // A capture that created its page: undo moves the page to the trash.
  await app.browser.execute(() => {
    const el = document.querySelector(".capture-input");
    el.select();
  });
  await app.keys(["Backspace"]);
  await app.type(">Neue Seite: Wegwerfseite");
  await app.keys(["Enter"]);
  await app.type("Nur ein Test");
  await app.keys(["Enter"]);
  await app.waitText(".capture-foot.done .capture-link", /Wegwerfseite/);
  assert.ok(await findPage(app, "Wegwerfseite"));
  await app.click(".capture-undo");
  await app.waitText(".capture-hint", /Rückgängig gemacht/);
  await app.browser.waitUntil(async () => (await findPage(app, "Wegwerfseite")) === null, { timeoutMsg: "page not trashed" });
  assert.ok((await app.invoke("trash_list")).some((t) => t.title === "Wegwerfseite"), "in the trash");
  // Nothing more to undo: Ctrl+Z on an empty field reports it, the text stays.
  await app.browser.execute(() => {
    const el = document.querySelector(".capture-input");
    el.select();
  });
  await app.keys(["Backspace"]);
  const undone = await app.invoke("capture_undo").catch((e) => String(e));
  assert.match(undone, /Nur die letzte Erfassung/);
  assert.deepEqual(await app.consoleErrors(), []);
  await app.keys(["Escape"]);
  await hidden();
});

test("the clipboard is offered at open and inserted with one shortcut", async () => {
  const w = await openCapture(app);
  // Simulate what the shell reads at open time (no clipboard owner under Xvfb).
  await w.toMain();
  await app.browser.execute(() => window.__TAURI_INTERNALS__.invoke("plugin:event|emit_to", { target: { kind: "WebviewWindow", label: "capture" }, event: "capture://shown", payload: { selection: false, clipboard: "Zitat aus der Mail" } }));
  await w.toCapture();
  await app.waitText(".capture-chip.clip", /Zwischenablage einfügen/);
  await app.shot("70-capture-clipboard");
  await app.keys(["Control", "Shift", "v"]);
  await app.browser.waitUntil(async () => (await value()) === "Zitat aus der Mail", { timeoutMsg: "clipboard not inserted" });
  assert.equal(await app.browser.execute(() => !!document.querySelector(".capture-chip.clip")), false);
  // „Auswahl übernehmen“ puts the text in directly.
  await w.toMain();
  await app.browser.execute(() => window.__TAURI_INTERNALS__.invoke("plugin:event|emit_to", { target: { kind: "WebviewWindow", label: "capture" }, event: "capture://shown", payload: { selection: true, clipboard: "Markierter Satz" } }));
  await w.toCapture();
  await app.browser.waitUntil(async () => (await value()) === "Zitat aus der Mail\nMarkierter Satz", { timeoutMsg: "selection not taken over" });
  await app.browser.execute(() => {
    const el = document.querySelector(".capture-input");
    el.select();
  });
  await app.keys(["Backspace"]);
  await app.keys(["Escape"]);
});

test("„Gespeichert in …“ opens the page in the main window", async () => {
  await hidden();
  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", { settings: { ...view.settings, capture: { ...view.settings.capture, auto_hide_ms: 8000 } } });
  const w = await openCapture(app);
  await app.type(">Neue Seite: Kundenideen");
  await app.keys(["Enter"]);
  await app.type("Workshop anbieten");
  await app.keys(["Enter"]);
  await app.waitText(".capture-foot.done .capture-link", /Kundenideen/);
  // Clicked from a script after the command returned: the window hides during the click, which
  // WebDriver's own click would wait for forever.
  await app.browser.execute(() => setTimeout(() => document.querySelector(".capture-foot.done .capture-link").click(), 50));
  await w.toMain();
  await app.browser.waitUntil(async () => (await captureVisible(app)) === false, { timeoutMsg: "capture window not hidden" });
  await app.browser.waitUntil(async () => (await (await app.$(".pane.active .page-title")).getValue()) === "Kundenideen", { timeoutMsg: "page not opened" });
  await app.waitText(".pane.active .ProseMirror", /Workshop anbieten/);
});
