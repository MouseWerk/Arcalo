// Drawings (Excalidraw): `![[Zeichnung 2026-09-24 14.05.excalidraw]]` embeds the scene
// `attachments/<name>` and shows its preview `attachments/<name>.svg`. A click opens the
// drawing editor (drawings.tsx, lazy-loaded Excalidraw) in a full-window overlay.

import { Node, type Editor } from "@tiptap/core";

/** `name.excalidraw`: a plain file name (no folders, not hidden), like the Rust side checks. */
export function isDrawingName(name: string): boolean {
  return /^[^./\\:\0 ][^/\\:\0]*\.excalidraw$/i.test(name) && name.length <= 180 && !/[\u0000-\u001f\u007f]/.test(name);
}

/** Title of a new drawing: „Zeichnung 2026-09-24 14.05“. */
export function drawingTitle(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `Zeichnung ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}`;
}

/** File name without folders and `.excalidraw`, for headers and alt texts. */
export const drawingLabel = (name: string) => (name.split(/[\\/]/).pop() ?? name).replace(/\.excalidraw$/i, "");

/** Fired on `window` after a drawing was saved (`detail.name`), so previews reload. */
export const DRAWING_SAVED_EVENT = "annalo:drawing-saved";

let lastEditor: Editor | null = null;

/** The editor that last had the focus and shows drawings (for the command palette). */
export const lastDrawingEditor = () => (lastEditor && !lastEditor.isDestroyed ? lastEditor : null);

// ------------------------------------------------------------- node

export interface DrawingOptions {
  /** URL for an attachment name. */
  resolve: (name: string) => string;
  /** Opens the drawing editor. */
  onOpen: (name: string) => void;
}

const DRAWING_RE = /^!\[\[([^\]|\n]+?\.excalidraw)(?:\|([^\]\n]*))?\]\]/i;

/** Obsidian embed `![[name.excalidraw]]` of a drawing, shown as its SVG preview. */
export const DrawingEmbed = Node.create<DrawingOptions>({
  name: "drawingEmbed",
  group: "inline",
  inline: true,
  atom: true,
  draggable: true,

  addOptions() {
    return { resolve: (name) => `attachments/${encodeURIComponent(name)}`, onOpen: () => {} };
  },
  addAttributes() {
    return { name: { default: "" }, alt: { default: null } };
  },
  parseHTML() {
    return [{ tag: "img[data-drawing]", getAttrs: (el) => ({ name: (el as HTMLElement).dataset.drawing, alt: (el as HTMLElement).dataset.alt ?? null }) }];
  },
  renderHTML({ node }) {
    const { name, alt } = node.attrs;
    return ["img", { "data-drawing": name, ...(alt != null ? { "data-alt": alt } : {}), src: this.options.resolve(`${name}.svg`), alt: drawingLabel(name), class: "drawing-preview" }];
  },
  renderText: ({ node }) => `![[${node.attrs.name}${node.attrs.alt != null ? "|" + node.attrs.alt : ""}]]`,

  markdownTokenizer: {
    name: "drawingEmbed",
    level: "inline",
    start: (src: string) => src.search(/!\[\[[^\]\n]*\.excalidraw[|\]]/i),
    tokenize(src: string) {
      const m = DRAWING_RE.exec(src);
      if (!m) return undefined;
      return { type: "drawingEmbed", raw: m[0], name: m[1].trim(), alt: m[2] ?? null };
    },
  },
  parseMarkdown: (token) => ({ type: "drawingEmbed", attrs: { name: token.name, alt: token.alt } }),
  renderMarkdown: (node, _h, ctx) =>
    `![[${node.attrs?.name}${node.attrs?.alt != null ? (ctx?.meta?.parentAttrs?.__inTableCell ? "\\|" : "|") + node.attrs.alt : ""}]]`,

  onFocus() {
    lastEditor = this.editor;
  },
  onDestroy() {
    if (lastEditor === this.editor) lastEditor = null;
  },

  addNodeView() {
    const { resolve, onOpen } = this.options;
    return ({ node }) => {
      const name: string = node.attrs.name;
      const dom = document.createElement("span");
      dom.className = "drawing-embed";
      dom.contentEditable = "false";
      dom.dataset.drawing = name;
      dom.title = `${drawingLabel(name)} – klicken zum Bearbeiten`;

      const img = document.createElement("img");
      img.className = "drawing-preview";
      img.alt = drawingLabel(name);
      img.draggable = false;
      const empty = document.createElement("span");
      empty.className = "drawing-empty";
      empty.textContent = "Leere Zeichnung – klicken zum Zeichnen";
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "drawing-edit";
      edit.textContent = "Bearbeiten";
      dom.append(img, empty, edit);

      // No preview file (new or emptied drawing) shows the placeholder.
      img.onload = () => dom.classList.remove("is-empty");
      img.onerror = () => dom.classList.add("is-empty");
      const load = (bust: boolean) => {
        const base = name.split(/[\\/]/).pop() ?? name;
        img.src = `${resolve(`${base}.svg`)}${bust ? `?v=${Date.now()}` : ""}`;
      };
      load(false);

      const onSaved = (e: Event) => {
        const saved = (e as CustomEvent<{ name: string }>).detail?.name;
        if (saved && saved === (name.split(/[\\/]/).pop() ?? name)) load(true);
      };
      window.addEventListener(DRAWING_SAVED_EVENT, onSaved);
      dom.addEventListener("click", (e) => {
        e.preventDefault();
        onOpen(name);
      });
      return {
        dom,
        ignoreMutation: () => true,
        destroy: () => window.removeEventListener(DRAWING_SAVED_EVENT, onSaved),
      };
    };
  },
});
