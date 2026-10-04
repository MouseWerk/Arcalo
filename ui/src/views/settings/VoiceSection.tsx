// Settings → Sprachnotizen: the Whisper model (download with progress, cancel, delete, „Modelldatei
// wählen …“), the admin download source, the language, the input device, system audio (Windows),
// the global shortcut, the summary and whether the audio is kept.

import { useEffect, useState } from "react";
import { Download, FolderOpen, Trash2, X } from "lucide-react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { Badge, Button, IconButton, Progress, Switch } from "../../components/ui";
import { Select } from "../../components/Select";
import { useApp } from "../../store/app";
import { api, on } from "../../lib/api";
import { fileSize } from "../../lib/format";
import { formatShortcut } from "../../lib/shortcut";
import { IS_MAC } from "../../lib/platform";
import { useT, t as tr } from "../../lib/i18n";
import { MODEL_LABELS, downloadPercent, voiceApi, type ModelDownload, type ModelsView, type VoiceDevices } from "../../lib/voice";
import type { DesktopInfo, VoiceSettings } from "../../lib/types";
import { CommitInput, Group, Row, SectionHead, ShortcutField, StatusNote, type SectionProps } from "./common";

export const voiceDefaults = (): VoiceSettings => ({
  model: "small",
  source_url: "",
  language: "auto",
  input_device: "",
  system_audio: false,
  auto_summary: false,
  keep_audio: true,
  shortcut: "",
});

export function VoiceSection({ draft, update }: SectionProps) {
  const t = useT();
  const voice = { ...voiceDefaults(), ...draft.voice };
  const saved = useApp((s) => s.settings?.settings.voice);
  const set = (p: Partial<VoiceSettings>) => update({ voice: { ...voice, ...p } });
  const [models, setModels] = useState<ModelsView | null>(null);
  const [devices, setDevices] = useState<VoiceDevices | null>(null);
  const [info, setInfo] = useState<DesktopInfo | null>(null);

  useEffect(() => {
    voiceApi.models().then(setModels, () => setModels(null));
    voiceApi.devices().then(setDevices, () => setDevices({ inputs: [], default: null, system_audio: false }));
    const un = on<ModelDownload>("voice://model", (d) => {
      setModels((m) => (m ? { ...m, download: d } : m));
      if (d.done) voiceApi.models().then(setModels, () => {});
    });
    return () => void un.then((f) => f());
  }, []);
  useEffect(() => void api.desktopInfo().then(setInfo, () => setInfo(null)), [saved?.shortcut]);

  const act = async (run: () => Promise<ModelsView>, failed: string) => {
    try {
      setModels(await run());
    } catch (e) {
      useApp.getState().error(failed, e);
    }
  };
  const importFile = async (id: string) => {
    const path = await openFileDialog({ multiple: false, directory: false, title: tr("voice.set.importTitle"), filters: [{ name: "Whisper", extensions: ["bin"] }] });
    if (typeof path !== "string") return;
    await act(() => voiceApi.importModel(id, path), tr("voice.set.importFailed"));
    useApp.getState().toast({ tone: "success", title: tr("voice.set.imported") });
  };

  const dl = models?.download ?? null;
  const running = !!dl && !dl.done;
  const noMic = devices !== null && devices.inputs.length === 0;

  return (
    <>
      <SectionHead title={t("nav.voice")} intro={t("voice.set.intro")} />
      <Group title={t("voice.set.modelTitle")} description={t("voice.set.modelDesc")}>
        <Row label={t("voice.set.model")} description={t("voice.set.modelHint")}>
          <Select
            value={voice.model}
            onChange={(e) => set({ model: e.target.value })}
            aria-label={t("voice.set.model")}
            options={(models?.models ?? []).map((m) => ({ value: m.id, label: `${MODEL_LABELS[m.id] ?? m.id} · ${fileSize(m.size)}${m.id === "small" ? ` · ${t("voice.set.default")}` : ""}` }))}
          />
        </Row>
        <div className="voice-models" role="list" aria-label={t("voice.set.models")}>
          {(models?.models ?? []).map((m) => {
            const mine = dl && dl.id === m.id ? dl : null;
            const active = !!mine && !mine.done;
            return (
              <div key={m.id} className="voice-model" role="listitem" data-model={m.id}>
                <div className="voice-model-head">
                  <span className="voice-model-name">{MODEL_LABELS[m.id] ?? m.id}</span>
                  <span className="faint small">{fileSize(m.size)}</span>
                  {m.installed ? (
                    <Badge tone="success">{t("voice.set.installed")}</Badge>
                  ) : m.partial > 0 && !active ? (
                    <Badge tone="warning">{t("voice.set.partial", { n: downloadPercent({ received: m.partial, total: m.size }) })}</Badge>
                  ) : null}
                  {m.id === voice.model && (m.installed ? <Badge tone="accent">{t("voice.set.selected")}</Badge> : <Badge tone="warning" title={t("voice.set.selectedMissingHint")}>{t("voice.set.selectedMissing")}</Badge>)}
                  <span className="grow" />
                  {active ? (
                    <Button size="sm" variant="ghost" icon={X} className="voice-model-cancel" onClick={() => void voiceApi.cancelDownload()}>
                      {t("common.cancel")}
                    </Button>
                  ) : m.installed ? (
                    <IconButton icon={Trash2} size="sm" label={t("voice.set.delete")} className="voice-model-delete" onClick={() => void act(() => voiceApi.deleteModel(m.id), tr("voice.set.deleteFailed"))} />
                  ) : (
                    <>
                      <Button size="sm" variant="ghost" icon={FolderOpen} className="voice-model-import" onClick={() => void importFile(m.id)}>
                        {t("voice.set.import")}
                      </Button>
                      <Button size="sm" icon={Download} disabled={running} className="voice-model-download" onClick={() => void act(() => voiceApi.download(m.id), tr("voice.set.downloadFailed"))}>
                        {m.partial > 0 ? t("voice.set.resume") : t("voice.set.download")}
                      </Button>
                    </>
                  )}
                </div>
                {active && (
                  <div className="voice-model-progress">
                    <Progress value={downloadPercent(mine)} />
                    <span className="faint small num">
                      {t("voice.set.progress", { done: fileSize(mine.received), total: fileSize(mine.total) })}
                      {mine.source && <span className="voice-model-source"> · {mine.source}</span>}
                    </span>
                  </div>
                )}
                {mine?.done && mine.error && (
                  <StatusNote tone="danger" className="voice-model-error">
                    {mine.error}
                  </StatusNote>
                )}
              </div>
            );
          })}
        </div>
        <Row label={t("voice.set.source")} description={t("voice.set.sourceDesc")} stack>
          <CommitInput className="grow voice-source-input" value={voice.source_url} onCommit={(v) => set({ source_url: v.trim() })} placeholder={t("voice.set.sourcePlaceholder")} aria-label={t("voice.set.source")} />
        </Row>
        <Row label={t("voice.set.language")} description={t("voice.set.languageDesc")}>
          <Select
            value={voice.language}
            onChange={(e) => set({ language: e.target.value })}
            aria-label={t("voice.set.language")}
            options={[
              { value: "auto", label: t("voice.set.lang.auto") },
              { value: "de", label: t("voice.set.lang.de") },
              { value: "en", label: t("voice.set.lang.en") },
            ]}
          />
        </Row>
      </Group>

      <Group title={t("voice.set.recTitle")} description={t("voice.set.recDesc")}>
        <Row label={t("voice.set.device")} description={noMic ? undefined : t("voice.set.deviceDesc")}>
          {noMic ? (
            <StatusNote tone="warning" className="voice-no-mic">
              {t("voice.noMic")}
            </StatusNote>
          ) : (
            <Select
              value={voice.input_device}
              onChange={(e) => set({ input_device: e.target.value })}
              aria-label={t("voice.set.device")}
              options={[
                { value: "", label: devices?.default ? t("voice.set.deviceDefaultNamed", { name: devices.default }) : t("voice.set.deviceDefault") },
                ...(devices?.inputs ?? []).filter((d) => d !== voice.input_device).map((d) => ({ value: d, label: d })),
                ...(voice.input_device ? [{ value: voice.input_device, label: voice.input_device }] : []),
              ]}
            />
          )}
        </Row>
        {devices?.system_audio && (
          <Row label={t("voice.set.system")} description={t("voice.set.systemDesc")}>
            <Switch label={t("voice.set.system")} checked={voice.system_audio} onChange={(v) => set({ system_audio: v })} />
          </Row>
        )}
        <Row label={t("set.desktop.globalShortcut")} description={t("voice.set.shortcutDesc", { example: formatShortcut(`${IS_MAC ? "Cmd" : "Ctrl"}+Shift+R`) })}>
          <ShortcutField
            value={voice.shortcut}
            onChange={(v) => set({ shortcut: v })}
            label={t("voice.set.shortcut")}
            placeholder={t("common.off")}
            active={info ? voice.shortcut === (saved?.shortcut ?? "") && !!info.voice_shortcut_active : undefined}
          />
        </Row>
      </Group>

      <Group title={t("voice.set.afterTitle")} description={t("voice.set.afterDesc")}>
        <Row label={t("voice.set.auto")} description={t("voice.set.autoDesc")}>
          <Switch label={t("voice.set.auto")} checked={voice.auto_summary} onChange={(v) => set({ auto_summary: v })} />
        </Row>
        <Row label={t("voice.set.keep")} description={t("voice.set.keepDesc")}>
          <Switch label={t("voice.set.keep")} checked={voice.keep_audio} onChange={(v) => set({ keep_audio: v })} />
        </Row>
      </Group>
    </>
  );
}
