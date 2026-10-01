// The voice bar: always on screen while a voice note is recorded (red dot, elapsed time, level
// meter, pause, stop, discard), then while it is transcribed (progress, cancel), then with the
// finished note (open, summarize with the AI).

import { useEffect } from "react";
import { Check, FileText, Loader2, Mic, Pause, Play, Sparkles, Square, Trash2, X } from "lucide-react";
import { Button, IconButton } from "./ui";
import { useApp } from "../store/app";
import { useT } from "../lib/i18n";
import { aiReady, discardVoice, dismissResult, elapsedLabel, listenVoice, meterSegments, stageLabel, stopVoice, summarizeVoice, useVoice, voiceApi } from "../lib/voice";

const SEGMENTS = 14;

export function VoiceBar() {
  const t = useT();
  useEffect(() => listenVoice(), []);
  const status = useVoice((s) => s.status);
  const results = useVoice((s) => s.results);
  const summarizing = useVoice((s) => s.summarizing);
  // Re-render when the AI settings change (the summary button).
  useApp((s) => s.settings);
  const rec = status.recording;
  if (!rec && !status.jobs.length && !results.length) return null;
  const lit = rec && !rec.paused ? meterSegments(rec.level, SEGMENTS) : 0;
  const ai = aiReady();

  return (
    <div className="voice-bar" role="region" aria-label={t("voice.bar")}>
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
  );
}

/** Ribbon and palette icon of voice notes. */
export const VoiceIcon = Mic;
