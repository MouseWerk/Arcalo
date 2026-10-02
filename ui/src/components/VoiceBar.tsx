// The voice bar: always on screen while a voice note is recorded (red dot, elapsed time, level
// meter, pause, stop, discard), then while it is transcribed (progress, cancel), then with the
// finished note (open, summarize with the AI). After a crash it offers the recordings left in the
// voice folder („unfertige Aufnahme“), and it hosts the „Neu transkribieren“ dialog.

import { useEffect, useState } from "react";
import { AlertTriangle, AudioLines, Check, FileText, Loader2, Mic, Pause, Play, Save, Sparkles, Square, Trash2, X } from "lucide-react";
import { Button, Dialog, Field, IconButton } from "./ui";
import { Select } from "./Select";
import { useApp } from "../store/app";
import { useT } from "../lib/i18n";
import { dateTime } from "../lib/format";
import {
  MODEL_LABELS,
  againModel,
  aiReady,
  discardUnfinished,
  discardVoice,
  dismissResult,
  elapsedLabel,
  listenVoice,
  meterSegments,
  saveUnfinished,
  stageLabel,
  stopVoice,
  summarizeVoice,
  transcribeAgain,
  useVoice,
  voiceApi,
  type ModelsView,
} from "../lib/voice";

const SEGMENTS = 14;

export function VoiceBar() {
  const t = useT();
  useEffect(() => listenVoice(), []);
  const status = useVoice((s) => s.status);
  const results = useVoice((s) => s.results);
  const summarizing = useVoice((s) => s.summarizing);
  const unfinished = useVoice((s) => s.unfinished);
  const again = useVoice((s) => s.again);
  // Re-render when the AI settings change (the summary button).
  useApp((s) => s.settings);
  const rec = status.recording;
  const dialog = again && <TranscribeAgainDialog pageId={again.pageId} audio={again.audio} onClose={() => useVoice.getState().set({ again: null })} />;
  if (!rec && !status.jobs.length && !results.length && !unfinished.length) return dialog || null;
  const lit = rec && !rec.paused ? meterSegments(rec.level, SEGMENTS) : 0;
  const ai = aiReady();

  return (
    <>
      {dialog}
      <div className="voice-bar" role="region" aria-label={t("voice.bar")}>
        {unfinished.map((u) => (
          <div key={u.name} className="voice-row voice-unfinished" data-file={u.name}>
            <AlertTriangle size={14} className="voice-icon warn" aria-hidden />
            <span className="voice-label">
              <span className="voice-state">{t("voice.unfinished.title")}</span>
              <span className="voice-target faint">{t("voice.unfinished.detail", { at: dateTime(u.modified), len: elapsedLabel(u.duration_ms) })}</span>
            </span>
            <span className="voice-actions">
              <IconButton icon={Trash2} label={t("voice.unfinished.discard")} className="voice-unfinished-discard" onClick={() => void discardUnfinished(u.name)} />
              <Button variant="primary" size="sm" icon={Save} className="voice-unfinished-save" onClick={() => void saveUnfinished(u.name)}>
                {t("voice.unfinished.save")}
              </Button>
            </span>
          </div>
        ))}
        {rec && (
          <div className={`voice-row voice-rec ${rec.paused ? "is-paused" : ""}`} role="status" aria-live="polite">
            <span className="voice-dot" aria-hidden />
            <span className="voice-label">
              <span className="voice-state">{rec.paused ? t("voice.paused") : t("voice.recording")}</span>
              {rec.title && <span className="voice-target faint">{rec.title}</span>}
            </span>
            <span className="voice-time num" aria-label={t("voice.elapsed")}>
              {elapsedLabel(rec.elapsed_ms)}
            </span>
            <span className="voice-meter" role="meter" aria-label={t("voice.level")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((rec.paused ? 0 : rec.level) * 100)}>
              {Array.from({ length: SEGMENTS }, (_, i) => (
                <span key={i} className={i < lit ? (i >= SEGMENTS - 2 ? "on hot" : "on") : ""} />
              ))}
            </span>
            <span className="voice-actions">
              <IconButton
                icon={rec.paused ? Play : Pause}
                label={rec.paused ? t("voice.resume") : t("voice.pause")}
                className="voice-pause"
                onClick={() => void voiceApi.pause(!rec.paused).then((st) => useVoice.getState().set({ status: st }))}
              />
              <IconButton icon={Trash2} label={t("voice.discard")} className="voice-discard" onClick={() => void discardVoice()} />
              <Button variant="danger" size="sm" icon={Square} className="voice-stop" onClick={() => void stopVoice()}>
                {t("voice.stop")}
              </Button>
            </span>
          </div>
        )}
        {status.jobs.map((job) => (
          <div key={job.id} className="voice-row voice-job" data-page={job.page_id}>
            <Loader2 size={14} className="spin voice-icon" aria-hidden />
            <span className="voice-label">
              <span className="voice-state">{stageLabel(job)}</span>
              <span className="voice-target faint">{job.title}</span>
            </span>
            <span className="voice-progress" role="progressbar" aria-label={t("voice.progress")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={job.progress}>
              <span style={{ width: `${job.stage === "transcribe" ? job.progress : 0}%` }} />
            </span>
            <span className="voice-actions">
              <Button variant="ghost" size="sm" className="voice-job-cancel" onClick={() => void voiceApi.cancelJob(job.id)}>
                {t("common.cancel")}
              </Button>
            </span>
          </div>
        ))}
        {results.map((r) => {
          const busy = summarizing.includes(r.page_id);
          return (
            <div key={r.id} className="voice-row voice-done" data-page={r.page_id}>
              <Check size={14} className="voice-icon ok" aria-hidden />
              <span className="voice-label">
                <span className="voice-state">{busy ? t("voice.summarizing") : t("voice.ready")}</span>
                <span className="voice-target faint">{r.title}</span>
              </span>
              <span className="voice-actions">
                <Button variant="ghost" size="sm" icon={FileText} className="voice-open" onClick={() => useApp.getState().openPage(r.page_id)}>
                  {t("voice.open")}
                </Button>
                {ai && (
                  <Button variant="primary" size="sm" icon={Sparkles} loading={busy} className="voice-summarize" onClick={() => void summarizeVoice(r)}>
                    {t("voice.summarize")}
                  </Button>
                )}
                <IconButton icon={X} label={t("common.close")} size="sm" onClick={() => dismissResult(r.page_id)} />
              </span>
            </div>
          );
        })}
      </div>
    </>
  );
}

/** „Neu transkribieren“: model and language for another run over the stored audio; the new
 *  transcript replaces the old one when it is done. */
function TranscribeAgainDialog({ pageId, audio, onClose }: { pageId: number; audio: string; onClose: () => void }) {
  const t = useT();
  const voice = useApp((s) => s.settings?.settings.voice);
  const [models, setModels] = useState<ModelsView | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [language, setLanguage] = useState(voice?.language ?? "auto");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    voiceApi.models().then(setModels, () => {});
  }, []);
  const list = models?.models ?? [];
  const chosen = model ?? againModel(list, voice?.model ?? "small");
  const installed = list.find((m) => m.id === chosen)?.installed ?? false;
  const submit = async () => {
    setBusy(true);
    const ok = await transcribeAgain(pageId, audio, chosen, language);
    setBusy(false);
    if (ok) onClose();
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={t("voice.again.title")}
      description={t("voice.again.desc", { name: audio })}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" icon={AudioLines} onClick={submit} loading={busy} disabled={!models || (!installed && !models.ready)} className="voice-again-start">
            {t("voice.again.start")}
          </Button>
        </>
      }
    >
      <div className="form-grid">
        <Field label={t("voice.set.model")} hint={models && !installed ? t("voice.again.notInstalled") : undefined}>
          <Select
            value={chosen}
            onChange={(e) => setModel(e.target.value)}
            aria-label={t("voice.set.model")}
            className="voice-again-model"
            options={list.map((m) => ({ value: m.id, label: `${MODEL_LABELS[m.id] ?? m.id}${m.installed ? "" : ` · ${t("voice.again.missing")}`}` }))}
          />
        </Field>
        <Field label={t("voice.set.language")}>
          <Select
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            aria-label={t("voice.set.language")}
            className="voice-again-language"
            options={[
              { value: "auto", label: t("voice.set.lang.auto") },
              { value: "de", label: t("voice.set.lang.de") },
              { value: "en", label: t("voice.set.lang.en") },
            ]}
          />
        </Field>
      </div>
    </Dialog>
  );
}

/** Ribbon and palette icon of voice notes. */
export const VoiceIcon = Mic;
