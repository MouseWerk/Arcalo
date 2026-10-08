// Sprachnotizen (German): recording from the ribbon with the voice bar (level, pause, elapsed
// time, tray entry), the note with audio player and collapsed transcript, the summary with the
// mock AI and its tasks; `/sprache` in a #privat note (the summary stays on the local model);
// „Besprechung aufnehmen“ in the calendar; a model download whose files fail the checksum.
// No microphone and no Whisper model: the test hooks feed a WAV file and the transcript.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { launch, guarded } from "../lib/harness.js";
import { startFakeOpenAI } from "../lib/fake-openai.js";
import { writeMeetingNow } from "../lib/calendar-fixtures.js";
import { isoIn, provider, startModelServer, summaryAnswer, voiceFixtures } from "../lib/voice.js";

const test = guarded(nodeTest, () => app);
let app, fx, cloud, local, models, meeting;

before(async () => {
  fx = voiceFixtures("[00:00] Guten Morgen, wir besprechen das Angebot für Kunde X.\n[00:02] Anna schickt das Angebot bis Montag.\n");
  cloud = await startFakeOpenAI({ port: 4991, kind: "openai", name: "Cloud", apiKey: "sk-voice-e2e", models: ["gpt-4o-mini"], respond: () => summaryAnswer("de") });
  local = await startFakeOpenAI({ port: 4992, kind: "ollama", name: "Ollama", models: ["llama3.2:latest"], respond: () => summaryAnswer("de") });
  models = await startModelServer();
  meeting = writeMeetingNow("Jour fixe Kunde X");
  app = await launch({ env: { ...fx.env, ARCALO_TEST_MODEL_BASES: `${models.url}/gh|${models.url}/hf` } });
  await app.invoke("provider_key_set", { id: "cloud", key: cloud.apiKey });
  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", {
    settings: {
      ...view.settings,
      providers: [provider("cloud", "Cloud", "openai", `${cloud.url}/v1`, false), provider("ollama", "Ollama", "ollama", local.url, true)],
      router: { ...view.settings.router, local_provider: "ollama", local_model: "llama3.2:latest", standard_provider: "cloud", standard_model: "gpt-4o-mini" },
    },
  });
  await app.invoke("calendar_source_add", { name: "Heute", url: null, path: meeting.file });
  await app.invoke("calendar_sync_now", { source: null });
  await app.browser.waitUntil(async () => (await app.invoke("calendar_status")).sources.every((s) => !s.enabled || (s.status?.synced_at && !s.syncing)), { timeout: 20000, timeoutMsg: "not synced" });
  await app.browser.pause(400);
});
after(async () => {
  await app?.close();
  await cloud?.close();
  await local?.close();
  await models?.close();
  for (const d of [fx?.dir, meeting?.dir]) if (d) fs.rmSync(d, { recursive: true, force: true });
});

const recordFor = async (ms) => {
  await app.waitFor(".voice-bar .voice-rec", 10000);
  await app.browser.pause(ms);
};
/** Stops the recording and waits for its finished row; returns the note's page id. */
const stopAndWait = async (timeout = 20000) => {
  const ids = () => app.browser.execute(() => [...document.querySelectorAll(".voice-bar .voice-done")].map((r) => Number(r.dataset.page)));
  const before = await ids();
  await app.click(".voice-stop");
  let id = null;
  await app.browser.waitUntil(async () => (id = (await ids()).find((x) => !before.includes(x)) ?? null) != null, { timeout, timeoutMsg: "no finished voice note" });
  return id;
};

test("ribbon → voice bar → note with audio and transcript → summary with tasks", async () => {
  await app.click(".ribbon-voice");
  await recordFor(300);
  assert.match(await app.text(".voice-rec .voice-state"), /^Aufnahme$/);
  // The elapsed time runs and the meter shows the test tone.
  await app.browser.waitUntil(async () => (await app.text(".voice-rec .voice-time")) >= "00:01", { timeout: 8000, timeoutMsg: "time does not run" });
  await app.browser.waitUntil(() => app.browser.execute(() => document.querySelectorAll(".voice-meter > span.on").length > 0), { timeout: 5000, timeoutMsg: "meter does not move" });
  // Never unnoticed: the tray has „Aufnahme beenden“ first.
  const info = await app.invoke("desktop_info");
  if (info.tray_menu) assert.deepEqual(info.tray_menu.slice(0, 2), ["voice-stop", "-"]);
  assert.match(await app.browser.execute(() => document.querySelector(".ribbon-voice")?.getAttribute("aria-label")), /Aufnahme beenden/);
  await app.click(".voice-pause");
  await app.waitFor(".voice-rec.is-paused");
  assert.match(await app.text(".voice-rec .voice-state"), /Pausiert/);
  await app.shot("111-voice-recording");
  await app.click(".voice-pause");
  await app.browser.waitUntil(() => app.browser.execute(() => !document.querySelector(".voice-rec.is-paused")), { timeoutMsg: "still paused" });
  // Transcribing (progress), then ready; the new page is open.
  const id = await stopAndWait();
  const doc = await app.invoke("page_get", { id });
  assert.match(doc.title, /^Sprachnotiz \d\d\.\d\d\.\d{4} \d\d:\d\d$/);
  assert.match(doc.content, /!\[\[Sprachnotiz \d\d\.\d\d\.\d{4} \d\d-\d\d\.flac\]\]/);
  // Short sentences close together form one paragraph with its start time.
  assert.match(doc.content, /> \[!note\]- Transkript · 00:0\d · Deutsch\n> \*\*00:00\*\* Guten Morgen, wir besprechen das Angebot für Kunde X\. Anna schickt das Angebot bis Montag\.\n/);
  assert.ok(!doc.content.includes("läuft"), "status line replaced");
  // The audio player gets the stored FLAC (a server without sound output shows the hint instead).
  await app.waitFor(".pane.active .audio-embed", 10000);
  await app.browser.waitUntil(() => app.browser.execute(() => !!document.querySelector(".pane.active .audio-embed .file-embed-size")?.textContent), { timeout: 8000, timeoutMsg: "audio file missing" });
  const src = await app.browser.execute(() => document.querySelector(".pane.active .audio-embed audio").getAttribute("src"));
  assert.match(src, /arcalo-asset/);
  assert.match(src, /\.flac$/);
  await app.shot("111-voice-note");

  // Summary with the (mock) AI: summary, decisions, tasks with assignee and due date.
  await app.click(".voice-done .voice-summarize");
  await app.waitText(".toast-title", /Zusammenfassung zur Sprachnotiz hinzugefügt/, 15000);
  assert.match(await app.text(".toast"), /2 Aufgaben angelegt/);
  const after = (await app.invoke("page_get", { id })).content;
  assert.match(after, /### Zusammenfassung\nDas Team hat sich/);
  assert.match(after, /### Entscheidungen\n- Das Budget ist freigegeben/);
  assert.ok(after.includes(`- [ ] Angebot schicken @Anna due:${isoIn(4)}`), after);
  assert.ok(after.includes(`- [ ] Workshop-Raum buchen @Ben due:${isoIn(4)}`), after);
  const tasks = await app.invoke("tasks_list", { filter: { status: "open" } });
  assert.ok(tasks.some((t) => /Workshop-Raum buchen/.test(t.text) && t.due === isoIn(4)), "real task with due date");
  const sent = JSON.stringify([...cloud.chats(), ...local.chats()].at(-1).body.messages);
  assert.match(sent, /Anna schickt das Angebot bis Montag/, "the transcript went to the AI");
  assert.ok(!(await app.browser.execute(() => !!document.querySelector(".voice-bar"))), "the bar is gone");
});

test("/sprache in a #privat note: transcript into the page, summary only from the local model", async () => {
  const page = await app.invoke("page_create", { parentId: null, title: "Personalgespräch", icon: null, content: "Gehalt besprechen #privat\n" });
  await app.invoke("capture_open", { pageId: page.id });
  await app.waitText(".pane.active .page-title, .pane.active h1", /Personalgespräch/, 8000).catch(() => {});
  await app.click(".pane.active .ProseMirror");
  await app.caretToEnd();
  await app.keys(["Enter"]);
  await app.type("/sprache");
  await app.waitFor(".slash-menu, .suggestion-popup", 5000).catch(() => {});
  await app.browser.pause(250);
  await app.keys(["Enter"]);
  await recordFor(1500);
  assert.match(await app.text(".voice-rec .voice-target"), /Personalgespräch/);
  await app.click(".voice-stop");
  await app.waitFor(`.voice-bar .voice-done[data-page="${page.id}"]`, 20000);
  const content = (await app.invoke("page_get", { id: page.id })).content;
  assert.match(content, /^Gehalt besprechen #privat\n/);
  assert.match(content, /## Sprachnotiz \d\d:\d\d\n\n!\[\[Sprachnotiz [^\]]+\.flac\]\]\n\n> \[!note\]- Transkript/);
  assert.ok(!content.includes("/sprache"), "the slash text is gone");

  const cloudBefore = cloud.chats().length;
  const localBefore = local.chats().length;
  await app.click(`.voice-done[data-page="${page.id}"] .voice-summarize`);
  await app.waitText(".toast-title", /Zusammenfassung zur Sprachnotiz hinzugefügt/, 15000);
  assert.equal(cloud.chats().length, cloudBefore, "nothing of a private note went to the cloud");
  assert.equal(local.chats().length, localBefore + 1);
});

test("„Besprechung aufnehmen“ in the calendar links the recording to the meeting note", async () => {
  await app.dismissToasts();
  await app.keys(["Control", "Shift", "e"]);
  await app.waitText(".calv-ev .calv-ev-title", /Jour fixe Kunde X/, 15000);
  await app.browser.execute(() => [...document.querySelectorAll(".calv-ev")].find((b) => /Jour fixe Kunde X/.test(b.textContent))?.click());
  await app.waitFor(".calv-detail .calv-record-btn");
  assert.match(await app.text(".calv-detail .calv-record-btn"), /Besprechung aufnehmen/);
  await app.click(".calv-detail .calv-record-btn");
  await recordFor(1200);
  assert.match(await app.text(".voice-rec .voice-target"), /Jour fixe Kunde X/);
  const id = await stopAndWait();
  const doc = await app.invoke("page_get", { id });
  assert.match(doc.title, /Jour fixe Kunde X/);
  assert.match(doc.content, /## Sprachnotiz \d\d:\d\d\n\n!\[\[/);
  // The calendar knows this note as the meeting's note.
  await app.keys(["Control", "Shift", "e"]);
  await app.waitText(".calv-ev .calv-ev-title", /Jour fixe Kunde X/, 15000);
  await app.browser.execute(() => [...document.querySelectorAll(".calv-ev")].find((b) => /Jour fixe Kunde X/.test(b.textContent))?.click());
  await app.waitText(".calv-detail .calv-detail-actions", /Besprechungsnotiz öffnen/);
});

test("model download: a wrong file is rejected at every source, in order", async () => {
  await app.dismissToasts();
  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", { settings: { ...view.settings, voice: { ...view.settings.voice, model: "base", source_url: `${models.url}/admin` } } });
  await app.browser.pause(300);
  await app.keys(["Control", ","]);
  await app.click('.settings-nav-item[data-section="voice"]');
  await app.waitFor('.voice-model[data-model="base"] .voice-model-download');
  await app.click('.voice-model[data-model="base"] .voice-model-download');
  await app.waitText('.voice-model[data-model="base"] .voice-model-error', /Prüfsumme stimmt nicht/, 20000);
  assert.deepEqual(models.requests, ["/admin/ggml-base.bin", "/gh/ggml-base.bin", "/hf/ggml-base.bin"]);
  const err = await app.text('.voice-model[data-model="base"] .voice-model-error');
  assert.match(err, /admin\/ggml-base\.bin: Prüfsumme stimmt nicht/);
  assert.match(err, /HTTP 404/);
  const st = await app.invoke("voice_models");
  const base = st.models.find((m) => m.id === "base");
  assert.equal(base.installed, false);
  assert.equal(base.partial, 0, "no part of a wrong file is kept");
  await app.shot("111-voice-settings");
});
