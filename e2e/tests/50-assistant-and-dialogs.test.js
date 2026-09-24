// 1.4 stabilization: the assistant panel never hangs and never mixes chats. „Neuer Chat“ while
// a tool call waits for approval, „Stoppen“ during tool calls, and a reply that arrives after
// „Neuer Chat“ (it must not end up in the new chat's history). A small fake provider answers
// with a tool call (`http_request`, which needs approval) or slowly, depending on the question.
// Also: fast answers appear once, huge answers are shown shortened, the time entry dialog
// books once however fast Enter comes, a damaged drawing is never overwritten, and a paste
// of megabytes of text is offered as an attached file.

import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app, server;
const requests = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startProvider(port) {
  server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const json = body ? JSON.parse(body) : null;
    const path = req.url.replace(/\?.*$/, "");
    if (path === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ object: "list", data: [{ id: "test-model", object: "model" }] }));
    }
    if (path !== "/v1/chat/completions") {
      res.writeHead(404);
      return res.end();
    }
    requests.push(json);
    const msgs = json.messages;
    const last = msgs[msgs.length - 1];
    const lastUser = [...msgs].reverse().find((m) => m.role === "user")?.content ?? "";
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    const finish = (reason) => {
      send({ choices: [{ delta: {}, finish_reason: reason }] });
      send({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } });
      res.write("data: [DONE]\n\n");
      res.end();
    };
    if (/langsam/.test(lastUser) && last.role === "user") await sleep(2500);
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (/werkzeug/i.test(lastUser) && last.role === "user") {
      send({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "http_request", arguments: '{"method":"GET","url":"https://api.example.com/status"}' } }] } }] });
      return finish("tool_calls");
    }
    if (/schnell/.test(lastUser)) {
      // Many small deltas at once: the last batch must not be added after the complete answer.
      for (const w of "Alles in Ordnung.".split(/(?=\s)/)) send({ choices: [{ delta: { content: w } }] });
      return finish("stop");
    }
    if (/sehr lang/.test(lastUser)) {
      const line = "Eine sehr lange Zeile der Antwort mit Text. ";
      for (let i = 0; i < 40; i++) send({ choices: [{ delta: { content: line.repeat(100) } }] });
      return finish("stop");
    }
    const text = last.role === "tool" ? "Fertig nach dem Werkzeug." : /langsam/.test(lastUser) ? "Späte Antwort aus dem alten Chat." : `Antwort: ${lastUser}`;
    send({ choices: [{ delta: { content: text } }] });
    finish("stop");
  });
  return new Promise((r) => server.listen(port, "127.0.0.1", r));
}

before(async () => {
  await startProvider(4979);
  app = await launch();
  const view = await app.invoke("settings_get");
  const url = "http://127.0.0.1:4979/v1";
  await app.invoke("settings_save", {
    settings: {
      ...view.settings,
      providers: [{ id: "test", name: "Test", kind: "openai", base_url: url, local: true, enabled: true, bypass_proxy: true, api_version: "", models: [] }],
      router: { ...view.settings.router, local_provider: "test", local_model: "test-model", standard_provider: "test", standard_model: "test-model", reasoning_provider: "test", reasoning_model: "test-model" },
      ai: { ...view.settings.ai, allowed_tools: [...new Set([...(view.settings.ai.allowed_tools ?? []), "http_request"])] },
    },
  });
  await app.browser.execute(() => location.reload());
  await app.browser.waitUntil(async () => (await app.browser.execute(() => document.body.classList.contains("ready"))) === true, { timeout: 15000 });
  await sleep(500);
});
after(async () => {
  await app?.close();
  server?.close();
});

const composer = () => app.waitFor(".assistant .composer textarea");
const ask = async (text) => {
  const ta = await composer();
  await ta.setValue(text);
  await app.keys(["Enter"]);
};
const newChat = () => app.click('.assistant-head [aria-label="Neuer Chat"]');
const idle = () => app.browser.waitUntil(async () => (await app.$$(".assistant .send-btn.stop")).length === 0, { timeout: 5000, timeoutMsg: "the panel stays busy" });

test("„Neuer Chat“ while a tool call waits for approval: the panel is usable again", async () => {
  await app.waitFor(".assistant");
  await ask("Bitte das Werkzeug nutzen");
  await app.waitFor(".assistant .tool-approval");
  await app.shot("assistant-approval");
  await newChat();
  await idle();
  assert.equal((await app.$$(".assistant .tool-approval")).length, 0);
  await ask("Hallo neu");
  await app.waitText(".assistant .msg-ai", /Antwort: Hallo neu/);
  assert.equal((await app.$$(".assistant .msg-user")).length, 1, "old chat still shown");
  // The new chat's request carries only the new question.
  const roles = requests.at(-1).messages.filter((m) => m.role !== "system").map((m) => `${m.role}:${m.content}`);
  assert.deepEqual(roles, ["user:Hallo neu"]);
});

test("„Stoppen“ during a pending tool call ends the answer", async () => {
  await newChat();
  await ask("Noch einmal das Werkzeug");
  await app.waitFor(".assistant .tool-approval");
  const before = requests.length;
  await app.click(".assistant .send-btn.stop");
  await idle();
  assert.equal((await app.$$(".assistant .tool-approval")).length, 0, "approval still waiting");
  await sleep(500);
  assert.equal(requests.length, before, "the chat went on after stopping");
  // The next question works and the history stays valid (every tool call has its answer).
  await ask("Weiter");
  await app.browser.waitUntil(async () => (await app.browser.execute(() => [...document.querySelectorAll(".assistant .msg-ai")].map((e) => e.textContent).join("|"))).includes("Antwort: Weiter"), {
    timeout: 8000,
    timeoutMsg: "no answer after stopping",
  });
  const msgs = requests.at(-1).messages;
  const calls = msgs.filter((m) => m.tool_calls?.length).flatMap((m) => m.tool_calls.map((c) => c.id));
  for (const id of calls) assert.ok(msgs.some((m) => m.role === "tool" && m.tool_call_id === id), `tool call ${id} without answer`);
});

test("a reply arriving after „Neuer Chat“ stays out of the new chat", async () => {
  await newChat();
  await ask("Antworte langsam");
  await app.browser.waitUntil(async () => (await app.$$(".assistant .send-btn.stop")).length === 1, { timeoutMsg: "not sending" });
  await newChat();
  await idle();
  // Let the slow answer arrive.
  await sleep(3500);
  assert.equal((await app.$$(".assistant .msg-ai, .assistant .msg-user")).length, 0, "the late reply shows up in the new chat");
  await ask("Frische Frage");
  await app.waitText(".assistant .msg-ai", /Antwort: Frische Frage/);
  const roles = requests.at(-1).messages.filter((m) => m.role !== "system").map((m) => m.role);
  assert.deepEqual(roles, ["user"], `old reply in the new history: ${roles.join(",")}`);
  await app.shot("assistant-new-chat");
});

test("time entry dialog: Enter twice in a row books once", async () => {
  const entries = () => app.invoke("time_entries", { from: null, to: null });
  const before = (await entries()).length;
  await app.click('.ribbon [aria-label="Zeiterfassung"]');
  await app.waitText(".view-header h1", /Zeiterfassung/);
  await app.browser.execute(() => [...document.querySelectorAll(".view-header button")].find((b) => b.textContent.trim() === "Eintrag")?.click());
  const desc = await app.waitFor('.dialog input[placeholder="Was wurde gemacht?"]');
  await desc.setValue("Doppelt gedrückt");
  await app.browser.execute(() => {
    const el = document.querySelector('.dialog input[placeholder="Was wurde gemacht?"]');
    for (let i = 0; i < 2; i++) el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
  });
  await app.browser.waitUntil(async () => (await app.$$(".dialog")).length === 0, { timeoutMsg: "dialog stays open" });
  await sleep(800);
  const booked = (await entries()).filter((e) => e.description === "Doppelt gedrückt");
  assert.equal(booked.length, 1, "booked twice");
  assert.equal((await entries()).length, before + 1);
});

const openPage = async (title) => {
  await app.browser.execute(() => location.reload());
  await app.browser.waitUntil(async () => (await app.browser.execute(() => document.body.classList.contains("ready"))) === true, { timeout: 15000 });
  await sleep(500);
  for (const r of await app.$$(".sidebar .tree-row")) if ((await app.textOf(r)) === title) return r.click();
  throw new Error(`no ${title}`);
};

test("a fast answer appears once", async () => {
  await newChat();
  for (let i = 0; i < 3; i++) {
    await ask(`schnell ${i}`);
    await idle();
  }
  await sleep(300);
  const texts = await app.browser.execute(() => [...document.querySelectorAll(".assistant .msg-ai .prose-chat")].map((e) => e.textContent.trim()));
  assert.deepEqual(texts, ["Alles in Ordnung.", "Alles in Ordnung.", "Alles in Ordnung."]);
});

test("a huge answer is shown shortened", async () => {
  await newChat();
  await ask("Bitte sehr lang");
  await idle();
  await app.waitFor(".assistant .msg-cut");
  const shown = await app.browser.execute(() => document.querySelector(".assistant .msg-ai .prose-chat").textContent.length);
  assert.ok(shown <= 100_000 + 10, `${shown} characters shown`);
  assert.match(await app.text(".assistant .msg-cut"), /von 17[56]\.\d{3} Zeichen/);
});

test("a damaged drawing is shown as such and never overwritten", async () => {
  const att = (n) => path.join(app.dataDir, "attachments", n);
  const broken = '{"type":"excalidraw","version":2,"elements":[{"id":"a","type":"rect';
  fs.mkdirSync(path.join(app.dataDir, "attachments"), { recursive: true });
  fs.writeFileSync(att("Kaputt.excalidraw"), broken);
  const p = await app.invoke("page_resolve", { title: "Zeichnungen 1.4", create: true });
  await app.invoke("page_save", { id: p.id, content: "![[Kaputt.excalidraw]]\n" });
  await openPage("Zeichnungen 1.4");
  await app.click(".pane.active .drawing-embed");
  await app.waitText(".drawing-overlay .drawing-broken", /beschädigt/);
  assert.equal((await app.$$(".drawing-overlay canvas.excalidraw__canvas")).length, 0, "an empty canvas was opened over the file");
  await app.shot("drawing-broken");
  await app.keys(["Escape"]);
  await app.browser.waitUntil(async () => (await app.$$(".drawing-overlay")).length === 0, { timeoutMsg: "did not close" });
  assert.equal(fs.readFileSync(att("Kaputt.excalidraw"), "utf8"), broken, "file changed");
  // „Neu beginnen“ keeps a copy first.
  await app.click(".pane.active .drawing-embed");
  await app.waitFor(".drawing-overlay .drawing-broken");
  await app.browser.execute(() => [...document.querySelectorAll(".drawing-broken button")].find((b) => /Neu beginnen/.test(b.textContent)).click());
  await app.waitFor(".drawing-overlay canvas.excalidraw__canvas.interactive", 20000);
  assert.equal(fs.readFileSync(att("Kaputt.excalidraw.bak"), "utf8"), broken);
  await app.click(".drawing-done");
  await app.browser.waitUntil(async () => (await app.$$(".drawing-overlay")).length === 0, { timeoutMsg: "did not close" });
});

test("a drawing in Obsidian's Markdown form opens with its content", async () => {
  const rect = { id: "r1", type: "rectangle", x: 0, y: 0, width: 120, height: 80, angle: 0, strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid", roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: null, seed: 1, version: 1, versionNonce: 1, isDeleted: false, boundElements: null, updated: 1, link: null, locked: false };
  const scene = { type: "excalidraw", version: 2, elements: [rect], appState: {}, files: {} };
  const fence = "```";
  const md = `---\nexcalidraw-plugin: parsed\n---\n# Excalidraw Data\n## Text Elements\n%%\n## Drawing\n${fence}json\n${JSON.stringify(scene)}\n${fence}\n%%\n`;
  fs.mkdirSync(path.join(app.dataDir, "attachments"), { recursive: true });
  fs.writeFileSync(path.join(app.dataDir, "attachments", "Obsidian.excalidraw"), md);
  const p = await app.invoke("page_resolve", { title: "Zeichnungen 1.4", create: true });
  await app.invoke("page_save", { id: p.id, content: "![[Obsidian.excalidraw]]\n" });
  await openPage("Zeichnungen 1.4");
  await app.click(".pane.active .drawing-embed");
  await app.waitFor(".drawing-overlay canvas.excalidraw__canvas.interactive", 20000);
  await sleep(400);
  assert.equal((await app.$$(".drawing-overlay .drawing-broken")).length, 0);
  // Move the loaded rectangle: saved as Excalidraw JSON, the original stays as a copy.
  await app.keys(["Control", "a"]);
  await app.keys(["ArrowRight"]);
  await sleep(300);
  await app.click(".drawing-done");
  await app.browser.waitUntil(async () => (await app.$$(".drawing-overlay")).length === 0, { timeoutMsg: "did not close" });
  const saved = JSON.parse(fs.readFileSync(path.join(app.dataDir, "attachments", "Obsidian.excalidraw"), "utf8"));
  assert.deepEqual(saved.elements.map((e) => e.id), ["r1"], "the drawing's content was not loaded");
  assert.equal(fs.readFileSync(path.join(app.dataDir, "attachments", "Obsidian.excalidraw.bak"), "utf8"), md);
});

test("pasting megabytes of text offers to attach it as a file", async () => {
  const p = await app.invoke("page_resolve", { title: "Großer Text", create: true });
  await app.invoke("page_save", { id: p.id, content: "Vorher\n" });
  await openPage("Großer Text");
  await app.waitFor(".pane.active .ProseMirror");
  await app.caretToEnd();
  await app.browser.execute(() => {
    const pm = document.querySelector(".pane.active .ProseMirror");
    const dt = new DataTransfer();
    dt.setData("text/plain", "Zeile mit Protokolltext 0123456789\n".repeat(40_000));
    let ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    if (!ev.clipboardData) {
      ev = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(ev, "clipboardData", { value: dt });
    }
    pm.dispatchEvent(ev);
  });
  await app.waitText(".dialog", /Sehr großer Text/);
  await app.shot("large-paste");
  await app.browser.execute(() => [...document.querySelectorAll(".dialog button")].find((b) => /Als Datei anhängen/.test(b.textContent)).click());
  await app.waitFor(".pane.active .ProseMirror .file-embed");
  await sleep(1500);
  const c = (await app.invoke("page_get", { id: p.id })).content;
  const name = /!\[\[(Eingefügter Text [^\]]+\.txt)\]\]/.exec(c)?.[1];
  assert.ok(name, c.slice(0, 200));
  assert.equal(fs.statSync(path.join(app.dataDir, "attachments", name)).size, 35 * 40_000);
});
