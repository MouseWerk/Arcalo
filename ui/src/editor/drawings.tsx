// Drawing actions: create + embed a drawing, open the editor overlay. The overlay has its
// own React root on <body>, so any note (slash menu, click on a preview) or the command
// palette can open it without state in the app shell. Excalidraw itself is lazy-loaded.

import { lazy, Suspense } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Editor } from "@tiptap/core";
import { api } from "../lib/api";
import { useApp } from "../store/app";
import { drawingTitle, isDrawingName, lastDrawingEditor } from "./drawing";
import { SHOWN_PLACE } from "../lib/keepalive";
import { t } from "../lib/i18n";

const DrawingEditor = lazy(() => {
  // Excalidraw loads its fonts from here instead of a CDN (copied by scripts/excalidraw-assets.mjs).
  (window as unknown as { EXCALIDRAW_ASSET_PATH: string }).EXCALIDRAW_ASSET_PATH = `${import.meta.env.BASE_URL}excalidraw-assets/`;
  return import("./DrawingEditor");
});
let root: Root | null = null;

/** Opens the drawing editor overlay for `name` (one at a time). */
export function openDrawing(name: string) {
  const base = name.split(/[\\/]/).pop() ?? name;
  if (!isDrawingName(base)) return;
  if (!root) {
    const host = document.createElement("div");
    host.className = "drawing-host";
    document.body.append(host);
    root = createRoot(host);
  }
  const close = () => root?.render(null);
  root.render(
    <Suspense fallback={<div className="drawing-overlay drawing-loading" role="dialog" aria-label={t("draw.loading")}>{t("draw.loadingDots")}</div>}>
      <DrawingEditor key={`${base}-${Date.now()}`} name={base} onClose={close} />
    </Suspense>,
  );
}

/** Creates an empty drawing, embeds it at the caret and opens the editor. */
export async function insertDrawing(editor: Editor) {
  try {
    const saved = await api.createDrawing(drawingTitle());
    if (editor.isDestroyed) return;
    editor.chain().focus().insertContent({ type: "drawingEmbed", attrs: { name: saved.name } }).run();
    openDrawing(saved.name);
  } catch (e) {
    useApp.getState().error(t("draw.notCreated"), e);
  }
}

/** Command palette „Neue Zeichnung einfügen“: into the note of the active pane, else the last focused one. */
export function insertDrawingInActiveNote() {
  const dom = document.querySelector<HTMLElement & { editor?: Editor }>(`${SHOWN_PLACE} .ProseMirror`);
  // The last focused note only while it is on screen (not in a hidden kept tab).
  const last = lastDrawingEditor();
  const lastShown = last && (last.view.dom as HTMLElement).getClientRects().length > 0 ? last : null;
  const editor = dom?.editor && !dom.editor.isDestroyed ? dom.editor : lastShown;
  if (!editor) {
    useApp.getState().toast({ tone: "warning", title: t("draw.noNote"), detail: t("draw.noNoteDetail") });
    return;
  }
  void insertDrawing(editor);
}
