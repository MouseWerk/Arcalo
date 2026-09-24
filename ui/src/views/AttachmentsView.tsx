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
import { Button, Dialog, EmptyState, IconButton, Segmented, Spinner, useMenu, type MenuEntry } from "../components/ui";
import { Select } from "../components/Select";
import { PageIcon } from "../components/icons";
import { fmtDate } from "../lib/format";
import { fileKind, formatSize, type FileKind } from "../editor/fileEmbed";
import { drawPdfPreview, forgetPdfPreview } from "../lib/pdf";
import { openDrawing } from "../editor/drawings";
import { flushAllEditors, reloadEditors } from "../editor/NoteEditor";
import { DEFAULT_FILTER, filterAttachments, isUnused, LARGE_BYTES, renameProblem, stemLength, totalSize, type KindFilter, type ListFilter, type SortKey } from "../lib/attachments";

const KINDS: { value: KindFilter; label: string }[] = [
  { value: "all", label: "Alle" },
  { value: "image", label: "Bilder" },
  { value: "drawing", label: "Zeichnungen" },
  { value: "pdf", label: "PDFs" },
  { value: "other", label: "Andere" },
];
const KIND_LABEL: Record<AttachmentInfo["kind"], string> = { image: "Bild", drawing: "Zeichnung", pdf: "PDF", other: "Datei" };
const SORTS: { value: SortKey; label: string }[] = [
  { value: "name", label: "Name" },
  { value: "size", label: "Größe" },
  { value: "date", label: "Geändert" },
  { value: "usage", label: "Verwendung" },
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

const plural = (n: number, one: string, many: string) => `${n.toLocaleString("de-DE")} ${n === 1 ? one : many}`;

/** Opens a file: PDFs in a viewer tab, drawings in the editor, everything else in its app. */
export function openAttachmentFile(f: Pick<AttachmentInfo, "name" | "kind">, newTab = true) {
  const s = useApp.getState();
  if (f.kind === "pdf") s.openTab({ kind: "pdf", tag: f.name }, { newTab });
  else if (f.kind === "drawing") openDrawing(f.name);
  else api.openAttachment(f.name).catch((e) => s.error("Datei ließ sich nicht öffnen", e));
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
  const [list, setList] = useState<AttachmentList | null>(null);
  const [filter, setFilter] = useState<ListFilter>(DEFAULT_FILTER);
  const [renaming, setRenaming] = useState<AttachmentInfo | null>(null);
  const [cleanup, setCleanup] = useState(false);
  const [menu, openMenu, openMenuAt] = useMenu();
  const s = useApp.getState;
  const load = useCallback(() => api.attachments().then(setList, (e) => (s().error("Anhänge nicht geladen", e), setList({ files: [], total_size: 0 }))), [s]);
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
  const set = (patch: Partial<ListFilter>) => setFilter((f) => ({ ...f, ...patch }));

  const remove = async (f: AttachmentInfo) => {
    const live = f.used_in.filter((u) => !u.trashed);
    const where = live.length
      ? ` Sie wird in ${plural(live.length, "Seite", "Seiten")} verwendet (${live.slice(0, 3).map((u) => `„${u.title}“`).join(", ")}${live.length > 3 ? ", …" : ""}); dort erscheint dann „Datei fehlt“.`
      : f.used_in.length
        ? " Sie wird nur noch in Seiten im Papierkorb verwendet."
        : "";
    const ok = await s().confirm({
      title: "Datei löschen?",
      message: `„${f.name}“ wird in den Papierkorb verschoben und lässt sich dort wiederherstellen.${where}`,
      confirmLabel: "Löschen",
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
            const t = trashed.find((x) => x.name === name);
            if (t) await api.restoreAttachment(t.id, t.name);
          }
          await load();
        } catch (e) {
          s().error("Wiederherstellen fehlgeschlagen", e);
        }
      };
      s().toast({
        tone: "success",
        title: moved.length === 1 ? "Datei gelöscht" : `${moved.length} Dateien gelöscht`,
        detail: moved.length === 1 ? moved[0] : "Im Papierkorb wiederherstellbar",
        action: { label: "Rückgängig", run: () => void undo() },
      });
    } catch (e) {
      s().error("Löschen fehlgeschlagen", e);
      await load();
    }
  };

  const rowMenu = (f: AttachmentInfo): MenuEntry[] => [
    { label: f.kind === "pdf" ? "Ansehen" : f.kind === "drawing" ? "Bearbeiten" : "Öffnen", icon: ExternalLink, onSelect: () => openAttachmentFile(f) },
    ...(f.kind === "pdf" || f.kind === "drawing"
      ? [{ label: "Mit Standard-App öffnen", icon: ExternalLink, onSelect: () => api.openAttachment(f.name).catch((e) => s().error("Datei ließ sich nicht öffnen", e)) } as MenuEntry]
      : []),
    { label: "Im Ordner zeigen", icon: FolderOpen, onSelect: () => api.openAttachment(f.name, true).catch((e) => s().error("Ordner ließ sich nicht öffnen", e)) },
    "separator",
    { label: "Umbenennen…", icon: Pencil, onSelect: () => setRenaming(f) },
    {
      label: "Einbettung kopieren",
      icon: Copy,
      onSelect: () => navigator.clipboard.writeText(`![[${f.name}]]`).then(() => s().toast({ tone: "success", title: "Einbettung kopiert" }), (e) => s().error("Kopieren fehlgeschlagen", e)),
    },
    "separator",
    { label: "Löschen…", icon: Trash2, danger: true, onSelect: () => void remove(f) },
  ];

  const empty = list && list.files.length === 0;
  return (
    <div className="view-scroll">
      <div className="view att-view">
        <header className="view-header">
          <div>
            <h1>Anhänge</h1>
            <div className="view-sub att-summary">
              {list
                ? `${plural(list.files.length, "Datei", "Dateien")} · ${formatSize(list.total_size)} insgesamt${unused.length ? ` · ${unused.length} unbenutzt (${formatSize(totalSize(unused))})` : ""}`
                : ""}
            </div>
          </div>
          <div className="view-actions">
            <IconButton icon={RefreshCw} label="Neu laden" onClick={() => void load()} />
            <Button icon={Sparkles} onClick={() => setCleanup(true)} disabled={!unused.length}>
              Unbenutzte aufräumen
            </Button>
          </div>
        </header>

        {!list ? (
          <Spinner />
        ) : empty ? (
          <EmptyState icon={Paperclip} title="Noch keine Anhänge">
            Bilder, Zeichnungen, PDFs und andere Dateien, die du in Notizen einfügst, erscheinen hier.
          </EmptyState>
        ) : (
          <>
            <div className="att-toolbar" role="search">
              <label className="att-search">
                <Search size={14} aria-hidden />
                <input
                  className="att-search-input"
                  placeholder="Name oder Seite suchen"
                  aria-label="Anhänge durchsuchen"
                  value={filter.query}
                  onChange={(e) => set({ query: e.target.value })}
                  onKeyDown={(e) => e.key === "Escape" && filter.query && (e.stopPropagation(), set({ query: "" }))}
                />
                {filter.query && <IconButton icon={X} label="Suche leeren" size="sm" onClick={() => set({ query: "" })} />}
              </label>
              <Segmented value={filter.kind} options={KINDS} onChange={(kind) => set({ kind })} label="Typ" />
              <div className="att-toggles">
                <button type="button" className={`att-chip ${filter.unused ? "on" : ""}`} aria-pressed={filter.unused} onClick={() => set({ unused: !filter.unused })}>
                  Unbenutzt
                </button>
                <button type="button" className={`att-chip ${filter.large ? "on" : ""}`} aria-pressed={filter.large} onClick={() => set({ large: !filter.large })} title={`Ab ${formatSize(LARGE_BYTES)}`}>
                  Groß
                </button>
              </div>
              <Select value={filter.sort} onChange={(e) => set({ sort: e.target.value as SortKey })} aria-label="Sortieren nach" className="att-sort" options={SORTS.map((o) => ({ value: o.value, label: `Nach ${o.label}` }))} />
            </div>

            {shown.length === 0 ? (
              <div className="att-none">Keine Datei passt zu den Filtern.</div>
            ) : (
              <div className="att-table" role="table" aria-label="Anhänge">
                <div className="att-row att-head" role="row">
                  <span role="columnheader" className="att-c-name">Name</span>
                  <span role="columnheader" className="att-c-kind">Typ</span>
                  <span role="columnheader" className="att-c-size">Größe</span>
                  <span role="columnheader" className="att-c-date">Geändert</span>
                  <span role="columnheader" className="att-c-used">Verwendet in</span>
                  <span role="columnheader" className="att-c-act" aria-label="Aktionen" />
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
                            {KIND_LABEL[f.kind]} · {formatSize(f.size)}
                            {f.modified ? ` · ${fmtDate(f.modified)}` : ""}
                          </span>
                        </span>
                      </span>
                      <span role="cell" className="att-c-kind">
                        {KIND_LABEL[f.kind]}
                      </span>
                      <span role="cell" className={`att-c-size num ${f.size >= LARGE_BYTES ? "att-large" : ""}`}>
                        {formatSize(f.size)}
                      </span>
                      <span role="cell" className="att-c-date num">
                        {f.modified ? fmtDate(f.modified) : "–"}
                      </span>
                      <span role="cell" className="att-c-used">
                        {live.length === 0 ? (
                          <span className={`att-unused ${f.used_in.length ? "is-trash" : ""}`}>{f.used_in.length ? "Nur im Papierkorb" : "Nicht verwendet"}</span>
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
                        <IconButton icon={MoreHorizontal} label={`Aktionen für ${f.name}`} size="sm" onClick={(e) => openMenuAt(e, rowMenu(f))} />
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
  const [value, setValue] = useState(file.name);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const problem = renameProblem(file.name, value, names);
  const s = useApp.getState;
  // The name without its extension is selected, ready to type over.
  useEffect(() => {
    const t = setTimeout(() => input.current?.setSelectionRange(0, stemLength(file.name)), 40);
    return () => clearTimeout(t);
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
        title: "Datei umbenannt",
        detail: out.pages.length ? `„${out.name}“ – in ${plural(out.pages.length, "Seite", "Seiten")} angepasst` : `„${out.name}“`,
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
      title="Datei umbenennen"
      description={live ? `Die Einbettungen in ${plural(live, "Seite", "Seiten")} werden mit angepasst; die bisherigen Fassungen bleiben als Versionen erhalten.` : "Die Datei wird in keiner Seite verwendet."}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Abbrechen
          </Button>
          <Button variant="primary" onClick={() => void submit()} loading={busy} disabled={!!problem}>
            Umbenennen
          </Button>
        </>
      }
    >
      <input
        ref={input}
        value={value}
        onChange={(e) => (setValue(e.target.value), setServerError(null))}
        onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), void submit())}
        aria-label="Neuer Dateiname"
        aria-invalid={!!error}
        className="input att-rename-input"
        data-autofocus
        spellCheck={false}
      />
      <div className={`att-rename-hint ${error ? "is-error" : ""}`} role={error ? "alert" : undefined}>
        {error ?? "Die Dateiendung bleibt gleich."}
      </div>
    </Dialog>
  );
}

function CleanupDialog({ files, onClose, onDelete }: { files: AttachmentInfo[]; onClose: () => void; onDelete: (names: string[]) => Promise<void> }) {
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
      title="Unbenutzte Anhänge aufräumen"
      description={`${plural(files.length, "Datei wird", "Dateien werden")} in keiner Seite verwendet (${formatSize(totalSize(files))}). Gelöschte Dateien lassen sich aus dem Papierkorb wiederherstellen.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Abbrechen
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
            {chosen.length ? `${plural(chosen.length, "Datei", "Dateien")} löschen (${formatSize(totalSize(chosen))})` : "Löschen"}
          </Button>
        </>
      }
    >
      <label className="att-clean-all">
        <input type="checkbox" className="task-check" checked={all} onChange={() => setPicked(all ? new Set() : new Set(files.map((f) => f.name)))} />
        <span>Alle auswählen</span>
      </label>
      <ul className="att-clean-list" aria-label="Unbenutzte Dateien">
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
