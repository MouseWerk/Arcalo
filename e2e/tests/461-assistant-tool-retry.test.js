// q124 H4-1: the assistant books time with a tool call (`log_time`), then its answer after the
// tool fails. „Erneut versuchen“ asked the whole question again, so the model booked a second
// time (and the first booking's card was gone). Now a retry, and „Neu generieren“ of an answer
// after tool steps, only ask for the answer after the steps that ran: one booking, the step card
// stays, and the saved chat holds the step once.

import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app, server;
const requests = [];
let failAfterTool = true;

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
    if (last.role === "tool" && failAfterTool) {
      res.writeHead(500, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "upstream exploded" } }));
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    const finish = (reason) => {
      send({ choices: [{ delta: {}, finish_reason: reason }] });
      send({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } });
      res.write("data: [DONE]\n\n");
      res.end();
    };
    // Asked (again) with the question last: the model books.
    if (last.role === "user" && /buche/i.test(last.content)) {
      send({ choices: [{ delta: { tool_calls: [{ index: 0, id: `call_${requests.length}`, type: "function", function: { name: "log_time", arguments: JSON.stringify({ command: "/zeit NP-8801/1010 2h #DEV Assistent-H4" }) } }] } }] });
      return finish("tool_calls");
    }
    send({ choices: [{ delta: { content: last.role === "tool" ? `Gebucht (${requests.length}).` : "Antwort." } }] });
    finish("stop");
  });
  return new Promise((r) => server.listen(port, "127.0.0.1", r));
}

before(async () => {
  await startProvider(4981);
  app = await launch();
  const view = await app.invoke("settings_get");
  const url = "http://127.0.0.1:4981/v1";
  await app.invoke("settings_save", {
    settings: {
      ...view.settings,
      providers: [{ id: "test", name: "Test", kind: "openai", base_url: url, local: true, enabled: true, bypass_proxy: true, api_version: "", models: [] }],
      router: { ...view.settings.router, local_provider: "test", local_model: "test-model", standard_provider: "test", standard_model: "test-model", reasoning_provider: "test", reasoning_model: "test-model" },
    },
  });
  await app.reload();
});
after(async () => {
  await app?.close();
  server?.close();
});

const bookings = async () => (await app.invoke("time_entries", { from: new Date(Date.now() - 2 * 86400000).toISOString(), to: null })).filter((e) => /Assistent-H4/.test(e.description));
const cards = () => app.browser.execute(() => document.querySelectorAll(".assistant .tool-step").length);
const answers = () => app.browser.execute(() => [...document.querySelectorAll(".assistant .msg-ai")].map((e) => e.innerText).join("|"));
const idle = () => app.browser.waitUntil(async () => (await app.$$(".assistant .send-btn.stop")).length === 0, { timeout: 8000, timeoutMsg: "the panel stays busy" });

test("„Erneut versuchen“ after the answer to a booking failed does not book again", async () => {
  await app.waitFor(".assistant .composer textarea");
  const ta = await app.$(".assistant .composer textarea");
  await ta.setValue("Bitte buche 2h");
  await app.keys(["Enter"]);
  await app.waitFor(".assistant .msg-error", 15000);
  await idle();
  assert.equal((await bookings()).length, 1, "the tool call booked once");
  const stepCards = await cards();
  assert.ok(stepCards > 0, "no card of the booking step");

  failAfterTool = false;
  const before = requests.length;
  await app.click(".assistant .msg-error-actions button");
  await app.browser.waitUntil(async () => /Gebucht \(/.test(await answers()), { timeout: 10000, timeoutMsg: "no answer after the retry" });
  await idle();
  assert.equal((await bookings()).length, 1, "the retry booked a second time");
  // One request: the answer after the step, with the step's result; no new tool call.
  assert.equal(requests.length, before + 1);
  const msgs = requests.at(-1).messages;
  assert.equal(msgs.at(-1).role, "tool", "the retry did not continue after the step");
  assert.match(msgs.at(-1).content, /NP-8801/);
  assert.equal(msgs.filter((m) => m.role === "user").length, 1);
  assert.equal(await cards(), stepCards, "the booking step's card went away");
  assert.equal((await app.$$(".assistant .msg-error")).length, 0);
});

test("„Neu generieren“ of the answer after a booking asks for the answer only", async () => {
  const before = requests.length;
  await app.click('.assistant [aria-label="Neu generieren"]');
  await app.browser.waitUntil(async () => requests.length > before && new RegExp(`Gebucht \\(${before + 1}\\)`).test(await answers()), { timeout: 10000, timeoutMsg: "no new answer" });
  await idle();
  assert.equal((await bookings()).length, 1, "regenerating booked again");
  assert.equal(requests.length, before + 1);
  assert.equal(requests.at(-1).messages.at(-1).role, "tool");
  // The saved chat: the question, the step and one answer after it (the failed one and the
  // replaced one are gone); opened again it continues the same way.
  const [conv] = await app.invoke("chat_list", { query: null, archived: null });
  const doc = await app.invoke("chat_get", { id: conv.id });
  const roles = doc.messages.map((m) => `${m.role}${m.error ? ":error" : ""}`);
  assert.deepEqual(roles, ["user", "assistant", "tool", "assistant"], JSON.stringify(roles));
  assert.match(doc.messages.at(-1).content, new RegExp(`Gebucht \\(${before + 1}\\)`));
});
