// Voice notes in English, dark theme: started from the command palette, the transcript is
// English, the summary adds English sections and real tasks; the settings section has no German
// left and reports a model file with the wrong checksum. Test hooks instead of microphone and model.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { guarded } from "../lib/harness.js";
import { launchEnglish, germanLeftovers } from "../lib/english.js";
import { startFakeOpenAI } from "../lib/fake-openai.js";
import { isoIn, provider, startModelServer, summaryAnswer, voiceFixtures } from "../lib/voice.js";

const test = guarded(nodeTest, () => app);
let app, dataDir, fx, ai, models;

before(async () => {
  fx = voiceFixtures("[00:00] Good morning, let's go through the offer for customer X.\n[00:02] Anna sends the offer by Monday.\n");
  ai = await startFakeOpenAI({ port: 4993, kind: "ollama", name: "Ollama", models: ["llama3.2:latest"], respond: () => summaryAnswer("en") });
  models = await startModelServer();
  ({ app, dataDir } = await launchEnglish({ env: { ...fx.env, ARCALO_TEST_MODEL_BASES: `${models.url}/gh|${models.url}/hf` } }));
  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", {
    settings: {
      ...view.settings,
      theme: "dark",
      providers: [provider("ollama", "Ollama", "ollama", ai.url, true)],
      router: { ...view.settings.router, local_provider: "ollama", local_model: "llama3.2:latest", standard_provider: "ollama", standard_model: "llama3.2:latest", reasoning_provider: "ollama", reasoning_model: "llama3.2:latest" },
      voice: { ...view.settings.voice, language: "en", auto_summary: true },
    },
  });
  await app.browser.pause(400);
});
after(async () => {
  await app?.close();
  await ai?.close();
  await models?.close();
  for (const d of [fx?.dir, dataDir]) if (d) fs.rmSync(d, { recursive: true, force: true });
});

test("palette → recording → English transcript → automatic summary with tasks", async () => {
  await app.keys(["Control", "k"]);
  await app.waitFor(".palette input");
  await app.type("Record voice note");
  await app.browser.pause(250);
  await app.keys(["Enter"]);
  await app.waitFor(".voice-bar .voice-rec", 10000);
  assert.match(await app.text(".voice-rec .voice-state"), /^Recording$/);
  await app.browser.waitUntil(async () => (await app.text(".voice-rec .voice-time")) >= "00:01", { timeout: 8000, timeoutMsg: "time does not run" });
  await app.shot("112-voice-recording-dark");
  const left = await germanLeftovers(app);
  assert.deepEqual(left.filter((l) => /voice|Recording|Pause|Stop|Discard/i.test(l)), []);
  await app.click(".voice-stop");

  // „Summarize automatically“: the summary follows the transcript without a click.
  await app.waitText(".toast-title", /Summary added to the voice note/, 25000);
  assert.match(await app.text(".toast"), /2 tasks created/);
  const flat = (nodes) => nodes.flatMap((n) => [n, ...flat(n.children ?? [])]);
  const pages = flat(await app.invoke("workspace_tree"));
  const note = pages.find((p) => /^Voice note \d\d\.\d\d\.\d{4} \d\d:\d\d$/.test(p.title));
  assert.ok(note, "voice-note page");
  // Voice notes/<year>/<MM – Month> (Folders & filing, 1.9).
  const parent = pages.find((p) => p.id === note.parent_id);
  assert.match(parent?.title ?? "", /^\d\d – [A-Z][a-z]+$/);
  const year = pages.find((p) => p.id === parent.parent_id);
  assert.equal(pages.find((p) => p.id === year?.parent_id)?.title, "Voice notes");
  const content = (await app.invoke("page_get", { id: note.id })).content;
  assert.match(content, /## Voice note \d\d:\d\d\n\n!\[\[Voice note \d\d\.\d\d\.\d{4} \d\d-\d\d\.flac\]\]/);
  assert.match(content, /> \[!note\]- Transcript · 00:0\d · English\n> \*\*00:00\*\* Good morning/);
  assert.match(content, /### Decisions\n- The budget is approved/);
  assert.ok(content.includes(`- [ ] Send the offer @Anna due:${isoIn(4)}`), content);
  assert.ok(content.includes(`- [ ] Book the workshop room @Ben due:${isoIn(4)}`), content);
  const tasks = await app.invoke("tasks_list", { filter: { status: "open" } });
  assert.ok(tasks.some((t) => /Book the workshop room/.test(t.text) && t.due === isoIn(4)));
  await app.waitFor(".pane.active > .pane-content:not([hidden]) .audio-embed", 10000);
  assert.ok(await app.browser.execute(() => !!document.querySelector(".pane.active > .pane-content:not([hidden]) .audio-embed audio[src]")), "audio player");
  await app.shot("112-voice-note-dark");
});

test("settings: English section, wrong model file rejected", async () => {
  await app.dismissToasts();
  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", { settings: { ...view.settings, voice: { ...view.settings.voice, model: "small", source_url: `${models.url}/admin` } } });
  await app.browser.pause(300);
  await app.keys(["Control", ","]);
  await app.click('.settings-nav-item[data-section="voice"]');
  await app.waitFor('.voice-model[data-model="small"] .voice-model-download');
  assert.match(await app.text(".settings-nav-item[data-section=\"voice\"]"), /Voice notes/);
  assert.deepEqual(await germanLeftovers(app, [/^global shortcut not available: /]), []);
  await app.click('.voice-model[data-model="small"] .voice-model-download');
  await app.waitText('.voice-model[data-model="small"] .voice-model-error', /checksum mismatch/, 20000);
  assert.deepEqual(models.requests, ["/admin/ggml-small.bin", "/gh/ggml-small.bin", "/hf/ggml-small.bin"]);
  assert.match(await app.text('.voice-model[data-model="small"] .voice-model-error'), /Model “ggml-small\.bin” not downloaded/);
  assert.equal((await app.invoke("voice_models")).models.find((m) => m.id === "small").installed, false);
  await app.shot("112-voice-settings-dark");
});
