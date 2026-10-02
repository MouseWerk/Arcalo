// File attachments in notes: the file dialog of „Datei einfügen“, the right-click menu of file
// chips and PDF cards, and the PDF viewer overlay. Like the drawing editor, the viewer has its own
// React root on <body>; it and pdf.js are lazy-loaded.

import { lazy, Suspense } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Editor } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import { open } from "@tauri-apps/plugin-dialog";
import { Copy, ExternalLink, Eye, FolderOpen, Trash2 } from "lucide-react";
import type { MenuEntry } from "../components/ui";
import { api } from "../lib/api";
import { useApp } from "../store/app";
import { anchorPage, baseName, isFileEmbedName, isFileLinkTarget, isImageName, isPdfName } from "./fileEmbed";
import { titleSet } from "../lib/links";
import { pdfAnchor } from "../lib/linking";
import { t } from "../lib/i18n";

const PdfViewer = lazy(() => import("./PdfViewer"));
let root: Root | null = null;

/** Opens the PDF viewer for an attachment (one at a time), optionally on `page`. */
export function openPdfViewer(name: string, page: number | null = null, highlight: number | null = null) {
  const base = baseName(name);
  if (!isPdfName(base)) return;
  if (!root) {
    const host = document.createElement("div");
    host.className = "pdf-host";
    document.body.append(host);
    root = createRoot(host);
  }
  const close = () => root?.render(null);
  root.render(
    <Suspense fallback={<div className="pdf-overlay pdf-loading" role="dialog" aria-label={t("pdf.loading")}>{t("ws.pdfLoading")}</div>}>
      <PdfViewer key={`${base}-${Date.now()}`} name={base} page={page} highlight={highlight} onClose={close} />
    </Suspense>,
  );
}

/** Opens a file in its default app (programs are only shown in the file manager, see the shell). */
export function openFile(name: string) {
  api.openAttachment(baseName(name)).catch((e) => useApp.getState().error(t("file.openFailed"), e));
}

/**
 * A `[[Angebot.pdf]]` link whose target is a file (no page has that title) opens like a file embed:
 * PDFs in the viewer, other files in their default app. Returns false for a page link.
 */
export function openIfFileLink(target: string, anchor: string | null = null): boolean {
  if (!isFileLinkTarget(target) || titleSet(useApp.getState().pages).has(target.trim().toLowerCase())) return false;
  const name = baseName(target.trim());
  if (isPdfName(name)) openPdfViewer(name, anchorPage(anchor == null ? null : `#${anchor}`), pdfAnchor(anchor).highlight);
  else openFile(name);
  return true;
}

/** Inserts the embed of a stored attachment at the caret: image, drawing or file. */
export function insertAttachment(editor: Editor, name: string) {
  if (editor.isDestroyed) return;
  const type = isImageName(name) ? "imageEmbed" : isFileEmbedName(name) ? "fileEmbed" : "drawingEmbed";
  editor.chain().focus().insertContent({ type, attrs: { name } }).run();
}

/** Slash „Datei einfügen“: the system file dialog; the shell copies each file by its path. */
export async function pickFiles(editor: Editor) {
  let picked: string | string[] | null;
  try {
    picked = await open({ multiple: true, directory: false, title: t("file.insert") });
  } catch (e) {
    useApp.getState().error(t("file.pickerUnavailable"), e);
    return;
  }
  for (const path of picked == null ? [] : Array.isArray(picked) ? picked : [picked]) {
    try {
      insertAttachment(editor, (await api.importAttachment(path)).name);
    } catch (e) {
      useApp.getState().error(t("file.notInserted"), e);
    }
  }
}

/** Right-click menu of the file embed at `pos`. */
export function fileMenu(editor: Editor, pos: number): MenuEntry[] {
  const node = editor.state.doc.nodeAt(pos);
  if (node?.type.name !== "fileEmbed") return [];
  const name = baseName(node.attrs.name);
  const s = useApp.getState();
  const failed = (what: string) => (e: unknown) => s.error(what, e);
  const embed = `![[${node.attrs.name}${node.attrs.anchor ?? ""}${node.attrs.alt != null ? "|" + node.attrs.alt : ""}]]`;
  return [
    ...(isPdfName(name) ? [{ label: t("file.view"), icon: Eye, onSelect: () => openPdfViewer(name) } as MenuEntry] : []),
    { label: isPdfName(name) ? t("file.openExternal") : t("file.open"), icon: ExternalLink, onSelect: () => openFile(name) },
    { label: t("file.showInFolder"), icon: FolderOpen, onSelect: () => api.openAttachment(name, true).catch(failed(t("common.openFolderFailed"))) },
    "separator",
    {
      label: t("file.copyEmbed"),
      icon: Copy,
      onSelect: () => navigator.clipboard.writeText(embed).then(() => s.toast({ tone: "success", title: t("file.embedCopied") }), failed(t("file.copyFailed"))),
    },
    "separator",
    {
      label: t("file.removeFromNote"),
      icon: Trash2,
      danger: true,
      onSelect: () => {
        editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos)));
        editor.chain().focus().deleteSelection().run();
      },
    },
  ];
}
