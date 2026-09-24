// Settings → Verwaltung: export all settings (no secrets) to a JSON file, import one with a
// preview of the changes, reset one section or everything.

import { useState } from "react";
import { Download, RotateCcw, Upload } from "lucide-react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { Button, Dialog, Select } from "../../components/ui";
import { api } from "../../lib/api";
import { isoDay } from "../../lib/format";
import { useT, type TKey } from "../../lib/i18n";
import { parseSettingsImport, settingsDiff, showValue, type Change } from "../../lib/settingsio";
import type { Settings } from "../../lib/types";
import { useApp } from "../../store/app";
import { Group, Row, SectionHead } from "./common";

/** Sections that can be reset on their own (ids as in `Settings::reset_section`). */
export const RESETTABLE: { id: string; label: TKey }[] = [
  { id: "appearance", label: "nav.appearance" },
  { id: "locale", label: "nav.locale" },
  { id: "start", label: "nav.start" },
  { id: "keyboard", label: "nav.keyboard" },
  { id: "editor", label: "nav.editor" },
  { id: "notes", label: "nav.notes" },
  { id: "time", label: "nav.time" },
  { id: "ai", label: "nav.ai" },
  { id: "privacy", label: "nav.privacy" },
  { id: "network", label: "nav.network" },
  { id: "notifications", label: "nav.notifications" },
];

export function AdminSection({ save }: { save: (next: Settings) => Promise<boolean> }) {
  const t = useT();
  const view = useApp((s) => s.settings)!;
  const s = useApp.getState;
  const [section, setSection] = useState(RESETTABLE[0].id);
  const [preview, setPreview] = useState<{ settings: Settings; changes: Change[]; warnings: string[]; title: string } | null>(null);

  const doExport = async () => {
    const path = await saveDialog({ defaultPath: `annalo-einstellungen-${isoDay(new Date())}.json`, filters: [{ name: "JSON", extensions: ["json"] }] });
    if (!path) return;
    try {
      await api.exportSettings(path);
      s().toast({ tone: "success", title: t("admin.exported"), detail: path });
    } catch (e) {
      s().error(t("admin.exportFailed"), e);
    }
  };

  const doImport = async () => {
    const path = await openDialog({ multiple: false, directory: false, filters: [{ name: "JSON", extensions: ["json"] }] });
    if (typeof path !== "string") return;
    try {
      const text = await api.readSettingsFile(path);
      const r = parseSettingsImport(text, view.settings);
      if (!r.settings) return s().toast({ tone: "danger", title: t("admin.importInvalid"), detail: r.error ?? undefined });
      setPreview({ settings: r.settings, changes: settingsDiff(view.settings, r.settings), warnings: r.warnings, title: t("admin.importTitle") });
    } catch (e) {
      s().error(t("admin.importFailed"), e);
    }
  };

  const previewReset = async (id: string | null) => {
    try {
      const next = await api.settingsDefaults(id);
      setPreview({ settings: next, changes: settingsDiff(view.settings, next), warnings: [], title: id ? t("admin.resetSectionTitle") : t("admin.resetAllTitle") });
    } catch (e) {
      s().error(t("admin.resetFailed"), e);
    }
  };

  const apply = async () => {
    if (!preview) return;
    if (await save(preview.settings)) setPreview(null);
  };

  return (
    <>
      <SectionHead title={t("set.admin.title")} intro={t("set.admin.intro")} />
      <Group title={t("admin.transfer")}>
        <Row label={t("admin.export")} description={t("admin.exportDesc")}>
          <Button icon={Download} onClick={doExport}>
            {t("admin.exportButton")}
          </Button>
        </Row>
        <Row label={t("admin.import")} description={t("admin.importDesc")}>
          <Button icon={Upload} onClick={doImport}>
            {t("admin.importButton")}
          </Button>
        </Row>
      </Group>
      <Group title={t("admin.reset")}>
        <Row label={t("admin.resetSection")} description={t("admin.resetSectionDesc")}>
          <Select value={section} onChange={(e) => setSection(e.target.value)} aria-label={t("admin.resetSection")}>
            {RESETTABLE.map((r) => (
              <option key={r.id} value={r.id}>
                {t(r.label)}
              </option>
            ))}
          </Select>
          <Button icon={RotateCcw} onClick={() => previewReset(section)}>
            {t("common.reset")}
          </Button>
        </Row>
        <Row label={t("admin.resetAll")} description={t("admin.resetAllDesc")}>
          <Button variant="danger" icon={RotateCcw} onClick={() => previewReset(null)}>
            {t("admin.resetAllButton")}
          </Button>
        </Row>
      </Group>
      {preview && (
        <Dialog
          open
          onClose={() => setPreview(null)}
          title={preview.title}
          description={preview.changes.length ? t("admin.changes", { n: preview.changes.length }) : t("admin.noChanges")}
          width={640}
          footer={
            <>
              <Button variant="ghost" onClick={() => setPreview(null)}>
                {t("common.cancel")}
              </Button>
              <Button variant="primary" onClick={apply} disabled={!preview.changes.length} data-autofocus>
                {t("admin.apply")}
              </Button>
            </>
          }
        >
          <div className="settings-diff" aria-label={t("admin.changesLabel")}>
            {preview.changes.map((c) => (
              <div key={c.path} className="diff-row">
                <span className="mono diff-path">{c.path}</span>
                <span className="diff-from">{showValue(c.from)}</span>
                <span className="faint">→</span>
                <span className="diff-to">{showValue(c.to)}</span>
              </div>
            ))}
          </div>
          {preview.warnings.length > 0 && (
            <div className="warn-note small">
              {t("admin.warnings")}
              <ul>
                {preview.warnings.slice(0, 20).map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </div>
          )}
        </Dialog>
      )}
    </>
  );
}
