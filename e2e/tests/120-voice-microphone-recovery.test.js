// Voice notes when things go wrong: a microphone that delivers only silence (no permission) is
// named in the voice bar and stopping says why instead of making a voice note; two starts at once
// open one recording; quitting while recording asks first; a transcription a crash cut off is
// marked „unterbrochen“ at the next start, its WAV stored as the note's FLAC and not offered as an
// unfinished recording (that made a second note). No microphone, no Whisper model.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { guarded, launch } from "../lib/harness.js";
import { writeWav } from "../lib/voice.js";

const test = guarded(nodeTest, () => app);
let app, dir;

/** A 16 kHz mono WAV of `seconds` of digital silence (what a blocked microphone delivers). */
function silentWav(file, seconds) {
  writeWav(file, seconds, 16_000);
  const buf = fs.readFileSync(file);
  buf.fill(0, 44);
  fs.writeFileSync(file, buf);
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "arcalo-voice-silent-"));
  const wav = path.join(dir, "silence.wav");
  silentWav(wav, 2);
  const text = path.join(dir, "transcript.txt");
  fs.writeFileSync(text, "[00:00] Sollte nie erscheinen.\n");
  app = await launch({ env: { ARCALO_TEST_AUDIO_FILE: wav, ARCALO_TEST_TRANSCRIPT: text } });
});
after(async () => {
  await app?.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

const voiceDir = () => path.join(app.dataDir, "voice");
const wavs = () => (fs.existsSync(voiceDir()) ? fs.readdirSync(voiceDir()).filter((f) => f.endsWith(".wav")) : []);

test("two starts at once open one recording; only silence is named and makes no voice note", async () => {
  const results = await app.browser.executeAsync((done) => {
    const start = () => window.__TAURI_INTERNALS__.invoke("voice_start", { pageId: null, meetingKey: null });
    Promise.allSettled([start(), start()]).then((r) => done(r.map((x) => (x.status === "fulfilled" ? "ok" : String(x.reason)))));
  });
  assert.equal(results.filter((r) => r === "ok").length, 1, results.join(" | "));
  assert.match(results.find((r) => r !== "ok"), /läuft bereits eine Aufnahme/);
  assert.ok((await app.invoke("voice_status")).recording);
  await app.waitFor(".voice-bar .voice-rec", 10000);
  // After three seconds of zeros the bar says where the access is switched on.
  await app.waitText(".voice-bar .voice-silent", /Bisher nur Stille: Das Mikrofon liefert nichts\. Prüfe/, 10000);
  await app.shot("120-voice-silent");
  const before = (await app.invoke("voice_status")).recording.page_id;
  assert.equal(before, null);
  await app.click(".voice-stop");
  await app.waitText(".toast", /Aufnahme nicht beendet[\s\S]*völlig still/, 10000);
  assert.equal((await app.invoke("voice_status")).recording, null);
  assert.deepEqual(wavs(), [], "the silent recording is not kept");
  assert.equal((await app.invoke("voice_status")).jobs.length, 0, "no transcription of silence");
  await app.dismissToasts();
});

test("quitting while recording asks first; staying keeps the recording", async () => {
  await app.invoke("voice_start", { pageId: null, meetingKey: null });
  await app.waitFor(".voice-bar .voice-rec", 10000);
  await app.browser.execute(() => void window.__TAURI__.event.emit("app://quit-requested"));
  await app.waitText(".dialog", /Aufnahme läuft[\s\S]*nach dem nächsten Start kannst du sie als Sprachnotiz speichern/, 8000);
  await app.shot("120-voice-quit-question");
  await app.browser.execute(() => [...document.querySelectorAll(".dialog button")].find((b) => b.textContent.trim() === "Abbrechen")?.click());
  await app.browser.waitUntil(async () => (await app.browser.execute(() => !document.querySelector(".dialog"))) === true, { timeout: 5000, timeoutMsg: "dialog still open" });
  assert.ok((await app.invoke("voice_status")).recording, "the recording goes on");
  await app.invoke("voice_discard");
  assert.deepEqual(wavs(), []);
});

test("a transcription cut off by a crash is marked interrupted; its WAV becomes the note's audio", async () => {
  const pending = (token) => `## Sprachnotiz 10:00\n\n![[Sprachnotiz alt ${token}.flac]]\n\n*Transkription läuft … (${token})*\n`;
  const fresh = await app.invoke("page_create", { parentId: null, title: "Abgestürzte Sprachnotiz", icon: null, content: `# Notiz\n\n${pending("abc1")}` });
  const again = await app.invoke("page_create", {
    parentId: null,
    title: "Neu transkribiert beim Absturz",
    icon: null,
    content: "## Sprachnotiz 09:00\n\n![[alt.flac]]\n\n*Transkription läuft … (def2)*\n\nDanach\n",
  });
  // What the crash left: the recording's WAV (a version without job notes) and the job note of
  // a „Neu transkribieren“ with the transcript it replaced.
  fs.mkdirSync(path.join(voiceDir(), "jobs"), { recursive: true });
  writeWav(path.join(voiceDir(), "rec-abc1.wav"), 2, 16_000);
  const previous = "> [!note]- Transkript · 00:02 · Deutsch\n> **00:00** Alter Text\n";
  fs.writeFileSync(path.join(voiceDir(), "jobs", "def2.json"), JSON.stringify({ token: "def2", page_id: again.id, audio: "alt.flac", wav: "", previous }));
  // Asked after every start (as the voice bar does): repairs first, then lists.
  assert.deepEqual(await app.invoke("voice_unfinished"), [], "the WAV belongs to its note: not offered");
  const doc = (await app.invoke("page_get", { id: fresh.id })).content;
  assert.match(doc, /!\[\[Sprachnotiz alt abc1\.flac\]\]\n\n\*Transkription unterbrochen\. „Neu transkribieren“ am Audio startet sie noch einmal\.\*/);
  assert.ok(!doc.includes("läuft"), doc);
  const attachments = path.join(app.dataDir, "attachments");
  assert.ok(fs.statSync(path.join(attachments, "Sprachnotiz alt abc1.flac")).size > 1000, "the WAV is stored as the note's FLAC");
  assert.ok(!fs.existsSync(path.join(voiceDir(), "rec-abc1.wav")), "the WAV is gone");
  assert.equal((await app.invoke("page_get", { id: again.id })).content, `## Sprachnotiz 09:00\n\n![[alt.flac]]\n\n${previous.trimEnd()}\n\nDanach\n`);
  assert.ok(!fs.existsSync(path.join(voiceDir(), "jobs", "def2.json")), "the job note is gone");
  // Nothing left for a second run.
  assert.deepEqual(await app.invoke("voice_unfinished"), []);
  assert.equal((await app.invoke("page_get", { id: fresh.id })).content, doc);
});
