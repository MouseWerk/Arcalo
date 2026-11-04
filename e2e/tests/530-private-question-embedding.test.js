// q124 R2D-3: the assistant embeds the question for its search before it knows what the answer
// is about. With a #privat page open (or earlier turns of the conversation carrying a marker)
// the answer stayed on the local model, but the question itself went to an embedding model of a
// provider that is not local. Now the open page and the earlier turns count for the question's
// embedding as well; a question about a page that is not private is still embedded there.

import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";
import { startFakeOpenAI } from "../lib/fake-openai.js";

const test = guarded(nodeTest, () => app);
let app, local, cloud, secret, open;
const provider = (id, name, base_url, isLocal) => ({ id, name, kind: "openai", base_url, local: isLocal, enabled: true, bypass_proxy: true, api_version: "", models: [] });

before(async () => {
  local = await startFakeOpenAI({ port: 4991, kind: "openai", name: "Lokal", models: ["lokal-modell"] });
  cloud = await startFakeOpenAI({ port: 4992, kind: "openai", name: "Cloud", apiKey: "sk-cloud-r2d", models: ["cloud-modell", "text-embedding-cloud"] });
  app = await launch();
  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", {
    settings: {
      ...view.settings,
      providers: [provider("lokal", "Lokal", `${local.url}/v1`, true), provider("cloud", "Cloud", `${cloud.url}/v1`, false)],
      router: { ...view.settings.router, local_provider: "lokal", local_model: "lokal-modell", standard_provider: "cloud", standard_model: "cloud-modell", reasoning_provider: "cloud", reasoning_model: "cloud-modell" },
      embedding_provider: "cloud",
      embedding_model: "text-embedding-cloud",
      auto_route: false,
      privacy: { ...view.settings.privacy, read_open_page: true, local_only: false },
    },
  });
  await app.invoke("provider_key_set", { id: "cloud", key: cloud.apiKey });
  secret = await app.invoke("page_create", { parentId: null, title: "Gehalt", icon: null, content: "---\ntags: [privat]\n---\nVerhandlung mit Zander: 92.000" });
  open = await app.invoke("page_create", { parentId: null, title: "Angebot", icon: null, content: "Angebot für Kunde Brandt" });
});
after(async () => {
  await app?.close();
  await local?.close();
  await cloud?.close();
});

const ask = (messages, pageId) =>
  app.invoke("ai_chat", { requestId: `r-${Date.now()}`, messages, useTools: false, tier: null, pageId, overrideLimit: null, conversationId: null, notes: true });

test("a question with a private page open is not sent to a cloud embedding model", async () => {
  const res = await ask([{ role: "user", content: "Was wurde mit Zander vereinbart?" }], secret.id);
  assert.equal(res.route.provider, "lokal", JSON.stringify(res.route));
  assert.ok(!cloud.embedded().some((t) => /Zander/.test(t)), JSON.stringify(cloud.embedded()));
  assert.doesNotMatch(cloud.chats().map((r) => JSON.stringify(r.body)).join("\n"), /Zander/);

  // The same question about a page that is not private is embedded there (the search works).
  await ask([{ role: "user", content: "Was steht im Angebot für Brandt?" }], open.id);
  assert.ok(cloud.embedded().some((t) => /Brandt/.test(t)), JSON.stringify(cloud.embedded()));
});

test("a follow-up in a conversation whose earlier turns carry a marker is not embedded in the cloud", async () => {
  const messages = [
    { role: "user", content: "Notiz #privat: Arzttermin Zander" },
    { role: "assistant", content: "Notiert." },
    { role: "user", content: "Und wann war der Termin mit Zander?" },
  ];
  const res = await ask(messages, null);
  assert.equal(res.route.provider, "lokal", JSON.stringify(res.route));
  assert.ok(!cloud.embedded().some((t) => /Zander/.test(t)), JSON.stringify(cloud.embedded()));
});
