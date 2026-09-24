// Minimal LiteLLM-compatible server for end-to-end tests.
// Streams chat completions (SSE), supports tool calls, embeddings and model listing,
// and records every request so tests can assert on headers and payloads.

import http from "node:http";

export function startFakeLiteLLM({ port = 4999, apiKey = "sk-test-annalo" } = {}) {
  const requests = [];
  const MODELS = ["firma-schnell", "firma-standard", "firma-reasoning", "firma-embed"];
  // Listed models without a working deployment (LiteLLM's cooldown after provider errors).
  const cooldown = new Set();
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const json = body ? JSON.parse(body) : null;
    requests.push({ method: req.method, url: req.url, headers: req.headers, body: json });

    if (req.headers.authorization !== `Bearer ${apiKey}`) {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "Authentication Error, invalid API key" } }));
    }
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ data: MODELS.map((id) => ({ id, object: "model" })) }));
    }
    if (req.url === "/v1/embeddings") {
      const vec = (t) => Array.from({ length: 8 }, (_, i) => ((t.charCodeAt(i % t.length) || 1) % 7) / 7 + (t.length % (i + 2)) / 10);
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ data: json.input.map((t, index) => ({ index, embedding: vec(t) })) }));
    }
    if (req.url === "/v1/chat/completions" && (!MODELS.includes(json.model) || cooldown.has(json.model))) {
      // What LiteLLM answers for an unknown model group or one whose deployments all cool down.
      res.writeHead(429, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: `No deployments available for selected model, Try again in 60 seconds. Passed model=${json.model}`, type: "None", param: "None", code: "429" } }));
    }
    if (req.url === "/v1/chat/completions") {
      const msgs = json.messages;
      const last = msgs[msgs.length - 1];
      const lastUser = [...msgs].reverse().find((m) => m.role === "user")?.content ?? "";
      res.writeHead(200, { "content-type": "text/event-stream", "x-litellm-response-cost": "0.0012" });
      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      const words = (text) => text.match(/\S+\s*/g) ?? [];
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

      let text;
      let toolCall = null;
      const booking = lastUser.match(/buche\s+([\d.,]+)\s*h\s+auf\s+(\S+)/i);
      // ai_transform (inline AI, meeting summary): "Anweisung: …" + <text>…</text>.
      const transform = msgs.some((m) => m.role === "system" && /Du bearbeitest Texte/.test(m.content ?? ""));
      const instruction = lastUser.match(/Anweisung: ([^\n]*)/)?.[1] ?? "";
      const source = lastUser.match(/<text>\n([\s\S]*)\n<\/text>/)?.[1] ?? "";
      // Smart /zeit (zeitguess): strict JSON with the best-matching candidate reference.
      const zeitguess = msgs.some((m) => m.role === "system" && /Du ordnest Zeitbuchungen/.test(m.content ?? ""));
      if (zeitguess) {
        const activity = (lastUser.match(/Tätigkeit: (.*)$/m)?.[1] ?? "").toLowerCase();
        const words = activity.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 3);
        const lines = lastUser.split("\n").filter((l) => /^- \S+ \| /.test(l));
        let best = lines[0] ?? "";
        let bestScore = -1;
        for (const l of lines) {
          const score = words.filter((w) => l.toLowerCase().includes(w)).length;
          if (score > bestScore) [best, bestScore] = [l, score];
        }
        const reference = best.match(/^- (\S+) \|/)?.[1] ?? "NP-0000";
        const leistungsart = best.match(/Leistungsarten: ([A-Z]+)/)?.[1] ?? null;
        text = JSON.stringify({ reference, leistungsart, confidence: 0.82, reason: `„${activity}“ passt zu den letzten Buchungen auf ${reference}` });
      } else if (transform && /Besprechungsnotiz/.test(instruction)) {
        text = `## Zusammenfassung\n\nIm Jour fixe wurde der Rollout besprochen. Der Termin bleibt.\n\n## Entscheidungen\n\n- Go-Live bleibt am 1. Oktober\n\n## Aufgaben\n\n- [ ] Testplan an [[Architektur]] anpassen @Max 📅 2026-09-30 !!\n\n## Offene Punkte\n\n- Schulungstermin`;
      } else if (transform && /^Kürze/.test(instruction)) {
        text = `**Kurz:** ${source.split(/\s+/).slice(0, 3).join(" ")} [[Architektur]]`;
      } else if (transform) {
        text = `Überarbeitet: ${source}`;
      } else if (last.role === "tool") {
        text = `Erledigt: Die Zeit ist gebucht. Details stehen in der **Zeiterfassung**.`;
      } else if (booking && json.tools?.length) {
        toolCall = { name: "log_time", arguments: JSON.stringify({ command: `/zeit ${booking[2]} ${booking[1].replace(",", ".")}h #DEV Gebucht vom Assistenten` }) };
      } else if (/git status/i.test(lastUser) && json.tools?.length) {
        toolCall = { name: "git", arguments: JSON.stringify({ args: ["status", "--short"], repo: "." }) };
      } else if (/langsam/i.test(lastUser)) {
        text = Array.from({ length: 200 }, (_, i) => `Wort${i}`).join(" ");
      } else {
        const sys = msgs.filter((m) => m.role === "system").map((m) => m.content).join("\n");
        const page = sys.match(/Aktuell geöffnete Seite „([^“]+)“/)?.[1];
        text = `## Zusammenfassung\n\nDu hast gefragt: *${lastUser}*.\n\n- Kontext: ${page ? `[[${page}]]` : "keine Seite"}\n- Siehe auch [[Architektur]]\n\n\`\`\`bash\necho annalo\n\`\`\``;
        // With numbered sources the answer cites the first one.
        if (/nummerierte Quellen/.test(sys)) text += `\n\nDas steht so in deinen Notizen [1].`;
      }

      await sleep(60);
      if (toolCall) {
        send({ choices: [{ delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: toolCall.name, arguments: "" } }] } }] });
        send({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: toolCall.arguments } }] }, finish_reason: "tool_calls" }] });
      } else {
        for (const w of words(text)) {
          send({ choices: [{ delta: { content: w } }] });
          await sleep(/langsam/i.test(lastUser) ? 60 : 8);
          if (res.destroyed) return;
        }
        send({ choices: [{ delta: {}, finish_reason: "stop" }] });
      }
      send({ choices: [], usage: { prompt_tokens: 420, completion_tokens: toolCall ? 12 : words(text).length } });
      res.write("data: [DONE]\n\n");
      return res.end();
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, requests, cooldown, url: `http://127.0.0.1:${port}`, apiKey, close: () => new Promise((r) => server.close(r)) })));
}
