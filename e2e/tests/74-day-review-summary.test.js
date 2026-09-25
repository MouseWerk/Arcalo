// Tagesrückblick summary: written only by a provider marked local (a fake Ollama), never by
// the cloud provider – not even when the local tier points at the cloud. Without a local
// provider the button explains why and leads to the AI settings; the command refuses too.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";
import { startFakeOpenAI } from "../lib/fake-openai.js";
import { iso } from "../lib/calendar-fixtures.js";

const test = guarded(nodeTest, () => app);
let app, ollama, cloud;
const today = iso(new Date());
const provider = (id, name, kind, base_url, local, enabled = true) => ({ id, name, kind, base_url, local, enabled, bypass_proxy: local, api_version: "", models: [] });

async function useProviders(list, router) {
  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", { settings: { ...view.settings, providers: list, router: { ...view.settings.router, ...router } } });
  // The UI takes the saved settings over through its settings event.
  await app.browser.pause(400);
}

before(async () => {
  ollama = await startFakeOpenAI({ port: 4981, kind: "ollama", name: "Ollama", models: ["llama3.2:latest", "nomic-embed-text"] });
  cloud = await startFakeOpenAI({ port: 4982, kind: "openai", name: "Cloud", apiKey: "sk-cloud-e2e", models: ["gpt-4o-mini"] });
  app = await launch();
  await app.invoke("provider_key_set", { id: "cloud", key: cloud.apiKey });
  const page = await app.invoke("page_create", { parentId: null, title: "Vertrauliche Notiz #privat", icon: null, content: "Gehalt besprechen\n" });
  await app.invoke("page_save", { id: page.id, content: "Gehalt besprechen\n\n- [x] Unterlagen sammeln\n" });
});
after(async () => {
  await app?.close();
  await ollama?.close();
  await cloud?.close();
});

const openReview = async () => {
  await app.click(".ribbon .ribbon-review");
  await app.waitFor(".pane.active .rv-view .rv-stats");
};

test("the summary is written by the local model only and goes into the daily note", async () => {
  // The local tier points at the cloud provider: the summary still goes to Ollama.
  await useProviders([provider("cloud", "Cloud", "openai", `${cloud.url}/v1`, false), provider("ollama", "Ollama", "ollama", ollama.url, true)], {
    local_provider: "cloud",
    local_model: "gpt-4o-mini",
    standard_provider: "cloud",
    standard_model: "gpt-4o-mini",
  });
  await openReview();
  await app.click(".rv-summarize");
  await app.waitText(".rv-summary .prose", /Antwort von Ollama \(llama3\.2:latest\)/, 15000);
  await app.waitFor(".rv-summary .rv-copy");
  assert.match(await app.text(".rv-summary .rv-summary-meta"), /lokal · llama3\.2:latest/);
  assert.equal(cloud.chats().length, 0, "nothing went to the cloud provider");
  const req = ollama.chats().at(-1);
  const sent = JSON.stringify(req.body.messages);
  assert.match(sent, /Offen für morgen/);
  assert.match(sent, /Vertrauliche Notiz/, "the private page is part of the local request");
  await app.shot("74-day-review-summary");
  // Into the daily note with the block.
  await app.click(".rv-insert");
  await app.waitText(".toast-title", /Rückblick in die Tagesnotiz übernommen/);
  const r = await app.invoke("day_review", { date: today });
  const note = (await app.invoke("page_get", { id: r.daily_note_id })).content;
  assert.match(note, /\*\*Zusammenfassung\*\*\n\nAntwort von Ollama/);
  assert.equal(note.split("<!-- rückblick -->").length, 2);
  assert.equal(cloud.chats().length, 0);
});

test("a local model that is down is not replaced by the cloud", async () => {
  await ollama.stop();
  await assert.rejects(app.invoke("day_review_summary", { requestId: "rv-down", date: today }), /bleibt lokal/);
  assert.equal(cloud.chats().length, 0);
  await ollama.start();
});

test("without a local provider the button explains why and leads to the settings", async () => {
  await useProviders([provider("cloud", "Cloud", "openai", `${cloud.url}/v1`, false), provider("ollama", "Ollama", "ollama", ollama.url, true, false)], {
    local_provider: "cloud",
    local_model: "gpt-4o-mini",
  });
  const before = ollama.chats().length;
  await assert.rejects(app.invoke("day_review_summary", { requestId: "rv-refused", date: today }), /nur ein lokales Modell/);
  await openReview();
  await app.browser.waitUntil(async () => (await app.browser.execute(() => document.querySelector(".rv-summarize")?.getAttribute("title") ?? "")).includes("Nur mit einem lokalen Modell"), { timeoutMsg: "button does not explain" });
  await app.click(".rv-summarize");
  await app.waitText(".rv-callout", /Nur mit einem lokalen Modell/);
  assert.match(await app.text(".rv-callout"), /nie ein Cloud-Anbieter/);
  await app.shot("74-day-review-no-local");
  assert.equal(cloud.chats().length, 0, "the cloud provider was never asked");
  assert.equal(ollama.chats().length, before, "the switched-off provider neither");
  await app.browser.execute(() => [...document.querySelectorAll(".rv-callout .btn")].find((b) => /KI-Einstellungen/.test(b.textContent))?.click());
  await app.waitText(".pane.active .tab.active", /Einstellungen/);
  assert.deepEqual(await app.consoleErrors(), []);
});
