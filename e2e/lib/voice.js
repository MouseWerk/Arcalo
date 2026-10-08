// Voice notes without a microphone or a Whisper model (tests 111–112): a WAV file the app records
// instead of the microphone (ARCALO_TEST_AUDIO_FILE), a transcript standing in for Whisper
// (ARCALO_TEST_TRANSCRIPT), a model server that delivers a wrong file, and the AI's summary.

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

/** A 16-bit mono WAV of `seconds` with a quiet tone (the level meter moves). */
export function writeWav(file, seconds = 3, rate = 48_000) {
  const n = Math.round(seconds * rate);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin((i * 440 * 2 * Math.PI) / rate) * 9000), i * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, data]));
}

/** A folder with the WAV and the transcript; the environment for the app. */
export function voiceFixtures(transcript) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arcalo-voice-"));
  const wav = path.join(dir, "input.wav");
  writeWav(wav);
  const text = path.join(dir, "transcript.txt");
  fs.writeFileSync(text, transcript);
  return { dir, env: { ARCALO_TEST_AUDIO_FILE: wav, ARCALO_TEST_TRANSCRIPT: text } };
}

/**
 * A model server: `/admin/<file>` and `/gh/<file>` answer with bytes that are not the model (the
 * checksum must reject them), everything else 404. Every request path is recorded.
 */
export async function startModelServer() {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    if (req.url.startsWith("/admin/") || req.url.startsWith("/gh/")) {
      const body = Buffer.alloc(64 * 1024, 7);
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": body.length });
      return res.end(body);
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, requests, close: () => new Promise((r) => server.close(r)) };
}

const pad = (n) => String(n).padStart(2, "0");
/** `YYYY-MM-DD` `days` from today. */
export const isoIn = (days) => {
  const d = new Date(Date.now() + days * 86400e3);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** The AI's summary of a meeting in German or English: one task in the requested format, one free-form. */
export function summaryAnswer(lang) {
  const due = isoIn(4);
  return lang === "en"
    ? `## Summary\nThe team agreed on the offer for customer X.\n\n## Decisions\n- The budget is approved\n\n## Tasks\n- [ ] Send the offer @Anna due:${due}\n- Ben: Book the workshop room by ${due}\n\n## Open points\n- Pricing of the support plan\n`
    : `## Zusammenfassung\nDas Team hat sich auf das Angebot für Kunde X geeinigt.\n\n## Entscheidungen\n- Das Budget ist freigegeben\n\n## Aufgaben\n- [ ] Angebot schicken @Anna due:${due}\n- Ben: Workshop-Raum buchen bis ${due}\n\n## Offene Punkte\n- Preis des Supportvertrags\n`;
}

/** A provider for `settings.providers`. */
export const provider = (id, name, kind, base_url, local) => ({ id, name, kind, base_url, local, enabled: true, bypass_proxy: local, api_version: "", models: [] });
