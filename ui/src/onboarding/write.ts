// Settings writes of the first-run flow: every answer is saved at once, one save after the
// other (quick clicks keep the last choice), always on top of the newest stored settings.

import { api } from "../lib/api";
import { t } from "../lib/i18n";
import type { Settings, SettingsView } from "../lib/types";
import { useApp } from "../store/app";

let queue: Promise<unknown> = Promise.resolve();

/** Applies `patch` to the stored settings and saves them; null when the save failed (reported). */
export function writeSettings(patch: (s: Settings) => Settings): Promise<SettingsView | null> {
  const run = async () => {
    try {
      const view = useApp.getState().settings ?? (await api.settings());
      const saved = await api.saveSettings(patch(structuredClone(view.settings)));
      useApp.getState().set({ settings: saved });
      return saved;
    } catch (e) {
      useApp.getState().error(t("fr.saveFailed"), e);
      return null;
    }
  };
  const next = queue.then(run);
  queue = next;
  return next;
}

/** Waits for the saves that are still running (before the summary or closing). */
export const settled = () => queue.then(() => undefined);
