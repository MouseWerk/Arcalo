// Audio embedded in a note plays in the app: the player loads the file's metadata (duration,
// seekable), on Linux too, where WebKitGTK hands media to GStreamer, which refuses the app's
// arcalo-asset: scheme. A file that truly cannot be decoded still shows the hint.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
before(async () => {
  app = await launch();
});
after(async () => app?.close());

const PANE = ".pane.active > .pane-content:not([hidden])";
const pageId = async (title) => (await app.invoke("page_resolve", { title, create: false })).id;

/** One second of a 440 Hz tone: 16-bit mono PCM at 8 kHz in a WAV container. */
function makeWav(seconds = 1, rate = 8000) {
  const n = seconds * rate;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000), 44 + i * 2);
  return buf;
}

/** `attachment_store` with the raw bytes as body and the file name as header, like the drop handler. */
async function store(name, bytes) {
  const r = await app.browser.executeAsync(
    (n, b64, done) => {
      const data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      window.__TAURI_INTERNALS__
        .invoke("attachment_store", data, { headers: { "x-arcalo-name": encodeURIComponent(n) } })
        .then((ok) => done({ ok }), (err) => done({ err: String(err) }));
    },
    name,
    Buffer.from(bytes).toString("base64"),
  );
  if (r.err) throw new Error(r.err);
  return r.ok;
}

/** The state of the player of the embed of `name`. */
const player = (name) =>
  app.browser.execute(
    (sel, n) => {
      const embed = document.querySelector(`${sel} .audio-embed[data-file="${n}"]`);
      const audio = embed?.querySelector("audio");
      if (!audio) return null;
      // NaN and Infinity do not cross WebDriver.
      const num = (x) => (Number.isFinite(x) ? x : -1);
      return {
        src: audio.getAttribute("src") ?? "",
        readyState: audio.readyState,
        duration: num(audio.duration),
        seekable: audio.seekable.length ? num(audio.seekable.end(0)) : 0,
        // Not `error`: WebKitWebDriver takes an object with that key for a failure of its own.
        mediaError: audio.error?.code ?? null,
        unplayable: embed.classList.contains("is-unplayable"),
        hint: getComputedStyle(embed.querySelector(".audio-embed-hint")).display !== "none",
      };
    },
    PANE,
    name,
  );

test("an embedded WAV loads its metadata in the player, no hint", async () => {
  const wav = await store("Ton Prüfung.wav", makeWav());
  assert.equal(wav.name, "Ton Prüfung.wav");
  await store("Kaputt.wav", Buffer.from("RIFF this is not audio at all"));
  await app.keys(["Control", "n"]);
  await app.browser.waitUntil(() => app.browser.execute(() => document.activeElement?.classList.contains("page-title") && document.activeElement.selectionEnd > 0));
  await app.type("Tonprobe");
  await app.keys(["Enter"]);
  await app.browser.waitUntil(async () => (await app.invoke("page_resolve", { title: "Tonprobe", create: false })) !== null);
  await app.invoke("page_save", { id: await pageId("Tonprobe"), content: "Aufnahme:\n\n![[Ton Prüfung.wav]]\n\nDefekt:\n\n![[Kaputt.wav]]\n" });
  await app.browser.execute(() => window.dispatchEvent(new CustomEvent("arcalo:reload-pages", { detail: {} })));
  await app.waitFor(`${PANE} .audio-embed[data-file="Ton Prüfung.wav"] audio`, 10000);

  let state = null;
  await app.browser
    .waitUntil(async () => (state = await player("Ton Prüfung.wav")) && ((state.readyState >= 1 && state.duration > 0) || state.unplayable), { timeout: 15000 })
    .catch(() => {});
  assert.ok(state, "player missing");
  assert.equal(state.unplayable, false, `unplayable: ${JSON.stringify(state)}`);
  assert.equal(state.hint, false, "hint shown");
  assert.ok(state.readyState >= 1, `no metadata: ${JSON.stringify(state)}`);
  assert.ok(Math.abs(state.duration - 1) < 0.05, `duration ${JSON.stringify(state)}`);
  assert.ok(state.seekable > 0.9, `not seekable: ${JSON.stringify(state)}`);

  // Seeking works (voice notes jump to a transcript time).
  const seeked = await app.browser.executeAsync(
    (sel, done) => {
      const audio = document.querySelector(`${sel} .audio-embed[data-file="Ton Prüfung.wav"] audio`);
      audio.addEventListener("seeked", () => done(audio.currentTime), { once: true });
      audio.currentTime = 0.5;
      setTimeout(() => done(null), 5000);
    },
    PANE,
  );
  assert.ok(seeked != null && Math.abs(seeked - 0.5) < 0.05, `seek: ${seeked}`);
  await app.shot("406-audio-embed");

  // A file that cannot be decoded keeps the hint instead of a broken player.
  let broken = null;
  await app.browser.waitUntil(async () => (broken = await player("Kaputt.wav"))?.unplayable, { timeout: 15000 }).catch(() => {});
  assert.ok(broken?.unplayable, `broken file shows no hint: ${JSON.stringify(broken)}`);
  assert.equal((await player("Kaputt.wav")).hint, true);
});
