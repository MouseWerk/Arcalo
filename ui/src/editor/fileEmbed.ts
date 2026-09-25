// File attachments: `![[Angebot.pdf]]`, `![[Daten.xlsx]]`, … (Obsidian embed syntax) of files in
// `attachments/`. PDFs show a preview card (first page, pdf.js, lazy) that opens the PDF viewer;
// any other file is a chip with type icon, name and size that opens in its default app.
// Images (`imageEmbed`) and drawings (`drawingEmbed`) keep their own nodes. Dropped and pasted
// files are stored here too (`AttachmentDrop`): images content-hashed, other files by name.

import { Extension, Node, type Editor } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg"]);

/**
 * Lower-case extension of a name that `![[…]]` embeds as a file: 1 to 10 ASCII letters or digits
 * with at least one letter, not `md`, so `![[Notiz]]` and `![[Version 1.2]]` stay note embeds.
 * Same rule as `attachments::file_extension` in the core.
 */
export function fileExtension(name: string): string | null {
  const i = name.lastIndexOf(".");
  if (i <= 0) return null;
  const ext = name.slice(i + 1);
  if (!/^[A-Za-z0-9]{1,10}$/.test(ext) || !/[A-Za-z]/.test(ext) || ext.toLowerCase() === "md") return null;
  return ext.toLowerCase();
}

export const isImageName = (name: string) => IMAGE_EXT.has(fileExtension(name) ?? "");
export const isPdfName = (name: string) => fileExtension(name) === "pdf";

/** Embedded by this node: a file that is neither an image nor a drawing. */
export function isFileEmbedName(name: string): boolean {
  const ext = fileExtension(name);
  return ext != null && !IMAGE_EXT.has(ext) && ext !== "excalidraw";
}

/** File name without folders (`![[Ordner/a.pdf]]` shows `a.pdf`). */
export const baseName = (name: string) => name.split(/[\\/]/).pop() ?? name;

/**
 * Whether a `[[target]]` link names a file (`[[Angebot.pdf]]`, `[[Ordner/Daten.xlsx]]`) rather than a
 * page: its last segment has a file extension. Where a page has that title, the page wins (callers
 * check that). Same rule as `attachment_manager::is_file_link` in the core.
 */
export const isFileLinkTarget = (target: string) => fileExtension(baseName(target.trim())) != null;

/** `1,2 MB`, `340 kB`, `12 B` (German decimal comma). */
export function formatSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const units = ["kB", "MB", "GB"];
  let v = bytes / 1000;
  let u = 0;
  while (v >= 1000 && u < units.length - 1) {
    v /= 1000;
    u++;
  }
  return `${v.toLocaleString("de-DE", { maximumFractionDigits: v < 10 ? 1 : 0 })} ${units[u]}`;
}

// ------------------------------------------------------------- icons

// Lucide icons (ISC) as markup: node views are plain DOM, like the time-entry chip.
const PAGE =
  '<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/>';
const ICONS = {
  file: PAGE,
  text: PAGE + '<path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
  sheet: PAGE + '<path d="M8 13h2"/><path d="M14 13h2"/><path d="M8 17h2"/><path d="M14 17h2"/>',
  archive:
    '<path d="M13.659 22H18a2 2 0 0 0 2-2V8a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 14 2H6a2 2 0 0 0-2 2v11.5"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/><path d="M8 12v-1"/><path d="M8 18v-2"/><path d="M8 7V6"/><circle cx="8" cy="20" r="2"/>',
  image: PAGE + '<circle cx="10" cy="12" r="2"/><path d="m20 17-1.296-1.296a2.41 2.41 0 0 0-3.408 0L9 22"/>',
  audio:
    '<path d="M11.65 22H18a2 2 0 0 0 2-2V8a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 14 2H6a2 2 0 0 0-2 2v10.35"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/><path d="M8 20v-7l3 1.474"/><circle cx="6" cy="20" r="2"/>',
  video: PAGE + '<path d="M15.033 13.44a.647.647 0 0 1 0 1.12l-4.065 2.352a.645.645 0 0 1-.968-.56v-4.704a.645.645 0 0 1 .967-.56z"/>',
  code: PAGE + '<path d="M10 12.5 8 15l2 2.5"/><path d="m14 12.5 2 2.5-2 2.5"/>',
  slides: '<path d="M2 3h20"/><path d="M21 3v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V3"/><path d="m7 21 5-5 5 5"/>',
};
export type FileKind = keyof typeof ICONS;

const KINDS: [FileKind, string[]][] = [
  ["text", ["pdf", "doc", "docx", "odt", "rtf", "txt", "pages", "epub", "msg", "eml"]],
  ["sheet", ["xls", "xlsx", "xlsm", "ods", "csv", "tsv", "numbers"]],
  ["slides", ["ppt", "pptx", "odp", "key"]],
  ["archive", ["zip", "7z", "rar", "tar", "gz", "tgz", "bz2", "xz", "zst"]],
  ["image", ["bmp", "tif", "tiff", "heic", "heif", "ico", "psd", "ai", "eps", "raw", "avif"]],
  ["audio", ["mp3", "wav", "m4a", "aac", "flac", "ogg", "opus", "wma"]],
  ["video", ["mp4", "mov", "avi", "mkv", "webm", "wmv", "m4v"]],
  ["code", ["json", "xml", "yaml", "yml", "html", "htm", "css", "js", "ts", "py", "sql", "sh", "ps1", "bat", "log", "ini", "toml", "drawio", "bpmn", "vsdx"]],
];

export function fileKind(name: string): FileKind {
  const ext = fileExtension(name) ?? "";
  return KINDS.find(([, exts]) => exts.includes(ext))?.[0] ?? "file";
}

export function fileIcon(kind: FileKind, size = 16): SVGSVGElement {
  const wrap = document.createElement("span");
  wrap.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[kind]}</svg>`;
  return wrap.firstElementChild as SVGSVGElement;
}

// ------------------------------------------------------------- node

export interface FileEmbedOptions {
  /** Size in bytes of an attachment, `null` when the file is missing. */
  size: (name: string) => Promise<number | null>;
  /** Opens a file in its default app. */
  onOpen: (name: string) => void;
  /** Opens the PDF viewer (on `page`, from `#page=3`). */
  onOpenPdf: (name: string, page: number | null) => void;
  /** Draws the first page of a PDF into `canvas` (`width` CSS pixels), resolves to its page count. */
  renderPdfPreview: ((name: string, canvas: HTMLCanvasElement, width: number) => Promise<number>) | null;
}

// `![[name.ext#sub|alt]]`: the name is checked with `isFileEmbedName` after matching.
const FILE_RE = /^!\[\[([^\]|#\n]+?)(#[^\]|\n]*)?(?:\|([^\]\n]*))?\]\]/;

/** `#page=3` → 3. */
export function anchorPage(anchor: string | null): number | null {
  const m = /^#page=(\d+)/.exec(anchor ?? "");
  return m ? Math.max(1, Number(m[1])) : null;
}

const embedMarkdown = (attrs: Record<string, unknown> | undefined, inCell: boolean) =>
  `![[${attrs?.name}${attrs?.anchor ?? ""}${attrs?.alt != null ? (inCell ? "\\|" : "|") + attrs.alt : ""}]]`;

/** Obsidian embed `![[Angebot.pdf]]` / `![[Daten.xlsx]]` of a stored file. */
export const FileEmbed = Node.create<FileEmbedOptions>({
  name: "fileEmbed",
  group: "inline",
  inline: true,
  atom: true,
  draggable: true,

  addOptions() {
    return { size: async () => null, onOpen: () => {}, onOpenPdf: () => {}, renderPdfPreview: null };
  },
  addAttributes() {
    return { name: { default: "" }, anchor: { default: null }, alt: { default: null } };
  },
  parseHTML() {
    return [
      {
        tag: "span[data-file]",
        getAttrs: (el) => ({ name: (el as HTMLElement).dataset.file, anchor: (el as HTMLElement).dataset.anchor ?? null, alt: (el as HTMLElement).dataset.alt ?? null }),
      },
    ];
  },
  renderHTML({ node }) {
    const { name, anchor, alt } = node.attrs;
    return ["span", { "data-file": name, ...(anchor != null ? { "data-anchor": anchor } : {}), ...(alt != null ? { "data-alt": alt } : {}), class: "file-embed" }, baseName(name)];
  },
  renderText: ({ node }) => embedMarkdown(node.attrs, false),

  markdownTokenizer: {
    name: "fileEmbed",
    level: "inline",
    start: (src: string) => src.indexOf("![["),
    tokenize(src: string) {
      const m = FILE_RE.exec(src);
      if (!m || !isFileEmbedName(m[1].trim())) return undefined;
      return { type: "fileEmbed", raw: m[0], name: m[1].trim(), anchor: m[2] ?? null, alt: m[3] ?? null };
    },
  },
  parseMarkdown: (token) => ({ type: "fileEmbed", attrs: { name: token.name, anchor: token.anchor, alt: token.alt } }),
  renderMarkdown: (node, _h, ctx) => embedMarkdown(node.attrs, !!ctx?.meta?.parentAttrs?.__inTableCell),

  addNodeView() {
    const { size, onOpen, onOpenPdf, renderPdfPreview } = this.options;
    return ({ node }) => {
      const name: string = node.attrs.name;
      const base = baseName(name);
      const pdf = isPdfName(base);
      const dom = document.createElement("span");
      dom.className = pdf ? "pdf-embed" : "file-embed";
      dom.contentEditable = "false";
      dom.dataset.file = name;
      dom.title = pdf ? `${base} – klicken zum Ansehen` : `${base} – klicken zum Öffnen`;

      const bar = document.createElement("span");
      bar.className = pdf ? "pdf-embed-bar" : "file-embed-bar";
      const icon = document.createElement("span");
      icon.className = "file-embed-icon";
      icon.append(fileIcon(fileKind(base), pdf ? 15 : 16));
      const label = document.createElement("span");
      label.className = "file-embed-name";
      label.textContent = base;
      const meta = document.createElement("span");
      meta.className = "file-embed-size";
      bar.append(icon, label, meta);

      let bytes: number | null = null;
      let pages: number | null = null;
      const showMeta = () => {
        const parts = [pages != null ? `${pages} ${pages === 1 ? "Seite" : "Seiten"}` : "", bytes != null ? formatSize(bytes) : ""].filter(Boolean);
        meta.textContent = parts.join(" · ");
      };
      let alive = true;
      size(base).then(
        (n) => {
          if (!alive) return;
          bytes = n;
          dom.classList.toggle("is-missing", n == null);
          if (n == null) meta.textContent = "Datei fehlt";
          else showMeta();
        },
        () => {},
      );

      let observer: IntersectionObserver | null = null;
      if (pdf) {
        const page = document.createElement("span");
        page.className = "pdf-embed-page";
        const canvas = document.createElement("canvas");
        canvas.className = "pdf-embed-canvas";
        const status = document.createElement("span");
        status.className = "pdf-embed-status";
        status.textContent = "Vorschau wird geladen…";
        page.append(canvas, status);
        dom.append(page, bar);
        // pdf.js loads when the card scrolls into view, not with every note that has a PDF.
        const render = () => {
          if (!renderPdfPreview) return;
          renderPdfPreview(base, canvas, 380).then(
            (n) => {
              if (!alive) return;
              pages = n;
              dom.classList.add("is-ready");
              showMeta();
            },
            () => {
              if (!alive) return;
              dom.classList.add("is-failed");
              status.textContent = bytes == null ? "Datei fehlt" : "Keine Vorschau möglich";
            },
          );
        };
        if (typeof IntersectionObserver === "undefined") render();
        else {
          observer = new IntersectionObserver((entries) => {
            if (entries.some((e) => e.isIntersecting)) {
              observer?.disconnect();
              observer = null;
              render();
            }
          }, { rootMargin: "200px" });
          observer.observe(dom);
        }
      } else {
        dom.append(bar);
      }

      dom.addEventListener("click", (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        if (pdf) onOpenPdf(base, anchorPage(node.attrs.anchor));
        else onOpen(base);
      });
      return {
        dom,
        ignoreMutation: () => true,
        destroy: () => {
          alive = false;
          observer?.disconnect();
        },
      };
    };
  },
});

/** The file-embed node at a DOM element inside the editor (for the context menu), or null. */
export function fileEmbedAt(editor: Editor, el: HTMLElement): { pos: number; name: string } | null {
  const view = editor.view;
  let pos: number;
  try {
    pos = view.posAtDOM(el, 0);
  } catch {
    return null;
  }
  for (const p of [pos, pos - 1]) {
    const node = p >= 0 ? view.state.doc.nodeAt(p) : null;
    if (node?.type.name === "fileEmbed") return { pos: p, name: node.attrs.name };
  }
  return null;
}

// ------------------------------------------------------------- drop + paste

export interface AttachmentDropOptions {
  /** Stores an image (content-hashed name), returns its attachment name. */
  uploadImage: ((file: File) => Promise<string | null>) | null;
  /** Stores any other file under its name, returns its attachment name. */
  uploadFile: ((file: File) => Promise<string | null>) | null;
}

/** Dropped or pasted files (from the file manager, the clipboard): images become `![[x.png]]`, others file embeds. */
export const AttachmentDrop = Extension.create<AttachmentDropOptions>({
  name: "attachmentDrop",

  addOptions() {
    return { uploadImage: null, uploadFile: null };
  },

  addProseMirrorPlugins() {
    const { uploadImage, uploadFile } = this.options;
    if (!uploadImage && !uploadFile) return [];
    const schema = this.editor.schema;
    // Images the image node shows (by name or type); anything else is stored as a file.
    const isImage = (f: File) => isImageName(f.name) || (!fileExtension(f.name) && /^image\/(png|jpe?g|gif|webp|svg\+xml)$/.test(f.type));
    const usable = (list?: FileList | null) => [...(list ?? [])].filter((f) => (isImage(f) ? uploadImage : uploadFile));
    const insert = async (view: EditorView, files: File[], at?: number) => {
      for (const file of files) {
        const image = isImage(file);
        const name = await (image ? uploadImage! : uploadFile!)(file);
        if (!name || view.isDestroyed) continue;
        const type = image ? schema.nodes.imageEmbed : isFileEmbedName(name) ? schema.nodes.fileEmbed : schema.nodes.drawingEmbed;
        if (!type) continue;
        const pos = Math.min(at ?? view.state.selection.from, view.state.doc.content.size);
        view.dispatch(view.state.tr.insert(pos, type.create({ name })).scrollIntoView());
        if (at != null) at += 1;
      }
    };
    return [
      new Plugin({
        key: new PluginKey("attachmentDrop"),
        props: {
          handlePaste(view, event) {
            const files = usable(event.clipboardData?.files);
            if (!files.length) return false;
            event.preventDefault();
            void insert(view, files);
            return true;
          },
          handleDrop(view, event, _slice, moved) {
            if (moved) return false;
            const files = usable(event.dataTransfer?.files);
            if (!files.length) return false;
            event.preventDefault();
            void insert(view, files, view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos);
            return true;
          },
        },
      }),
    ];
  },
});
