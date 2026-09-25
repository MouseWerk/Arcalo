// Obsidian-style page preview: hovering a [[link]] shows a card with the start of that page.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { renderMarkdown } from "../lib/markdown";
import { splitFrontmatter } from "../editor/extensions";
import { useApp } from "../store/app";
import { isFileLinkTarget } from "../editor/fileEmbed";
import { titleSet } from "../lib/links";
import { PageIcon } from "./icons";
import type { PageDoc } from "../lib/types";

/** Settings → Editor: hover preview on/off and its delay. */
const editorPrefs = () => useApp.getState().settings?.settings.editor;
const PREVIEW_CHARS = 900;
// Pages previewed in the last seconds; expired ones are dropped (they hold whole pages).
const cache = new Map<string, { at: number; doc: PageDoc | null }>();
const CACHE_MS = 10_000;
const CACHE_MAX = 30;

async function load(target: string): Promise<PageDoc | null> {
  const hit = cache.get(target.toLowerCase());
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.doc;
  const page = await api.resolvePage(target, false);
  const doc = page ? await api.page(page.id) : null;
  const now = Date.now();
  for (const [k, v] of cache) if (now - v.at >= CACHE_MS) cache.delete(k);
  cache.delete(target.toLowerCase());
  cache.set(target.toLowerCase(), { at: now, doc });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  return doc;
}

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
  doc: PageDoc | null;
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
      const target = a.dataset.target;
      // `[[Angebot.pdf]]` links a file, not a page: nothing to preview.
      if (!target || a.dataset.fileLink != null || (isFileLinkTarget(target) && !titleSet(useApp.getState().pages).has(target.trim().toLowerCase()))) return;
      window.clearTimeout(hideTimer.current);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(async () => {
        if (!a.isConnected || !a.matches(":hover")) return;
        try {
          const doc = await load(target);
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
          <button type="button" className="link-preview-title" onClick={(e) => (useApp.getState().openPage(doc.id, { newTab: e.ctrlKey || e.metaKey }), setShown(null))}>
            <PageIcon name={doc.icon} size={15} />
            {doc.title}
          </button>
          {preview!.text ? (
            <div ref={body} className="prose prose-chat link-preview-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(preview!.text) }} />
          ) : (
            <div className="link-preview-empty">Leere Seite</div>
          )}
          {(preview!.more || cut) && <div className="link-preview-fade" aria-hidden />}
        </>
      ) : (
        <div className="link-preview-empty">„{shown.target}“ existiert noch nicht – Klick auf den Link legt die Seite an.</div>
      )}
    </div>
  );
}
