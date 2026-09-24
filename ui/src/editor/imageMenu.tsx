// Right-click on an image in a note: size (`![[bild.png|480]]`), full view, open in its app or
// in the file manager, copy the image or the embed, remove it.

import { useEffect } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import { ClipboardCopy, Copy, ExternalLink, FolderOpen, Maximize2, Ruler, Trash2, X } from "lucide-react";
import type { MenuEntry } from "../components/ui";
import { IconButton } from "../components/ui";
import { api } from "../lib/api";
import { useApp } from "../store/app";

const SIZES: { label: string; width: number | null }[] = [
  { label: "Klein (240 px)", width: 240 },
  { label: "Mittel (480 px)", width: 480 },
  { label: "Groß (720 px)", width: 720 },
  { label: "Originalgröße", width: null },
];

/** Copies an image as PNG to the clipboard (other formats are converted). */
async function copyImage(src: string) {
  const blob = await (await fetch(src)).blob();
  let png = blob;
  if (blob.type !== "image/png") {
    const bmp = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    canvas.getContext("2d")!.drawImage(bmp, 0, 0);
    png = await new Promise<Blob>((ok, fail) => canvas.toBlob((b) => (b ? ok(b) : fail(new Error("PNG"))), "image/png"));
  }
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}

/** The menu for the image node at `pos`. `view` opens the full view. */
export function imageMenu(editor: Editor, pos: number, img: HTMLImageElement, view: (src: string, name: string) => void): MenuEntry[] {
  const node = editor.state.doc.nodeAt(pos);
  if (!node) return [];
  const embed = node.type.name === "imageEmbed";
  const name: string = embed ? node.attrs.name : (node.attrs.src ?? "");
  const s = useApp.getState();
  const select = () => editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos)));
  const setWidth = (width: number | null) => {
    select();
    // The part after | is the width for embeds (Obsidian syntax); a caption stays.
    const alt: string | null = node.attrs.alt;
    const caption = alt && !/^\d+(x\d+)?$/.test(alt) ? alt : null;
    editor.chain().focus().updateAttributes(node.type.name, { alt: width ? String(width) : caption }).run();
  };
  const failed = (what: string) => (e: unknown) => s.error(what, e);
  return [
    { label: "Vollbild ansehen", icon: Maximize2, onSelect: () => view(img.currentSrc || img.src, name) },
    ...(embed
      ? ([
          { label: "Größe", icon: Ruler, submenu: SIZES.map((z) => ({ label: z.label, checked: (node.attrs.alt ?? null) === (z.width ? String(z.width) : null), onSelect: () => setWidth(z.width) })) },
          "separator",
          { label: "Öffnen", icon: ExternalLink, onSelect: () => api.openAttachment(name).catch(failed("Bild ließ sich nicht öffnen")) },
          { label: "Im Ordner zeigen", icon: FolderOpen, onSelect: () => api.openAttachment(name, true).catch(failed("Ordner ließ sich nicht öffnen")) },
        ] as MenuEntry[])
      : []),
    "separator",
    {
      label: "Bild kopieren",
      icon: ClipboardCopy,
      onSelect: () => copyImage(img.currentSrc || img.src).then(() => s.toast({ tone: "success", title: "Bild kopiert" }), failed("Bild ließ sich nicht kopieren")),
    },
    ...(embed ? [{ label: "Einbettung kopieren", icon: Copy, onSelect: () => navigator.clipboard.writeText(`![[${name}]]`) } as MenuEntry] : []),
    "separator",
    {
      label: "Aus der Notiz entfernen",
      icon: Trash2,
      danger: true,
      onSelect: () => {
        select();
        editor.chain().focus().deleteSelection().run();
      },
    },
  ];
}

/** Full view of an image; Esc or a click closes it. */
export function ImageViewer({ src, name, onClose }: { src: string; name: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), onClose());
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return createPortal(
    <div className="image-viewer" role="dialog" aria-label={name} onClick={onClose}>
      <img src={src} alt={name} onClick={(e) => e.stopPropagation()} />
      <div className="image-viewer-bar" onClick={(e) => e.stopPropagation()}>
        <span className="image-viewer-name">{name}</span>
        <IconButton icon={X} label="Schließen" onClick={onClose} />
      </div>
    </div>,
    document.body,
  );
}
