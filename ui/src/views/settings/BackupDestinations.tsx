// Settings → Sicherung: further backup destinations (network shares, mapped drives, mounted
// volumes, synced cloud folders) with their status, and the list of backups – local and in
// the destinations – to restore from.

import { useEffect, useState } from "react";
import { CheckCircle2, Cloud, DatabaseBackup, FolderOpen, HardDrive, Network, Plus, RefreshCw, RotateCcw, Server, Trash2, Wifi } from "lucide-react";
import { Button, IconButton, Input, Switch } from "../../components/ui";
import { api, on } from "../../lib/api";
import { pickFolder } from "../../lib/actions";
import { flushBeforeExit } from "../../lib/exit";
import { dateTime, fileSize, fmtDate, relative, time } from "../../lib/format";
import { t, useT } from "../../lib/i18n";
import { IS_LINUX, IS_MAC } from "../../lib/platform";
import { useApp } from "../../store/app";
import type { BackupInfo, Settings } from "../../lib/types";
import {
  canAdd,
  kindKey,
  mergeBackups,
  newDestination,
  problemText,
  statusLine,
  type BackupDestination,
  type DestFailure,
  type DestTest,
  type DestView,
  type PathKind,
  type RemoteBackups,
  type SourcedBackup,
} from "../../lib/backupdest";
import { Group, NumberInput, PathValue, Row, StatusNote } from "./common";
import { isComposing } from "../../lib/ime";

const PLATFORM = IS_MAC ? "mac" : IS_LINUX ? "linux" : "windows";
const KIND_ICON: Record<PathKind, typeof Server> = { unc: Network, drive: HardDrive, mount: Server, cloud: Cloud, local: FolderOpen };

/** „25.09.2026, 14:05 (vor 3 Min.)“ */
const when = (iso: string) => `${fmtDate(iso)}, ${time(iso)} (${relative(iso)})`;

/** Status of the destinations, refreshed on every change the shell reports and every 20 s. */
function useDestinations(): [DestView[] | null, () => void] {
  const [views, setViews] = useState<DestView[] | null>(null);
  const reload = () => void api.backupDestinations().then(setViews).catch(() => setViews([]));
  useEffect(() => {
    reload();
    const off = on("backup://destinations", reload);
    const timer = window.setInterval(reload, 20000);
    return () => {
      window.clearInterval(timer);
      void off.then((f) => f());
    };
  }, []);
  return [views, reload];
}

export function BackupDestinationsGroup({ draft, update }: { draft: Settings; update: (p: Partial<Settings>) => void }) {
  const t = useT();
  const targets = draft.backup_targets;
  const list = targets.destinations;
  const [views, reload] = useDestinations();
  const [path, setPath] = useState("");
  const setTargets = (p: Partial<typeof targets>) => update({ backup_targets: { ...targets, ...p } });
  const setDest = (i: number, p: Partial<BackupDestination>) => setTargets({ destinations: list.map((d, j) => (j === i ? { ...d, ...p } : d)) });
  // Saved (ids filled in), switched on or off: the status follows.
  const shape = list.map((d) => `${d.id}:${d.enabled}`).join();
  useEffect(reload, [shape]); // eslint-disable-line react-hooks/exhaustive-deps

  const add = (p = path) => {
    if (!canAdd(p, list)) return;
    setTargets({ destinations: [...list, newDestination(p)] });
    setPath("");
  };
  const pick = async () => {
    const dir = await pickFolder(t("bdest.pickTitle"));
    if (dir) add(dir);
  };
  const remove = async (i: number) => {
    const d = list[i];
    const ok = await useApp.getState().confirm({ title: t("bdest.removeTitle"), message: t("bdest.removeMessage", { path: d.path }), confirmLabel: t("bdest.remove"), danger: true });
    if (ok) setTargets({ destinations: list.filter((_, j) => j !== i) });
  };
  const duplicate = path.trim() !== "" && !canAdd(path, list);

  return (
    <Group title={t("bdest.title")} description={t("bdest.desc")}>
      <div className="bdest-list" aria-label={t("bdest.title")}>
        {list.length === 0 && <p className="faint small bdest-empty">{t("bdest.none")}</p>}
        {list.map((d, i) => (
          <DestinationCard
            key={d.id || d.path}
            dest={d}
            view={views?.find((v) => v.id === d.id) ?? null}
            mirrorOn={draft.markdown_mirror}
            onChange={(p) => setDest(i, p)}
            onRemove={() => void remove(i)}
            onRetry={() => void api.retryBackupDestinations().then(() => window.setTimeout(reload, 400), (e) => useApp.getState().error(t("common.actionFailed"), e))}
          />
        ))}
      </div>
      <Row label={t("bdest.add")} description={duplicate ? <span className="bdest-dup">{t("bdest.exists")}</span> : undefined} keywords="Netzwerk UNC OneDrive Nextcloud NAS Freigabe share">
        <div className="bdest-add">
          <Input
            className="bdest-input mono"
            value={path}
            placeholder={t("bdest.pathPlaceholder")}
            aria-label={t("bdest.path")}
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => {
              if (isComposing(e)) return;
              if (e.key === "Enter") add();
            }}
          />
          <Button icon={FolderOpen} onClick={() => void pick()}>
            {t("bdest.pick")}
          </Button>
          <Button variant="primary" icon={Plus} onClick={() => add()} disabled={!canAdd(path, list)}>
            {t("bdest.add")}
          </Button>
        </div>
      </Row>
      {list.length > 0 && (
        <Row label={t("bdest.localOnly")} description={t("bdest.localOnlyDesc")}>
          <Switch label={t("bdest.localOnly")} checked={targets.local_latest_only} onChange={(v) => setTargets({ local_latest_only: v })} />
        </Row>
      )}
    </Group>
  );
}

function DestinationCard({
  dest,
  view,
  mirrorOn,
  onChange,
  onRemove,
  onRetry,
}: {
  dest: BackupDestination;
  view: DestView | null;
  mirrorOn: boolean;
  onChange: (p: Partial<BackupDestination>) => void;
  onRemove: () => void;
  onRetry: () => void;
}) {
  const t = useT();
  const [test, setTest] = useState<DestTest | null>(null);
  const [testing, setTesting] = useState(false);
  const info = view?.info ?? test?.info ?? null;
  const Icon = KIND_ICON[info?.kind ?? "local"];
  const status = view ? statusLine(t, view, when, PLATFORM) : { tone: "neutral" as const, text: t(dest.enabled ? "bdest.st.waiting" : "bdest.st.off") };
  const health = view?.health ?? (dest.enabled ? "waiting" : "off");

  const runTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      setTest(await api.testBackupDestination(dest.path));
    } catch (e) {
      setTest({ ok: false, probe: null, info: info ?? { kind: "local", server: null, share: null, cloud: null }, failure: { problem: "other", message: String(e), path: dest.path } });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="bdest-card" data-health={health} data-id={dest.id}>
      <div className="bdest-head">
        <span className="bdest-icon" aria-hidden>
          <Icon size={16} strokeWidth={1.75} />
        </span>
        <div className="bdest-title">
          <PathValue value={dest.path} className="bdest-path" />
          <span className="bdest-kind faint small">
            {info ? t(kindKey(info)) : t("bdest.kind.local")}
            {info?.cloud ? ` · ${info.cloud}` : ""}
            {view?.folder ? ` · ${t("bdest.folderHint", { folder: view.folder })}` : ""}
          </span>
        </div>
        <Switch label={t("bdest.enabled")} checked={dest.enabled} onChange={(v) => onChange({ enabled: v })} />
        <IconButton icon={Trash2} size="md" label={t("bdest.remove")} onClick={onRemove} />
      </div>
      {status && (
        <div className="bdest-status">
          <StatusNote tone={status.tone} className={`bdest-state bdest-${health}`}>
            {status.text}
          </StatusNote>
        </div>
      )}
      {info?.kind === "cloud" && info.cloud && <p className="bdest-hint small">{t("bdest.cloudHint", { name: info.cloud })}</p>}
      <div className="bdest-opts">
        <div className="bdest-optline">
        <label className="bdest-opt">
          <span>{t("bdest.keep")}</span>
          <NumberInput min={1} max={365} value={dest.keep} onCommit={(v) => onChange({ keep: v })} aria-label={t("bdest.keep")} />
          <span className="faint">{t("bdest.keepUnit")}</span>
        </label>
        <label className="bdest-opt">
          <span>{t("bdest.maxAge")}</span>
          <NumberInput min={0} max={3650} value={dest.keep_days} onCommit={(v) => onChange({ keep_days: v })} aria-label={t("bdest.days")} />
          <span className="faint">{t("bdest.days")}</span>
        </label>
        </div>
        <div className="bdest-optline">
        <span className="bdest-opt">
          <Switch label={t("bdest.attachments")} checked={dest.attachments} onChange={(v) => onChange({ attachments: v })} />
          <span>{t("bdest.attachments")}</span>
        </span>
        <span className="bdest-opt" title={mirrorOn ? undefined : t("bdest.markdownOff")}>
          <Switch label={t("bdest.markdown")} checked={dest.markdown && mirrorOn} disabled={!mirrorOn} onChange={(v) => onChange({ markdown: v })} />
          <span className={mirrorOn ? "" : "faint"}>{t("bdest.markdown")}</span>
        </span>
        </div>
      </div>
      <div className="bdest-actions">
        <Button size="sm" icon={Wifi} onClick={() => void runTest()} loading={testing}>
          {t("bdest.test")}
        </Button>
        {(health === "pending" || health === "failing") && (
          <Button size="sm" icon={RefreshCw} onClick={onRetry} disabled={view?.busy}>
            {t("bdest.retry")}
          </Button>
        )}
        {testing && <StatusNote tone="busy">{t("bdest.testing")}</StatusNote>}
        {test && !testing && (
          <StatusNote tone={test.ok ? "success" : "warning"} className="bdest-test">
            {test.ok && test.probe ? t("bdest.testOk", { ms: test.probe.write_ms + test.probe.delete_ms }) : problemText(t, test.failure as DestFailure, PLATFORM)}
          </StatusNote>
        )}
      </div>
    </div>
  );
}

/** `backup://destination-failed`: a destination has missed backups for a day or three backups (told once per outage). */
export function warnDestination(w: { path: string; failure: DestFailure }) {
  const s = useApp.getState();
  s.toast({ tone: "warning", title: t("bdest.warnTitle"), detail: `${w.path}: ${problemText(t, w.failure, PLATFORM)}` });
}

/** The backups, local and in the destinations, each with „Wiederherstellen…“. */
export function BackupList({ local, reloadKey }: { local: BackupInfo[] | null; reloadKey: unknown }) {
  const t = useT();
  const [remote, setRemote] = useState<RemoteBackups | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const hasDest = (useApp((s) => s.settings?.settings.backup_targets.destinations.some((d) => d.enabled)) ?? false) as boolean;
  useEffect(() => {
    if (!hasDest) {
      setRemote(null);
      return;
    }
    let live = true;
    setLoading(true);
    api
      .remoteBackups()
      .then((r) => live && setRemote(r))
      .catch(() => live && setRemote(null))
      .finally(() => live && setLoading(false));
    const off = on("backup://destinations", () => void api.remoteBackups().then((r) => live && setRemote(r)).catch(() => {}));
    return () => {
      live = false;
      void off.then((f) => f());
    };
  }, [hasDest, reloadKey]);

  const rows = mergeBackups(local ?? [], remote?.backups ?? []);
  const source = (b: SourcedBackup) => (b.source === "local" ? t("bdest.local") : t("bdest.fromHost", { source: b.source_path, host: b.host }));

  const restore = async (b: SourcedBackup) => {
    const s = useApp.getState();
    const ok = await s.confirm({
      title: t("bdest.restoreTitle"),
      message: t("bdest.restoreMessage", { when: `${fmtDate(b.created_at)}, ${time(b.created_at)}`, source: source(b) }),
      confirmLabel: t("bdest.restoreConfirm"),
      danger: true,
    });
    if (!ok || !(await flushBeforeExit())) return;
    setBusy(b.path);
    try {
      const res = await api.restoreBackup(b.path);
      if (!res.ok) {
        s.toast({ tone: "danger", title: t("bdest.restoreFailed"), detail: res.failure ? problemText(t, res.failure, PLATFORM) : "" });
        return;
      }
      s.toast({ tone: "success", title: t("bdest.restoreStaged") });
      await api.restart();
    } catch (e) {
      s.error(t("bdest.restoreFailed"), e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="backup-list" aria-label={t("set.backup.list")}>
      {rows.length === 0 && !loading && <p className="faint small">{t("set.backup.none")}</p>}
      {rows.map((b) => (
        <div key={b.path} className="backup-row" title={b.path} data-source={b.source}>
          <span className="grow backup-when">{dateTime(b.created_at)}</span>
          <span className={`backup-source small ${b.source === "local" ? "faint" : ""}`}>
            {b.source === "local" ? <DatabaseBackup size={12} aria-hidden /> : <Network size={12} aria-hidden />}
            <span className="backup-source-text">{source(b)}</span>
            {b.has_sum && <CheckCircle2 size={12} className="backup-sum" aria-label={t("bdest.checksum")} />}
          </span>
          <span className="faint small">{relative(b.created_at)}</span>
          <span className="faint small num">{fileSize(b.size_bytes)}</span>
          <Button size="sm" variant="ghost" icon={RotateCcw} className="backup-restore" onClick={() => void restore(b)} loading={busy === b.path} disabled={busy != null}>
            {t("bdest.restore")}
          </Button>
        </div>
      ))}
      {loading && <StatusNote tone="busy">{t("bdest.searching")}</StatusNote>}
      {remote?.offline.map((f) => (
        <StatusNote key={f.path} tone="info" className="backup-offline">
          {t("bdest.offline", { path: f.path })}
        </StatusNote>
      ))}
    </div>
  );
}
