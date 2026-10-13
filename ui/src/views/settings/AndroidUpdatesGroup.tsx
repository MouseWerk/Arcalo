// Settings → Über Arcalo → Updates in the full app on Android (1.20): the Android app's own
// updates (src-tauri/src/mobile/apkupdate.rs), as the phone app's settings offer them: the check,
// the download over mobile data, Android's installer and its permission. The desktop's updater
// does not exist there.

import { useEffect, useState } from "react";
import { Download, RefreshCw, ShieldAlert } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { Button, Progress, Switch } from "../../components/ui";
import { useT } from "../../lib/i18n";
import { mobileApi, type UpdateStatus } from "../../mobile/api";
import { updateLine, updateProgress } from "../../mobile/model";
import { useApp } from "../../store/app";
import { Group, Row, StatusNote } from "./common";

export function AndroidUpdatesGroup() {
  const t = useT();
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [needsPermission, setNeedsPermission] = useState(false);
  const s = useApp.getState;
  useEffect(() => {
    let live = true;
    mobileApi.update.status().then(
      (x) => live && setStatus(x),
      () => live && setStatus(null),
    );
    const off = listen<UpdateStatus>("apkupdate://status", (e) => live && setStatus(e.payload)).catch(() => null);
    return () => {
      live = false;
      void off.then((f) => f?.());
    };
  }, []);
  if (!status) return null;
  const run = (f: () => Promise<unknown>) => {
    setBusy(true);
    void f()
      .catch((e) => s().error(t("mob.upd.failed"), e))
      .finally(() => setBusy(false));
  };
  const install = () =>
    run(async () => {
      setNeedsPermission((await mobileApi.update.install()) === "needs_permission");
    });
  const allow = () =>
    run(async () => {
      if (await mobileApi.update.allowInstall()) {
        setNeedsPermission(false);
        await mobileApi.update.install();
      } else {
        s().toast({ tone: "info", title: t("mob.upd.permissionDenied") });
      }
    });
  if (!status.configured) {
    return (
      <Group title={t("set.about.updates")}>
        <Row label={t("set.about.updates")} description={t("mob.upd.notConfigured")}>
          <span />
        </Row>
      </Group>
    );
  }
  const line = updateLine(status);
  const running = status.phase === "checking" || status.phase === "downloading";
  return (
    <Group title={t("set.about.updates")} help="updates">
      <Row label={line.text} description={line.detail ?? undefined}>
        <div className="set-actions">
          {status.phase === "ready" && !needsPermission && (
            <Button variant="primary" icon={Download} onClick={install} loading={busy}>
              {t("mob.upd.install")}
            </Button>
          )}
          {status.phase === "waiting" && status.metered && (
            <Button icon={Download} onClick={() => run(() => mobileApi.update.download().then(setStatus))} disabled={busy}>
              {t("mob.upd.downloadNow")}
            </Button>
          )}
          <Button variant="ghost" icon={RefreshCw} onClick={() => run(() => mobileApi.update.check(true).then(setStatus))} disabled={busy || running}>
            {t("mob.upd.check")}
          </Button>
        </div>
      </Row>
      {status.phase === "downloading" && <Progress value={updateProgress(status)} />}
      {needsPermission && (
        <Row label={t("mob.upd.permissionTitle")} description={t("mob.upd.permissionText")}>
          <Button icon={ShieldAlert} onClick={allow} disabled={busy}>
            {t("mob.upd.permissionOpen")}
          </Button>
        </Row>
      )}
      {status.phase === "blocked" && status.blocked && <StatusNote tone="warning">{status.blocked}</StatusNote>}
      <Row label={t("mob.upd.mobileData")} description={t("mob.upd.mobileDataDesc")}>
        <Switch
          label={t("mob.upd.mobileData")}
          checked={status.allow_mobile_data}
          onChange={(v) => void mobileApi.update.setMobileData(v).then(setStatus, (e) => s().error(t("common.saveFailed"), e))}
        />
      </Row>
    </Group>
  );
}
