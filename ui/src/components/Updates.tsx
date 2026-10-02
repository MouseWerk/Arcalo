// Auto-update: periodic checks, the background download with its status-bar hint (mode
// „automatisch“: „Update 1.9.1 bereit – wird beim Beenden installiert“), the „Version X
// verfügbar“ toast (mode „nur benachrichtigen“, installs on a click), „Später erinnern“ and
// „Diese Version überspringen“, release notes, and „Neu in Arcalo“ after an update. Builds
// without an update key never check.

import { useEffect, useState } from "react";
import { create } from "zustand";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowRight, CalendarClock, Download, ExternalLink, MoreHorizontal, Pause, Play, RefreshCw, RotateCcw, SkipForward, Sparkles, X } from "lucide-react";
import { api, on } from "../lib/api";
import { flushBeforeExit } from "../lib/exit";
import { renderMarkdown } from "../lib/markdown";
import { fmtDate } from "../lib/format";
import { autoCheckAllowed, checkIntervalMs, effectiveMode, FIRST_CHECK_DELAY_MS, manualUpdate, NOT_CONFIGURED, progressLabel, progressValue, REMIND_DAYS, updateHint } from "../lib/updates";
import { bundledNotes, HIGHLIGHTS, highlightsBetween, imageUrl, textOf, type Highlight, type VersionHighlights } from "../lib/highlights";
import { saveUpdateSession } from "../lib/updatesession";
import { openSettingsSection } from "../lib/calnav";
import type { UpdateInfo, UpdateProgress, UpdateStatus } from "../lib/types";
import { useApp } from "../store/app";
import { Button, Dialog, IconButton, Progress, Spinner, useMenu } from "./ui";
import { currentLang, t, useT } from "../lib/i18n";

/** `preparing`: the editors are being stored before the download (a second click waits for it). */
type Phase = "idle" | "checking" | "preparing" | "downloading" | "installing";

interface UpdateState {
  status: UpdateStatus | null;
  available: UpdateInfo | null;
  phase: Phase;
  progress: UpdateProgress | null;
  /** When the last check finished (successfully). */
  checkedAt: Date | null;
  /** Version whose toast the user closed; a manual check shows it again. */
  dismissed: string | null;
  /** Version whose status-bar hint „Später“ folded away (it still installs on quit). */
  hintHidden: string | null;
  notesOpen: boolean;
  /** „Neu in Arcalo“: the versions shown, and the one to mark as seen on close. */
  whatsNew: { versions: VersionHighlights[]; seen?: string } | null;
  /** Release notes of a version (Settings → Über → Neu in Arcalo). */
  releaseNotes: { version: string; text: string | null; error?: string } | null;
}

export const useUpdates = create<UpdateState>(() => ({
  status: null,
  available: null,
  phase: "idle",
  progress: null,
  checkedAt: null,
  dismissed: null,
  hintHidden: null,
  notesOpen: false,
  whatsNew: null,
  releaseNotes: null,
}));

// End-to-end runs (WebDriver) drive the update states: their builds have no update key.
if (typeof navigator !== "undefined" && navigator.webdriver) (window as unknown as { __annaloUpdates?: typeof useUpdates }).__annaloUpdates = useUpdates;

/** Reads the backend's state (after a check, a download step, a skip). */
export async function refreshUpdateStatus(): Promise<UpdateStatus | null> {
  try {
    const status = await api.updateStatus();
    useUpdates.setState((s) => ({ status, available: status.available ?? (status.policy ? null : s.available) }));
    return status;
  } catch {
    return null;
  }
}

export async function loadUpdateStatus(): Promise<UpdateStatus | null> {
  const status = await refreshUpdateStatus();
  if (!status) return null;
  const r = status.restarted;
  const back = status.rolled_back;
  // In the language of the settings, which may still be loading at start.
  for (let i = 0; (r || back) && !useApp.getState().settings && i < 100; i++) await new Promise((ok) => setTimeout(ok, 50));
  const toast = useApp.getState().toast;
  // The first start after an update (reported once): it worked, or the installer did not finish.
  if (r?.installed) {
    const versions = highlightsBetween(HIGHLIGHTS, r.from, r.version);
    const fresh = versions.length > 0 && status.whats_new_seen !== r.version;
    toast({
      tone: "success",
      title: t("upd.restarted", { version: r.version }),
      action: versions.length ? { label: t("wn.show"), run: () => useUpdates.setState({ whatsNew: { versions, seen: r.version } }) } : undefined,
    });
    if (fresh) useUpdates.setState({ whatsNew: { versions, seen: r.version } });
  } else if (r) toast({ tone: "warning", persistent: true, title: t("upd.notInstalled", { version: r.version }), detail: t("upd.notInstalledDetail", { current: status.current_version }) });
  if (back) toast({ tone: "warning", persistent: true, title: t("upd.rolledBack", { version: back.from }), detail: t("upd.rolledBackDetail", { version: back.to }) });
  return status;
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
    const found = await api.updateCheck(manual);
    useUpdates.setState((s) => ({ available: found, checkedAt: new Date(), dismissed: manual ? null : s.dismissed, hintHidden: manual ? null : s.hintHidden }));
    const fresh = await refreshUpdateStatus();
    if (!found && manual) {
      // A newer version the user skipped (or that did not start) is not „up to date“.
      if (fresh?.skipped) toast({ tone: "info", title: t("upd.upToDate"), detail: t("upd.latestSkipped", { version: status.current_version, skipped: fresh.skipped }) });
      else toast({ tone: "success", title: t("upd.upToDate"), detail: t("upd.latest", { version: status.current_version }) });
    }
  } catch (e) {
    if (manual) useApp.getState().error(t("upd.checkFailed"), e);
    else console.warn("update check failed", e);
  } finally {
    useUpdates.setState({ phase: "idle" });
  }
}

/** Mode „nur benachrichtigen“: stores all editors, then downloads, installs and restarts. */
export async function installUpdate() {
  const st = useUpdates.getState();
  if (!st.available || st.phase !== "idle") return;
  useUpdates.setState({ notesOpen: false, phase: "preparing", progress: null });
  if (!(await flushBeforeExit(t("upd.anyway")))) {
    useUpdates.setState({ phase: "idle" });
    return;
  }
  saveSessionIfWanted();
  useUpdates.setState({ phase: "downloading" });
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

/** Settings → Über „Sitzung nach dem Neustart wiederherstellen“: the open tabs come back as they are. */
function saveSessionIfWanted() {
  if (useApp.getState().settings?.settings.updates?.restore_session !== false) saveUpdateSession();
}

/** „Jetzt neu starten“ on the hint of a downloaded update. */
export async function restartNow() {
  const st = useUpdates.getState();
  if (st.phase !== "idle") return;
  useUpdates.setState({ phase: "preparing" });
  if (!(await flushBeforeExit(t("upd.anyway")))) {
    useUpdates.setState({ phase: "idle" });
    return;
  }
  saveSessionIfWanted();
  useUpdates.setState({ phase: "installing" });
  try {
    await api.updateRestartNow();
  } catch (e) {
    useUpdates.setState({ phase: "idle" });
    useApp.getState().error(t("upd.failed"), e);
  }
}

export async function skipVersion(version: string) {
  try {
    await api.updateSkip(version);
    useUpdates.setState({ available: null, notesOpen: false });
    await refreshUpdateStatus();
    useApp.getState().toast({ tone: "info", title: t("upd.skippedToast", { version }), action: { label: t("common.undo"), run: () => void undoSkip(true) } });
  } catch (e) {
    useApp.getState().error(t("upd.failed"), e);
  }
}

export async function undoSkip(check = false) {
  try {
    await api.updateUnskip();
    await refreshUpdateStatus();
    if (check) void checkForUpdates(false);
  } catch (e) {
    useApp.getState().error(t("upd.failed"), e);
  }
}

export async function remindLater(days: number) {
  try {
    const at = await api.updateRemind(days);
    useUpdates.setState((s) => ({ available: null, dismissed: s.available?.version ?? null, notesOpen: false }));
    await refreshUpdateStatus();
    useApp.getState().toast({ tone: "info", title: t("upd.remindToast", { date: fmtDate(at) }) });
  } catch (e) {
    useApp.getState().error(t("upd.failed"), e);
  }
}

/** The menu of „Später“: remind tomorrow or next week, or skip this version. */
function laterItems(version: string) {
  return [
    { label: t("upd.remindTomorrow"), icon: CalendarClock, onSelect: () => void remindLater(REMIND_DAYS.tomorrow) },
    { label: t("upd.remindNextWeek"), icon: CalendarClock, onSelect: () => void remindLater(REMIND_DAYS.nextWeek) },
    "separator" as const,
    { label: t("upd.skip"), icon: SkipForward, onSelect: () => void skipVersion(version) },
  ];
}

/** Portable copy or system package: the release page, where the ZIP or package is downloaded by hand (nothing is installed). */
export async function downloadPortable(url?: string) {
  const target = url ?? useUpdates.getState().available?.url;
  if (!target) return;
  useUpdates.setState({ notesOpen: false });
  await openUrl(target).catch((e) => useApp.getState().error(t("upd.releasePageFailed"), e));
}

/** The update action: install and restart, or (portable) download from the release page. */
export function UpdateAction({ size }: { size?: "sm" | "md" }) {
  const t = useT();
  const manual = useUpdates((s) => manualUpdate(s.status));
  const busy = useUpdates((s) => s.phase === "preparing" || s.phase === "downloading" || s.phase === "installing");
  const ready = useUpdates((s) => effectiveMode(s.status) === "auto" && !!s.available && s.status?.ready === s.available.version);
  if (manual)
    return (
      <Button size={size} variant="primary" icon={Download} onClick={() => void downloadPortable()}>
        {manual === "package" ? t("upd.packageAction") : t("upd.download")}
      </Button>
    );
  return (
    <Button size={size} variant="primary" icon={RefreshCw} loading={busy} disabled={busy} onClick={() => void (ready ? restartNow() : installUpdate())}>
      {ready ? t("upd.restartNow") : t("upd.install")}
    </Button>
  );
}

/** Checks shortly after start and then every few hours (Settings or the organization's policy); returns the cleanup. */
export function startUpdateChecks(): () => void {
  const auto = () => {
    const { status } = useUpdates.getState();
    if (autoCheckAllowed(status, useApp.getState().settings?.settings.auto_update_check)) void checkForUpdates(false);
  };
  let every: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    clearTimeout(every);
    every = setTimeout(() => {
      auto();
      schedule();
    }, checkIntervalMs(useUpdates.getState().status));
  };
  void loadUpdateStatus().then(schedule);
  const first = setTimeout(auto, FIRST_CHECK_DELAY_MS);
  // The background download reports each step; the status follows (at most every 300 ms).
  let pending: ReturnType<typeof setTimeout> | undefined;
  const refresh = () => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = undefined;
      void refreshUpdateStatus();
    }, 300);
  };
  const offState = on("update://state", refresh);
  const offProgress = on<UpdateProgress>("update://progress", (progress) => {
    useUpdates.setState({ progress });
    refresh();
  });
  // A changed interval (Settings) applies from now on.
  const offSettings = useApp.subscribe((s, prev) => {
    if (s.settings?.settings.updates !== prev.settings?.settings.updates) void refreshUpdateStatus().then(schedule);
  });
  return () => {
    clearTimeout(first);
    clearTimeout(every);
    clearTimeout(pending);
    offState.then((f) => f());
    offProgress.then((f) => f());
    offSettings();
  };
}

/** The persistent update toast (mode „nur benachrichtigen“), shown above the other toasts. */
export function UpdateToast() {
  const t = useT();
  const { available, phase, progress, dismissed, status } = useUpdates();
  const [menu, , openMenuAt] = useMenu();
  const manual = manualUpdate(status);
  // Settings → Benachrichtigungen „Neue Version verfügbar“ (the settings' Über section still shows it).
  const notifyUpdates = useApp((st) => st.settings?.settings.notifications?.updates !== false);
  if (!available) return null;
  const busy = phase === "preparing" || phase === "downloading" || phase === "installing";
  // Mode „automatisch“: the status bar shows the download and the hint, no toast.
  if (!busy && effectiveMode(status) === "auto") return null;
  if (!busy && (dismissed === available.version || !notifyUpdates)) return null;
  return (
    <div className="toast toast-info update-toast" role="status">
      <Download size={16} className="toast-icon" />
      <div className="toast-body">
        {busy ? (
          <>
            <div className="toast-title">{phase === "installing" ? t("upd.installing", { version: available.version }) : t("upd.downloading", { version: available.version })}</div>
            <div className="toast-detail">{phase === "installing" ? t("upd.restartSoon") : phase === "preparing" ? t("upd.preparing") : progressLabel(progress)}</div>
            {phase === "downloading" && <Progress value={progressValue(progress)} />}
          </>
        ) : (
          <>
            <div className="toast-title">{t("upd.availableShort", { version: available.version })}</div>
            <div className="toast-detail">{manual === "portable" ? t("upd.portableHint") : manual === "package" ? t("upd.package") : t("upd.savedFirst")}</div>
            <div className="toast-actions">
              <UpdateAction size="sm" />
              <Button size="sm" variant="ghost" onClick={() => useUpdates.setState({ notesOpen: true })}>
                {t("upd.whatsNew")}
              </Button>
              <IconButton icon={MoreHorizontal} label={t("upd.later")} size="sm" onClick={(e) => openMenuAt(e, laterItems(available.version))} />
            </div>
          </>
        )}
      </div>
      {!busy && <IconButton icon={X} label={t("common.later")} size="sm" onClick={() => useUpdates.setState({ dismissed: available.version })} />}
      {menu}
      <ReleaseNotes />
    </div>
  );
}

/** The status-bar item of a background update: progress (pausable), or the calm „bereit“ hint. */
export function UpdateStatusItem() {
  const t = useT();
  const { status, available, hintHidden, progress, phase } = useUpdates();
  const [menu, , openMenuAt] = useMenu();
  const hint = updateHint(status, available);
  if (hint.kind === "none") return null;
  if (hint.kind === "downloading") {
    const percent = progress?.percent ?? hint.percent;
    return (
      <span className="sb-item sb-static sb-update" data-state="downloading" title={t("upd.downloadingBg", { version: hint.version })}>
        <Download size={12} />
        <span>{t("upd.sbDownloading", { version: hint.version })}</span>
        {percent != null && <span className="num faint">{percent} %</span>}
        <span className="sb-update-bar" aria-hidden>
          <span style={{ width: `${percent ?? 0}%` }} />
        </span>
        <button type="button" className="sb-update-btn" aria-label={t("upd.pause")} title={t("upd.pause")} onClick={() => void api.updatePause()}>
          <Pause size={12} />
        </button>
      </span>
    );
  }
  if (hint.kind === "paused" || hint.kind === "failed") {
    return (
      <span className="sb-item sb-static sb-update" data-state={hint.kind} title={hint.kind === "failed" ? (hint.error ?? undefined) : undefined}>
        <Download size={12} />
        <span>{hint.kind === "paused" ? t("upd.sbPaused", { version: hint.version }) : t("upd.sbFailed", { version: hint.version })}</span>
        <button type="button" className="sb-update-btn" aria-label={t("upd.resume")} title={t("upd.resume")} onClick={() => void api.updateDownload().catch((e) => useApp.getState().error(t("upd.failed"), e))}>
          {hint.kind === "paused" ? <Play size={12} /> : <RotateCcw size={12} />}
        </button>
      </span>
    );
  }
  // Ready: folded away by „Später“, only a small mark remains.
  if (hintHidden === hint.version)
    return (
      <button type="button" className="sb-item sb-update" data-state="ready-folded" title={t("upd.sbReady", { version: hint.version })} onClick={() => useUpdates.setState({ hintHidden: null })}>
        <Sparkles size={12} />
        <span>{hint.version}</span>
      </button>
    );
  const busy = phase !== "idle";
  return (
    <span className="sb-item sb-static sb-update sb-update-ready" data-state="ready" role="status">
      <Sparkles size={12} />
      <span className="sb-update-text">{hint.installNow || !hint.window ? t("upd.sbReady", { version: hint.version }) : t("upd.sbReadyWindow", { version: hint.version, window: hint.window })}</span>
      {hint.installNow && (
        <button type="button" className="sb-update-action primary" disabled={busy} onClick={() => void restartNow()}>
          {busy ? <Spinner size={11} /> : null}
          {t("upd.restartNow")}
        </button>
      )}
      <button type="button" className="sb-update-action" onClick={() => useUpdates.setState({ hintHidden: hint.version })}>
        {t("upd.later")}
      </button>
      <button type="button" className="sb-update-btn" aria-label={t("upd.moreOptions")} title={t("upd.moreOptions")} onClick={(e) => openMenuAt(e, laterItems(hint.version))}>
        <MoreHorizontal size={12} />
      </button>
      {menu}
    </span>
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

/** Closes „Neu in Arcalo“; after an update it does not come again. */
function closeWhatsNew() {
  const seen = useUpdates.getState().whatsNew?.seen;
  useUpdates.setState({ whatsNew: null });
  if (seen) void api.updateWhatsNewSeen(seen).catch(() => {});
}

/** Opens the action of a highlight (a view, a settings section, a command of the keymap). */
function runHighlight(h: Highlight) {
  const a = h.action;
  if (!a) return;
  closeWhatsNew();
  if (a.type === "settings") openSettingsSection(a.section);
  else if (a.type === "view") useApp.getState().openTab({ kind: a.view });
  else window.dispatchEvent(new CustomEvent("annalo:run-command", { detail: a.command }));
}

/** „Neu in Arcalo 1.9“: the highlights of an update, after its first start or from Settings → Über. */
export function WhatsNewDialog() {
  const t = useT();
  const whatsNew = useUpdates((s) => s.whatsNew);
  const lang = currentLang();
  const close = closeWhatsNew;
  const versions = whatsNew?.versions ?? [];
  const newest = versions[0]?.version ?? "";
  return (
    <Dialog open={!!whatsNew && versions.length > 0} onClose={close} title={t("wn.title", { version: newest })} description={t("wn.subtitle")} width={600}
      footer={
        <>
          <Button variant="ghost" onClick={() => void showReleaseNotes(newest)}>
            {t("wn.allNotes")}
          </Button>
          <Button variant="primary" onClick={close}>
            {t("wn.done")}
          </Button>
        </>
      }
    >
      <div className="whatsnew">
        {versions.map((v) => (
          <section key={v.version} className="whatsnew-version">
            {versions.length > 1 && <h3 className="whatsnew-version-title">{t("upd.version", { version: v.version })}</h3>}
            <ul className="whatsnew-list">
              {v.items.map((h) => {
                const text = textOf(h, lang);
                const img = imageUrl(h.image);
                return (
                  <li key={h.id} className={`whatsnew-item ${img ? "has-image" : ""}`} data-id={h.id}>
                    {img ? <img className="whatsnew-image" src={img} alt="" /> : <span className="whatsnew-dot" aria-hidden><Sparkles size={14} /></span>}
                    <div className="whatsnew-text">
                      <div className="whatsnew-item-title">{text.title}</div>
                      <p>{text.text}</p>
                      {h.action && (
                        <button type="button" className="whatsnew-action" onClick={() => runHighlight(h)}>
                          {text.action ?? (h.action.type === "settings" ? t("wn.openSettings") : t("wn.open"))}
                          <ArrowRight size={13} />
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </Dialog>
  );
}

/** The full release notes of `version`: bundled, or from the repository. */
export async function showReleaseNotes(version: string) {
  useUpdates.setState({ releaseNotes: { version, text: null } });
  try {
    const text = (await bundledNotes(version)) ?? (await api.updateReleaseNotes(version));
    useUpdates.setState({ releaseNotes: { version, text } });
  } catch (e) {
    useUpdates.setState({ releaseNotes: { version, text: null, error: String(e) } });
  }
}

/** Strips the first line („Arcalo 1.9.0“) the release files start with. */
const notesBody = (md: string) => md.replace(/^\s*Arcalo [^\n]*\n/, "");

function ReleaseNotesDialog() {
  const t = useT();
  const notes = useUpdates((s) => s.releaseNotes);
  const [html, setHtml] = useState("");
  useEffect(() => setHtml(notes?.text ? renderMarkdown(notesBody(notes.text)) : ""), [notes?.text]);
  if (!notes) return null;
  return (
    <Dialog open onClose={() => useUpdates.setState({ releaseNotes: null })} title={t("wn.notesTitle", { version: notes.version })} width={640}>
      {notes.error ? (
        <p className="muted">{t("wn.notesFailed")}</p>
      ) : notes.text == null ? (
        <div className="whatsnew-loading">
          <Spinner />
        </div>
      ) : (
        <div className="prose update-notes release-notes" dangerouslySetInnerHTML={{ __html: html }} />
      )}
    </Dialog>
  );
}

/** Everything of the updater that floats: the toast, „Neu in Arcalo“ and the release notes. */
export function UpdateLayer() {
  return (
    <>
      <UpdateToast />
      <WhatsNewDialog />
      <ReleaseNotesDialog />
    </>
  );
}


