// q124 H4-3: a booking typed on a #privat page (a `/zeit` line keeps its page) is text of that
// page. The assistant sent its description to the cloud model: as a source of the answer, in the
// result of `search_workspace` and of `time_summary` (the weekly status e-mail asks for it). Now
// each of them counts the booking's page, so the conversation stays on the local model.

import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";
import { startFakeOpenAI } from "../lib/fake-openai.js";

const test = guarded(nodeTest, () => app);
let app, local, cloud;
const provider = (id, name, kind, base_url, isLocal) => ({ id, name, kind, base_url, local: isLocal, enabled: true, bypass_proxy: true, api_version: "", models: [] });
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

before(async () => {
  local = await startFakeOpenAI({ port: 4983, kind: "openai", name: "Lokal", models: ["lokal-modell"] });
  cloud = await startFakeOpenAI({ port: 4984, kind: "openai", name: "Cloud", apiKey: "sk-cloud-h4", models: ["cloud-modell"] });
  app = await launch();
  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", {
    settings: {
      ...view.settings,
      providers: [provider("lokal", "Lokal", "openai", `${local.url}/v1`, true), provider("cloud", "Cloud", "openai", `${cloud.url}/v1`, false)],
      router: { ...view.settings.router, local_provider: "lokal", local_model: "lokal-modell", standard_provider: "cloud", standard_model: "cloud-modell", reasoning_provider: "cloud", reasoning_model: "cloud-modell" },
      auto_route: false,
    },
  });
  await app.invoke("provider_key_set", { id: "cloud", key: cloud.apiKey });
  // The page says nothing of the booking any more (its line was edited away); the booking keeps its page.
  const page = await app.invoke("page_create", { parentId: null, title: "Arzt", icon: null, content: "#privat\n\nTermine" });
  await app.invoke("log_time", { line: "/zeit NP-8801/1010 1h Psychotherapie Sitzung Zander", pageId: page.id });
  await app.invoke("log_time", { line: "/zeit NP-8801/1010 1h Schnittstellen Abstimmung", pageId: null });
});
after(async () => {
  await app?.close();
  await local?.close();
  await cloud?.close();
});

const sent = (server) => server.chats().map((r) => JSON.stringify(r.body.messages)).join("\n");
const ask = (content) =>
  app.invoke("ai_chat", { requestId: `r-${Date.now()}`, messages: [{ role: "user", content }], useTools: false, tier: null, pageId: null, overrideLimit: null, conversationId: null, notes: true });

test("a booking of a private page among the sources keeps the answer on the local model", async () => {
  const res = await ask("Sitzung Zander");
  assert.ok(res.context.some((c) => /Sitzung Zander/.test(c.text) && c.time_entry_id != null), JSON.stringify(res.context));
  assert.equal(res.route.provider, "lokal", JSON.stringify(res.route));
  assert.ok(res.private);
  assert.doesNotMatch(sent(cloud), /Zander/);
  // A booking of no private page still goes to the cloud model.
  const open = await ask("Schnittstellen Abstimmung");
  assert.equal(open.route.provider, "cloud", JSON.stringify(open.route));
});

test("search_workspace, time_summary and activity_log mark the booking's text as confidential", async () => {
  const tool = (name, args) => app.invoke("ai_run_workspace_tool", { name, arguments: JSON.stringify(args) });
  const search = await tool("search_workspace", { query: "Zander" });
  assert.match(search, /Sitzung Zander/);
  assert.match(search, /Enthält vertrauliche Inhalte: #privat/);
  const summary = await tool("time_summary", { from: today(), to: today() });
  assert.match(summary, /Sitzung Zander/);
  assert.match(summary, /Enthält vertrauliche Inhalte: #privat/);
  const activity = await tool("activity_log", { from: today() });
  assert.match(activity, /Enthält vertrauliche Inhalte: #privat/);
  // Without the private booking in it, nothing is marked.
  assert.doesNotMatch(await tool("search_workspace", { query: "Schnittstellen Abstimmung" }), /vertrauliche/);
});
