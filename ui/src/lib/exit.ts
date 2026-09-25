// Storing pending edits before the app goes away (quit, close, update).

import { getCurrentWindow } from "@tauri-apps/api/window";
import { flushAllEditors } from "../editor/NoteEditor";
import { useApp } from "../store/app";
import { t } from "./i18n";

/** Stores pending edits before the app goes away; false when the user chose to stay. */
export async function flushBeforeExit(confirmLabel = t("exit.closeAnyway")): Promise<boolean> {
  try {
    await Promise.race([flushAllEditors(), new Promise((_, fail) => setTimeout(() => fail(new Error("timeout")), 5000))]);
    return true;
  } catch {
    // Quitting from the tray: the window may be hidden, but the question needs an answer.
    const win = getCurrentWindow();
    await win.show().catch(() => {});
    await win.setFocus().catch(() => {});
    return useApp.getState().confirm({
      title: t("exit.unsaved"),
      message: t("exit.unsavedText", { action: confirmLabel }),
      confirmLabel,
      danger: true,
    });
  }
}
