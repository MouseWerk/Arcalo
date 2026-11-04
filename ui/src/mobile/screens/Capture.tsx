// Schnellerfassung: a note or a task into today's daily note or the inbox (also with text shared
// from another app), or a booking (the form of the „Zeit“ tab).

import { useEffect, useMemo, useRef, useState } from "react";
import { fmtDate } from "../../lib/format";
import { draftSaver, loadDraft, normalizeCapture } from "../../lib/capture";
import { t } from "../../lib/i18n";
import { mobileApi } from "../api";
import { errorText, useMobile } from "../context";
import { captureDraft, captureMarkdown, dueOf, noonOf, restoreCapture, type CaptureMode, type DueChoice } from "../model";
import { Header, Segmented } from "../ui";
import { ZeitForm } from "./Time";

export function CaptureScreen({ mode: initial, text: shared }: { mode: CaptureMode; text?: string }) {
  const m = useMobile();
  const timeOn = m.settings.time?.enabled !== false;
  const [mode, setMode] = useState<CaptureMode>(initial === "booking" && !timeOn ? "note" : initial);
  const [text, setText] = useState(shared ?? "");
  const [inbox, setInbox] = useState(false);
  const [due, setDue] = useState<DueChoice>("none");
  const [busy, setBusy] = useState(false);

  // The text typed is kept until it is saved (Back, the close button, Android ending the app in
  // the background lost it): the draft opens again with the next capture, as on the desktop.
  const drafts = useMemo(() => draftSaver(mobileApi.captureDraft), []);
  const draftRead = useRef(false);
  const typed = useRef(false);
  useEffect(() => {
    let live = true;
    // Text shared from another app comes first; the draft stays until that text is typed on.
    if (shared) return;
    void loadDraft(mobileApi.captureDraft)
      .then((d) => {
        const back = restoreCapture(d);
        if (!live || !back || typed.current) return;
        setMode(back.mode);
        setText(back.text);
        setInbox(back.inbox);
        setDue(back.due);
      })
      .finally(() => {
        if (live) draftRead.current = true;
      });
    return () => {
      live = false;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    // A booking has its own form: the note's text stays kept meanwhile.
    if (mode === "booking") return;
    if (draftRead.current || typed.current) drafts.save(captureDraft(mode, text, inbox, due));
  }, [drafts, mode, text, inbox, due]);
  // Stored at once when the app goes to the background or the capture closes.
  useEffect(() => {
    const onHidden = () => document.visibilityState === "hidden" && void drafts.flush();
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      document.removeEventListener("visibilitychange", onHidden);
      void drafts.flush();
    };
  }, [drafts]);

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
      typed.current = false;
      // Removed before the capture closes: one opened right after must not bring the text back.
      await drafts.flush();
      await mobileApi.captureDraft.set(null).catch(() => {});
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
              onChange={(e) => {
                typed.current = true;
                setText(e.target.value);
              }}
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
