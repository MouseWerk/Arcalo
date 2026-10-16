// Storing pending edits before the app goes away (quit, close, update).

import { getCurrentWindow } from "@tauri-apps/api/window";
import { flushAllEditors } from "../editor/NoteEditor";
import { useApp } from "../store/app";
import { t } from "./i18n";
import { useVoice } from "./voice";

/** Brings the window up: quitting from the tray, it may be hidden, but the question needs an answer. */
async function showWindow() {
  const win = getCurrentWindow();
  await win.show().catch(() => {});
  await win.setFocus().catch(() => {});
}

/**
 * A voice note is recorded or transcribed: asked first. The shell then keeps the recording for the
 * next start, and an interrupted transcription can be started again („Neu transkribieren“).
 */
async function confirmVoice(confirmLabel: string): Promise<boolean> {
  const { recording, jobs } = useVoice.getState().status;
  if (!recording && !jobs.length) return true;
  await showWindow();
  return useApp.getState().confirm({
    title: recording ? t("exit.recording") : t("exit.transcribing"),
    message: recording ? t("exit.recordingText", { action: confirmLabel }) : t("exit.transcribingText", { action: confirmLabel }),
    confirmLabel,
    danger: true,
  });
}

/** Stores pending edits before the app goes away; false when the user chose to stay. */
export async function flushBeforeExit(confirmLabel = t("exit.closeAnyway")): Promise<boolean> {
  if (!(await confirmVoice(confirmLabel))) return false;
  try {
    await Promise.race([flushAllEditors(), new Promise((_, fail) => setTimeout(() => fail(new Error("timeout")), 5000))]);
    return true;
  } catch {
    await showWindow();
    return useApp.getState().confirm({
      title: t("exit.unsaved"),
      message: t("exit.unsavedText", { action: confirmLabel }),
      confirmLabel,
      danger: true,
    });
  }
}
