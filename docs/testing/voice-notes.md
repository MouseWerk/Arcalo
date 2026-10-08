# Voice notes: testing with a real microphone and a real model

The e2e tests `e2e/tests/111-voice-notes.test.js` (German) and `112-voice-notes-english.test.js`
(English, dark theme) need neither a microphone nor a Whisper model. Debug builds read three test hooks:

| Variable | Replaces |
|---|---|
| `ARCALO_TEST_AUDIO_FILE` | The microphone: this WAV file (any rate, mono or stereo, 8–32 bit or float) is fed in real time, then silence. |
| `ARCALO_TEST_TRANSCRIPT` | Whisper: lines `[00:12] Text` (inline or as a file path); the progress runs in five steps. |
| `ARCALO_TEST_MODEL_BASES` | The GitHub and Hugging Face addresses, as `<github base>|<huggingface base>`, so a download never leaves the test machine. |

Release builds ignore them. The unit tests in `crates/arcalo-core/src/voice/` cover the model registry and
its checksums, the source order with a local HTTP server, resuming (HTTP range and a file share), the
transcript as Markdown, FLAC encoding and the parsing of action items.

In the Linux test container the audio player shows „Das Audio lässt sich hier nicht abspielen“: WebKitGTK has
no sound output there. Check playback on Windows and macOS.

## Before a release (Windows and macOS)

1. Fresh profile, Einstellungen → Sprachnotizen: the input device list shows the microphones; without one,
   the section says „Kein Mikrofon gefunden“. On macOS the first recording asks for microphone access (the
   text comes from `NSMicrophoneUsageDescription`); with access denied, starting fails with the message.
2. Download Small. Cancel at about 30 %, then „Fortsetzen“: the download continues from there (the
   progress does not start at 0). The model shows „Geladen“; `models/whisper/ggml-small.bin` is in the
   data folder and is neither in `backups/` nor in the Git sync folder.
3. Ribbon → microphone: the voice bar shows „Aufnahme“, the time runs, the level meter follows your voice,
   the tray tooltip says „Aufnahme läuft“ and the tray menu starts with „Aufnahme beenden“. Pause (the time
   stops), resume, speak German for a minute, stop.
4. The page „Sprachnotiz <Datum Uhrzeit>“ below „Sprachnotizen“ opens: player (plays, seeks), the status
   line turns into the collapsed „Transkript · 01:02 · Deutsch“ with timestamps. Meanwhile the editor and
   the rest of the app stay responsive.
5. „Zusammenfassen“ with a cloud provider: summary, decisions and tasks appear; the tasks are in the task
   view with assignee and due date. Repeat in a note tagged `#privat`: only the local provider (Ollama) is
   asked (Einstellungen → Protokoll shows the request).
6. Einstellungen → Sprachnotizen → „Automatisch zusammenfassen“ on, „Audio behalten“ off: the next note gets
   the summary without a click and has no audio file afterwards.
7. Language English, then Large v3 Turbo: an English recording gets „Transcript · … · English“.
8. Kalender → a meeting → „Besprechung aufnehmen“: the transcript goes into the meeting's note.
9. A global shortcut (e.g. Ctrl+Shift+R) with the window minimized: the window comes to the front and
   records; the shortcut again stops it.
10. Windows: „Systemaudio aufnehmen“ on, play a video while speaking: both are in the recording.
11. Company network: the admin source (`https://…` or `\\server\share\whisper`) is used first; with a
    wrong file there the error lists each source with „Prüfsumme stimmt nicht“ and the next source is tried.
    Behind the proxy (Einstellungen → Netzwerk) GitHub and Hugging Face are reached through it.

## Publishing the models (maintainers)

The default source is the release `whisper-models-v1` of `MouseWerk/Arcalo`. Run the workflow
„Whisper models“ (Actions → Whisper models → Run workflow) or, with the GitHub CLI logged in,
`scripts/publish-whisper-models.sh`. Both download the three files from Hugging Face, check them against
the SHA-256 in `crates/arcalo-core/src/voice/models.rs` and upload them as release assets (the release is
created when missing; existing assets are replaced). A new model means a new entry in `MODELS` with its
size and SHA-256 and, for changed files, a new tag (`whisper-models-v2`).
