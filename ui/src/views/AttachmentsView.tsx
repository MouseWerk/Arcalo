// Attachment manager („Anhänge“): every file in the attachments folder with preview, type,
// size, date and the pages that embed it. Filter, search and sort; open, show in the folder,
// rename (the shell rewrites every embed through the pages' save path), delete into the file
// trash, and „Unbenutzte aufräumen“ for files no page embeds.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Archive, Copy, ExternalLink, File, FileAudio, FileCode2, FileSpreadsheet, FileText, FileVideo, FolderOpen, Image as ImageIcon, MoreHorizontal, Paperclip,
  PenTool, Pencil, Presentation, RefreshCw, Search, Sparkles, Trash2, X,
} from "lucide-react";
import { api, attachmentUrl } from "../lib/api";
import type { AttachmentInfo, AttachmentList } from "../lib/types";
import { useApp } from "../store/app";
import { Button, Dialog, EmptyState, IconButton, Segmented, useMenu, type MenuEntry, Skeleton } from "../components/ui";
import { Select } from "../components/Select";
import { PageIcon } from "../components/icons";
import { fmtDate, int } from "../lib/format";
import { fileKind, formatSize, type FileKind } from "../editor/fileEmbed";
import { drawPdfPreview, forgetPdfPreview } from "../lib/pdf";
import { openDrawing } from "../editor/drawings";
import { flushAllEditors, reloadEditors } from "../editor/NoteEditor";
import { DEFAULT_FILTER, filterAttachments, isUnused, LARGE_BYTES, onlyInVersions, renameProblem, stemLength, totalSize, type KindFilter, type ListFilter, type SortKey } from "../lib/attachments";
import { t, useT, withLabel, type TKey } from "../lib/i18n";

const KINDS: { value: KindFilter; readonly label: string }[] = [
  withLabel({ value: "all" as KindFilter }, "att.kind.all"),
  withLabel({ value: "image" as KindFilter }, "att.kind.image"),
  withLabel({ value: "drawing" as KindFilter }, "att.kind.drawing"),
  withLabel({ value: "pdf" as KindFilter }, "att.kind.pdf"),
  withLabel({ value: "other" as KindFilter }, "att.kind.other"),
];
const KIND_LABEL: Record<AttachmentInfo["kind"], TKey> = { image: "feed.kind.image", drawing: "feed.kind.drawing", pdf: "att.pdf", other: "feed.kind.file" };
const SORTS: { value: SortKey; label: TKey }[] = [
  { value: "name", label: "att.sort.name" },
  { value: "size", label: "att.sort.size" },
  { value: "date", label: "att.sort.date" },
  { value: "usage", label: "att.sort.usage" },
];
const FILE_ICONS: Record<FileKind, typeof File> = {
  file: File,
  text: FileText,
  sheet: FileSpreadsheet,
  slides: Presentation,
  archive: Archive,
  image: ImageIcon,
  audio: FileAudio,
  video: FileVideo,
  code: FileCode2,
};


/** Opens a file: PDFs in a viewer tab, drawings in the editor, everything else in its app. */
export function openAttachmentFile(f: Pick<AttachmentInfo, "name" | "kind">, newTab = true) {
  const s = useApp.getState();
  if (f.kind === "pdf") s.openTab({ kind: "pdf", tag: f.name }, { newTab });
  else if (f.kind === "drawing") openDrawing(f.name);
  else api.openAttachment(f.name).catch((e) => s.error(t("att.openFailed"), e));
}

/** Small preview: the image, the drawing's SVG, the PDF's first page, or a type icon. */
function Thumb({ file }: { file: AttachmentInfo }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLSpanElement>(null);
  const [failed, setFailed] = useState(false);
  const [pdfReady, setPdfReady] = useState(false);
  useEffect(() => {
    if (file.kind !== "pdf" || !box.current) return;
    let alive = true;
    // pdf.js only loads for PDFs that scroll into view.
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting) || !canvas.current) return;
      io.disconnect();
      drawPdfPreview(file.name, canvas.current, 380).then(
        () => alive && setPdfReady(true),
        () => alive && setFailed(true),
      );
    }, { rootMargin: "200px" });
    io.observe(box.current);
    return () => {
      alive = false;
      io.disconnect();
    };
  }, [file.kind, file.name]);
  const Icon = file.kind === "drawing" ? PenTool : FILE_ICONS[fileKind(file.name)];
  let inner: ReactNode = <Icon size={18} strokeWidth={1.6} aria-hidden />;
  if (!failed && file.kind === "image") inner = <img src={attachmentUrl(file.name)} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />;
  else if (!failed && file.kind === "drawing" && file.preview) inner = <img src={attachmentUrl(file.preview)} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />;
  else if (!failed && file.kind === "pdf")
    inner = (
      <>
        <canvas ref={canvas} className={pdfReady ? "ready" : ""} aria-hidden />
        {!pdfReady && <FileText size={18} strokeWidth={1.6} aria-hidden />}
      </>
    );
  return (
    <span ref={box} className={`att-thumb att-thumb-${file.kind}`} aria-hidden>
      {inner}
    </span>
  );
}

export function AttachmentsView() {
  const t = useT();
  const [list, setList] = useState<AttachmentList | null>(null);
  const [filter, setFilter] = useState<ListFilter>(DEFAULT_FILTER);
  const [renaming, setRenaming] = useState<AttachmentInfo | null>(null);
  const [cleanup, setCleanup] = useState(false);
  const [menu, openMenu, openMenuAt] = useMenu();
  const s = useApp.getState;
  const load = useCallback(() => api.attachments().then(setList, (e) => (s().error(t("att.loadFailed"), e), setList({ files: [], total_size: 0 }))), [s, t]);
  useEffect(() => void load(), [load]);
  // Pages renamed or deleted elsewhere: the „Verwendet in“ titles follow.
  const tree = useApp((st) => st.tree);
  useEffect(() => void load(), [tree, load]);

  const shown = useMemo(() => (list ? filterAttachments(list.files, filter) : []), [list, filter]);
  // A page created elsewhere (an import, the assistant) may not be in the tree yet.
  const openUse = async (id: number, newTab: boolean) => {
    if (!s().pages.has(id)) await s().refreshTree();
    s().openPage(id, { newTab });
  };
  const unused = useMemo(() => list?.files.filter(isUnused) ?? [], [list]);
  const versionsOnly = useMemo(() => list?.files.filter(onlyInVersions).length ?? 0, [list]);
  const set = (patch: Partial<ListFilter>) => setFilter((f) => ({ ...f, ...patch }));

  const remove = async (f: AttachmentInfo) => {
    const live = f.used_in.filter((u) => !u.trashed);
    const where = live.length
      ? ` ${t("att.deleteUsed", { n: live.length, pages: live.slice(0, 3).map((u) => t("common.quoted", { text: u.title })).join(", ") + (live.length > 3 ? ", …" : "") })}`
      : f.used_in.length
        ? ` ${t("att.deleteTrashOnly")}`
        : f.mail
          ? ` ${t("att.deleteMail")}`
          : onlyInVersions(f)
            ? ` ${t("att.deleteVersionsOnly")}`
            : "";
    const ok = await s().confirm({
      title: t("att.deleteAsk"),
      message: t("att.deleteText", { name: f.name }) + where,
      confirmLabel: t("common.delete"),
      danger: true,
    });
    if (!ok) return;
    await trash([f.name]);
  };

  const trash = async (names: string[]) => {
    try {
      const moved = await api.trashAttachments(names);
      moved.forEach(forgetPdfPreview);
      await load();
      const undo = async () => {
        try {
          const trashed = await api.trashedAttachments();
          for (const name of moved) {
            const x = trashed.find((y) => y.name === name);
            if (x) await api.restoreAttachment(x.id, x.name);
          }
          await load();
        } catch (e) {
          s().error(t("set.git.restoreFailed"), e);
        }
      };
      s().toast({
        tone: "success",
        title: t("att.deleted", { n: moved.length }),
        detail: moved.length === 1 ? moved[0] : t("att.restorable"),
        action: { label: t("common.undo"), run: () => void undo() },
      });
    } catch (e) {
      s().error(t("common.deleteFailed"), e);
      await load();
    }
  };

  const rowMenu = (f: AttachmentInfo): MenuEntry[] => [
    { label: f.kind === "pdf" ? t("att.view") : f.kind === "drawing" ? t("links.editShort") : t("links.open"), icon: ExternalLink, onSelect: () => openAttachmentFile(f) },
    ...(f.kind === "pdf" || f.kind === "drawing"
      ? [{ label: t("att.openDefault"), icon: ExternalLink, onSelect: () => api.openAttachment(f.name).catch((e) => s().error(t("att.openFailed"), e)) } as MenuEntry]
      : []),
    { label: t("att.showInFolder"), icon: FolderOpen, onSelect: () => api.openAttachment(f.name, true).catch((e) => s().error(t("common.openFolderFailed"), e)) },
    "separator",
    { label: t("att.rename"), icon: Pencil, onSelect: () => setRenaming(f) },
    {
      label: t("att.copyEmbed"),
      icon: Copy,
      onSelect: () => navigator.clipboard.writeText(`![[${f.name}]]`).then(() => s().toast({ tone: "success", title: t("att.embedCopied") }), (e) => s().error(t("devlog.copyFailed"), e)),
    },
    "separator",
    { label: t("att.deleteMenu"), icon: Trash2, danger: true, onSelect: () => void remove(f) },
  ];

  const empty = list && list.files.length === 0;
  return (
    <div className="view-scroll">
      <div className="view att-view">
        <header className="view-header">
          <div>
            <h1>{t("mail.attachments")}</h1>
            <div className="view-sub att-summary">
              {list
                ? `${t("att.files", { n: list.files.length, count: int(list.files.length) })} · ${t("att.total", { size: formatSize(list.total_size) })}${unused.length ? ` · ${t("att.unusedCount", { n: unused.length, size: formatSize(totalSize(unused)) })}` : ""}${versionsOnly ? ` · ${t("att.versionsCount", { n: versionsOnly })}` : ""}`
                : ""}
            </div>
          </div>
          <div className="view-actions">
            <IconButton icon={RefreshCw} label={t("att.reload")} onClick={() => void load()} />
            <Button icon={Sparkles} onClick={() => setCleanup(true)} disabled={!unused.length}>
              {t("att.cleanup")}
            </Button>
          </div>
        </header>

        {!list ? (
          <Skeleton rows={4} variant="cards" />
        ) : empty ? (
          <EmptyState icon={Paperclip} title={t("att.empty")}>
            {t("att.emptyHint")}
          </EmptyState>
        ) : (
          <>
            <div className="att-toolbar" role="search">
              <label className="att-search">
                <Search size={14} aria-hidden />
                <input
                  className="att-search-input"
                  placeholder={t("att.searchPlaceholder")}
                  aria-label={t("att.search")}
                  value={filter.query}
                  onChange={(e) => set({ query: e.target.value })}
                  onKeyDown={(e) => e.key === "Escape" && filter.query && (e.stopPropagation(), set({ query: "" }))}
                />
                {filter.query && <IconButton icon={X} label={t("att.clearSearch")} size="sm" onClick={() => set({ query: "" })} />}
              </label>
              <Segmented value={filter.kind} options={KINDS} onChange={(kind) => set({ kind })} label={t("att.type")} />
              <div className="att-toggles">
                <button type="button" className={`att-chip ${filter.unused ? "on" : ""}`} aria-pressed={filter.unused} onClick={() => set({ unused: !filter.unused })}>
                  {t("att.unused")}
                </button>
                <button type="button" className={`att-chip ${filter.large ? "on" : ""}`} aria-pressed={filter.large} onClick={() => set({ large: !filter.large })} title={t("att.largeFrom", { size: formatSize(LARGE_BYTES) })}>
                  {t("att.large")}
                </button>
              </div>
              <Select value={filter.sort} onChange={(e) => set({ sort: e.target.value as SortKey })} aria-label={t("att.sortBy")} className="att-sort" options={SORTS.map((o) => ({ value: o.value, label: t("att.sortOption", { field: t(o.label) }) }))} />
            </div>

            {shown.length === 0 ? (
              <div className="att-none">{t("att.noMatch")}</div>
            ) : (
              <div className="att-table" role="table" aria-label={t("mail.attachments")}>
                <div className="att-row att-head" role="row">
                  <span role="columnheader" className="att-c-name">{t("att.sort.name")}</span>
                  <span role="columnheader" className="att-c-kind">{t("att.type")}</span>
                  <span role="columnheader" className="att-c-size">{t("att.sort.size")}</span>
                  <span role="columnheader" className="att-c-date">{t("att.sort.date")}</span>
                  <span role="columnheader" className="att-c-used">{t("att.usedIn")}</span>
                  <span role="columnheader" className="att-c-act" aria-label={t("ribbon.actions")} />
                </div>
                {shown.map((f) => {
                  const live = f.used_in.filter((u) => !u.trashed);
                  return (
                    <div
                      key={f.name}
                      className="att-row"
                      role="row"
                      data-file={f.name}
                      onContextMenu={(e) => openMenu(e, rowMenu(f))}
                      onDoubleClick={(e) => !(e.target as HTMLElement).closest("button") && openAttachmentFile(f)}
                    >
                      <span role="cell" className="att-c-name">
                        <Thumb file={f} />
                        <span className="att-name-text">
                          <button type="button" className="att-name" title={f.name} onClick={() => openAttachmentFile(f)}>
                            {f.name}
                          </button>
                          <span className="att-sub">
                            {t(KIND_LABEL[f.kind])} · {formatSize(f.size)}
                            {f.modified ? ` · ${fmtDate(f.modified)}` : ""}
                          </span>
                        </span>
                      </span>
                      <span role="cell" className="att-c-kind">
                        {t(KIND_LABEL[f.kind])}
                      </span>
                      <span role="cell" className={`att-c-size num ${f.size >= LARGE_BYTES ? "att-large" : ""}`}>
                        {formatSize(f.size)}
                      </span>
                      <span role="cell" className="att-c-date num">
                        {f.modified ? fmtDate(f.modified) : "–"}
                      </span>
                      <span role="cell" className="att-c-used">
                        {live.length === 0 ? (
                          <UnusedLabel file={f} />
                        ) : (
                          <span className="att-uses">
                            {live.slice(0, 3).map((u) => (
                              <button key={u.id} type="button" className="att-use" title={u.title} onClick={(e) => void openUse(u.id, e.ctrlKey || e.metaKey)}>
                                <PageIcon name={s().pages.get(u.id)?.icon} size={12} />
                                <span>{u.title}</span>
                              </button>
                            ))}
                            {live.length > 3 && <span className="att-more">+{live.length - 3}</span>}
                          </span>
                        )}
                      </span>
                      <span role="cell" className="att-c-act">
                        <IconButton icon={MoreHorizontal} label={t("calset.actionsFor", { name: f.name })} size="sm" onClick={(e) => openMenuAt(e, rowMenu(f))} />
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
      {menu}
      {renaming && list && <RenameDialog file={renaming} names={list.files.flatMap((f) => (f.preview ? [f.name, f.preview] : [f.name]))} onClose={() => setRenaming(null)} onDone={load} />}
      {cleanup && <CleanupDialog files={unused} onClose={() => setCleanup(false)} onDelete={(names) => trash(names).then(() => setCleanup(false))} />}
    </div>
  );
}

function RenameDialog({ file, names, onClose, onDone }: { file: AttachmentInfo; names: string[]; onClose: () => void; onDone: () => Promise<void> }) {
  const t = useT();
  const [value, setValue] = useState(file.name);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const problem = renameProblem(file.name, value, names);
  const s = useApp.getState;
  // The name without its extension is selected, ready to type over.
  useEffect(() => {
    const timer = setTimeout(() => input.current?.setSelectionRange(0, stemLength(file.name)), 40);
    return () => clearTimeout(timer);
  }, [file.name]);

  const submit = async () => {
    if (problem || busy) return;
    if (value.trim() === file.name) return onClose();
    setBusy(true);
    try {
      // Open editors save first, so the rewrite works on what is on screen.
      await flushAllEditors();
      const out = await api.renameAttachment(file.name, value.trim());
      forgetPdfPreview(file.name);
      if (out.pages.length) reloadEditors(out.pages);
      await onDone();
      onClose();
      s().toast({
        tone: "success",
        title: t("att.renamed"),
        detail: out.pages.length ? t("att.renamedIn", { name: out.name, n: out.pages.length }) : t("common.quoted", { text: out.name }),
      });
    } catch (e) {
      setServerError(String(e).replace(/^invalid state: /, ""));
      setBusy(false);
    }
  };
  const live = file.used_in.filter((u) => !u.trashed).length;
  const error = serverError ?? (value.trim() !== file.name ? problem : null);
  return (
    <Dialog
      open
      onClose={onClose}
      title={t("att.renameTitle")}
      description={live ? t("att.renameDesc", { n: live }) : t("att.renameUnused")}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" onClick={() => void submit()} loading={busy} disabled={!!problem}>
            {t("att.renameButton")}
          </Button>
        </>
      }
    >
      <input
        ref={input}
        value={value}
        onChange={(e) => (setValue(e.target.value), setServerError(null))}
        onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), void submit())}
        aria-label={t("att.newName")}
        aria-invalid={!!error}
        className="input att-rename-input"
        data-autofocus
        spellCheck={false}
      />
      <div className={`att-rename-hint ${error ? "is-error" : ""}`} role={error ? "alert" : undefined}>
        {error ?? t("att.extStays")}
      </div>
    </Dialog>
  );
}

/** Why a file no page shows is still kept: trashed pages, a stored e-mail, old versions. */
function UnusedLabel({ file: f }: { file: AttachmentInfo }) {
  const t = useT();
  if (f.used_in.length) return <span className="att-unused is-trash">{t("att.onlyTrash")}</span>;
  if (f.mail) return <span className="att-unused is-kept">{t("att.storedMail")}</span>;
  if (onlyInVersions(f)) {
    const pages = (f.in_versions ?? []).map((u) => t("common.quoted", { text: u.title }));
    return (
      <span className="att-unused is-kept" title={t("att.versionsOnlyHint", { pages: pages.slice(0, 3).join(", ") + (pages.length > 3 ? ", …" : "") })}>
        {t("att.versionsOnly")}
      </span>
    );
  }
  return <span className="att-unused">{t("att.notUsed")}</span>;
}

function CleanupDialog({ files, onClose, onDelete }: { files: AttachmentInfo[]; onClose: () => void; onDelete: (names: string[]) => Promise<void> }) {
  const t = useT();
  const [picked, setPicked] = useState(() => new Set(files.map((f) => f.name)));
  const [busy, setBusy] = useState(false);
  const chosen = files.filter((f) => picked.has(f.name));
  const toggle = (name: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(name)) n.delete(name);
      else n.add(name);
      return n;
    });
  const all = chosen.length === files.length;
  return (
    <Dialog
      open
      onClose={onClose}
      width={560}
      title={t("att.cleanupTitle")}
      description={t("att.cleanupDesc", { n: files.length, size: formatSize(totalSize(files)) })}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="danger"
            icon={Trash2}
            loading={busy}
            disabled={!chosen.length}
            onClick={async () => {
              setBusy(true);
              await onDelete(chosen.map((f) => f.name));
              setBusy(false);
            }}
          >
            {chosen.length ? t("att.deleteN", { n: chosen.length, size: formatSize(totalSize(chosen)) }) : t("common.delete")}
          </Button>
        </>
      }
    >
      <label className="att-clean-all">
        <input type="checkbox" className="task-check" checked={all} onChange={() => setPicked(all ? new Set() : new Set(files.map((f) => f.name)))} />
        <span>{t("common.selectAll")}</span>
      </label>
      <ul className="att-clean-list" aria-label={t("att.unusedFiles")}>
        {files.map((f) => (
          <li key={f.name}>
            <label className="att-clean-item">
              <input type="checkbox" className="task-check" checked={picked.has(f.name)} onChange={() => toggle(f.name)} aria-label={f.name} />
              <Thumb file={f} />
              <span className="att-clean-name" title={f.name}>
                {f.name}
              </span>
              <span className="att-clean-size num">{formatSize(f.size)}</span>
            </label>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
