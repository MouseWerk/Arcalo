// The app's own updates on screen: the banner on „Heute“ when a checked update is ready (or
// cannot be installed over this app), and the „Updates“ section of the settings with the check,
// the download over mobile data, the release notes and „Update installieren“.

import { useState } from "react";
import { ChevronDown, ChevronRight, CircleArrowDown, ShieldAlert, TriangleAlert } from "lucide-react";
import { renderMarkdown } from "../lib/markdown";
import { t } from "../lib/i18n";
import { mobileApi } from "./api";
import { errorText, useMobile } from "./context";
import { updateLine, updateProgress } from "./model";
import { Notice, Spinner, Switch } from "./ui";

const openPage = (url: string) => void import("@tauri-apps/plugin-opener").then((o) => o.openUrl(url)).catch(() => {});

/** „Was ist neu“: the release notes of the offered version, folded until tapped. */
function ReleaseNotes({ notes }: { notes: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="m-upd-notes">
      <button type="button" className="m-row m-upd-notes-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="m-row-main">
          <span className="m-row-title">{t("mob.upd.notes")}</span>
        </span>
        {open ? <ChevronDown size={18} className="m-chevron" /> : <ChevronRight size={18} className="m-chevron" />}
      </button>
      {open && <div className="m-read m-upd-notes-text" dangerouslySetInnerHTML={{ __html: renderMarkdown(notes) }} />}
    </div>
  );
}

/** The app may not install apps yet: the way to Android's setting, then the installation. */
function PermissionNotice() {
  const m = useMobile();
  const [busy, setBusy] = useState(false);
  return (
    <Notice
      tone="warning"
      icon={<ShieldAlert size={18} />}
      action={
        <button
          type="button"
          className="m-btn"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void m.allowInstall().finally(() => setBusy(false));
          }}
        >
          {t("mob.upd.permissionOpen")}
        </button>
      }
    >
      <strong>{t("mob.upd.permissionTitle")}</strong>
      <span>{t("mob.upd.permissionText")}</span>
    </Notice>
  );
}

/** On „Heute“: a ready update with „Update installieren“, or why a newer version cannot be
 *  installed over this app. Nothing otherwise. */
export function UpdateBanner() {
  const m = useMobile();
  const s = m.update;
  if (!s?.offered || (s.phase !== "ready" && s.phase !== "blocked")) return null;
  const line = updateLine(s);
  if (s.phase === "blocked") {
    return (
      <Notice
        tone="warning"
        icon={<TriangleAlert size={18} />}
        action={
          <button type="button" className="m-btn" onClick={() => openPage(s.offered!.page)}>
            {t("mob.upd.releasePage")}
          </button>
        }
      >
        <strong>{line.text}</strong>
        {line.detail && <span>{line.detail}</span>}
      </Notice>
    );
  }
  return (
    <section className="m-section">
      <div className="m-card m-upd-card" role="status">
        <div className="m-upd-head">
          <span className="m-row-icon m-upd-icon">
            <CircleArrowDown size={20} />
          </span>
          <span className="m-row-main">
            <span className="m-row-title">{line.text}</span>
            <span className="m-row-sub m-wrap">{line.detail}</span>
          </span>
        </div>
        {m.installBlocked ? (
          <PermissionNotice />
        ) : (
          <button type="button" className="m-btn m-btn-primary m-btn-block" onClick={() => void m.installUpdate()}>
            {t("mob.upd.install")}
          </button>
        )}
        {s.offered.notes && <ReleaseNotes notes={s.offered.notes} />}
      </div>
    </section>
  );
}

/** Einstellungen → Updates. */
export function UpdateSection() {
  const m = useMobile();
  const s = m.update;
  const [busy, setBusy] = useState(false);
  if (!s?.configured) {
    return <p className="m-desc">{t("mob.upd.notConfigured")}</p>;
  }
  const line = updateLine(s);
  const running = s.phase === "checking" || s.phase === "downloading";
  const run = (f: () => Promise<unknown>) => {
    setBusy(true);
    void f()
      .catch((e) => m.toast("error", t("mob.upd.failed"), errorText(e)))
      .finally(() => setBusy(false));
  };
  return (
    <>
      <div className="m-upd-status" aria-live="polite">
        <span className="m-row-main">
          <span className="m-row-title m-wrap">{line.text}</span>
          {line.detail && <span className="m-row-sub m-wrap">{line.detail}</span>}
        </span>
        {running && <Spinner />}
      </div>
      {s.phase === "downloading" && (
        <div className="m-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(updateProgress(s) * 100)} aria-label={line.text}>
          <div className="m-progress-fill" style={{ width: `${updateProgress(s) * 100}%` }} />
        </div>
      )}
      {s.phase === "ready" && m.installBlocked && <PermissionNotice />}
      <div className="m-form-actions">
        {s.phase === "ready" && !m.installBlocked && (
          <button type="button" className="m-btn m-btn-primary" onClick={() => void m.installUpdate()}>
            {t("mob.upd.install")}
          </button>
        )}
        {s.phase === "waiting" && s.metered && (
          <button type="button" className="m-btn" disabled={busy} onClick={() => run(() => mobileApi.update.download().then(m.setUpdate))}>
            {t("mob.upd.downloadNow")}
          </button>
        )}
        {s.phase === "blocked" && s.offered && (
          <button type="button" className="m-btn" onClick={() => openPage(s.offered!.page)}>
            {t("mob.upd.releasePage")}
          </button>
        )}
        <button type="button" className="m-btn" disabled={busy || running} onClick={() => run(() => mobileApi.update.check(true).then(m.setUpdate))}>
          {t("mob.upd.check")}
        </button>
      </div>
      <div className="m-divider" />
      <Switch
        checked={s.allow_mobile_data}
        onChange={(v) => void mobileApi.update.setMobileData(v).then(m.setUpdate).catch((e) => m.toast("error", t("common.saveFailed"), errorText(e)))}
        label={t("mob.upd.mobileData")}
        desc={t("mob.upd.mobileDataDesc")}
      />
      {s.offered?.notes && s.phase !== "idle" && <ReleaseNotes notes={s.offered.notes} />}
    </>
  );
}
