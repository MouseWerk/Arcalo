// Trash: deleted pages (with their subpages) until restored, purged or 30 days old.

import { useCallback, useEffect, useState } from "react";
import { Paperclip, RotateCcw, Trash2, X } from "lucide-react";
import { api } from "../lib/api";
import { useApp } from "../store/app";
import { Button, EmptyState, IconButton, Spinner } from "../components/ui";
import { PageIcon } from "../components/icons";
import { relative } from "../lib/format";
import type { TrashEntry, TrashedFile } from "../lib/types";
import { formatSize } from "../editor/fileEmbed";

export async function restorePage(id: number, title: string) {
  const s = useApp.getState();
  try {
    const p = await api.restorePage(id);
    await s.refreshTree();
    s.toast({ tone: "success", title: "Seite wiederhergestellt", detail: p.title !== title ? `als „${p.title}“` : title, action: { label: "Öffnen", run: () => s.openPage(p.id) } });
  } catch (e) {
    s.error("Wiederherstellen fehlgeschlagen", e);
  }
}

export function TrashView() {
  const tree = useApp((s) => s.tree);
  const [list, setList] = useState<TrashEntry[] | null>(null);
  const s = useApp.getState;
  const reload = useCallback(() => api.trash().then(setList).catch(() => setList([])), []);
  // Deleting and restoring refresh the tree, so follow it.
  useEffect(() => {
    reload();
  }, [tree, reload]);

  const purge = async (e: TrashEntry) => {
    const kids = e.descendants ? ` und ${e.descendants} ${e.descendants === 1 ? "Unterseite" : "Unterseiten"}` : "";
    if (!(await s().confirm({ title: "Endgültig löschen?", message: `„${e.title}“${kids} werden endgültig gelöscht. Das kann nicht rückgängig gemacht werden.`, confirmLabel: "Endgültig löschen", danger: true }))) return;
    try {
      await api.purgePage(e.id);
      reload();
    } catch (err) {
      s().error("Löschen fehlgeschlagen", err);
    }
  };
  const empty = async () => {
    if (!(await s().confirm({ title: "Papierkorb leeren?", message: "Alle Seiten im Papierkorb werden endgültig gelöscht. Das kann nicht rückgängig gemacht werden.", confirmLabel: "Leeren", danger: true }))) return;
    try {
      const n = await api.emptyTrash();
      reload();
      s().toast({ tone: "info", title: "Papierkorb geleert", detail: `${n} ${n === 1 ? "Seite" : "Seiten"} gelöscht` });
    } catch (err) {
      s().error("Leeren fehlgeschlagen", err);
    }
  };

  return (
    <div className="view-scroll">
      <div className="view narrow">
        <header className="view-header">
          <div>
            <h1>Papierkorb</h1>
            <div className="view-sub">Gelöschte Seiten werden nach {useApp.getState().settings?.settings.notes?.trash_retention_days ?? 30} Tagen endgültig entfernt.</div>
          </div>
          {!!list?.length && (
            <div className="view-actions">
              <Button variant="danger" icon={Trash2} onClick={empty}>
                Papierkorb leeren
              </Button>
            </div>
          )}
        </header>
        {!list ? (
          <Spinner />
        ) : list.length === 0 ? (
          <EmptyState icon={Trash2} title="Der Papierkorb ist leer">
            Gelöschte Seiten landen hier und lassen sich wiederherstellen.
          </EmptyState>
        ) : (
          <div className="trash-list" role="list">
            {list.map((e) => (
              <div key={e.id} className="trash-item" role="listitem">
                <PageIcon name={e.icon} size={16} />
                <div className="trash-item-text">
                  <span className="trash-item-title">{e.title}</span>
                  <span className="trash-item-meta">
                    Gelöscht {relative(e.deleted_at)}
                    {e.descendants > 0 && ` · ${e.descendants} ${e.descendants === 1 ? "Unterseite" : "Unterseiten"}`}
                    {e.parent_title && ` · aus „${e.parent_title}“`}
                  </span>
                </div>
                <Button size="sm" icon={RotateCcw} onClick={() => restorePage(e.id, e.title)}>
                  Wiederherstellen
                </Button>
                <IconButton icon={X} label="Endgültig löschen" size="md" onClick={() => purge(e)} />
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
  const [files, setFiles] = useState<TrashedFile[]>([]);
  const s = useApp.getState;
  const reload = useCallback(() => api.trashedAttachments().then(setFiles).catch(() => setFiles([])), []);
  useEffect(() => void reload(), [reload]);
  if (!files.length) return null;
  const restore = async (f: TrashedFile) => {
    try {
      await api.restoreAttachment(f.id, f.name);
      s().toast({ tone: "success", title: "Datei wiederhergestellt", detail: f.name, action: { label: "Anhänge", run: () => s().openTab({ kind: "attachments" }) } });
    } catch (e) {
      s().error("Wiederherstellen fehlgeschlagen", e);
    }
    reload();
  };
  const purge = async (f: TrashedFile) => {
    if (!(await s().confirm({ title: "Endgültig löschen?", message: `„${f.name}“ wird endgültig gelöscht. Das kann nicht rückgängig gemacht werden.`, confirmLabel: "Endgültig löschen", danger: true }))) return;
    try {
      await api.purgeAttachment(f.id, f.name);
    } catch (e) {
      s().error("Löschen fehlgeschlagen", e);
    }
    reload();
  };
  return (
    <section className="trash-files" aria-label="Gelöschte Dateien">
      <h2 className="trash-files-title">Gelöschte Dateien</h2>
      <div className="trash-list" role="list">
        {files.map((f) => (
          <div key={`${f.id}/${f.name}`} className="trash-item" role="listitem" data-file={f.name}>
            <Paperclip size={16} />
            <div className="trash-item-text">
              <span className="trash-item-title">{f.name}</span>
              <span className="trash-item-meta">
                Gelöscht {relative(f.deleted_at)} · {formatSize(f.size)}
              </span>
            </div>
            <Button size="sm" icon={RotateCcw} onClick={() => void restore(f)}>
              Wiederherstellen
            </Button>
            <IconButton icon={X} label="Endgültig löschen" size="md" onClick={() => void purge(f)} />
          </div>
        ))}
      </div>
    </section>
  );
}
