// Trash: deleted pages (with their subpages) until restored, purged or 30 days old.

import { useCallback, useEffect, useState } from "react";
import { Paperclip, RotateCcw, Trash2, X } from "lucide-react";
import { api } from "../lib/api";
import { useApp } from "../store/app";
import { Button, EmptyState, IconButton, Skeleton } from "../components/ui";
import { PageIcon } from "../components/icons";
import { relative } from "../lib/format";
import type { TrashEntry, TrashedFile } from "../lib/types";
import { formatSize } from "../editor/fileEmbed";
import { t, useT } from "../lib/i18n";

export async function restorePage(id: number, title: string) {
  const s = useApp.getState();
  try {
    const p = await api.restorePage(id);
    await s.refreshTree();
    s.toast({ tone: "success", title: t("trash.restored"), detail: p.title !== title ? t("trash.restoredAs", { title: p.title }) : title, action: { label: t("file.open"), run: () => s.openPage(p.id) } });
  } catch (e) {
    s.error(t("trash.restoreFailed"), e);
  }
}

export function TrashView() {
  useT();
  const tree = useApp((s) => s.tree);
  const [list, setList] = useState<TrashEntry[] | null>(null);
  const s = useApp.getState;
  const reload = useCallback(() => api.trash().then(setList).catch(() => setList([])), []);
  // Deleting and restoring refresh the tree, so follow it.
  useEffect(() => {
    reload();
  }, [tree, reload]);

  const purge = async (e: TrashEntry) => {
    const message = e.descendants ? t("trash.purgeWithSubpages", { title: e.title, n: e.descendants }) : t("trash.purgeOne", { title: e.title });
    if (!(await s().confirm({ title: t("trash.purgeTitle"), message, confirmLabel: t("trash.purge"), danger: true }))) return;
    try {
      await api.purgePage(e.id);
      reload();
    } catch (err) {
      s().error(t("trash.deleteFailed"), err);
    }
  };
  const empty = async () => {
    if (!(await s().confirm({ title: t("trash.emptyTitle"), message: t("trash.emptyMessage"), confirmLabel: t("trash.emptyConfirm"), danger: true }))) return;
    try {
      const n = await api.emptyTrash();
      reload();
      s().toast({ tone: "info", title: t("trash.emptied"), detail: t("trash.pagesDeleted", { n }) });
    } catch (err) {
      s().error(t("trash.emptyFailed"), err);
    }
  };

  return (
    <div className="view-scroll">
      <div className="view narrow">
        <header className="view-header">
          <div>
            <h1>{t("trash.title")}</h1>
            <div className="view-sub">{t("trash.sub", { n: useApp.getState().settings?.settings.notes?.trash_retention_days ?? 30 })}</div>
          </div>
          {!!list?.length && (
            <div className="view-actions">
              <Button variant="danger" icon={Trash2} onClick={empty}>
                {t("trash.emptyButton")}
              </Button>
            </div>
          )}
        </header>
        {!list ? (
          <Skeleton />
        ) : list.length === 0 ? (
          <EmptyState icon={Trash2} title={t("trash.isEmpty")}>
            {t("trash.isEmptyText")}
          </EmptyState>
        ) : (
          <div className="trash-list" role="list">
            {list.map((e) => (
              <div key={e.id} className="trash-item" role="listitem">
                <PageIcon name={e.icon} size={16} />
                <div className="trash-item-text">
                  <span className="trash-item-title">{e.title}</span>
                  <span className="trash-item-meta">
                    {t("trash.deletedWhen", { when: relative(e.deleted_at) })}
                    {e.descendants > 0 && ` · ${t("trash.subpages", { n: e.descendants })}`}
                    {e.parent_title && ` · ${t("trash.from", { title: e.parent_title })}`}
                  </span>
                </div>
                <Button size="sm" icon={RotateCcw} onClick={() => restorePage(e.id, e.title)} aria-label={t("trash.restoreOne", { title: e.title })}>
                  {t("trash.restore")}
                </Button>
                <IconButton icon={X} label={t("trash.deleteOne", { title: e.title })} size="md" onClick={() => purge(e)} />
              </div>
            ))}
          </div>
        )}
        <FileTrash />
      </div>
    </div>
  );
}

/** Files deleted in the attachment manager (`<data dir>/trash/files`), until restored or expired. */
function FileTrash() {
  useT();
  const [files, setFiles] = useState<TrashedFile[]>([]);
  const s = useApp.getState;
  const reload = useCallback(() => api.trashedAttachments().then(setFiles).catch(() => setFiles([])), []);
  useEffect(() => void reload(), [reload]);
  if (!files.length) return null;
  const restore = async (f: TrashedFile) => {
    try {
      await api.restoreAttachment(f.id, f.name);
      s().toast({ tone: "success", title: t("trash.fileRestored"), detail: f.name, action: { label: t("share.attachments"), run: () => s().openTab({ kind: "attachments" }) } });
    } catch (e) {
      s().error(t("trash.restoreFailed"), e);
    }
    reload();
  };
  const purge = async (f: TrashedFile) => {
    if (!(await s().confirm({ title: t("trash.purgeTitle"), message: t("trash.purgeFile", { name: f.name }), confirmLabel: t("trash.purge"), danger: true }))) return;
    try {
      await api.purgeAttachment(f.id, f.name);
    } catch (e) {
      s().error(t("trash.deleteFailed"), e);
    }
    reload();
  };
  return (
    <section className="trash-files" aria-label={t("trash.files")}>
      <h2 className="trash-files-title">{t("trash.files")}</h2>
      <div className="trash-list" role="list">
        {files.map((f) => (
          <div key={`${f.id}/${f.name}`} className="trash-item" role="listitem" data-file={f.name}>
            <Paperclip size={16} />
            <div className="trash-item-text">
              <span className="trash-item-title">{f.name}</span>
              <span className="trash-item-meta">
                {t("trash.deletedWhen", { when: relative(f.deleted_at) })} · {formatSize(f.size)}
              </span>
            </div>
            <Button size="sm" icon={RotateCcw} onClick={() => void restore(f)} aria-label={t("trash.restoreOne", { title: f.name })}>
              {t("trash.restore")}
            </Button>
            <IconButton icon={X} label={t("trash.deleteOne", { title: f.name })} size="md" onClick={() => void purge(f)} />
          </div>
        ))}
      </div>
    </section>
  );
}
