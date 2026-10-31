// Images on the clipboard.
//
// Copying: ProseMirror writes its HTML (the images as `<img data-embed="name">`, so a paste in any
// note embeds the same stored file again) and the Markdown text (`![[name]]`). Other programs
// cannot load the app's image addresses, so the HTML carries the images' bytes as `data:`
// addresses, and a single image is also copied as an image (PNG) for programs that take no HTML
// (an image editor, a chat) where the web clipboard allows it.
//
// Pasting: which format counts is decided in lib/pasted.ts. Images inside pasted HTML as `data:`
// addresses (web pages, mail programs, another Arcalo) are stored as attachments and embedded.

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { DOMSerializer, type Node as PMNode, type Schema, type Slice } from "@tiptap/pm/model";
import type { EditorView } from "@tiptap/pm/view";
import { baseName, isImageName } from "./fileEmbed";
import { dataUri, mimeOf } from "../lib/htmlExport";
import type { ClipData } from "../lib/clipboard";

/** Images above this size keep their address in copied HTML. */
export const INLINE_IMAGE_BYTES = 10 * 1024 * 1024;
/** The images read for copies are kept up to this size in all. */
const INLINE_CACHE_BYTES = 64 * 1024 * 1024;

// ------------------------------------------------------------- paste

const DATA_IMAGE = /^data:(image\/(?:png|jpeg|jpg|gif|webp|svg\+xml))(;base64)?,(.*)$/is;
const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg" };

/** The image of a `data:` address as a file (`bild.png`), or null for anything else. */
export function dataUrlFile(src: string | null): File | null {
  const m = DATA_IMAGE.exec((src ?? "").trim());
  if (!m) return null;
  const type = m[1].toLowerCase();
  let bytes: Uint8Array;
  try {
    bytes = m[2] ? Uint8Array.from(atob(m[3].replace(/\s+/g, "")), (c) => c.charCodeAt(0)) : new TextEncoder().encode(decodeURIComponent(m[3]));
  } catch {
    return null;
  }
  return bytes.length ? new File([bytes as BlobPart], `bild.${EXT[type]}`, { type }) : null;
}

/** Images with a `data:` address in pasted HTML (not the stored images of a note's copy, which name their file). */
function dataImages(doc: Document): HTMLImageElement[] {
  return [...doc.querySelectorAll<HTMLImageElement>("img[src]")].filter((img) => !img.hasAttribute("data-embed") && !img.hasAttribute("data-src") && DATA_IMAGE.test(img.getAttribute("src")!.trim()));
}

/**
 * Stores the `data:` images of pasted HTML (`upload` returns the attachment name) and returns the
 * HTML with them as embeds; an image that could not be stored is left out.
 */
export async function storeDataImages(doc: Document, upload: (file: File) => Promise<string | null>): Promise<string> {
  for (const img of dataImages(doc)) {
    const file = dataUrlFile(img.getAttribute("src"));
    const name = file ? await upload(file) : null;
    if (!name) {
      img.remove();
      continue;
    }
    img.setAttribute("data-embed", name);
    img.removeAttribute("src");
  }
  return doc.body.innerHTML;
}

/** A paste of HTML with `data:` images: the images are stored first, then the HTML is pasted with them embedded. */
export function pasteDataImages(view: EditorView, event: ClipboardEvent, upload: ((file: File) => Promise<string | null>) | null): boolean {
  const html = event.clipboardData?.getData("text/html") ?? "";
  if (!upload || !/<img[^>]+data:image\//i.test(html) || view.state.selection.$from.parent.type.spec.code) return false;
  // Ctrl+Shift+V pastes plain text (ProseMirror).
  const input = (view as unknown as { input?: { shiftKey?: boolean; lastKeyCode?: number } }).input;
  if (input?.shiftKey && input.lastKeyCode !== 45) return false;
  const doc = new DOMParser().parseFromString(html, "text/html");
  if (!dataImages(doc).length) return false;
  event.preventDefault();
  void storeDataImages(doc, upload).then((out) => {
    if (!view.isDestroyed) view.pasteHTML(out);
  });
  return true;
}

// ------------------------------------------------------------- copy

/** The stored image an `<img>` address shows (`resolve`: the address of a name), or null. */
function nameOfSrc(src: string, resolve: (name: string) => string): string | null {
  let name: string;
  try {
    name = decodeURIComponent(src.split(/[?#]/)[0].split("/").pop() ?? "");
  } catch {
    return null;
  }
  return name && isImageName(name) && resolve(name) === src ? name : null;
}

/** The stored image an `<img>` of the editor shows (`resolve`: the address of a name), or null. */
export function storedImageName(img: Element, resolve: (name: string) => string): string | null {
  const embed = img.getAttribute("data-embed");
  return embed ? baseName(embed) : nameOfSrc(img.getAttribute("src") ?? "", resolve);
}

// The bytes of the images in the selection, as `data:` addresses, read when an image is selected
// (a copy must write its formats while the key is handled, there is no time to read files then).
const inlined = new Map<string, string>();
const reading = new Set<string>();
let inlinedSize = 0;

/** The `data:` address of a stored image read before, or undefined. */
export function inlinedImage(name: string): string | undefined {
  return inlined.get(name);
}

/** Reads stored images for copies (`read`: their bytes); the least recently read go above `INLINE_CACHE_BYTES`. */
export async function readForCopy(names: string[], read: (name: string) => Promise<Uint8Array>): Promise<void> {
  await Promise.all(
    names
      .filter((n) => !inlined.has(n) && !reading.has(n))
      .map(async (name) => {
        reading.add(name);
        try {
          const bytes = await read(name);
          if (bytes.length > INLINE_IMAGE_BYTES) return;
          const uri = dataUri(bytes, mimeOf(name));
          inlined.set(name, uri);
          inlinedSize += uri.length;
          for (const [old, u] of inlined) {
            if (inlinedSize <= INLINE_CACHE_BYTES || old === name) break;
            inlined.delete(old);
            inlinedSize -= u.length;
          }
        } catch {
          /* not stored (any more): the copy keeps the address */
        } finally {
          reading.delete(name);
        }
      }),
  );
}

/** Stored images in `from`–`to` of `doc` (at most `max`). */
export function imagesIn(doc: PMNode, from: number, to: number, resolve: (name: string) => string, max = 50): string[] {
  const names = new Set<string>();
  doc.nodesBetween(from, to, (node) => {
    if (names.size >= max) return false;
    if (node.type.name === "imageEmbed" && node.attrs.name) names.add(baseName(node.attrs.name));
    else if (node.type.name === "image") {
      const name = nameOfSrc(resolveMarkdownSrc(node.attrs.src ?? "", resolve), resolve);
      if (name) names.add(name);
    }
    return true;
  });
  return [...names];
}

/** The address a Markdown image's `src` is shown with (as `MarkdownImage` renders it). */
function resolveMarkdownSrc(src: string, resolve: (name: string) => string): string {
  if (!src || /^(https?:|data:|blob:|arcalo-asset:)/i.test(src)) return src;
  let path = src;
  try {
    path = decodeURI(src);
  } catch {
    /* keep as is */
  }
  return resolve(baseName(path));
}

/**
 * The serializer for copies and drags: stored images carry their bytes (read when they were
 * selected) instead of the app's address, which other programs cannot load. A paste in a note
 * still takes the image by its name (`data-embed`, `data-src`).
 */
export function copySerializer(schema: Schema, resolve: (name: string) => string): DOMSerializer {
  const base = DOMSerializer.fromSchema(schema);
  const nodes = { ...base.nodes };
  for (const type of ["imageEmbed", "image"]) {
    const render = nodes[type];
    if (!render) continue;
    nodes[type] = (node) => {
      const spec = render(node);
      if (!Array.isArray(spec) || spec[0] !== "img" || !spec[1] || typeof spec[1] !== "object" || Array.isArray(spec[1])) return spec;
      const attrs = spec[1] as Record<string, unknown>;
      const name = typeof attrs["data-embed"] === "string" ? baseName(attrs["data-embed"]) : nameOfSrc(String(attrs.src ?? ""), resolve);
      const uri = name ? inlined.get(name) : undefined;
      return uri ? ["img", { ...attrs, src: uri }, ...spec.slice(2)] : spec;
    };
  }
  return new DOMSerializer(nodes, base.marks);
}

/** An image's bytes as PNG (other formats drawn into a canvas; GIFs with their first frame). */
export async function toPng(bytes: Uint8Array, mime: string): Promise<Blob> {
  if (mime === "image/png") return new Blob([bytes as BlobPart], { type: "image/png" });
  const img = new Image();
  img.src = dataUri(bytes, mime);
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth || 1;
  canvas.height = img.naturalHeight || 1;
  canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
  return new Promise<Blob>((ok, fail) => canvas.toBlob((b) => (b ? ok(b) : fail(new Error("PNG"))), "image/png"));
}

export interface ImageCopyOptions {
  /** Address of a stored image (as the image nodes use it). */
  resolve: (name: string) => string;
  /** Bytes of a stored file. */
  read: ((name: string) => Promise<Uint8Array>) | null;
  /** Writes several formats at once (`copyFormats`); rejects when the clipboard refuses. */
  write: ((formats: Record<string, ClipData>) => Promise<void>) | null;
}

/**
 * The formats for a copy of a single stored image (selected, or the only thing in `slice`): the
 * note's HTML with the image's bytes, its text (`![[name]]`) and the image as PNG. Null otherwise.
 */
export function imageCopyFormats(view: EditorView, slice: Slice, o: Pick<ImageCopyOptions, "resolve"> & { read: (name: string) => Promise<Uint8Array> }): Record<string, ClipData> | null {
  let leaves = 0;
  slice.content.descendants((n) => {
    if (n.isLeaf) leaves++;
    return true;
  });
  if (leaves !== 1) return null;
  const { dom, text } = view.serializeForClipboard(slice);
  const img = dom.querySelector("img");
  const name = img ? storedImageName(img, o.resolve) : null;
  if (!img || !name) return null;
  const bytes = o.read(name);
  const html = bytes.then(
    (b) => {
      if (b.length <= INLINE_IMAGE_BYTES) img.setAttribute("src", dataUri(b, mimeOf(name)));
      return new Blob([dom.innerHTML], { type: "text/html" });
    },
    () => new Blob([dom.innerHTML], { type: "text/html" }),
  );
  return {
    "text/html": html,
    "text/plain": new Blob([text], { type: "text/plain" }),
    "image/png": bytes.then((b) => toPng(b, mimeOf(name))),
  };
}

/**
 * Copies with stored images: the HTML carries their bytes (`copySerializer`); a single image is
 * also copied as an image where the web clipboard allows it (WebKit refuses it without a user's
 * own key press), else ProseMirror's copy stays as it is.
 */
export const ImageClipboard = Extension.create<ImageCopyOptions & { upload: ((file: File) => Promise<string | null>) | null }>({
  name: "imageClipboard",
  addOptions() {
    return { resolve: (name) => `attachments/${encodeURIComponent(name)}`, read: null, write: null, upload: null };
  },
  addProseMirrorPlugins() {
    const { resolve, read, write, upload } = this.options;
    const serializer = copySerializer(this.editor.schema, resolve);
    const onCopy = (view: EditorView) => {
      if (!read || !write || view.state.selection.empty) return false;
      const formats = imageCopyFormats(view, view.state.selection.content(), { resolve, read });
      if (formats) write(formats).catch(() => {});
      return false;
    };
    return [
      new Plugin({
        key: new PluginKey("imageClipboard"),
        props: {
          clipboardSerializer: serializer,
          handleDOMEvents: { copy: onCopy, cut: onCopy },
          handlePaste: (view, event) => pasteDataImages(view, event, upload),
        },
        view: () => ({
          update(view, prev) {
            const sel = view.state.selection;
            if (!read || sel.empty || prev.selection.eq(sel)) return;
            const names = imagesIn(view.state.doc, sel.from, sel.to, resolve).filter((n) => !inlined.has(n));
            if (names.length) void readForCopy(names, read);
          },
        }),
      }),
    ];
  },
});
