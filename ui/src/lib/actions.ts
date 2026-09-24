// App-level actions shared by the palette, settings and menus.

import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { api, on } from "./api";
import { applyThemeState } from "./themes";
import type { AppearancePrefs } from "./types";
import { useApp } from "../store/app";
import { collapsePages, foldersBelow } from "./collapsed";
import { importProgress, importSummary } from "./format";

/** Light, dark or the OS: picks the light or dark color theme (Settings → Darstellung). */
export function applyTheme(theme: "system" | "light" | "dark", appearance?: AppearancePrefs) {
  applyThemeState({ mode: theme, ...(appearance ? { appearance } : {}) });
}

export async function toggleTheme() {
  const s = useApp.getState();
  const view = s.settings ?? (await api.settings());
  const current = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
  const next = { ...view.settings, theme: current === "dark" ? ("light" as const) : ("dark" as const) };
  const saved = await api.saveSettings(next);
  s.set({ settings: saved });
  applyTheme(next.theme);
}

export async function pickFolder(title: string): Promise<string | null> {
  const r = await openDialog({ directory: true, multiple: false, title });
  return typeof r === "string" ? r : null;
}

export async function importVault(path?: string) {
  const s = useApp.getState();
  let progressId: number | undefined;
  let stop: Promise<() => void> | undefined;
  try {
    const dir = path ?? (await pickFolder("Obsidian-Vault auswählen"));
    if (!dir) return;
    // Large vaults take a while: a progress toast that can stop the import.
    s.toast({ tone: "info", persistent: true, title: "Vault wird importiert", detail: importProgress({ done: 0, total: 0 }), action: { label: "Abbrechen", run: () => void api.cancelVaultImport() } });
    progressId = useApp.getState().toasts.at(-1)?.id;
    stop = on<{ done: number; total: number }>("vault://progress", (p) =>
      useApp.setState({ toasts: useApp.getState().toasts.map((t) => (t.id === progressId ? { ...t, detail: importProgress(p) } : t)) }),
    );
    const r = await api.importVault(dir);
    await s.refreshTree();
    // Large vaults stay readable: the imported folders start collapsed.
    collapsePages(foldersBelow(useApp.getState().pages.get(r.root_page_id)));
    s.openPage(r.root_page_id);
    s.toast({ tone: "success", title: "Vault importiert", detail: importSummary(r) });
    if (r.warnings?.length) s.toast({ tone: "warning", persistent: true, title: "Hinweise zum Import", detail: r.warnings.slice(0, 5).join("\n") + (r.warnings.length > 5 ? `\n… und ${r.warnings.length - 5} weitere` : "") });
  } catch (e) {
    s.error("Import fehlgeschlagen", e);
  } finally {
    void stop?.then((f) => f());
    if (progressId != null) s.dismissToast(progressId);
  }
}

export async function exportVault(path?: string) {
  const s = useApp.getState();
  try {
    const dir = path ?? (await pickFolder("Zielordner für den Export"));
    if (!dir) return;
    const n = await api.exportVault(dir);
    s.toast({ tone: "success", title: "Export abgeschlossen", detail: `${n} Markdown-Dateien geschrieben` });
  } catch (e) {
    s.error("Export fehlgeschlagen", e);
  }
}
