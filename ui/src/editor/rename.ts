// Renaming a page (in the tree or in its title): links to it are rewritten, and the toast offers
// „Rückgängig“ in both places alike.

import { api } from "../lib/api";
import { t } from "../lib/i18n";
import { useApp } from "../store/app";
import { flushAllEditors } from "./saves";
import { reloadEditors } from "./NoteEditor";

/** Renames page `id` from `old` to `title`; the toast takes it back. */
export async function renamePageWithUndo(id: number, old: string, title: string) {
  const s = useApp.getState;
  // All editors: a pending autosave elsewhere would write the old [[links]] back.
  await flushAllEditors();
  const count = await api.renamePage(id, title, true);
  reloadEditors();
  await s().refreshTree();
  // A new page getting its first title (Ctrl+N, type, Enter) needs no undo to „Unbenannt“.
  const firstTitle = !old.trim() || old === t("page.untitled") || old === t("common.untitled");
  if (firstTitle && count === 0) return;
  s().toast({
    tone: "success",
    title: t("sb.renamed", { title }),
    detail: count > 0 ? t("page.linksUpdated", { n: count }) : undefined,
    action: {
      label: t("common.undo"),
      run: async () => {
        try {
          await flushAllEditors();
          await api.renamePage(id, old, true);
          reloadEditors();
          await s().refreshTree();
          s().toast({ tone: "info", title: t("sb.renameUndone"), detail: t("common.quoted", { text: old }) });
        } catch (e) {
          s().error(t("page.renameFailed"), e);
        }
      },
    },
  });
}
