// Voice notes: recording from the microphone (and on Windows the system audio, WASAPI loopback)
// on a thread of its own, and the local transcription with whisper.cpp in the background.
//
// A recording writes 16 kHz mono WAV under `<data>/voice/` while it runs (level meter, pause,
// elapsed time as events). Stopping adds the voice-note block to its page (a new page „Sprachnotiz
// …“, the meeting note, or the page it was started on) and starts a job: the audio is stored as a
// FLAC attachment, Whisper writes the transcript (progress, cancel), the block gets it. The UI
// then summarizes with the configured AI when wanted (`voice_summary_apply` adds it with tasks).
//
// Privacy: a recording is always visible: the voice bar in the window, the tray tooltip and a tray
// entry „Aufnahme beenden“; the global shortcut brings the window to the front.
//
// Test hooks (debug builds only): `ANNALO_TEST_AUDIO_FILE` feeds a WAV file instead of the
// microphone, `ANNALO_TEST_TRANSCRIPT` stands in for Whisper (text with `[mm:ss]` lines, or a file
// with them), `ANNALO_TEST_MODEL_BASES` replaces the GitHub and Hugging Face addresses
// (`<github>|<huggingface>`).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use annalo_core::calsync::tz::Zone;
use annalo_core::error::{Error, Result};
use annalo_core::voice::{audio, download, models, transcript};
use annalo_core::{tr, trf};
use chrono::Local;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::{AppState, lock};

fn test_var(name: &str) -> Option<String> {
    if !cfg!(debug_assertions) {
        return None;
    }
    std::env::var(name).ok().filter(|v| !v.trim().is_empty())
}

/// Recording, transcription jobs and the model download.
#[derive(Default)]
pub struct Voice {
    rec: Mutex<Option<Recording>>,
    jobs: Mutex<Vec<JobInfo>>,
    job_cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
    download: Mutex<Option<(DownloadStatus, Arc<AtomicBool>)>>,
    /// One Whisper run at a time (they would only slow each other down).
    whisper: Mutex<()>,
}

fn voice(app: &AppHandle) -> &Voice {
    app.state::<Voice>().inner()
}

struct Recording {
    id: String,
    started: chrono::DateTime<Local>,
    /// The page the transcript goes to (`None`: a new voice-note page).
    page_id: Option<i64>,
    title: Option<String>,
    device: String,
    system_audio: bool,
    ctl: Arc<Ctl>,
    thread: Option<JoinHandle<Result<u32>>>,
    wav: PathBuf,
}

#[derive(Default)]
struct Ctl {
    stop: AtomicBool,
    paused: AtomicBool,
    /// Samples written (16 kHz): the elapsed time without pauses.
    samples: AtomicU64,
    /// Level 0..1 as f32 bits.
    level: AtomicU32,
    error: Mutex<Option<String>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RecStatus {
    id: String,
    elapsed_ms: u64,
    paused: bool,
    level: f32,
    page_id: Option<i64>,
    title: Option<String>,
    device: String,
    system_audio: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct JobInfo {
    id: String,
    page_id: i64,
    title: String,
    /// `waiting`, `audio`, `model` (waits for the download), `transcribe`.
    stage: &'static str,
    progress: u8,
    /// The audio file the job reads (a recording's WAV, or the stored FLAC when transcribing
    /// again).
    file: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct DownloadStatus {
    id: String,
    received: u64,
    total: u64,
    source: String,
    done: bool,
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct VoiceStatus {
    recording: Option<RecStatus>,
    jobs: Vec<JobInfo>,
}

#[derive(Debug, Clone, Serialize)]
struct Level {
    id: String,
    level: f32,
    elapsed_ms: u64,
    paused: bool,
}

/// A finished (or failed) transcription.
#[derive(Debug, Clone, Serialize)]
struct Done {
    id: String,
    page_id: i64,
    title: String,
    /// Plain transcript with timestamps (the summary's input); empty on failure.
    transcript: String,
    auto_summary: bool,
    error: Option<String>,
    cancelled: bool,
    /// „Neu transkribieren“ (no summary offered).
    again: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct Stopped {
    page_id: i64,
    title: String,
    job_id: String,
}

fn rec_status(r: &Recording) -> RecStatus {
    RecStatus {
        id: r.id.clone(),
        elapsed_ms: r.ctl.samples.load(Ordering::Relaxed) * 1000 / u64::from(audio::RATE),
        paused: r.ctl.paused.load(Ordering::Relaxed),
        level: f32::from_bits(r.ctl.level.load(Ordering::Relaxed)),
        page_id: r.page_id,
        title: r.title.clone(),
        device: r.device.clone(),
        system_audio: r.system_audio,
    }
}

fn status(app: &AppHandle) -> VoiceStatus {
    let v = voice(app);
    let recording = lock(&v.rec).as_ref().map(rec_status);
    let jobs = lock(&v.jobs).clone();
    VoiceStatus { recording, jobs }
}

fn emit_status(app: &AppHandle) {
    let _ = app.emit("voice://status", status(app));
}

pub fn is_recording(app: &AppHandle) -> bool {
    app.try_state::<Voice>().is_some_and(|v| lock(&v.rec).is_some())
}

/// The tray tooltip while recording.
pub fn tray_tip(app: &AppHandle, tip: String) -> String {
    if is_recording(app) { format!("{} · {tip}", tr!("Aufnahme läuft", "Recording")) } else { tip }
}

fn voice_dir(state: &AppState) -> PathBuf {
    state.data_dir.join("voice")
}

fn models_dir(state: &AppState) -> PathBuf {
    models::dir(&state.data_dir)
}

// ------------------------------------------------------------------ devices

#[derive(Debug, Clone, Serialize)]
pub struct Devices {
    inputs: Vec<String>,
    default: Option<String>,
    /// System audio can be recorded (Windows).
    system_audio: bool,
}

#[tauri::command(async)]
pub fn voice_devices() -> Devices {
    if test_var("ANNALO_TEST_AUDIO_FILE").is_some() {
        let name = tr!("Test-Eingang", "Test input").to_owned();
        return Devices { inputs: vec![name.clone()], default: Some(name), system_audio: cfg!(windows) };
    }
    use cpal::traits::{DeviceTrait, HostTrait};
    let host = cpal::default_host();
    let default = host.default_input_device().and_then(|d| d.name().ok());
    let mut inputs: Vec<String> =
        host.input_devices().map(|it| it.filter_map(|d| d.name().ok()).collect()).unwrap_or_default();
    inputs.dedup();
    Devices { inputs, default, system_audio: cfg!(windows) }
}

fn no_microphone() -> Error {
    Error::State(
        tr!(
            "Kein Mikrofon gefunden. Schließe ein Mikrofon an oder wähle in Einstellungen → Sprachnotizen ein anderes Eingabegerät.",
            "No microphone found. Connect a microphone or choose another input device in Settings → Voice notes."
        )
        .into(),
    )
}

// ------------------------------------------------------------------ recording

type Chunk = (bool, Vec<f32>);

/// Feeds a WAV file in real time (the test hook), then silence.
fn feed_file(path: PathBuf, tx: mpsc::Sender<Chunk>, ctl: Arc<Ctl>) -> Result<()> {
    let samples = audio::read_16k(&path)?;
    std::thread::spawn(move || {
        let chunk = audio::RATE as usize / 10;
        let mut pos = 0;
        while !ctl.stop.load(Ordering::Relaxed) {
            let end = (pos + chunk).min(samples.len());
            let mut part = samples[pos.min(samples.len())..end].to_vec();
            part.resize(chunk, 0.0);
            pos = end;
            if tx.send((true, part)).is_err() {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    });
    Ok(())
}

/// Opens an input stream on `device` that sends 16 kHz mono chunks tagged `mic`.
fn open_stream(device: &cpal::Device, mic: bool, tx: mpsc::Sender<Chunk>, ctl: Arc<Ctl>) -> Result<cpal::Stream> {
    use cpal::traits::DeviceTrait;
    let config = if mic { device.default_input_config() } else { device.default_output_config() }
        .map_err(|e| Error::State(trf!("Audiogerät nicht verfügbar: {e}", "Audio device not available: {e}")))?;
    let channels = usize::from(config.channels());
    let rate = config.sample_rate().0;
    let format = config.sample_format();
    let stream_config: cpal::StreamConfig = config.into();
    let err_ctl = ctl.clone();
    let on_error = move |e: cpal::StreamError| {
        *lock(&err_ctl.error) = Some(e.to_string());
        err_ctl.stop.store(true, Ordering::Relaxed);
    };
    fn build<T>(
        device: &cpal::Device,
        config: &cpal::StreamConfig,
        channels: usize,
        rate: u32,
        mic: bool,
        tx: mpsc::Sender<Chunk>,
        on_error: impl FnMut(cpal::StreamError) + Send + 'static,
    ) -> std::result::Result<cpal::Stream, cpal::BuildStreamError>
    where
        T: cpal::SizedSample,
        f32: cpal::FromSample<T>,
    {
        let mut resampler = audio::Resampler::new(rate);
        device.build_input_stream(
            config,
            move |data: &[T], _: &cpal::InputCallbackInfo| {
                let floats: Vec<f32> = data.iter().map(|s| s.to_sample::<f32>()).collect();
                let mono = audio::downmix(&floats, channels);
                let mut out = Vec::with_capacity(mono.len());
                resampler.process(&mono, &mut out);
                let _ = tx.send((mic, out));
            },
            on_error,
            None,
        )
    }
    let stream = match format {
        cpal::SampleFormat::F32 => build::<f32>(device, &stream_config, channels, rate, mic, tx, on_error),
        cpal::SampleFormat::I16 => build::<i16>(device, &stream_config, channels, rate, mic, tx, on_error),
        cpal::SampleFormat::U16 => build::<u16>(device, &stream_config, channels, rate, mic, tx, on_error),
        cpal::SampleFormat::I32 => build::<i32>(device, &stream_config, channels, rate, mic, tx, on_error),
        other => {
            return Err(Error::State(trf!(
                "Audioformat {other} wird nicht unterstützt",
                "Audio format {other} is not supported"
            )));
        }
    }
    .map_err(|e| Error::State(trf!("Mikrofon lässt sich nicht öffnen: {e}", "Cannot open the microphone: {e}")))?;
    Ok(stream)
}

/// The record thread: opens the inputs, then writes what arrives until stopped. Returns the
/// number of samples; the streams live and die on this thread.
fn record(
    app: AppHandle,
    id: String,
    wav: PathBuf,
    device_name: String,
    system_audio: bool,
    ctl: Arc<Ctl>,
    ready: mpsc::Sender<Result<String>>,
) -> Result<u32> {
    let (tx, rx) = mpsc::channel::<Chunk>();
    let mut streams: Vec<cpal::Stream> = Vec::new();
    let opened: Result<String> = (|| {
        if let Some(file) = test_var("ANNALO_TEST_AUDIO_FILE") {
            feed_file(PathBuf::from(file), tx.clone(), ctl.clone())?;
            return Ok(tr!("Test-Eingang", "Test input").to_owned());
        }
        use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
        let host = cpal::default_host();
        let device = if device_name.is_empty() {
            host.default_input_device()
        } else {
            host.input_devices()
                .ok()
                .and_then(|mut it| it.find(|d| d.name().is_ok_and(|n| n == device_name)))
                .or_else(|| host.default_input_device())
        }
        .ok_or_else(no_microphone)?;
        let name = device.name().unwrap_or_default();
        let mic = open_stream(&device, true, tx.clone(), ctl.clone())?;
        mic.play().map_err(|e| Error::State(trf!("Aufnahme startet nicht: {e}", "Recording does not start: {e}")))?;
        streams.push(mic);
        // Windows: an input stream on the output device records what plays (WASAPI loopback).
        if system_audio && cfg!(windows) {
            match host.default_output_device().map(|out| open_stream(&out, false, tx.clone(), ctl.clone())) {
                Some(Ok(s)) => {
                    let _ = s.play();
                    streams.push(s);
                }
                Some(Err(e)) => crate::devlog::warn("voice", format!("system audio not recorded: {e}")),
                None => {}
            }
        }
        Ok(name)
    })();
    drop(tx);
    let failed = opened.is_err();
    let _ = ready.send(opened);
    if failed {
        return Ok(0);
    }
    let mut writer = audio::WavWriter::create(&wav)?;
    let mut system: std::collections::VecDeque<f32> = std::collections::VecDeque::new();
    let mut last_emit = Instant::now();
    let mut last_sync = Instant::now();
    let mut window: Vec<f32> = Vec::new();
    while !ctl.stop.load(Ordering::Relaxed) {
        match rx.recv_timeout(Duration::from_millis(50)) {
            Ok((true, mut chunk)) => {
                if ctl.paused.load(Ordering::Relaxed) {
                    system.clear();
                    window.clear();
                    ctl.level.store(0f32.to_bits(), Ordering::Relaxed);
                    continue;
                }
                let take = chunk.len().min(system.len());
                let other: Vec<f32> = system.drain(..take).collect();
                audio::mix_into(&mut chunk, &other);
                writer.write(&chunk)?;
                ctl.samples.store(u64::from(writer.samples()), Ordering::Relaxed);
                window.extend_from_slice(&chunk);
            }
            Ok((false, chunk)) => {
                if !ctl.paused.load(Ordering::Relaxed) {
                    system.extend(chunk);
                    // More than 2 s ahead of the microphone: the oldest goes.
                    let max = audio::RATE as usize * 2;
                    if system.len() > max {
                        let extra = system.len() - max;
                        system.drain(..extra);
                    }
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
        if last_emit.elapsed() >= Duration::from_millis(100) {
            last_emit = Instant::now();
            let level = audio::level(&window);
            window.clear();
            ctl.level.store(level.to_bits(), Ordering::Relaxed);
            let _ = app.emit(
                "voice://level",
                Level {
                    id: id.clone(),
                    level,
                    elapsed_ms: ctl.samples.load(Ordering::Relaxed) * 1000 / u64::from(audio::RATE),
                    paused: ctl.paused.load(Ordering::Relaxed),
                },
            );
        }
        if last_sync.elapsed() >= Duration::from_secs(5) {
            last_sync = Instant::now();
            writer.sync()?;
        }
    }
    drop(streams);
    writer.finish()
}

/// Starts a recording: into `page_id`, into the meeting note of `meeting_key`, or into a new
/// voice-note page (none given).
#[tauri::command(async)]
pub fn voice_start(
    app: AppHandle,
    state: State<'_, AppState>,
    page_id: Option<i64>,
    meeting_key: Option<String>,
) -> Result<VoiceStatus> {
    let v = voice(&app);
    if lock(&v.rec).is_some() {
        return Err(Error::State(tr!("Es läuft bereits eine Aufnahme", "A recording is already running").into()));
    }
    let (page_id, title) = match (page_id, meeting_key) {
        (_, Some(key)) => {
            let (page, _) = state.db().calendar_meeting_note(&key, &Zone::Local)?;
            let _ = app.emit("data://pages", [page.id]);
            (Some(page.id), Some(page.title))
        }
        (Some(id), None) => (Some(id), Some(state.db().page_doc(id)?.page.title)),
        (None, None) => (None, None),
    };
    let settings = state.settings().voice;
    let dir = voice_dir(&state);
    std::fs::create_dir_all(&dir).map_err(Error::Io)?;
    let id = format!("{:x}", Local::now().timestamp_millis());
    let wav = dir.join(format!("rec-{id}.wav"));
    let ctl = Arc::new(Ctl::default());
    let (ready_tx, ready_rx) = mpsc::channel();
    let thread = {
        let (app, id, wav, ctl) = (app.clone(), id.clone(), wav.clone(), ctl.clone());
        let (device, system_audio) = (settings.input_device.clone(), settings.system_audio);
        std::thread::Builder::new()
            .name("annalo-voice-record".into())
            .spawn(move || record(app, id, wav, device, system_audio, ctl, ready_tx))
            .map_err(Error::Io)?
    };
    let device = match ready_rx.recv_timeout(Duration::from_secs(10)) {
        Ok(Ok(name)) => name,
        Ok(Err(e)) => {
            let _ = thread.join();
            return Err(e);
        }
        Err(_) => {
            ctl.stop.store(true, Ordering::Relaxed);
            return Err(no_microphone());
        }
    };
    *lock(&v.rec) = Some(Recording {
        id,
        started: Local::now(),
        page_id,
        title,
        device,
        system_audio: settings.system_audio && cfg!(windows),
        ctl,
        thread: Some(thread),
        wav,
    });
    crate::desktop::refresh_tray(&app);
    emit_status(&app);
    Ok(status(&app))
}

#[tauri::command]
pub fn voice_pause(app: AppHandle, paused: bool) -> VoiceStatus {
    if let Some(r) = lock(&voice(&app).rec).as_ref() {
        r.ctl.paused.store(paused, Ordering::Relaxed);
    }
    emit_status(&app);
    status(&app)
}

#[tauri::command]
pub fn voice_status(app: AppHandle) -> VoiceStatus {
    status(&app)
}

/// Ends the recording thread; the WAV file and its samples.
fn end_recording(app: &AppHandle) -> Option<(Recording, Result<u32>)> {
    let mut rec = lock(&voice(app).rec).take()?;
    rec.ctl.stop.store(true, Ordering::Relaxed);
    let result = rec.thread.take().map_or(Ok(0), |t| t.join().unwrap_or_else(|_| Ok(0)));
    crate::desktop::refresh_tray(app);
    Some((rec, result))
}

/// Discards the recording: nothing is written to a page.
#[tauri::command(async)]
pub fn voice_discard(app: AppHandle) -> VoiceStatus {
    if let Some((rec, _)) = end_recording(&app) {
        let _ = std::fs::remove_file(&rec.wav);
    }
    emit_status(&app);
    status(&app)
}

/// A free attachment name for the audio („Sprachnotiz 2026-10-01 14-30.flac“, „… 2.flac“).
fn audio_name(dir: &Path, started: chrono::DateTime<Local>) -> String {
    let base = trf!("Sprachnotiz {}", "Voice note {}", started.format("%Y-%m-%d %H-%M"));
    let mut name = format!("{base}.flac");
    let mut n = 2;
    while dir.join(&name).exists() {
        name = format!("{base} {n}.flac");
        n += 1;
    }
    name
}

/// Stops the recording: the block goes onto its page and the transcription starts.
#[tauri::command(async)]
pub fn voice_stop(app: AppHandle) -> Result<Stopped> {
    stop(&app)
}

pub fn stop(app: &AppHandle) -> Result<Stopped> {
    let Some((rec, result)) = end_recording(app) else {
        return Err(Error::State(tr!("Es läuft keine Aufnahme", "No recording is running").into()));
    };
    let device_error = lock(&rec.ctl.error).take();
    let samples = match result {
        Ok(n) => n,
        Err(e) => {
            emit_status(app);
            return Err(e);
        }
    };
    if samples == 0 {
        let _ = std::fs::remove_file(&rec.wav);
        emit_status(app);
        return Err(Error::State(match device_error {
            Some(e) => trf!("Die Aufnahme ist abgebrochen: {e}", "The recording stopped: {e}"),
            None => tr!("Die Aufnahme ist leer", "The recording is empty").into(),
        }));
    }
    let stopped = store_recording(app, &rec.id, rec.page_id, rec.started, &rec.wav, samples)?;
    let _ = app.emit("voice://stopped", &stopped);
    if let Some(e) = device_error {
        crate::devlog::warn("voice", format!("recording ended by the device: {e}"));
    }
    Ok(stopped)
}

/// A recorded WAV becomes a voice note: the block goes onto its page (`page_id`, or a new
/// voice-note page) and the job stores the audio as FLAC and transcribes it.
fn store_recording(
    app: &AppHandle,
    id: &str,
    page_id: Option<i64>,
    started: chrono::DateTime<Local>,
    wav: &Path,
    samples: u32,
) -> Result<Stopped> {
    let state = app.state::<AppState>();
    let settings = state.settings().voice;
    let name = audio_name(&state.attachments_dir(), started);
    let page = state.db().voice_begin(page_id, started.naive_local(), Some(&name), id)?;
    let _ = app.emit("data://pages", [page.id]);
    spawn_job(
        app,
        JobSpec {
            id: id.to_owned(),
            page_id: page.id,
            title: page.title.clone(),
            wav: wav.to_owned(),
            audio: name,
            samples,
            encode: true,
            again: false,
            previous: String::new(),
            keep_audio: settings.keep_audio,
            auto_summary: settings.auto_summary,
            language: settings.whisper_language(),
            model: models::get(&settings.model),
            cancel: Arc::new(AtomicBool::new(false)),
        },
    )?;
    Ok(Stopped { page_id: page.id, title: page.title, job_id: id.to_owned() })
}

fn spawn_job(app: &AppHandle, spec: JobSpec) -> Result<()> {
    let job = JobInfo {
        id: spec.id.clone(),
        page_id: spec.page_id,
        title: spec.title.clone(),
        stage: "waiting",
        progress: 0,
        file: spec.wav.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
    };
    lock(&voice(app).jobs).push(job);
    lock(&voice(app).job_cancels).insert(spec.id.clone(), spec.cancel.clone());
    let handle = app.clone();
    std::thread::Builder::new()
        .name("annalo-voice-job".into())
        .spawn(move || run_job(&handle, spec))
        .map_err(Error::Io)?;
    emit_status(app);
    Ok(())
}

// ------------------------------------------------------------------ transcribe again

/// „Neu transkribieren“: the stored audio `audio` of a voice note on `page_id` is transcribed
/// again with `model` and `language` (`auto`, `de`, `en`); the new transcript replaces the old.
#[tauri::command(async)]
pub fn voice_transcribe_again(
    app: AppHandle,
    state: State<'_, AppState>,
    page_id: i64,
    audio: String,
    model: String,
    language: String,
) -> Result<String> {
    let info = self::model(&model)?;
    let path = state.attachments_dir().join(&audio);
    if audio.contains(['/', '\\']) || !path.is_file() {
        return Err(Error::State(
            tr!("Die Aufnahme ist nicht mehr gespeichert", "The recording is no longer stored").into(),
        ));
    }
    let installed = std::fs::metadata(models_dir(&state).join(info.file)).is_ok_and(|m| m.len() == info.size);
    if !installed && test_var("ANNALO_TEST_TRANSCRIPT").is_none() {
        return Err(Error::State(trf!(
            "Das Whisper-Modell „{}“ ist nicht geladen (Einstellungen → Sprachnotizen).",
            "The Whisper model “{}” is not downloaded (Settings → Voice notes).",
            info.id
        )));
    }
    let busy = lock(&voice(&app).jobs).iter().any(|j| j.page_id == page_id && j.file == audio);
    if busy {
        return Err(Error::State(
            tr!("Diese Aufnahme wird gerade transkribiert", "This recording is being transcribed right now").into(),
        ));
    }
    let id = format!("{:x}", Local::now().timestamp_millis());
    let (page, previous) = state.db().voice_again(page_id, &audio, &id)?;
    let _ = app.emit("data://pages", [page.id]);
    let language = annalo_core::voice::VoiceSettings { language, ..Default::default() }.whisper_language();
    spawn_job(
        &app,
        JobSpec {
            id: id.clone(),
            page_id,
            title: page.title,
            wav: path,
            audio,
            samples: 0,
            encode: false,
            again: true,
            previous,
            keep_audio: true,
            auto_summary: false,
            language,
            model: info,
            cancel: Arc::new(AtomicBool::new(false)),
        },
    )?;
    Ok(id)
}

// ------------------------------------------------------------------ unfinished recordings

/// WAV files in use: the running recording and those transcription jobs read.
fn busy_files(app: &AppHandle) -> Vec<String> {
    let v = voice(app);
    let mut out: Vec<String> = lock(&v.jobs).iter().map(|j| j.file.clone()).collect();
    if let Some(r) = lock(&v.rec).as_ref()
        && let Some(n) = r.wav.file_name()
    {
        out.push(n.to_string_lossy().into_owned());
    }
    out
}

/// Recordings a crash or a forced quit left in `<data>/voice/` (offered after the start).
#[tauri::command(async)]
pub fn voice_unfinished(app: AppHandle, state: State<'_, AppState>) -> Vec<annalo_core::voice::Unfinished> {
    annalo_core::voice::unfinished(&voice_dir(&state), &busy_files(&app))
}

fn unfinished_path(app: &AppHandle, state: &AppState, name: &str) -> Result<PathBuf> {
    let path = voice_dir(state).join(name);
    if !annalo_core::voice::is_recording_name(name) || !path.is_file() || busy_files(app).iter().any(|b| b == name) {
        return Err(Error::State(tr!("Die Aufnahme gibt es nicht mehr", "The recording is gone").into()));
    }
    Ok(path)
}

/// „Als Sprachnotiz speichern“: an unfinished recording becomes a voice note (FLAC, then the
/// transcript), dated when it was last written.
#[tauri::command(async)]
pub fn voice_unfinished_save(app: AppHandle, state: State<'_, AppState>, name: String) -> Result<Stopped> {
    let path = unfinished_path(&app, &state, &name)?;
    let samples = audio::repair_wav(&path)?;
    let modified = std::fs::metadata(&path).and_then(|m| m.modified()).map(chrono::DateTime::<Local>::from);
    let ended = modified.unwrap_or_else(|_| Local::now());
    let started = ended - chrono::Duration::milliseconds(i64::from(samples) * 1000 / i64::from(audio::RATE));
    let id = format!("{:x}", Local::now().timestamp_millis());
    let stopped = store_recording(&app, &id, None, started, &path, samples)?;
    let _ = app.emit("voice://stopped", &stopped);
    Ok(stopped)
}

/// „Verwerfen“: an unfinished recording is deleted.
#[tauri::command(async)]
pub fn voice_unfinished_discard(app: AppHandle, state: State<'_, AppState>, name: String) -> Result<()> {
    let path = unfinished_path(&app, &state, &name)?;
    std::fs::remove_file(&path).map_err(Error::Io)
}

/// Global shortcut and tray: starts a voice note (the window comes to the front, so the
/// recording is seen) or stops the running one.
pub fn on_shortcut(app: &AppHandle) {
    crate::desktop::show_main(app);
    if is_recording(app) {
        if let Err(e) = stop(app) {
            crate::desktop::notify(app, tr!("Aufnahme", "Recording"), &e.to_string());
        }
        return;
    }
    // The UI starts it: it checks the model first and shows the voice bar.
    let _ = app.emit("voice://start", ());
}

/// The app quits while recording: the WAV file is closed properly (kept under `voice/`).
pub fn shutdown(app: &AppHandle) {
    if app.try_state::<Voice>().is_some() {
        let _ = end_recording(app);
        for c in lock(&voice(app).job_cancels).values() {
            c.store(true, Ordering::Relaxed);
        }
    }
}

// ------------------------------------------------------------------ transcription

struct JobSpec {
    id: String,
    page_id: i64,
    title: String,
    /// What is transcribed: the recording's WAV, or the stored audio when transcribing again.
    wav: PathBuf,
    audio: String,
    /// Samples of the WAV; 0 when not known yet (read from the file).
    samples: u32,
    /// A new recording: stored as FLAC first, the WAV removed after.
    encode: bool,
    /// „Neu transkribieren“ of a stored voice note.
    again: bool,
    /// The transcript it replaces (put back when the new one fails or is cancelled).
    previous: String,
    keep_audio: bool,
    auto_summary: bool,
    language: Option<&'static str>,
    model: &'static models::ModelInfo,
    cancel: Arc<AtomicBool>,
}

fn set_job(app: &AppHandle, id: &str, stage: &'static str, progress: u8) {
    let changed = {
        let mut jobs = lock(&voice(app).jobs);
        match jobs.iter_mut().find(|j| j.id == id) {
            Some(j) if j.stage != stage || j.progress != progress => {
                j.stage = stage;
                j.progress = progress;
                true
            }
            _ => false,
        }
    };
    if changed {
        emit_status(app);
    }
}

fn cancelled_error() -> Error {
    Error::State(tr!("Transkription abgebrochen", "Transcription cancelled").into())
}

fn run_job(app: &AppHandle, job: JobSpec) {
    let result = transcribe_job(app, &job);
    let state = app.state::<AppState>();
    let cancelled = job.cancel.load(Ordering::Relaxed);
    let (markdown, text, error) = match &result {
        Ok(t) => (transcript::to_markdown(t), transcript::plain_text(t), None),
        Err(e) if job.again && !job.previous.trim().is_empty() => {
            (job.previous.trim_end().to_owned(), String::new(), Some(e.to_string()))
        }
        Err(e) => {
            let line = if cancelled {
                format!("*{}*", tr!("Transkription abgebrochen.", "Transcription cancelled."))
            } else {
                format!("*{}: {e}*", tr!("Keine Transkription", "No transcript"))
            };
            (line, String::new(), Some(e.to_string()))
        }
    };
    // Without a transcript the audio is always kept: it is all there is.
    let drop_audio = (result.is_ok() && !job.keep_audio).then_some(job.audio.as_str());
    if let Some(name) = drop_audio {
        let _ = std::fs::remove_file(state.attachments_dir().join(name));
    }
    if let Err(e) = state.db().voice_finish(job.page_id, &job.id, &markdown, drop_audio) {
        crate::devlog::warn("voice", format!("transcript not written: {e}"));
    }
    let audio_stored = state.attachments_dir().join(&job.audio).exists() || drop_audio.is_some();
    if audio_stored && job.encode {
        let _ = std::fs::remove_file(&job.wav);
    }
    let _ = app.emit("data://pages", [job.page_id]);
    lock(&voice(app).jobs).retain(|j| j.id != job.id);
    lock(&voice(app).job_cancels).remove(&job.id);
    emit_status(app);
    let _ = app.emit(
        "voice://done",
        Done {
            id: job.id.clone(),
            page_id: job.page_id,
            title: job.title.clone(),
            transcript: text,
            auto_summary: job.auto_summary && result.is_ok(),
            error: if cancelled { None } else { error },
            cancelled,
            again: job.again,
        },
    );
}

fn transcribe_job(app: &AppHandle, job: &JobSpec) -> Result<transcript::Transcript> {
    let state = app.state::<AppState>();
    set_job(app, &job.id, "audio", 0);
    if job.encode {
        audio::encode_flac(&job.wav, &state.attachments_dir().join(&job.audio))?;
    }
    // Transcribing again: the stored audio is read now (its length is not known before).
    let mut decoded = if job.samples == 0 { Some(audio::read_16k_any(&job.wav)?) } else { None };
    let count = decoded.as_ref().map_or(job.samples as usize, Vec::len);
    let duration_ms = count as i64 * 1000 / i64::from(audio::RATE);
    if let Some(fake) = test_var("ANNALO_TEST_TRANSCRIPT") {
        let text = std::fs::read_to_string(&fake).unwrap_or(fake);
        for p in [10u8, 35, 60, 85, 100] {
            if job.cancel.load(Ordering::Relaxed) {
                return Err(cancelled_error());
            }
            set_job(app, &job.id, "transcribe", p);
            std::thread::sleep(Duration::from_millis(150));
        }
        let language = job.language.unwrap_or(if annalo_core::i18n::is_en() { "en" } else { "de" });
        return Ok(transcript::Transcript {
            segments: transcript::parse_text(&text, duration_ms),
            language: Some(language.into()),
            duration_ms,
        });
    }
    let path = models_dir(&state).join(job.model.file);
    // A download of the model may still run (started when the recording began).
    loop {
        if job.cancel.load(Ordering::Relaxed) {
            return Err(cancelled_error());
        }
        if std::fs::metadata(&path).is_ok_and(|m| m.len() == job.model.size) {
            break;
        }
        let downloading = lock(&voice(app).download).as_ref().is_some_and(|(d, _)| d.id == job.model.id && !d.done);
        if !downloading {
            return Err(Error::State(trf!(
                "Das Whisper-Modell „{}“ ist nicht geladen (Einstellungen → Sprachnotizen). Die Aufnahme bleibt erhalten.",
                "The Whisper model “{}” is not downloaded (Settings → Voice notes). The recording is kept.",
                job.model.id
            )));
        }
        set_job(app, &job.id, "model", 0);
        std::thread::sleep(Duration::from_millis(500));
    }
    set_job(app, &job.id, "waiting", 0);
    let _turn = lock(&voice(app).whisper);
    if job.cancel.load(Ordering::Relaxed) {
        return Err(cancelled_error());
    }
    set_job(app, &job.id, "transcribe", 0);
    let mut samples = match decoded.take() {
        Some(s) => s,
        None => audio::read_16k_any(&job.wav)?,
    };
    // whisper.cpp needs at least a second.
    if samples.len() < audio::RATE as usize * 11 / 10 {
        samples.resize(audio::RATE as usize * 11 / 10, 0.0);
    }
    let (segments, language) = whisper(app, job, &path, &samples)?;
    Ok(transcript::Transcript { segments, language, duration_ms })
}

fn whisper(
    app: &AppHandle,
    job: &JobSpec,
    model: &Path,
    samples: &[f32],
) -> Result<(Vec<transcript::Segment>, Option<String>)> {
    use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};
    static HOOKS: std::sync::Once = std::sync::Once::new();
    // whisper.cpp's own log goes through `log` (not printed) instead of stderr.
    HOOKS.call_once(whisper_rs::install_logging_hooks);
    let failed = |e: whisper_rs::WhisperError| Error::State(trf!("Whisper: {e}", "Whisper: {e}"));
    let ctx = WhisperContext::new_with_params(model, WhisperContextParameters::default()).map_err(failed)?;
    let mut state = ctx.create_state().map_err(failed)?;
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_language(Some(job.language.unwrap_or("auto")));
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).clamp(1, 8);
    params.set_n_threads(threads as i32);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_special(false);
    params.set_print_timestamps(false);
    {
        let (app, id) = (app.clone(), job.id.clone());
        params.set_progress_callback_safe(move |p: i32| set_job(&app, &id, "transcribe", p.clamp(0, 100) as u8));
    }
    {
        let cancel = job.cancel.clone();
        params.set_abort_callback_safe(move || cancel.load(Ordering::Relaxed));
    }
    state
        .full(params, samples)
        .map_err(|e| if job.cancel.load(Ordering::Relaxed) { cancelled_error() } else { failed(e) })?;
    if job.cancel.load(Ordering::Relaxed) {
        return Err(cancelled_error());
    }
    let mut segments = Vec::new();
    for i in 0..state.full_n_segments() {
        let Some(seg) = state.get_segment(i) else { continue };
        let text = seg.to_str_lossy().map(|t| t.into_owned()).unwrap_or_default();
        // Timestamps in 10 ms steps.
        segments.push(transcript::Segment {
            start_ms: seg.start_timestamp() * 10,
            end_ms: seg.end_timestamp() * 10,
            text,
        });
    }
    let language = whisper_rs::get_lang_str(state.full_lang_id_from_state())
        .map(str::to_owned)
        .or(job.language.map(str::to_owned));
    Ok((segments, language))
}

#[tauri::command]
pub fn voice_job_cancel(app: AppHandle, id: String) {
    if let Some(c) = lock(&voice(&app).job_cancels).get(&id) {
        c.store(true, Ordering::Relaxed);
    }
}

/// Adds the summary of a voice note to its page: headings below the voice note, the tasks
/// section as real tasks. Returns the number of tasks.
#[tauri::command(async)]
pub fn voice_summary_apply(app: AppHandle, state: State<'_, AppState>, page_id: i64, summary: String) -> Result<usize> {
    if summary.trim().is_empty() {
        return Err(Error::State(tr!("Die Zusammenfassung ist leer", "The summary is empty").into()));
    }
    let n = state.db().voice_append_summary(page_id, &summary, Local::now().date_naive())?;
    let _ = app.emit("data://tasks", page_id);
    Ok(n)
}

// ------------------------------------------------------------------ models

#[derive(Debug, Clone, Serialize)]
pub struct ModelsView {
    models: Vec<models::ModelStatus>,
    dir: String,
    download: Option<DownloadStatus>,
    /// The selected model is there (or the test hook stands in for Whisper).
    ready: bool,
}

fn models_view(app: &AppHandle) -> ModelsView {
    let state = app.state::<AppState>();
    let dir = models_dir(&state);
    let models = models::status(&dir);
    let selected = models::get(&state.settings().voice.model).id;
    let ready =
        test_var("ANNALO_TEST_TRANSCRIPT").is_some() || models.iter().any(|m| m.info.id == selected && m.installed);
    ModelsView {
        models,
        dir: dir.display().to_string(),
        download: lock(&voice(app).download).as_ref().map(|(d, _)| d.clone()),
        ready,
    }
}

#[tauri::command(async)]
pub fn voice_models(app: AppHandle) -> ModelsView {
    models_view(&app)
}

fn model(id: &str) -> Result<&'static models::ModelInfo> {
    models::find(id).ok_or_else(|| Error::not_found("model", id.to_owned()))
}

/// The default sources (GitHub release, Hugging Face), replaced in tests.
fn default_bases() -> (String, String) {
    match test_var("ANNALO_TEST_MODEL_BASES").as_deref().and_then(|v| v.split_once('|')) {
        Some((gh, hf)) => (gh.to_owned(), hf.to_owned()),
        None => (models::GITHUB_BASE.to_owned(), models::HUGGINGFACE_BASE.to_owned()),
    }
}

fn emit_download(app: &AppHandle, d: &DownloadStatus) {
    let _ = app.emit("voice://model", d);
}

/// Starts downloading model `id` (admin source, GitHub, Hugging Face); progress as `voice://model`.
#[tauri::command]
pub fn voice_model_download(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<ModelsView> {
    let info = model(&id)?;
    let v = voice(&app);
    {
        let mut slot = lock(&v.download);
        if slot.as_ref().is_some_and(|(d, _)| !d.done) {
            return Err(Error::State(
                tr!("Es wird bereits ein Modell geladen", "A model is already downloading").into(),
            ));
        }
        let status = DownloadStatus {
            id: id.clone(),
            received: 0,
            total: info.size,
            source: String::new(),
            done: false,
            error: None,
        };
        *slot = Some((status, Arc::new(AtomicBool::new(false))));
    }
    let cancel = lock(&v.download).as_ref().map(|(_, c)| c.clone()).unwrap_or_default();
    let settings = state.settings();
    let network = annalo_core::network::Prepared::new(
        &settings.network,
        state.proxy_secret.get().as_deref(),
        annalo_core::network::Purpose::Updates,
    )?;
    let client =
        network.apply(reqwest::Client::builder()).read_timeout(Duration::from_secs(60)).build().map_err(Error::Http)?;
    let (gh, hf) = default_bases();
    let sources = models::sources(info, &settings.voice.source_url, &gh, &hf);
    let dir = models_dir(&state);
    let handle = app.clone();
    std::thread::Builder::new()
        .name("annalo-voice-model".into())
        .spawn(move || {
            let app = handle;
            let mut last = Instant::now() - Duration::from_secs(1);
            let result =
                tauri::async_runtime::block_on(download::fetch(&client, &info.into(), &sources, &dir, &cancel, |p| {
                    if last.elapsed() < Duration::from_millis(150) && p.received < p.total {
                        return;
                    }
                    last = Instant::now();
                    let d = {
                        let mut slot = lock(&voice(&app).download);
                        let Some((d, _)) = slot.as_mut() else { return };
                        d.received = p.received;
                        d.source = p.source.clone();
                        d.clone()
                    };
                    emit_download(&app, &d);
                }));
            finish_download(&app, result.map(|_| ()));
        })
        .map_err(Error::Io)?;
    Ok(models_view(&app))
}

fn finish_download(app: &AppHandle, result: Result<()>) {
    let d = {
        let mut slot = lock(&voice(app).download);
        let Some((d, cancel)) = slot.as_mut() else { return };
        d.done = true;
        if let Err(e) = &result {
            d.error =
                Some(if cancel.load(Ordering::Relaxed) { download::cancelled_text().into() } else { e.to_string() });
        } else {
            d.received = d.total;
        }
        d.clone()
    };
    if let Some(e) = &d.error {
        crate::devlog::warn("voice", format!("model download failed: {e}"));
    }
    emit_download(app, &d);
}

#[tauri::command]
pub fn voice_model_cancel(app: AppHandle) {
    if let Some((_, c)) = lock(&voice(&app).download).as_ref() {
        c.store(true, Ordering::Relaxed);
    }
}

/// „Modelldatei wählen …“: copies a model file the user has, if its checksum is right.
#[tauri::command(async)]
pub async fn voice_model_import(app: AppHandle, id: String, path: String) -> Result<ModelsView> {
    let info = model(&id)?;
    let dir = models_dir(&app.state::<AppState>());
    let source = models::Source::File(PathBuf::from(&path));
    let client = reqwest::Client::new();
    download::fetch(&client, &info.into(), &[source], &dir, &AtomicBool::new(false), |_| {}).await.map_err(|e| {
        Error::State(trf!("Die Datei ist nicht das Modell „{}“: {e}", "The file is not the model “{}”: {e}", info.id))
    })?;
    Ok(models_view(&app))
}

#[tauri::command(async)]
pub fn voice_model_delete(app: AppHandle, id: String) -> Result<ModelsView> {
    let info = model(&id)?;
    let dir = models_dir(&app.state::<AppState>());
    let path = dir.join(info.file);
    for p in [download::part_path(&path), path] {
        match std::fs::remove_file(&p) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(Error::Io(e)),
        }
    }
    Ok(models_view(&app))
}
