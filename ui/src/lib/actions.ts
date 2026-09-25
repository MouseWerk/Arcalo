// App-level actions shared by the palette, settings and menus.

import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { api, on } from "./api";
import { applyThemeState } from "./themes";
import type { AppearancePrefs } from "./types";
import { useApp } from "../store/app";
import { collapsePages, foldersBelow } from "./collapsed";
import { importProgress, importSummary } from "./format";
import { t } from "./i18n";

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
    const dir = path ?? (await pickFolder(t("vault.pick")));
    if (!dir) return;
    // Large vaults take a while: a progress toast that can stop the import.
    s.toast({ tone: "info", persistent: true, title: t("vault.importing"), detail: importProgress({ done: 0, total: 0 }), action: { label: t("common.cancel"), run: () => void api.cancelVaultImport() } });
    progressId = useApp.getState().toasts.at(-1)?.id;
    stop = on<{ done: number; total: number }>("vault://progress", (p) =>
      useApp.setState({ toasts: useApp.getState().toasts.map((x) => (x.id === progressId ? { ...x, detail: importProgress(p) } : x)) }),
    );
    const r = await api.importVault(dir);
    await s.refreshTree();
    // Large vaults stay readable: the imported folders start collapsed.
    collapsePages(foldersBelow(useApp.getState().pages.get(r.root_page_id)));
    s.openPage(r.root_page_id);
    s.toast({ tone: "success", title: t("vault.imported"), detail: importSummary(r) });
    if (r.warnings?.length)
      s.toast({ tone: "warning", persistent: true, title: t("vault.notes"), detail: r.warnings.slice(0, 5).join("\n") + (r.warnings.length > 5 ? `\n${t("vault.more", { n: r.warnings.length - 5 })}` : "") });
  } catch (e) {
    s.error(t("vault.importFailed"), e);
  } finally {
    void stop?.then((f) => f());
    if (progressId != null) s.dismissToast(progressId);
  }
}

export async function exportVault(path?: string) {
  const s = useApp.getState();
  try {
    const dir = path ?? (await pickFolder(t("vault.exportPick")));
    if (!dir) return;
    const n = await api.exportVault(dir);
    s.toast({ tone: "success", title: t("vault.exported"), detail: t("vault.exportedFiles", { n }) });
  } catch (e) {
    s.error(t("time.exportFailed"), e);
  }
}
