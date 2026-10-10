// Voice notes (English): recordings a crash left in <data>/voice/ are offered after the start as
// „Unfinished recording“ (save as voice note: FLAC, then the transcript; discard), and a stored
// voice note is transcribed again with a chosen model and language, the new transcript replacing
// the old. No microphone and no Whisper model: the test hooks feed a WAV file and the transcript.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { guarded, launch } from "../lib/harness.js";
import { launchEnglish } from "../lib/english.js";
import { voiceFixtures, writeWav } from "../lib/voice.js";

const test = guarded(nodeTest, () => app);
let app, dataDir, fx;

/** A recording cut off by a crash: 16 kHz mono, the header still says no data. */
function crashedWav(file, seconds) {
  writeWav(file, seconds, 16_000);
  const fd = fs.openSync(file, "r+");
  const zero = Buffer.alloc(4);
  fs.writeSync(fd, zero, 0, 4, 4);
  fs.writeSync(fd, zero, 0, 4, 40);
  fs.closeSync(fd);
}

before(async () => {
  fx = voiceFixtures("[00:00] Good morning, we go through the offer.\n[00:02] Anna sends it on Monday.\n");
  ({ app, dataDir } = await launchEnglish({ env: fx.env }));
  // The app „crashed“ while recording twice: the files stay in the voice folder.
  await app.close();
  const voice = path.join(dataDir, "voice");
  fs.mkdirSync(voice, { recursive: true });
  crashedWav(path.join(voice, "rec-crash1.wav"), 2);
  crashedWav(path.join(voice, "rec-crash2.wav"), 1);
  app = await launch({ dataDir, env: { ARCALO_LOCALE: "en-US", ...fx.env } });
});
after(async () => {
  await app?.close();
  for (const d of [fx?.dir, dataDir]) if (d) fs.rmSync(d, { recursive: true, force: true });
});

const transcriptOf = async (id) => (await app.invoke("page_get", { id })).content;

test("unfinished recordings are offered after the start: save one, discard the other", async () => {
  await app.waitFor('.voice-unfinished[data-file="rec-crash1.wav"]', 15000);
  assert.equal(await app.browser.execute(() => document.querySelectorAll(".voice-unfinished").length), 2);
  assert.match(await app.text('.voice-unfinished[data-file="rec-crash1.wav"]'), /Unfinished recording[\s\S]*00:02/);
  await app.shot("119-voice-unfinished");
  // Discard: asked first, then the file is gone.
  await app.click('.voice-unfinished[data-file="rec-crash2.wav"] .voice-unfinished-discard');
  await app.waitText(".dialog", /Discard the unfinished recording/);
  await app.click(".dialog .btn-danger");
  await app.browser.waitUntil(() => app.browser.execute(() => !document.querySelector('.voice-unfinished[data-file="rec-crash2.wav"]')), { timeout: 8000, timeoutMsg: "still offered" });
  assert.ok(!fs.existsSync(path.join(dataDir, "voice", "rec-crash2.wav")));
  // Save: a voice note with the audio as FLAC and the transcript; the WAV goes.
  await app.click('.voice-unfinished[data-file="rec-crash1.wav"] .voice-unfinished-save');
  await app.waitFor(".voice-bar .voice-done", 20000);
  const id = Number(await app.browser.execute(() => document.querySelector(".voice-bar .voice-done")?.dataset.page));
  const doc = await app.invoke("page_get", { id });
  assert.match(doc.title, /^Voice note \d\d\.\d\d\.\d{4} \d\d:\d\d$/);
  const flac = /!\[\[([^\]]+\.flac)\]\]/.exec(doc.content)?.[1];
  assert.ok(flac, doc.content);
  assert.match(doc.content, /> \[!note\]- Transcript · 00:02[\s\S]*Good morning/);
  assert.ok(!fs.existsSync(path.join(dataDir, "voice", "rec-crash1.wav")), "the WAV is removed once stored");
  assert.equal(await app.browser.execute(() => document.querySelectorAll(".voice-unfinished").length), 0);
  assert.deepEqual(await app.invoke("voice_unfinished"), []);
});

test("transcribe again with another language replaces the transcript", async () => {
  const id = Number(await app.browser.execute(() => document.querySelector(".voice-bar .voice-done")?.dataset.page));
  await app.browser.execute(() => document.querySelectorAll(".voice-bar .voice-done [aria-label='Close']").forEach((b) => b.click()));
  // The voice note is open; its audio has „Transcribe again“.
  await app.waitFor(".pane.active > .pane-content:not([hidden]) .audio-embed .audio-embed-again", 10000);
  fs.writeFileSync(fx.env.ARCALO_TEST_TRANSCRIPT, "[00:00] Second run, better words.\n");
  await app.click(".pane.active > .pane-content:not([hidden]) .audio-embed .audio-embed-again");
  await app.waitText(".dialog", /Transcribe again[\s\S]*replaces the current one/);
  await app.select(".dialog .voice-again-language", "de");
  await app.shot("119-voice-again-dialog");
  await app.click(".dialog .voice-again-start");
  await app.waitText(".toast-title", /New transcript added/, 20000);
  const content = await transcriptOf(id);
  assert.match(content, /Second run, better words/);
  assert.doesNotMatch(content, /Good morning/, "the old transcript is replaced");
  assert.equal((content.match(/\[!note\]- Transcript/g) ?? []).length, 1);
  assert.match(content, /Transcript · 00:02 · German/, "the chosen language");
  // Without the stored audio it says so.
  await assert.rejects(app.invoke("voice_transcribe_again", { pageId: id, audio: "missing.flac", model: "small", language: "auto" }), /no longer stored/);
  assert.deepEqual(await app.consoleErrors(), []);
});
