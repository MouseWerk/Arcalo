// The editor's hooks for live blocks: page embeds and ```mermaid/```query previews mount through
// these (their renderers load on first use), and the `[[`/`![[` autocomplete lists a page's
// headings after `#` and its block ids after `#^`.

import { api } from "../lib/api";
import { useApp } from "../store/app";
import { t } from "../lib/i18n";
import { blockIds, markdownHeadings, splitTarget, type EmbedRef, type RichKind } from "./embedSyntax";
import { fuzzyIncludes, type LinkSuggestItem } from "./extensions";
import type { RichControl, RichPreview } from "./richBlocks";

/** The page an editor shows, for the cycle check and export file names. */
export type CurrentTitle = () => string;

/** `PageEmbed` mount: the live frame, rendered by embedView.ts once it has loaded. */
export function embedMount(title: CurrentTitle, onOpen: (target: string, newTab: boolean) => void) {
  return (dom: HTMLElement, ref: EmbedRef) => {
    let alive = true;
    let cleanup = () => {};
    void import("./embedView").then((m) => {
      if (alive) cleanup = m.mountPageEmbed(dom, ref, { stack: [title().toLowerCase()], depth: 1, onOpen });
    });
    return () => {
      alive = false;
      cleanup();
    };
  };
}

/** `RichBlocks` mount: a diagram or query preview. */
export function richMount(title: CurrentTitle) {
  return (kind: RichKind, dom: HTMLElement, source: string, ctl: RichControl): RichPreview => {
    let inner: RichPreview | null = null;
    let alive = true;
    let last = { source, editing: false };
    void import("./embedView").then((m) => {
      if (!alive) return;
      inner = m.mountRich(kind, dom, last.source, ctl, title);
      inner.update(last.source, last.editing);
    });
    return {
      update(s, editing) {
        last = { source: s, editing };
        inner?.update(s, editing);
      },
      destroy() {
        alive = false;
        inner?.destroy();
      },
    };
  };
}

const contents = new Map<number, { at: string; md: string }>();

/** A page's Markdown for the completion (cached until the page changes). */
async function contentOf(id: number, updated: string): Promise<string> {
  const c = contents.get(id);
  if (c && c.at === updated) return c.md;
  const doc = await api.page(id);
  contents.set(id, { at: updated, md: doc.content });
  return doc.content;
}

/** `Seite#Teil`: the page's headings (or block ids after `^`) matching `Teil`; null without `#`. */
export async function anchorItems(q: string): Promise<LinkSuggestItem[] | null> {
  if (!q.includes("#")) return null;
  const { target, anchor } = splitTarget(q);
  const pages = [...useApp.getState().pages.values()];
  const page = pages.find((p) => p.title.toLowerCase() === target.toLowerCase());
  if (!page) return [];
  const md = await contentOf(page.id, page.updated_at).catch(() => "");
  const needle = (anchor ?? "").trim();
  if (needle.startsWith("^")) {
    const id = needle.slice(1);
    return blockIds(md)
      .filter((b) => fuzzyIncludes(b.id, id) || fuzzyIncludes(b.text, id))
      .slice(0, 12)
      .map((b) => ({ id: `b-${b.id}`, title: b.text || `^${b.id}`, subtitle: `^${b.id} · ${t("embed.blockIn", { title: page.title })}`, target: `${page.title}#^${b.id}` }));
  }
  return markdownHeadings(md)
    .filter((h) => fuzzyIncludes(h.text, needle))
    .slice(0, 12)
    .map((h, i) => ({ id: `h-${i}-${h.text}`, title: `${"#".repeat(h.level)} ${h.text}`, subtitle: t("embed.headingIn", { title: page.title }), target: `${page.title}#${h.text}` }));
}
