// Settings → Protokoll: the developer log (`logs/annalo.log` in the data folder) with a level
// filter, copy for bug reports, clearing and the folder in the file manager. The About page
// shows a short summary row (errors of the last 7 days).

import { useEffect, useState } from "react";
import { Copy, FolderOpen, RefreshCw, ScrollText, Trash2 } from "lucide-react";
import { Badge, Button, Segmented, Switch } from "../../components/ui";
import { api } from "../../lib/api";
import { entriesText, entryTime, filterEntries, levelTone, type DevLogFilter } from "../../lib/devlog";
import { useT } from "../../lib/i18n";
import type { DevLogEntry, DevLogStats } from "../../lib/types";
import { useApp } from "../../store/app";
import { Group, Row, SectionHead, Unfiltered, type SectionProps } from "./common";

const LIMIT = 500;

async function openFolder() {
  try {
    await api.devlogOpenFolder();
  } catch (e) {
    useApp.getState().error("Protokollordner nicht geöffnet", e);
  }
}

export function DevLogSection({ draft, update }: SectionProps) {
  const t = useT();
  const s = useApp.getState;
  const [entries, setEntries] = useState<DevLogEntry[] | null>(null);
  const [filter, setFilter] = useState<DevLogFilter>("all");
  const [loading, setLoading] = useState(false);
  const [writeError, setWriteError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    void api.devlogStats().then((st) => setWriteError(st.write_error ?? null), () => {});
    try {
      setEntries(await api.devlogRead(LIMIT));
    } catch (e) {
      s().error(t("devlog.readFailed"), e);
      setEntries([]);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const shown = filterEntries(entries ?? [], filter);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(entriesText(shown));
      s().toast({ tone: "success", title: t("devlog.copied"), detail: t("devlog.lines", { n: shown.length }) });
    } catch (e) {
      s().error(t("devlog.copyFailed"), e);
    }
  };
  const clear = async () => {
    const ok = await s().confirm({ title: t("devlog.clearTitle"), message: t("devlog.clearMessage"), confirmLabel: t("common.clear"), danger: true });
    if (!ok) return;
    try {
      await api.devlogClear();
      await load();
    } catch (e) {
      s().error(t("devlog.clearFailed"), e);
    }
  };

  return (
    <div className="devlog-section">
      <SectionHead title={t("nav.devlog")} intro={t("devlog.intro")} />
      <Group title={t("devlog.settings")}>
        <Row label={t("devlog.verbose")} description={t("devlog.verboseDesc")}>
          <Switch label={t("devlog.verbose")} checked={draft.dev_log_verbose} onChange={(v) => update({ dev_log_verbose: v })} />
        </Row>
        <Row label={t("devlog.folder")} description={writeError ? <span className="mirror-error">{t("devlog.writeError", { msg: writeError })}</span> : t("devlog.folderDesc")}>
          <Button icon={FolderOpen} onClick={() => void openFolder()}>
            {t("devlog.openFolder")}
          </Button>
        </Row>
      </Group>
      <Unfiltered>
        <Group title={t("devlog.entries")}>
          <div className="devlog-toolbar">
            <Segmented
              label={t("devlog.filter")}
              value={filter}
              onChange={setFilter}
              options={[
                { value: "all", label: t("devlog.all") },
                { value: "errors", label: t("devlog.errors") },
                { value: "warnings", label: t("devlog.warnings") },
              ]}
            />
            <div className="devlog-actions">
              <Button icon={RefreshCw} loading={loading} onClick={() => void load()}>
                {t("devlog.refresh")}
              </Button>
              <Button icon={Copy} disabled={shown.length === 0} onClick={() => void copy()}>
                {t("devlog.copy")}
              </Button>
              <Button icon={Trash2} variant="ghost" disabled={!entries?.length} onClick={() => void clear()}>
                {t("common.clear")}
              </Button>
            </div>
          </div>
          {entries && shown.length === 0 ? (
            <div className="devlog-empty">
              <ScrollText size={20} strokeWidth={1.5} aria-hidden />
              <span>{entries.length === 0 ? t("devlog.empty") : t("devlog.emptyFilter")}</span>
            </div>
          ) : (
            <ol className="devlog-list" aria-label={t("devlog.entries")}>
              {shown.map((e, i) => (
                <li key={`${e.time}-${i}`} className={`devlog-entry level-${e.level.toLowerCase()}`}>
                  <div className="devlog-meta">
                    <span className="devlog-time">{entryTime(e.time)}</span>
                    <Badge tone={levelTone(e.level)}>{e.level}</Badge>
                    {e.source && <span className="devlog-source">{e.source}</span>}
                  </div>
                  <div className="devlog-message selectable">{e.message}</div>
                </li>
              ))}
            </ol>
          )}
          {entries && entries.length >= LIMIT && <p className="faint small">{t("devlog.limited", { n: LIMIT })}</p>}
        </Group>
      </Unfiltered>
    </div>
  );
}

/** Row on the About page: errors of the last 7 days, open the section or the folder. */
export function DevLogAboutRow({ onOpen }: { onOpen: () => void }) {
  const t = useT();
  const [stats, setStats] = useState<DevLogStats | null>(null);
  useEffect(() => void api.devlogStats().then(setStats, () => setStats(null)), []);
  const errors = stats?.errors_week ?? 0;
  return (
    <Row label={t("devlog.aboutLabel")} description={t("devlog.aboutDesc")}>
      <div className="devlog-about">
        {stats && (
          <Badge tone={errors > 0 ? "danger" : "success"}>
            {errors === 1 ? t("devlog.errorsWeekOne") : t("devlog.errorsWeek", { n: errors })}
          </Badge>
        )}
        <Button icon={ScrollText} onClick={onOpen}>
          {t("devlog.show")}
        </Button>
        <Button icon={FolderOpen} variant="ghost" onClick={() => void openFolder()}>
          {t("devlog.openFolder")}
        </Button>
      </div>
    </Row>
  );
}
