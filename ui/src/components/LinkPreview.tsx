// Obsidian-style page preview: hovering a [[link]] shows a card with the start of that page, or
// the section of `[[Seite#Abschnitt]]` / the block of `[[Seite#^id]]` (`[[#Abschnitt]]`: this page).

import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { api } from "../lib/api";
import { renderMarkdown } from "../lib/markdown";
import { splitFrontmatter } from "../editor/extensions";
import { useApp } from "../store/app";
import { isFileLinkTarget } from "../editor/fileEmbed";
import { titleSet } from "../lib/links";
import { PageIcon } from "./icons";
import type { EmbedView, PageDoc } from "../lib/types";
import { t } from "../lib/i18n";
import { openAtAnchor, pageOfElement } from "../editor/reveal";

/** Settings → Editor: hover preview on/off and its delay. */
const editorPrefs = () => useApp.getState().settings?.settings.editor;
const PREVIEW_CHARS = 900;
// Pages previewed in the last seconds; expired ones are dropped (they hold whole pages).
const cache = new Map<string, { at: number; doc: Preview | null }>();
const CACHE_MS = 10_000;
const CACHE_MAX = 30;

/** What a card shows: the page and the Markdown (the section when the link names one). */
export interface Preview {
  id: number;
  title: string;
  icon: string | null;
  content: string;
  /** The heading or `^block` of the link (null: the page). */
  anchor: string | null;
  /** The link's section is not on the page: the card shows the start of the page. */
  sectionMissing: boolean;
}

export interface PreviewSource {
  resolvePage: (title: string) => Promise<{ id: number } | null>;
  page: (id: number) => Promise<PageDoc>;
  pageEmbed: (target: string, anchor: string | null) => Promise<EmbedView>;
}

const appSource: PreviewSource = {
  resolvePage: (title) => api.resolvePage(title, false),
  page: (id) => api.page(id),
  pageEmbed: (target, anchor) => api.pageEmbed(target, anchor),
};

/** The preview of `[[target#anchor]]`: the section (like `![[target#anchor]]` shows it), else the page. */
export async function loadPreview(target: string, anchor: string | null, src: PreviewSource = appSource): Promise<Preview | null> {
  if (anchor) {
    const view = await src.pageEmbed(target, anchor);
    if (view.page_id == null) return null;
    // The heading is in the card title already.
    if (view.content != null) return { id: view.page_id, title: view.title, icon: view.icon, content: anchor.startsWith("^") ? view.content : view.content.replace(/^#{1,6}[ \t]+[^\n]*\n*/, ""), anchor, sectionMissing: false };
    const doc = await src.page(view.page_id);
    return { id: doc.id, title: doc.title, icon: doc.icon, content: doc.content, anchor, sectionMissing: true };
  }
  const page = await src.resolvePage(target);
  if (!page) return null;
  const doc = await src.page(page.id);
  return { id: doc.id, title: doc.title, icon: doc.icon, content: doc.content, anchor: null, sectionMissing: false };
}

async function load(target: string, anchor: string | null): Promise<Preview | null> {
  const key = `${target.toLowerCase()}#${anchor ?? ""}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.doc;
  const doc = await loadPreview(target, anchor);
  const now = Date.now();
  for (const [k, v] of cache) if (now - v.at >= CACHE_MS) cache.delete(k);
  cache.delete(key);
  cache.set(key, { at: now, doc });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  return doc;
}

/** The label of an anchor in the card's title: the last heading of `H1#H2`, or `^id`. */
export const anchorLabel = (anchor: string) => (anchor.startsWith("^") ? anchor : (anchor.split("#").filter(Boolean).pop() ?? anchor));

/** Shortens Markdown at a paragraph boundary so the preview never ends mid-sentence if avoidable. */
export function previewMarkdown(md: string, max = PREVIEW_CHARS): { text: string; more: boolean } {
  const body = splitFrontmatter(md).body.trim();
  if (body.length <= max) return { text: body, more: false };
  const cut = body.lastIndexOf("\n\n", max);
  return { text: body.slice(0, cut > max / 2 ? cut : max).trimEnd(), more: true };
}

interface Shown {
  target: string;
  rect: DOMRect;
  doc: Preview | null;
}

export function LinkPreview() {
  const [shown, setShown] = useState<Shown | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const hideTimer = useRef<number | undefined>(undefined);
  const card = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const linkOf = (el: EventTarget | null) => (el instanceof Element ? el.closest<HTMLElement>("a[data-wikilink], .wikilink[data-target]") : null);
    const onOver = (e: MouseEvent) => {
      if (card.current?.contains(e.target as Node)) return void window.clearTimeout(hideTimer.current);
      const a = linkOf(e.target);
      if (!a || editorPrefs()?.hover_preview === false) return;
      const anchor = a.dataset.anchor || null;
      // `[[#Abschnitt]]`: a section of the page the link is on.
      const here = !a.dataset.target && anchor ? pageOfElement(a) : null;
      const target = here != null ? useApp.getState().pages.get(here)?.title : a.dataset.target;
      // `[[Angebot.pdf]]` links a file, not a page: nothing to preview.
      if (!target || a.dataset.fileLink != null || (isFileLinkTarget(target) && !titleSet(useApp.getState().pages).has(target.trim().toLowerCase()))) return;
      window.clearTimeout(hideTimer.current);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(async () => {
        if (!a.isConnected || !a.matches(":hover")) return;
        try {
          const doc = await load(target, anchor);
          if (a.matches(":hover")) setShown({ target, rect: a.getBoundingClientRect(), doc });
        } catch {
          /* no preview */
        }
      }, editorPrefs()?.hover_delay_ms ?? 450);
    };
    const onOut = (e: MouseEvent) => {
      const from = linkOf(e.target) ?? (card.current?.contains(e.target as Node) ? card.current : null);
      if (!from) return;
      window.clearTimeout(timer.current);
      window.clearTimeout(hideTimer.current);
      hideTimer.current = window.setTimeout(() => setShown(null), 220);
    };
    const hide = () => {
      window.clearTimeout(timer.current);
      setShown(null);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && hide();
    const onDown = (e: MouseEvent) => !card.current?.contains(e.target as Node) && hide();
    window.addEventListener("mouseover", onOver);
    window.addEventListener("mouseout", onOut);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("mouseover", onOver);
      window.removeEventListener("mouseout", onOut);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("mousedown", onDown);
      window.clearTimeout(timer.current);
      window.clearTimeout(hideTimer.current);
    };
  }, []);

  // The card is cut at its height as well as at PREVIEW_CHARS: fade whenever text is hidden.
  const body = useRef<HTMLDivElement>(null);
  const [cut, setCut] = useState(false);
  useLayoutEffect(() => {
    const el = body.current;
    setCut(!!el && el.scrollHeight > el.clientHeight + 1);
  }, [shown]);

  if (!shown) return null;
  const W = 380;
  const H = 300;
  const below = shown.rect.bottom + 8 + H < window.innerHeight;
  const left = Math.max(8, Math.min(shown.rect.left, window.innerWidth - W - 8));
  const top = below ? shown.rect.bottom + 6 : Math.max(8, shown.rect.top - H - 6);
  const doc = shown.doc;
  const preview = doc ? previewMarkdown(doc.content) : null;
  const open = (e: ReactMouseEvent) => {
    if (!doc) return;
    const newTab = e.ctrlKey || e.metaKey;
    setShown(null);
    if (doc.anchor && !doc.sectionMissing) void openAtAnchor(doc.id, doc.anchor, (id) => useApp.getState().openPage(id, { newTab }));
    else useApp.getState().openPage(doc.id, { newTab });
  };
  return (
    <div
      ref={card}
      className="link-preview"
      role="tooltip"
      style={{ left, top, width: W, maxHeight: H }}
      onMouseLeave={() => (hideTimer.current = window.setTimeout(() => setShown(null), 220))}
    >
      {doc ? (
        <>
          <button type="button" className="link-preview-title" onClick={open}>
            <PageIcon name={doc.icon} size={15} />
            <span className="link-preview-page">{doc.title}</span>
            {doc.anchor && !doc.sectionMissing && (
              <>
                <span className="link-preview-sep" aria-hidden>
                  ›
                </span>
                <span className="link-preview-section">{anchorLabel(doc.anchor)}</span>
              </>
            )}
          </button>
          {doc.sectionMissing && <div className="link-preview-note">{t("preview.noSection", { anchor: anchorLabel(doc.anchor!) })}</div>}
          {preview!.text ? (
            <div ref={body} className="prose prose-chat link-preview-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(preview!.text) }} />
          ) : (
            <div className="link-preview-empty">{t("preview.empty")}</div>
          )}
          {(preview!.more || cut) && <div className="link-preview-fade" aria-hidden />}
        </>
      ) : (
        <div className="link-preview-empty">{t("preview.missing", { target: shown.target })}</div>
      )}
    </div>
  );
}
