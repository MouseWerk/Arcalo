// The page embed node: `![[Seite]]`, `![[Seite#Überschrift]]`, `![[Seite#^block]]` (Obsidian
// syntax; names with a file extension stay file embeds). The Markdown is kept exactly as written.
// In the editor the node view shows the embedded part live (embedView.ts); headless (share,
// tests) it is a placeholder span that the HTML export fills.

import { Node } from "@tiptap/core";
import { embedLabel, pageEmbedMarkdown, parsePageEmbed, type EmbedRef } from "./embedSyntax";

export interface PageEmbedOptions {
  /** Shows the embed in `dom` (live, read-only); returns its cleanup. Null: a plain placeholder. */
  mount: ((dom: HTMLElement, ref: EmbedRef) => () => void) | null;
}

const refOf = (attrs: Record<string, unknown>): EmbedRef => ({
  target: String(attrs.target ?? ""),
  anchor: (attrs.anchor as string | null) ?? null,
  alt: (attrs.alt as string | null) ?? null,
});

export const PageEmbed = Node.create<PageEmbedOptions>({
  name: "pageEmbed",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: true,

  addOptions() {
    return { mount: null };
  },
  addAttributes() {
    return { target: { default: "" }, anchor: { default: null }, alt: { default: null } };
  },
  parseHTML() {
    return [
      {
        tag: "span[data-page-embed]",
        getAttrs: (el) => ({ target: (el as HTMLElement).dataset.pageEmbed, anchor: (el as HTMLElement).dataset.anchor ?? null, alt: (el as HTMLElement).dataset.alt ?? null }),
      },
    ];
  },
  renderHTML({ node }) {
    const { target, anchor, alt } = node.attrs;
    return ["span", { "data-page-embed": target, ...(anchor != null ? { "data-anchor": anchor } : {}), ...(alt != null ? { "data-alt": alt } : {}), class: "page-embed-ref" }, embedLabel(refOf(node.attrs))];
  },
  renderText: ({ node }) => pageEmbedMarkdown(refOf(node.attrs)),

  markdownTokenizer: {
    name: "pageEmbed",
    level: "inline",
    start: (src: string) => src.indexOf("![["),
    tokenize(src: string) {
      const m = parsePageEmbed(src);
      return m ? { type: "pageEmbed", raw: m.raw, target: m.target, anchor: m.anchor, alt: m.alt } : undefined;
    },
  },
  parseMarkdown: (token) => ({ type: "pageEmbed", attrs: { target: token.target, anchor: token.anchor, alt: token.alt } }),
  renderMarkdown: (node, _h, ctx) => pageEmbedMarkdown(refOf(node.attrs ?? {}), !!ctx?.meta?.parentAttrs?.__inTableCell),

  addNodeView() {
    const mount = this.options.mount;
    if (!mount) return null;
    return ({ node }) => {
      const dom = document.createElement("span");
      dom.className = "page-embed";
      dom.contentEditable = "false";
      dom.dataset.pageEmbed = node.attrs.target;
      if (node.attrs.anchor) dom.dataset.anchor = node.attrs.anchor;
      const cleanup = mount(dom, refOf(node.attrs));
      return {
        dom,
        // Clicks, selection and scrolling inside the frame belong to it, not to the editor;
        // the frame's edge still selects and drags the node.
        stopEvent: (e) => {
          const target = e.target as HTMLElement | null;
          if (e.type.startsWith("drag")) return false;
          return !!target?.closest?.(".pe-body, button, a, input");
        },
        ignoreMutation: () => true,
        selectNode: () => dom.classList.add("is-selected"),
        deselectNode: () => dom.classList.remove("is-selected"),
        destroy: cleanup,
      };
    };
  },
});
