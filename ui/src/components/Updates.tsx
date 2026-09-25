// Auto-update: periodic checks, the „Version X verfügbar“ toast, release notes and the
// install flow (store editors → download with progress → install → restart). Builds without
// an update key never check; nothing is installed without the user's click.

import { create } from "zustand";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Download, ExternalLink, RefreshCw, X } from "lucide-react";
import { api, on } from "../lib/api";
import { flushBeforeExit } from "../lib/exit";
import { renderMarkdown } from "../lib/markdown";
import { fmtDate } from "../lib/format";
import { autoCheckAllowed, CHECK_INTERVAL_MS, FIRST_CHECK_DELAY_MS, NOT_CONFIGURED, progressLabel, progressValue } from "../lib/updates";
import type { UpdateInfo, UpdateProgress, UpdateStatus } from "../lib/types";
import { useApp } from "../store/app";
import { Button, Dialog, IconButton, Progress } from "./ui";
import { t, useT } from "../lib/i18n";

type Phase = "idle" | "checking" | "downloading" | "installing";

interface UpdateState {
  status: UpdateStatus | null;
  available: UpdateInfo | null;
  phase: Phase;
  progress: UpdateProgress | null;
  /** When the last check finished (successfully). */
  checkedAt: Date | null;
  /** Version whose toast the user closed; a manual check shows it again. */
  dismissed: string | null;
  notesOpen: boolean;
}

export const useUpdates = create<UpdateState>(() => ({
  status: null,
  available: null,
  phase: "idle",
  progress: null,
  checkedAt: null,
  dismissed: null,
  notesOpen: false,
}));

// End-to-end runs (WebDriver) drive the update states: their builds have no update key.
if (typeof navigator !== "undefined" && navigator.webdriver) (window as unknown as { __annaloUpdates?: typeof useUpdates }).__annaloUpdates = useUpdates;

export async function loadUpdateStatus(): Promise<UpdateStatus | null> {
  try {
    const status = await api.updateStatus();
    useUpdates.setState((s) => ({ status, available: status.available ?? s.available }));
    return status;
  } catch {
    return null;
  }
}

/** Looks for a newer release. `manual` reports every outcome; automatic checks stay quiet. */
export async function checkForUpdates(manual: boolean) {
  const status = useUpdates.getState().status ?? (await loadUpdateStatus());
  const toast = useApp.getState().toast;
  if (!status?.enabled) {
    if (manual) toast({ tone: "info", title: t(NOT_CONFIGURED) });
    return;
  }
  if (useUpdates.getState().phase !== "idle") return;
  useUpdates.setState({ phase: "checking" });
  try {
    const found = await api.updateCheck();
    useUpdates.setState((s) => ({ available: found, checkedAt: new Date(), dismissed: manual ? null : s.dismissed }));
    if (!found && manual) toast({ tone: "success", title: t("upd.upToDate"), detail: t("upd.latest", { version: status.current_version }) });
  } catch (e) {
    if (manual) useApp.getState().error(t("upd.checkFailed"), e);
    else console.warn("update check failed", e);
  } finally {
    useUpdates.setState({ phase: "idle" });
  }
}

/** Stores all editors, then downloads, installs and restarts into the new version. */
export async function installUpdate() {
  const st = useUpdates.getState();
  if (!st.available || st.phase !== "idle") return;
  useUpdates.setState({ notesOpen: false });
  if (!(await flushBeforeExit(t("upd.anyway")))) return;
  useUpdates.setState({ phase: "downloading", progress: null });
  const unlisten = on<UpdateProgress>("update://progress", (progress) => useUpdates.setState({ progress, phase: progress.percent === 100 ? "installing" : "downloading" }));
  try {
    // On Windows the installer ends this process and starts the new version.
    await api.updateInstall();
    useUpdates.setState({ phase: "installing" });
  } catch (e) {
    useUpdates.setState({ phase: "idle", progress: null });
    useApp.getState().error(t("upd.failed"), e);
  } finally {
    unlisten.then((f) => f());
  }
}

/** Portable copy: the release page, where the portable ZIP is downloaded by hand (nothing is installed). */
export async function downloadPortable(url?: string) {
  const target = url ?? useUpdates.getState().available?.url;
  if (!target) return;
  useUpdates.setState({ notesOpen: false });
  await openUrl(target).catch((e) => useApp.getState().error(t("upd.releasePageFailed"), e));
}

/** The update action: install and restart, or (portable) download from the release page. */
function UpdateAction({ size }: { size?: "sm" | "md" }) {
  const t = useT();
  const portable = useUpdates((s) => !!s.status?.portable);
  return portable ? (
    <Button size={size} variant="primary" icon={Download} onClick={() => void downloadPortable()}>
      {t("upd.download")}
    </Button>
  ) : (
    <Button size={size} variant="primary" icon={RefreshCw} onClick={() => void installUpdate()}>
      {t("upd.install")}
    </Button>
  );
}

/** Checks shortly after start and every 6 hours (if enabled); returns the cleanup. */
export function startUpdateChecks(): () => void {
  const auto = () => {
    const { status } = useUpdates.getState();
    if (autoCheckAllowed(status, useApp.getState().settings?.settings.auto_update_check)) void checkForUpdates(false);
  };
  void loadUpdateStatus();
  const first = setTimeout(auto, FIRST_CHECK_DELAY_MS);
  const every = setInterval(auto, CHECK_INTERVAL_MS);
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}

/** The persistent update toast, shown above the other toasts. */
export function UpdateToast() {
  const t = useT();
  const { available, phase, progress, dismissed } = useUpdates();
  // Settings → Benachrichtigungen „Neue Version verfügbar“ (the settings' Über section still shows it).
  const notifyUpdates = useApp((st) => st.settings?.settings.notifications?.updates !== false);
  if (!available) return null;
  const busy = phase === "downloading" || phase === "installing";
  if (!busy && (dismissed === available.version || !notifyUpdates)) return null;
  return (
    <div className="toast toast-info update-toast" role="status">
      <Download size={16} className="toast-icon" />
      <div className="toast-body">
        {busy ? (
          <>
            <div className="toast-title">{phase === "installing" ? t("upd.installing", { version: available.version }) : t("upd.downloading", { version: available.version })}</div>
            <div className="toast-detail">{phase === "installing" ? t("upd.restartSoon") : progressLabel(progress)}</div>
            {phase === "downloading" && <Progress value={progressValue(progress)} />}
          </>
        ) : (
          <>
            <div className="toast-title">{t("upd.availableShort", { version: available.version })}</div>
            <div className="toast-detail">{useUpdates.getState().status?.portable ? t("upd.portableHint") : t("upd.savedFirst")}</div>
            <div className="toast-actions">
              <UpdateAction size="sm" />
              <Button size="sm" variant="ghost" onClick={() => useUpdates.setState({ notesOpen: true })}>
                {t("upd.whatsNew")}
              </Button>
            </div>
          </>
        )}
      </div>
      {!busy && <IconButton icon={X} label={t("common.later")} size="sm" onClick={() => useUpdates.setState({ dismissed: available.version })} />}
      <ReleaseNotes />
    </div>
  );
}

function ReleaseNotes() {
  const t = useT();
  const { available, notesOpen } = useUpdates();
  if (!available) return null;
  const close = () => useUpdates.setState({ notesOpen: false });
  return (
    <Dialog
      open={notesOpen}
      onClose={close}
      title={t("upd.newIn", { version: available.version })}
      description={available.date ? t("upd.published", { date: fmtDate(available.date) }) : undefined}
      width={520}
      footer={
        <>
          <Button variant="ghost" icon={ExternalLink} onClick={() => void openUrl(available.url).catch(() => {})}>
            {t("upd.changelog")}
          </Button>
          <UpdateAction />
        </>
      }
    >
      {available.notes ? (
        <div className="prose update-notes" dangerouslySetInnerHTML={{ __html: renderMarkdown(available.notes) }} />
      ) : (
        <p className="muted">{t("upd.noNotes")}</p>
      )}
    </Dialog>
  );
}
