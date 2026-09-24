// Fake OpenAI-compatible servers for end-to-end tests: an Ollama (native /api/tags,
// /api/version and /api/pull, no auth) or an OpenAI-style API with a bearer key and without a
// cost header (costs then come from Annalo's price table). Both stream chat completions, answer
// tool calls, embed, and record every request. `stop()` closes the port (connection refused),
// `start()` opens it again.

import http from "node:http";

export function startFakeOpenAI({ port, kind = "openai", apiKey = null, models = [], name = kind } = {}) {
  const requests = [];
  const list = [...models];
  let server = null;
  const handler = async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const json = body ? JSON.parse(body) : null;
    requests.push({ method: req.method, url: req.url, headers: req.headers, body: json });
    const reply = (status, obj) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (apiKey && req.headers.authorization !== `Bearer ${apiKey}`) return reply(401, { error: { message: "Incorrect API key provided", code: "invalid_api_key" } });
    const path = req.url.replace(/\?.*$/, "");
    if (kind === "ollama" && path === "/api/version") return reply(200, { version: "0.9.0" });
    if (kind === "ollama" && path === "/api/tags") return reply(200, { models: list.map((m) => ({ name: m, model: m, size: 2_000_000_000 })) });
    if (kind === "ollama" && path === "/api/pull") {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      const steps = [{ status: "pulling manifest" }, { status: "downloading", total: 1000, completed: 250 }, { status: "downloading", total: 1000, completed: 1000 }, { status: "success" }];
      for (const s of steps) {
        res.write(JSON.stringify(s) + "\n");
        await new Promise((r) => setTimeout(r, 120));
      }
      if (!list.includes(json.model)) list.push(json.model);
      return res.end();
    }
    if (path === `/v1/models`) return reply(200, { object: "list", data: list.map((id) => ({ id, object: "model" })) });
    if (path === `/v1/embeddings`) {
      const vec = (t) => Array.from({ length: 8 }, (_, i) => ((t.charCodeAt(i % t.length) || 1) % 5) / 5 + (t.length % (i + 3)) / 10);
      return reply(200, { data: json.input.map((t, index) => ({ index, embedding: vec(t) })) });
    }
    if (path === `/v1/chat/completions`) {
      if (!list.includes(json.model)) {
        return kind === "ollama"
          ? reply(404, { error: `model "${json.model}" not found, try pulling it first` })
          : reply(404, { error: { message: `The model \`${json.model}\` does not exist`, code: "model_not_found" } });
      }
      const msgs = json.messages;
      const lastUser = [...msgs].reverse().find((m) => m.role === "user")?.content ?? "";
      const text = `Antwort von ${name} (${json.model}): ${lastUser.slice(0, 60)}`;
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      const words = text.match(/\S+\s*/g) ?? [];
      for (const w of words) {
        send({ choices: [{ delta: { content: w } }] });
        await new Promise((r) => setTimeout(r, 5));
      }
      send({ choices: [{ delta: {}, finish_reason: "stop" }] });
      send({ choices: [], usage: { prompt_tokens: 1000, completion_tokens: 500 } });
      res.write("data: [DONE]\n\n");
      return res.end();
    }
    reply(404, { error: "not found" });
  };
  const open = () =>
    new Promise((resolve, reject) => {
      server = http.createServer(handler);
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => resolve());
    });
  const close = () =>
    new Promise((r) => {
      if (!server) return r();
      server.closeAllConnections?.();
      server.close(() => r());
      server = null;
    });
  const chats = () => requests.filter((r) => r.url.startsWith("/v1/chat/completions"));
  return open().then(() => ({ requests, chats, models: list, url: `http://127.0.0.1:${port}`, apiKey, stop: close, start: open, close }));
}
