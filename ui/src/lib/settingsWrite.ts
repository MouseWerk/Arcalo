// Settings are saved as a whole object. A write built from a copy taken earlier (the settings
// view's draft, the store before another save landed) would take back what was changed since:
// every write here applies its change to the settings as stored when it runs, one after another.

import { api } from "./api";
import type { Settings, SettingsView } from "./types";
import { useApp } from "../store/app";

let chain: Promise<unknown> = Promise.resolve();

/** Saves `change` applied to the current settings (after the writes queued before it); the store follows. */
export function writeSettings(change: (current: Settings) => Settings | Promise<Settings>): Promise<SettingsView> {
  const run = chain.then(async () => {
    const view = useApp.getState().settings ?? (await api.settings());
    const saved = await api.saveSettings(await change(structuredClone(view.settings)));
    useApp.getState().set({ settings: saved });
    return saved;
  });
  chain = run.catch(() => {});
  return run;
}
