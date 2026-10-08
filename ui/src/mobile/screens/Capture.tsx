// Schnellerfassung: a note or a task into today's daily note or the inbox, or a booking (the
// form of the „Zeit“ tab).

import { useState } from "react";
import { fmtDate } from "../../lib/format";
import { normalizeCapture } from "../../lib/capture";
import { t } from "../../lib/i18n";
import { mobileApi } from "../api";
import { errorText, useMobile } from "../context";
import { captureMarkdown, dueOf, noonOf, type CaptureMode, type DueChoice } from "../model";
import { Header, Segmented } from "../ui";
import { ZeitForm } from "./Time";

export function CaptureScreen({ mode: initial }: { mode: CaptureMode }) {
  const m = useMobile();
  const timeOn = m.settings.time?.enabled !== false;
  const [mode, setMode] = useState<CaptureMode>(initial === "booking" && !timeOn ? "note" : initial);
  const [text, setText] = useState("");
  const [inbox, setInbox] = useState(false);
  const [due, setDue] = useState<DueChoice>("none");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (mode === "booking") return;
    const md = captureMarkdown(mode, normalizeCapture(text), dueOf(due));
    if (!md) {
      m.toast("info", t("mob.cap.empty"));
      return;
    }
    setBusy(true);
    try {
      const page = await mobileApi.capture(md, inbox);
      m.toast("success", t("mob.cap.saved", { title: page.title }));
      m.back();
    } catch (e) {
      m.toast("error", t("common.saveFailed"), errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const modes: { value: CaptureMode; label: string }[] = [
    { value: "note", label: t("mob.cap.note") },
    { value: "task", label: t("mob.cap.task") },
    ...(timeOn ? [{ value: "booking" as const, label: t("mob.cap.booking") }] : []),
  ];
  const dueDate = dueOf(due);
  return (
    <div className="m-screen m-sheet">
      <Header title={t("mob.cap.title")} back="close" />
      <div className="m-toolbar">
        <Segmented label={t("mob.cap.kind")} value={mode} onChange={setMode} options={modes} />
      </div>
      <div className="m-scroll m-form">
        {mode === "booking" ? (
          <ZeitForm onBooked={() => m.back()} />
        ) : (
          <>
            <textarea
              className="m-textarea"
              value={text}
              autoFocus
              rows={mode === "note" ? 8 : 3}
              placeholder={mode === "note" ? t("mob.cap.notePlaceholder") : t("mob.cap.taskPlaceholder")}
              onChange={(e) => setText(e.target.value)}
              aria-label={mode === "note" ? t("mob.cap.note") : t("mob.cap.task")}
            />
            {mode === "task" && (
              <div className="m-field">
                <div className="m-field-label">{t("mob.cap.due")}</div>
                <div className="m-chips m-chips-grid">
                  {(["none", "today", "tomorrow", "nextWeek"] as const).map((c) => (
                    <button key={c} type="button" className={due === c ? "m-chip-btn on" : "m-chip-btn"} aria-pressed={due === c} onClick={() => setDue(c)}>
                      {c === "none" ? t("mob.cap.noDate") : c === "today" ? t("mob.daily.today") : c === "tomorrow" ? t("mob.cap.tomorrow") : t("mob.cap.nextWeek")}
                    </button>
                  ))}
                </div>
                {dueDate && <div className="m-field-hint">{fmtDate(noonOf(dueDate))}</div>}
              </div>
            )}
            <div className="m-field">
              <div className="m-field-label">{t("mob.cap.target")}</div>
              <Segmented
                label={t("mob.cap.target")}
                value={inbox ? "inbox" : "daily"}
                onChange={(v) => setInbox(v === "inbox")}
                options={[
                  { value: "daily", label: t("mob.cap.daily") },
                  { value: "inbox", label: t("mob.cap.inbox") },
                ]}
              />
            </div>
            <div className="m-form-actions">
              <button type="button" className="m-btn m-btn-primary m-btn-block" disabled={busy || !text.trim()} onClick={() => void save()}>
                {t("mob.cap.save")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
