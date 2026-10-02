// Voice notes: the shell's recording and transcription commands, the state the voice bar shows
// (recording, running transcriptions, finished ones waiting for a summary) and the start and
// summary flows used by the ribbon, the palette, `/voice`, the calendar and the global shortcut.

import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { api, on } from "./api";
import { useApp } from "../store/app";
import { t } from "./i18n";
import { meetingSummaryInstruction, cleanAiMarkdown } from "./aitext";
import { usableProvider } from "./providers";
import { withCostLimit, warnCost } from "./aicost";
import { openSettingsSection } from "./calnav";

export interface RecStatus {
  id: string;
  elapsed_ms: number;
  paused: boolean;
  level: number;
  page_id: number | null;
  title: string | null;
  device: string;
  system_audio: boolean;
}

export type JobStage = "waiting" | "audio" | "model" | "transcribe";

export interface VoiceJob {
  id: string;
  page_id: number;
  title: string;
  stage: JobStage;
  progress: number;
  /** The audio file the job reads. */
  file: string;
}

export interface VoiceStatus {
  recording: RecStatus | null;
  jobs: VoiceJob[];
}

export interface VoiceDone {
  id: string;
  page_id: number;
  title: string;
  transcript: string;
  auto_summary: boolean;
  error: string | null;
  cancelled: boolean;
  /** „Neu transkribieren“ of a stored voice note (no summary offered). */
  again: boolean;
}

/** A recording a crash or a forced quit left behind (voice.rs `Unfinished`). */
export interface UnfinishedRecording {
  name: string;
  duration_ms: number;
  /** RFC 3339: when it was last written. */
  modified: string;
}

export interface VoiceModel {
  id: string;
  file: string;
  size: number;
  sha256: string;
  installed: boolean;
  partial: number;
}

export interface ModelDownload {
  id: string;
  received: number;
  total: number;
  source: string;
  done: boolean;
  error: string | null;
}

export interface ModelsView {
  models: VoiceModel[];
  dir: string;
  download: ModelDownload | null;
  /** The selected model is there (or the test hook stands in for Whisper). */
  ready: boolean;
}

export interface VoiceDevices {
  inputs: string[];
  default: string | null;
  system_audio: boolean;
}

const call = <R>(cmd: string, args?: Record<string, unknown>) => invoke<R>(cmd, args);

export const voiceApi = {
  devices: () => call<VoiceDevices>("voice_devices"),
  start: (target: { pageId?: number | null; meetingKey?: string | null } = {}) =>
    call<VoiceStatus>("voice_start", { pageId: target.pageId ?? null, meetingKey: target.meetingKey ?? null }),
  pause: (paused: boolean) => call<VoiceStatus>("voice_pause", { paused }),
  stop: () => call<{ page_id: number; title: string; job_id: string }>("voice_stop"),
  discard: () => call<VoiceStatus>("voice_discard"),
  status: () => call<VoiceStatus>("voice_status"),
  cancelJob: (id: string) => call<void>("voice_job_cancel", { id }),
  applySummary: (pageId: number, summary: string) => call<number>("voice_summary_apply", { pageId, summary }),
  models: () => call<ModelsView>("voice_models"),
  download: (id: string) => call<ModelsView>("voice_model_download", { id }),
  cancelDownload: () => call<void>("voice_model_cancel"),
  importModel: (id: string, path: string) => call<ModelsView>("voice_model_import", { id, path }),
  deleteModel: (id: string) => call<ModelsView>("voice_model_delete", { id }),
  transcribeAgain: (pageId: number, audio: string, model: string, language: string) => call<string>("voice_transcribe_again", { pageId, audio, model, language }),
  unfinished: () => call<UnfinishedRecording[]>("voice_unfinished"),
  saveUnfinished: (name: string) => call<{ page_id: number; title: string; job_id: string }>("voice_unfinished_save", { name }),
  discardUnfinished: (name: string) => call<void>("voice_unfinished_discard", { name }),
};

/** Audio of a voice note that can be transcribed again (stored as FLAC, or a WAV). */
export const isVoiceAudio = (name: string): boolean => /\.(flac|wav)$/i.test(name.trim());

/** The model offered when transcribing again: the one in the settings when it is there, else the
 *  largest one downloaded, else the setting (the command then says it is missing). */
export function againModel(models: Pick<VoiceModel, "id" | "installed" | "size">[], setting: string): string {
  if (models.some((m) => m.id === setting && m.installed)) return setting;
  const best = models.filter((m) => m.installed).sort((a, b) => b.size - a.size)[0];
  return best?.id ?? setting;
}

/** Labels of the models (sizes from the registry). */
export const MODEL_LABELS: Record<string, string> = { base: "Base", small: "Small", "large-v3-turbo-q5": "Large v3 Turbo (q5)" };

/** `65_000` → `01:05`, `3_725_000` → `1:02:05`. */
export function elapsedLabel(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor(s / 60) % 60;
  const sec = s % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${two(m)}:${two(sec)}` : `${two(m)}:${two(sec)}`;
}

/** Number of lit segments of a meter with `segments` for a level 0..1. */
export function meterSegments(level: number, segments: number): number {
  if (!Number.isFinite(level) || level <= 0) return 0;
  return Math.min(segments, Math.max(1, Math.round(level * segments)));
}

/** Percent of a download, 0..100. */
export function downloadPercent(d: Pick<ModelDownload, "received" | "total"> | null): number {
  if (!d || d.total <= 0) return 0;
  return Math.min(100, Math.floor((d.received / d.total) * 100));
}

export function stageLabel(job: Pick<VoiceJob, "stage" | "progress">): string {
  switch (job.stage) {
    case "audio":
      return t("voice.stage.audio");
    case "model":
      return t("voice.stage.model");
    case "transcribe":
      return t("voice.stage.transcribe", { n: job.progress });
    default:
      return t("voice.stage.waiting");
  }
}

// ------------------------------------------------------------ state

interface VoiceState {
  status: VoiceStatus;
  /** Finished transcriptions the bar still offers (open, summarize). */
  results: VoiceDone[];
  /** Pages whose summary is being written. */
  summarizing: number[];
  /** „Neu transkribieren“ asked for (the dialog shows). */
  again: { pageId: number; audio: string } | null;
  /** Recordings left from a crash, offered in the voice bar. */
  unfinished: UnfinishedRecording[];
  set: (p: Partial<Omit<VoiceState, "set">>) => void;
}

export const useVoice = create<VoiceState>((set) => ({
  status: { recording: null, jobs: [] },
  results: [],
  summarizing: [],
  again: null,
  unfinished: [],
  set: (p) => set(p),
}));

const v = useVoice.getState;

/** Subscribes to the shell's voice events (once, from the app). Returns the unsubscribe. */
export function listenVoice(): () => void {
  const subs = [
    on<VoiceStatus>("voice://status", (status) => v().set({ status })),
    on<{ id: string; level: number; elapsed_ms: number; paused: boolean }>("voice://level", (l) => {
      const rec = v().status.recording;
      if (rec && rec.id === l.id) v().set({ status: { ...v().status, recording: { ...rec, level: l.level, elapsed_ms: l.elapsed_ms, paused: l.paused } } });
    }),
    on<{ page_id: number }>("voice://stopped", (s) => {
      // A new voice-note page (or meeting note) joins the tree before it opens.
      const app = useApp.getState();
      void app
        .refreshTree()
        .catch(() => {})
        .then(() => app.openPage(s.page_id));
    }),
    on<VoiceDone>("voice://done", (d) => onDone(d)),
    on("voice://start", () => void startVoice()),
  ];
  voiceApi
    .status()
    .then((status) => v().set({ status }))
    .catch(() => {});
  // After a crash: recordings left in the voice folder are offered.
  void loadUnfinished();
  return () => subs.forEach((p) => p.then((f) => f()));
}

function onDone(d: VoiceDone) {
  const s = useApp.getState();
  if (d.cancelled) {
    s.toast({ tone: "info", title: t("voice.cancelled"), detail: d.title });
    return;
  }
  if (d.error) {
    s.toast({ tone: "warning", title: d.again ? t("voice.again.failed") : t("voice.failed"), detail: d.error, persistent: true });
    return;
  }
  if (d.again) {
    s.toast({ tone: "success", title: t("voice.again.done"), detail: d.title });
    return;
  }
  v().set({ results: [...v().results.filter((r) => r.page_id !== d.page_id), d] });
  if (d.auto_summary && aiReady()) void summarizeVoice(d);
}

// ------------------------------------------------------------ transcribe again, unfinished

/** „Neu transkribieren“ on the voice note with the audio `audio` on `pageId`: the dialog asks for
 *  model and language. */
export function openTranscribeAgain(pageId: number, audio: string) {
  v().set({ again: { pageId, audio } });
}

export async function transcribeAgain(pageId: number, audio: string, model: string, language: string): Promise<boolean> {
  try {
    await voiceApi.transcribeAgain(pageId, audio, model, language);
    return true;
  } catch (e) {
    useApp.getState().error(t("voice.again.failed"), e);
    return false;
  }
}

export async function loadUnfinished() {
  const list = await voiceApi.unfinished().catch(() => [] as UnfinishedRecording[]);
  v().set({ unfinished: list });
}

/** „Als Sprachnotiz speichern“: stored and transcribed like a recording that just stopped. */
export async function saveUnfinished(name: string) {
  try {
    await voiceApi.saveUnfinished(name);
  } catch (e) {
    useApp.getState().error(t("voice.unfinished.saveFailed"), e);
  }
  await loadUnfinished();
}

export async function discardUnfinished(name: string) {
  const ok = await useApp.getState().confirm({ title: t("voice.unfinished.discardAsk"), message: t("voice.unfinished.discardText"), confirmLabel: t("common.discard"), danger: true });
  if (!ok) return;
  try {
    await voiceApi.discardUnfinished(name);
  } catch (e) {
    useApp.getState().error(t("voice.unfinished.discardFailed"), e);
  }
  await loadUnfinished();
}

export function dismissResult(pageId: number) {
  v().set({ results: v().results.filter((r) => r.page_id !== pageId) });
}

/** An AI provider is set up (with its key): the summary is offered. */
export function aiReady(): boolean {
  const view = useApp.getState().settings;
  return !!view && usableProvider(view);
}

// ------------------------------------------------------------ flows

/**
 * Starts a recording: into `pageId`, into the meeting note of `meetingKey`, or into a new voice-note
 * page. Without the Whisper model it offers the download first (the recording may start meanwhile).
 */
export async function startVoice(target: { pageId?: number | null; meetingKey?: string | null } = {}): Promise<boolean> {
  const s = useApp.getState();
  if (v().status.recording) {
    s.toast({ tone: "info", title: t("voice.alreadyRecording") });
    return false;
  }
  try {
    const models = await voiceApi.models();
    const downloading = models.download && !models.download.done;
    if (!models.ready && !downloading) {
      const id = s.settings?.settings.voice?.model ?? "small";
      const model = models.models.find((m) => m.id === id);
      const choice = await s.choose({
        title: t("voice.noModel.title"),
        message: t("voice.noModel.text", { model: MODEL_LABELS[id] ?? id, size: model ? Math.round(model.size / 1_000_000) : "?" }),
        confirmLabel: t("voice.noModel.download"),
        altLabel: t("voice.noModel.settings"),
      });
      if (choice === "alt") {
        openVoiceSettings();
        return false;
      }
      if (choice !== "confirm") return false;
      await voiceApi.download(id);
    }
    const status = await voiceApi.start(target);
    v().set({ status });
    return true;
  } catch (e) {
    s.error(t("voice.startFailed"), e);
    return false;
  }
}

export async function stopVoice() {
  try {
    await voiceApi.stop();
  } catch (e) {
    useApp.getState().error(t("voice.stopFailed"), e);
  }
}

export async function discardVoice() {
  const s = useApp.getState();
  const ok = await s.confirm({ title: t("voice.discard.title"), message: t("voice.discard.text"), confirmLabel: t("voice.discard"), danger: true });
  if (!ok) return;
  v().set({ status: await voiceApi.discard() });
}

export function openVoiceSettings() {
  openSettingsSection("voice");
}

/**
 * Summarizes a transcript with the configured AI (the meeting-summary prompt; a private page stays
 * on the local model) and adds summary, decisions and tasks to the voice note's page.
 */
export async function summarizeVoice(d: Pick<VoiceDone, "page_id" | "title" | "transcript">): Promise<void> {
  const s = useApp.getState();
  if (v().summarizing.includes(d.page_id)) return;
  v().set({ summarizing: [...v().summarizing, d.page_id] });
  try {
    const instruction = meetingSummaryInstruction(s.settings?.settings.ai?.meeting_template);
    const out = await withCostLimit((overrideLimit) =>
      api.transform({ requestId: crypto.randomUUID(), instruction, text: d.transcript, pageId: d.page_id, overrideLimit }),
    );
    warnCost(out.cost_warning);
    const summary = cleanAiMarkdown(out.completion.content);
    if (!summary.trim()) throw new Error(t("voice.summaryEmpty"));
    const n = await voiceApi.applySummary(d.page_id, summary);
    dismissResult(d.page_id);
    s.toast({ tone: "success", title: t("voice.summaryAdded"), detail: t("voice.summaryTasks", { n }), action: { label: t("voice.open"), run: () => s.openPage(d.page_id) } });
  } catch (e) {
    s.error(t("voice.summaryFailed"), e);
  } finally {
    v().set({ summarizing: v().summarizing.filter((id) => id !== d.page_id) });
  }
}
