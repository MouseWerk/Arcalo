// The PDF viewer: all pages in a scrolling column (rendered when they come into view), page
// navigation, zoom, search (jumps between pages containing the text) and „Extern öffnen“.
// Lazy-loaded (pdfViewer.tsx) with pdf.js; Esc closes it.

import { useCallback, useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist/legacy/build/pdf.mjs";
import { ChevronDown, ChevronUp, ExternalLink, MoveHorizontal, Search, X, ZoomIn, ZoomOut } from "lucide-react";
import { IconButton } from "../components/ui";
import { api, errorText } from "../lib/api";
import { openPdf } from "../lib/pdf";
import { useApp } from "../store/app";

const ZOOMS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 3];
/** Gap between pages and around the column (px, as in the CSS). */
const GAP = 16;

/** `auto`: fit to width, at most 125 % (wide windows); `fit`: always the full width. */
type Zoom = number | "fit" | "auto";
const AUTO_MAX = 1.25;

function PdfPage({ doc, index, scale, size, root }: { doc: PDFDocumentProxy; index: number; scale: number; size: { w: number; h: number }; root: HTMLElement | null }) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = box.current;
    if (!el || !root) return;
    const io = new IntersectionObserver((entries) => setVisible(entries.some((e) => e.isIntersecting)), { root, rootMargin: "600px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [root]);

  useEffect(() => {
    if (!visible || !canvas.current) return;
    let task: RenderTask | null = null;
    let alive = true;
    const target = canvas.current;
    void doc.getPage(index + 1).then((page) => {
      if (!alive) return;
      const ratio = window.devicePixelRatio || 1;
      const viewport = page.getViewport({ scale: scale * ratio });
      // Render off-screen, then swap: the old rendering stays visible while zooming.
      const next = document.createElement("canvas");
      next.width = Math.floor(viewport.width);
      next.height = Math.floor(viewport.height);
      task = page.render({ canvas: next, viewport });
      task.promise.then(
        () => {
          if (!alive) return;
          target.width = next.width;
          target.height = next.height;
          target.getContext("2d")?.drawImage(next, 0, 0);
        },
        () => {},
      );
    });
    return () => {
      alive = false;
      task?.cancel();
    };
  }, [visible, doc, index, scale]);

  return (
    <div ref={box} className="pdf-page" data-page={index + 1} style={{ width: Math.floor(size.w * scale), height: Math.floor(size.h * scale) }}>
      <canvas ref={canvas} aria-label={`Seite ${index + 1}`} />
    </div>
  );
}

export default function PdfViewer({ name, page: startPage, onClose }: { name: string; page: number | null; onClose: () => void }) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [sizes, setSizes] = useState<{ w: number; h: number }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState<Zoom>("auto");
  const [width, setWidth] = useState(0);
  const [current, setCurrent] = useState(1);
  const [pageInput, setPageInput] = useState("1");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<{ query: string; pages: number[]; at: number } | null>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const texts = useRef(new Map<number, string>());
  // The scroll container, also the pages' IntersectionObserver root.
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const scrollRef = useCallback((el: HTMLDivElement | null) => {
    scroller.current = el;
    setRoot(el);
  }, []);

  useEffect(() => {
    let alive = true;
    let opened: PDFDocumentProxy | null = null;
    openPdf(name).then(
      async (d) => {
        opened = d;
        if (!alive) return void d.loadingTask.destroy();
        const out: { w: number; h: number }[] = [];
        for (let i = 1; i <= d.numPages; i++) {
          const vp = (await d.getPage(i)).getViewport({ scale: 1 });
          out.push({ w: vp.width, h: vp.height });
        }
        if (!alive) return;
        setSizes(out);
        setDoc(d);
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

  const pageText = async (n: number) => {
    let t = texts.current.get(n);
    if (t == null && doc) {
      const content = await (await doc.getPage(n)).getTextContent();
      t = content.items.map((it) => ("str" in it ? it.str : "")).join(" ").toLowerCase();
      texts.current.set(n, t);
    }
    return t ?? "";
  };

  const search = async (back: boolean) => {
    const q = query.trim().toLowerCase();
    if (!q || !doc) return setHits(null);
    let found = hits;
    if (!found || found.query !== q) {
      const pages: number[] = [];
      for (let n = 1; n <= doc.numPages; n++) if ((await pageText(n)).includes(q)) pages.push(n);
      found = { query: q, pages, at: -1 };
    }
    if (!found.pages.length) return setHits(found);
    let at: number;
    if (found.at < 0) {
      at = found.pages.findIndex((p) => p >= current);
      if (at < 0) at = 0;
    } else {
      at = (found.at + (back ? -1 : 1) + found.pages.length) % found.pages.length;
    }
    setHits({ ...found, at });
    goTo(found.pages[at]);
  };

  // The focus moves from the note into the viewer.
  useEffect(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && !overlay.current?.contains(active)) active.blur();
    overlay.current?.focus();
  }, []);

  // Esc closes; keys never reach the note or the app's shortcuts behind the viewer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = overlay.current;
      if (!el) return;
      const mod = e.ctrlKey || e.metaKey;
      const inInput = e.target instanceof HTMLInputElement;
      let handled = true;
      if (e.key === "Escape") onClose();
      else if (mod && e.key.toLowerCase() === "f") searchInput.current?.select();
      else if (mod && (e.key === "+" || e.key === "=")) step(1);
      else if (mod && e.key === "-") step(-1);
      else if (mod && e.key === "0") zoomTo("auto");
      else if (!inInput && !mod && (e.key === "PageDown" || e.key === "ArrowRight")) goTo(current + 1);
      else if (!inInput && !mod && (e.key === "PageUp" || e.key === "ArrowLeft")) goTo(current - 1);
      else if (!inInput && !mod && e.key === "Home") goTo(1);
      else if (!inInput && !mod && e.key === "End") goTo(sizes.length);
      else handled = !(e.target instanceof Node && el.contains(e.target));
      if (handled) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const openExternal = () => api.openAttachment(name).catch((e) => useApp.getState().error("PDF ließ sich nicht öffnen", e));

  return (
    <div
      ref={overlay}
      className="pdf-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={`PDF ${name}`}
      tabIndex={-1}
      onKeyDown={(e) => e.stopPropagation()}
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
            {hits && (
              <span className="pdf-hits" aria-live="polite">
                {hits.pages.length ? `Seite ${hits.pages[hits.at]} · ${hits.at + 1}/${hits.pages.length}` : "Keine Treffer"}
              </span>
            )}
          </label>
          <span className="pdf-sep" />
          <IconButton icon={ExternalLink} label="Extern öffnen" onClick={openExternal} />
          <IconButton icon={X} label="Schließen" onClick={onClose} className="pdf-close" />
        </div>
      </header>
      <div
        ref={scrollRef}
        className="pdf-scroll"
        onScroll={onScroll}
      >
        {error ? (
          <div className="pdf-message is-error">PDF ließ sich nicht anzeigen: {error}</div>
        ) : !doc ? (
          <div className="pdf-message">PDF wird geladen…</div>
        ) : (
          sizes.map((s, i) => <PdfPage key={i} doc={doc} index={i} scale={scale} size={s} root={root} />)
        )}
      </div>
    </div>
  );
}
