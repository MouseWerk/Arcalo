// The PDF viewer: all pages in a scrolling column, page navigation, zoom, search with every hit
// highlighted (next/previous) and „Extern öffnen“. As an overlay over a note (Esc closes it) or
// in a tab of its own (`PdfPane`). Lazy-loaded with pdf.js, which parses in a Web Worker.
//
// Large PDFs stay light: pages render only near the viewport, a render is cancelled when its
// page scrolls away, and canvases and text layers of pages far from the viewport are released
// (at most a few screens of pages hold pixels). A text layer (pdf.js TextLayer) over each
// rendered page makes the text selectable and carries the search highlights.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PDFDocumentProxy, RenderTask, TextLayer } from "pdfjs-dist/legacy/build/pdf.mjs";
import { ChevronDown, ChevronUp, ExternalLink, MoveHorizontal, PanelTop, Search, X, ZoomIn, ZoomOut } from "lucide-react";
import { IconButton } from "../components/ui";
import { api, errorText } from "../lib/api";
import { loadPdfjs, openPdf, pdfWorkerKind } from "../lib/pdf";
import { findHits, matchOffsets, type PdfHit } from "../lib/pdfsearch";
import { useApp } from "../store/app";

const ZOOMS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 3];
/** Gap between pages and around the column (px, as in the CSS). */
const GAP = 16;
/** Pages within this many viewport heights render; beyond `KEEP` they give their pixels back. */
const NEAR = "100%";
const KEEP = "300%";

/** `auto`: fit to width, at most 125 % (wide windows); `fit`: always the full width. */
type Zoom = number | "fit" | "auto";
const AUTO_MAX = 1.25;

type Size = { w: number; h: number };
/** What a page highlights: the query and, when the current hit is on it, which one. */
type Mark = { query: string; current: { item: number; n: number } | null };

/** Wraps the hits of `query` in the text layer's spans; the current one gets `selected`. */
function highlight(layer: TextLayer, mark: Mark | null): HTMLElement | null {
  let current: HTMLElement | null = null;
  layer.textDivs.forEach((div, i) => {
    const text = layer.textContentItemsStr[i] ?? "";
    const offsets = mark ? matchOffsets(text, mark.query) : [];
    if (!offsets.length) {
      if (div.childElementCount) div.textContent = text;
      return;
    }
    const q = mark!.query.length;
    const parts: (string | HTMLElement)[] = [];
    let at = 0;
    offsets.forEach((o, n) => {
      if (o > at) parts.push(text.slice(at, o));
      const hit = document.createElement("span");
      hit.className = "highlight appended";
      hit.textContent = text.slice(o, o + q);
      if (mark!.current?.item === i && mark!.current.n === n) {
        hit.classList.add("selected");
        current = hit;
      }
      parts.push(hit);
      at = o + q;
    });
    if (at < text.length) parts.push(text.slice(at));
    div.replaceChildren(...parts);
  });
  return current;
}

function PdfPage({ doc, index, scale, size, root, mark }: { doc: PDFDocumentProxy; index: number; scale: number; size: Size; root: HTMLElement | null; mark: Mark | null }) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const textBox = useRef<HTMLDivElement>(null);
  const layer = useRef<TextLayer | null>(null);
  const [near, setNear] = useState(false);
  const [keep, setKeep] = useState(false);
  const [layerScale, setLayerScale] = useState<number | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el || !root) return;
    const nearIo = new IntersectionObserver((e) => setNear(e.some((x) => x.isIntersecting)), { root, rootMargin: `${NEAR} 0px` });
    const keepIo = new IntersectionObserver((e) => setKeep(e.some((x) => x.isIntersecting)), { root, rootMargin: `${KEEP} 0px` });
    nearIo.observe(el);
    keepIo.observe(el);
    return () => {
      nearIo.disconnect();
      keepIo.disconnect();
    };
  }, [root]);

  // Far away: give the pixels and the text layer back.
  useEffect(() => {
    if (keep) return;
    const c = canvas.current;
    if (c && c.width) {
      c.width = 0;
      c.height = 0;
    }
    layer.current?.cancel();
    layer.current = null;
    textBox.current?.replaceChildren();
    setLayerScale(null);
    box.current?.classList.remove("is-rendered");
    // The page object frees its parsed fonts and images too.
    void doc.getPage(index + 1).then((p) => p.cleanup(), () => {});
  }, [keep, doc, index]);

  useEffect(() => {
    if (!near || !canvas.current) return;
    let task: RenderTask | null = null;
    let text: TextLayer | null = null;
    let alive = true;
    const target = canvas.current;
    void Promise.all([doc.getPage(index + 1), loadPdfjs()]).then(async ([p, pdfjs]) => {
      if (!alive) return;
      const ratio = window.devicePixelRatio || 1;
      const viewport = p.getViewport({ scale: scale * ratio });
      // Render off-screen, then swap: the old rendering stays visible while zooming.
      const next = document.createElement("canvas");
      next.width = Math.floor(viewport.width);
      next.height = Math.floor(viewport.height);
      task = p.render({ canvas: next, viewport });
      try {
        await task.promise;
      } catch {
        next.width = next.height = 0;
        return; // cancelled: scrolled away or zoomed again
      }
      if (!alive) return;
      target.width = next.width;
      target.height = next.height;
      target.getContext("2d")?.drawImage(next, 0, 0);
      next.width = next.height = 0;
      box.current?.classList.add("is-rendered");
      const host = textBox.current;
      if (!host || layerScale === scale) return;
      host.replaceChildren();
      text = new pdfjs.TextLayer({ textContentSource: p.streamTextContent(), container: host, viewport: p.getViewport({ scale }) });
      try {
        await text.render();
      } catch {
        return;
      }
      if (!alive) return;
      layer.current = text;
      setLayerScale(scale);
    });
    return () => {
      alive = false;
      task?.cancel();
      if (text && text !== layer.current) text.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [near, doc, index, scale]);

  // Search highlights follow the query and the current hit; the view moves to a hit once, not
  // again whenever the page comes back into view.
  const scrolledFor = useRef<Mark | null>(null);
  useEffect(() => {
    if (!layer.current || layerScale !== scale) return;
    const current = highlight(layer.current, mark);
    if (current && scrolledFor.current !== mark) {
      scrolledFor.current = mark;
      current.scrollIntoView({ block: "center", inline: "nearest" });
    }
  }, [mark, layerScale, scale]);

  const style = {
    width: Math.floor(size.w * scale),
    height: Math.floor(size.h * scale),
    "--total-scale-factor": scale,
    "--scale-factor": scale,
    "--scale-round-x": "1px",
    "--scale-round-y": "1px",
  } as React.CSSProperties;
  return (
    <div ref={box} className="pdf-page" data-page={index + 1} style={style}>
      <canvas ref={canvas} aria-label={`Seite ${index + 1}`} />
      <div ref={textBox} className="textLayer" />
    </div>
  );
}

function PdfDocument({ name, page: startPage, onClose, mode }: { name: string; page: number | null; onClose: () => void; mode: "overlay" | "tab" }) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [sizes, setSizes] = useState<Size[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState<Zoom>("auto");
  const [width, setWidth] = useState(0);
  const [current, setCurrent] = useState(1);
  const [pageInput, setPageInput] = useState("1");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<{ query: string; list: PdfHit[]; at: number } | null>(null);
  const [searching, setSearching] = useState(false);
  const [workerKind, setWorkerKind] = useState<string>("");
  const frame = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const texts = useRef(new Map<number, string[]>());
  // The scroll container, also the pages' IntersectionObserver root.
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const scrollRef = useCallback((el: HTMLDivElement | null) => {
    scroller.current = el;
    setRoot(el);
  }, []);

  useEffect(() => {
    let alive = true;
    let opened: PDFDocumentProxy | null = null;
    void pdfWorkerKind().then((k) => alive && setWorkerKind(k), () => {});
    openPdf(name).then(
      async (d) => {
        opened = d;
        if (!alive) return void d.loadingTask.destroy();
        // Every page starts with the first page's size; the real sizes follow in the background.
        const first = (await d.getPage(1)).getViewport({ scale: 1 });
        if (!alive) return;
        const out: Size[] = Array.from({ length: d.numPages }, () => ({ w: first.width, h: first.height }));
        setSizes([...out]);
        setDoc(d);
        let changed = false;
        for (let i = 2; i <= d.numPages && alive; i++) {
          const vp = (await d.getPage(i)).getViewport({ scale: 1 });
          if (vp.width !== out[i - 1].w || vp.height !== out[i - 1].h) {
            out[i - 1] = { w: vp.width, h: vp.height };
            changed = true;
          }
          if (changed && (i % 25 === 0 || i === d.numPages)) {
            changed = false;
            if (alive) setSizes([...out]);
          }
        }
      },
      (e) => alive && setError(errorText(e)),
    );
    return () => {
      alive = false;
      void opened?.loadingTask.destroy();
    };
  }, [name]);

  // The column's width decides the „fit to width“ scale.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const widest = sizes.reduce((m, s) => Math.max(m, s.w), 0) || 612;
  const fitScale = width > 0 ? Math.max(0.25, Math.min(4, (width - 2 * GAP) / widest)) : 1;
  const scale = zoom === "fit" ? fitScale : zoom === "auto" ? Math.min(fitScale, AUTO_MAX) : zoom;

  const goTo = useCallback(
    (n: number) => {
      const el = scroller.current?.querySelector<HTMLElement>(`.pdf-page[data-page="${Math.max(1, Math.min(sizes.length, n))}"]`);
      if (el && scroller.current) scroller.current.scrollTop = el.offsetTop - GAP;
    },
    [sizes.length],
  );

  // Opens on the page of `![[x.pdf#page=3]]`.
  const started = useRef(false);
  useEffect(() => {
    if (!doc || started.current) return;
    started.current = true;
    if (startPage && startPage > 1) requestAnimationFrame(() => goTo(startPage));
  }, [doc, startPage, goTo]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const mark = el.scrollTop + el.clientHeight / 3;
    let n = 1;
    for (const p of el.querySelectorAll<HTMLElement>(".pdf-page")) {
      if (p.offsetTop <= mark) n = Number(p.dataset.page);
      else break;
    }
    if (n !== current) {
      setCurrent(n);
      setPageInput(String(n));
    }
  };

  // Keeps the page in view when the zoom changes.
  const zoomTo = (z: Zoom) => {
    const keep = current;
    setZoom(z);
    requestAnimationFrame(() => goTo(keep));
  };
  const step = (dir: 1 | -1) => {
    const i = ZOOMS.findIndex((z) => (dir > 0 ? z > scale + 0.001 : z >= scale - 0.001));
    const next = dir > 0 ? ZOOMS[i < 0 ? ZOOMS.length - 1 : i] : ZOOMS[Math.max(0, (i < 0 ? ZOOMS.length : i) - 1)];
    zoomTo(next);
  };

  const pageItems = async (n: number) => {
    let t = texts.current.get(n);
    if (t == null && doc) {
      const content = await (await doc.getPage(n)).getTextContent();
      t = content.items.map((it) => ("str" in it ? it.str : ""));
      texts.current.set(n, t);
    }
    return t ?? [];
  };

  const search = async (back: boolean) => {
    const q = query.trim();
    if (!q || !doc) return setHits(null);
    let found = hits;
    if (!found || found.query !== q) {
      setSearching(true);
      const pages: string[][] = [];
      for (let n = 1; n <= doc.numPages; n++) pages.push(await pageItems(n));
      setSearching(false);
      found = { query: q, list: findHits(pages, q), at: -1 };
    }
    if (!found.list.length) return setHits(found);
    let at: number;
    if (found.at < 0) {
      at = found.list.findIndex((h) => h.page >= current);
      if (at < 0) at = 0;
    } else {
      at = (found.at + (back ? -1 : 1) + found.list.length) % found.list.length;
    }
    setHits({ ...found, at });
    const hit = found.list[at];
    // Far pages are not rendered yet: jump there, the highlight scrolls the hit into view.
    if (Math.abs(hit.page - current) > 1 || !scroller.current?.querySelector(`.pdf-page[data-page="${hit.page}"].is-rendered`)) goTo(hit.page);
  };

  // What each page highlights (stable objects, so unchanged pages do not redo their spans).
  const marks = useMemo(() => {
    const out = new Map<number, Mark>();
    if (!hits || !hits.list.length) return out;
    const cur = hits.list[hits.at];
    for (const h of hits.list) if (!out.has(h.page)) out.set(h.page, { query: hits.query, current: null });
    if (cur) out.set(cur.page, { query: hits.query, current: { item: cur.item, n: cur.n } });
    return out;
  }, [hits]);

  // The focus moves from the note into the viewer (overlay).
  useEffect(() => {
    if (mode !== "overlay") return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && !frame.current?.contains(active)) active.blur();
    frame.current?.focus();
  }, [mode]);

  const handleKey = (e: KeyboardEvent, inside: boolean) => {
    const el = frame.current;
    if (!el) return false;
    const mod = e.ctrlKey || e.metaKey;
    const inInput = e.target instanceof HTMLInputElement;
    // Copying selected text works as everywhere else.
    if (mod && e.key.toLowerCase() === "c") return false;
    let handled = true;
    if (e.key === "Escape" && mode === "overlay") onClose();
    else if (e.key === "Escape" && inInput && query) (setQuery(""), setHits(null));
    else if (mod && e.key.toLowerCase() === "f") searchInput.current?.select();
    else if (mod && (e.key === "+" || e.key === "=")) step(1);
    else if (mod && e.key === "-") step(-1);
    else if (mod && e.key === "0") zoomTo("auto");
    else if (!inInput && !mod && (e.key === "PageDown" || e.key === "ArrowRight")) goTo(current + 1);
    else if (!inInput && !mod && (e.key === "PageUp" || e.key === "ArrowLeft")) goTo(current - 1);
    else if (!inInput && !mod && e.key === "Home") goTo(1);
    else if (!inInput && !mod && e.key === "End") goTo(sizes.length);
    else if (mode === "overlay") handled = !inside;
    else handled = false;
    return handled;
  };

  // Overlay: Esc closes; keys never reach the note or the app's shortcuts behind the viewer.
  useEffect(() => {
    if (mode !== "overlay") return;
    const onKey = (e: KeyboardEvent) => {
      const inside = e.target instanceof Node && !!frame.current?.contains(e.target);
      if (handleKey(e, inside)) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const openExternal = () => api.openAttachment(name).catch((e) => useApp.getState().error("PDF ließ sich nicht öffnen", e));
  const hit = hits?.list[hits.at];
  const overlay = mode === "overlay";

  return (
    <div
      ref={frame}
      className={overlay ? "pdf-overlay" : "pdf-pane"}
      role={overlay ? "dialog" : "region"}
      aria-modal={overlay ? true : undefined}
      aria-label={`PDF ${name}`}
      data-worker={workerKind}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (overlay) return e.stopPropagation();
        // In a tab the viewer's keys win while the focus is inside it (Ctrl+F searches the PDF).
        if (handleKey(e.nativeEvent, true)) {
          e.preventDefault();
          e.stopPropagation();
        }
      }}
    >
      <header className="pdf-header">
        <span className="pdf-title" title={name}>
          {name}
        </span>
        <div className="pdf-tools">
          <IconButton icon={ChevronUp} label="Vorherige Seite" onClick={() => goTo(current - 1)} disabled={!doc || current <= 1} />
          <IconButton icon={ChevronDown} label="Nächste Seite" onClick={() => goTo(current + 1)} disabled={!doc || current >= sizes.length} />
          <span className="pdf-page-nav">
            <input
              className="input pdf-page-input"
              aria-label="Seite"
              value={pageInput}
              inputMode="numeric"
              onChange={(e) => setPageInput(e.target.value.replace(/\D/g, ""))}
              onKeyDown={(e) => e.key === "Enter" && goTo(Number(pageInput) || 1)}
              onBlur={() => setPageInput(String(current))}
            />
            <span className="pdf-page-count">/ {sizes.length || "–"}</span>
          </span>
          <span className="pdf-sep" />
          <IconButton icon={ZoomOut} label="Verkleinern" onClick={() => step(-1)} disabled={!doc} />
          <span className="pdf-zoom" aria-live="polite">
            {Math.round(scale * 100)} %
          </span>
          <IconButton icon={ZoomIn} label="Vergrößern" onClick={() => step(1)} disabled={!doc} />
          <IconButton icon={MoveHorizontal} label="An Breite anpassen" active={zoom === "fit"} onClick={() => zoomTo(zoom === "fit" ? "auto" : "fit")} disabled={!doc} />
          <span className="pdf-sep" />
          <label className="pdf-search">
            <Search size={14} aria-hidden />
            <input
              ref={searchInput}
              className="pdf-search-input"
              placeholder="Im PDF suchen"
              aria-label="Im PDF suchen"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setHits(null);
              }}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                void search(e.shiftKey);
              }}
            />
            {(hits || searching) && (
              <span className="pdf-hits" aria-live="polite">
                {searching ? "Suche…" : hit ? `Seite ${hit.page} · ${hits!.at + 1}/${hits!.list.length}` : "Keine Treffer"}
              </span>
            )}
          </label>
          <IconButton icon={ChevronUp} label="Vorheriger Treffer" size="sm" onClick={() => void search(true)} disabled={!doc || !query.trim()} className="pdf-hit-prev" />
          <IconButton icon={ChevronDown} label="Nächster Treffer" size="sm" onClick={() => void search(false)} disabled={!doc || !query.trim()} className="pdf-hit-next" />
          <span className="pdf-sep" />
          {overlay && (
            <IconButton
              icon={PanelTop}
              label="In einem Tab öffnen"
              onClick={() => {
                onClose();
                useApp.getState().openTab({ kind: "pdf", tag: name }, { newTab: true });
              }}
            />
          )}
          <IconButton icon={ExternalLink} label="Extern öffnen" onClick={openExternal} />
          {overlay && <IconButton icon={X} label="Schließen" onClick={onClose} className="pdf-close" />}
        </div>
      </header>
      <div ref={scrollRef} className="pdf-scroll" onScroll={onScroll}>
        {error ? (
          <div className="pdf-message is-error">PDF ließ sich nicht anzeigen: {error}</div>
        ) : !doc ? (
          <div className="pdf-message">PDF wird geladen…</div>
        ) : (
          sizes.map((s, i) => <PdfPage key={i} doc={doc} index={i} scale={scale} size={s} root={root} mark={marks.get(i + 1) ?? null} />)
        )}
      </div>
    </div>
  );
}

export default function PdfViewer({ name, page, onClose }: { name: string; page: number | null; onClose: () => void }) {
  return <PdfDocument name={name} page={page} onClose={onClose} mode="overlay" />;
}

/** The viewer in a tab (a PDF dropped on the tab bar, „In einem Tab öffnen“, the attachment manager). */
export function PdfPane({ name, onClose }: { name: string; onClose: () => void }) {
  return <PdfDocument name={name} page={null} onClose={onClose} mode="tab" />;
}
