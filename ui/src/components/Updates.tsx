// Auto-update: periodic checks, the „Version X verfügbar“ toast, release notes and the
// install flow (store editors → download with progress → install → restart). Builds without
// an update key never check; nothing is installed without the user's click.

import { create } from "zustand";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Download, ExternalLink, RefreshCw, X } from "lucide-react";
import { api, on } from "../lib/api";
import { flushBeforeExit } from "../lib/exit";
import { renderMarkdown } from "../lib/markdown";
import { autoCheckAllowed, CHECK_INTERVAL_MS, FIRST_CHECK_DELAY_MS, NOT_CONFIGURED, progressLabel, progressValue } from "../lib/updates";
import type { UpdateInfo, UpdateProgress, UpdateStatus } from "../lib/types";
import { useApp } from "../store/app";
import { Button, Dialog, IconButton, Progress } from "./ui";

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
    if (manual) toast({ tone: "info", title: NOT_CONFIGURED });
    return;
  }
  if (useUpdates.getState().phase !== "idle") return;
  useUpdates.setState({ phase: "checking" });
  try {
    const found = await api.updateCheck();
    useUpdates.setState((s) => ({ available: found, checkedAt: new Date(), dismissed: manual ? null : s.dismissed }));
    if (!found && manual) toast({ tone: "success", title: "Annalo ist aktuell", detail: `Version ${status.current_version} ist die neueste.` });
  } catch (e) {
    if (manual) useApp.getState().error("Update-Prüfung fehlgeschlagen", e);
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
  if (!(await flushBeforeExit("Trotzdem aktualisieren"))) return;
  useUpdates.setState({ phase: "downloading", progress: null });
  const unlisten = on<UpdateProgress>("update://progress", (progress) => useUpdates.setState({ progress, phase: progress.percent === 100 ? "installing" : "downloading" }));
  try {
    // On Windows the installer ends this process and starts the new version.
    await api.updateInstall();
    useUpdates.setState({ phase: "installing" });
  } catch (e) {
    useUpdates.setState({ phase: "idle", progress: null });
    useApp.getState().error("Update fehlgeschlagen", e);
  } finally {
    unlisten.then((f) => f());
  }
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
            <div className="toast-title">{phase === "installing" ? `Version ${available.version} wird installiert` : `Version ${available.version} wird geladen`}</div>
            <div className="toast-detail">{phase === "installing" ? "Annalo startet gleich neu." : progressLabel(progress)}</div>
            {phase === "downloading" && <Progress value={progressValue(progress)} />}
          </>
        ) : (
          <>
            <div className="toast-title">Version {available.version} verfügbar</div>
            <div className="toast-detail">Offene Notizen werden vor dem Neustart gespeichert.</div>
            <div className="toast-actions">
              <Button size="sm" variant="primary" icon={RefreshCw} onClick={() => void installUpdate()}>
                Installieren und neu starten
              </Button>
              <Button size="sm" variant="ghost" onClick={() => useUpdates.setState({ notesOpen: true })}>
                Was ist neu?
              </Button>
            </div>
          </>
        )}
      </div>
      {!busy && <IconButton icon={X} label="Später" size="sm" onClick={() => useUpdates.setState({ dismissed: available.version })} />}
      <ReleaseNotes />
    </div>
  );
}

function ReleaseNotes() {
  const { available, notesOpen } = useUpdates();
  if (!available) return null;
  const close = () => useUpdates.setState({ notesOpen: false });
  return (
    <Dialog
      open={notesOpen}
      onClose={close}
      title={`Neu in Version ${available.version}`}
      description={available.date ? `Veröffentlicht am ${new Date(available.date).toLocaleDateString("de-DE")}` : undefined}
      width={520}
      footer={
        <>
          <Button variant="ghost" icon={ExternalLink} onClick={() => void openUrl(available.url).catch(() => {})}>
            Changelog auf GitHub
          </Button>
          <Button variant="primary" icon={RefreshCw} onClick={() => void installUpdate()}>
            Installieren und neu starten
          </Button>
        </>
      }
    >
      {available.notes ? (
        <div className="prose update-notes" dangerouslySetInnerHTML={{ __html: renderMarkdown(available.notes) }} />
      ) : (
        <p className="muted">Für diese Version sind keine Hinweise hinterlegt.</p>
      )}
    </Dialog>
  );
}
