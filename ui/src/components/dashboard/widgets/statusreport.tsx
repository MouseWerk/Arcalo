// Start page widget „Statusbericht“: the last report written (title, scope, when) with
// „Öffnen“ and „Neu erstellen“ (the same scope and period kind, written again in place for the
// same period), or „Statusbericht erstellen“ before the first one.

import { useState } from "react";
import { FileBarChart, FileText, RefreshCw } from "lucide-react";
import { useApp } from "../../../store/app";
import { useT } from "../../../lib/i18n";
import { fmtDate } from "../../../lib/format";
import { meetApi, type LastReport } from "../../../lib/meetwork";
import { openStatusReport } from "../../MeetingWork";
import { Button } from "../../ui";
import { flushAllEditors } from "../../../editor/saves";
import { reloadEditors } from "../../../editor/NoteEditor";
import { defineWidget } from "../define";
import { useLazyData } from "../data";
import { Empty, Loadable } from "../common";
import type { WidgetProps } from "../registry";

const s = () => useApp.getState();

function StatusReportWidget({ widget }: WidgetProps) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const { data, error, loading, reload } = useLazyData<LastReport | null>(widget.id, () => meetApi.lastReport(), { topics: ["pages"], every: 300_000 });
  const again = async (last: LastReport) => {
    setBusy(true);
    try {
      await flushAllEditors().catch(() => {});
      const r = await meetApi.report(crypto.randomUUID(), last.request);
      if (!r.created) reloadEditors([r.page.id]);
      await s().refreshTree();
      s().toast({ tone: "success", title: t(r.created ? "mw.sr.created" : "mw.sr.updated"), detail: r.page.title });
      reload?.();
    } catch (e) {
      s().error(t("mw.sr.failed"), e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Loadable loading={loading && data === undefined} error={error}>
      {() => {
        const last = data ?? null;
        if (!last)
          return (
            <Empty icon={FileBarChart} action={<Button size="sm" className="dw-sr-new" onClick={() => openStatusReport()}>{t("mw.sr.create")}</Button>}>
              {t("mw.w.none")}
            </Empty>
          );
        return (
          <div className="dw-sr">
            <button type="button" className="dw-sr-title" onClick={() => s().openPage(last.page_id)}>
              <FileText size={14} aria-hidden />
              <span className="ellipsis">{last.title}</span>
            </button>
            <div className="faint small dw-sr-meta">
              <span className="ellipsis">{last.request.scope.label}</span>
              <span className="num">{t("mw.w.at", { date: fmtDate(last.at) })}</span>
            </div>
            <div className="dw-sr-actions">
              <Button size="sm" variant="primary" icon={RefreshCw} loading={busy} className="dw-sr-again" onClick={() => void again(last)}>
                {t("mw.w.again")}
              </Button>
              <Button size="sm" variant="ghost" className="dw-sr-other" onClick={() => openStatusReport(last.request.scope)}>
                {t("mw.w.other")}
              </Button>
            </div>
          </div>
        );
      }}
    </Loadable>
  );
}

defineWidget({
  kind: "statusreport",
  label: "mw.w.label",
  hint: "mw.w.hint",
  group: "tools",
  size: { w: 4, h: 4 },
  min: { w: 3, h: 3 },
  config: () => ({}),
  icon: FileBarChart,
  look: "text",
  body: StatusReportWidget,
  opener: () => () => openStatusReport(),
});
