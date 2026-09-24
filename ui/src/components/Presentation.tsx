// Presentation mode: a note as full-screen slides (split at `---`), with counter, progress,
// timer and speaker notes in the presenter view – an overlay with one monitor, a second window
// (`#presenter`) with two. The main window owns the state; the presenter window mirrors it
// through events and steers it with `presentation://nav`.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Clock, MonitorSpeaker, Presentation as PresentationIcon, Sun, X } from "lucide-react";
import { emitTo } from "@tauri-apps/api/event";
import { api, attachmentUrl, on } from "../lib/api";
import { useApp } from "../store/app";
import { renderMarkdown } from "../lib/markdown";
import { elapsedLabel, fitScale, jumpTarget, prepareSlideMarkdown, splitSlides, type Slide } from "../lib/slides";
import { CALLOUT_LABELS } from "../editor/extensions";
import { fileExtension, fileIcon, fileKind, isImageName, isPdfName } from "../editor/fileEmbed";
import { isDrawingName } from "../editor/drawing";
import { drawPdfPreview } from "../lib/pdf";
import { flushAllEditors } from "../editor/NoteEditor";
import { useMenu } from "./ui";

/** Design size of a slide; it is scaled to the screen (and to the previews). */
const STAGE_W = 1600;

/** State shared with the presenter window. */
export interface DeckState {
  title: string;
  slides: Slide[];
  index: number;
  startedAt: number;
  /** Target duration in minutes (null: none). */
  target: number | null;
  beamer: boolean;
  theme: string;
}

type Nav = { action: "next" | "prev" | "first" | "last" | "end" | "beamer" | "reset" } | { action: "goto"; index: number } | { action: "target"; minutes: number | null };

const BEAMER_KEY = "annalo.present.beamer";
const readBeamer = () => {
  try {
    return localStorage.getItem(BEAMER_KEY) === "1";
  } catch {
    return false;
  }
};

/** Shows the page as a presentation (pending edits are saved first). */
export async function startPresentation(pageId: number) {
  const s = useApp.getState();
  await flushAllEditors().catch(() => {});
  s.set({ presenting: { pageId }, paletteOpen: false });
}

export function PresentationHost() {
  const p = useApp((st) => st.presenting);
  return p ? <Presentation key={p.pageId} pageId={p.pageId} /> : null;
}

// ------------------------------------------------------------------ slides

/** Replaces the embed placeholders and marks callouts (after each render). */
function hydrate(root: HTMLElement, refit: () => void) {
  for (const bq of root.querySelectorAll<HTMLElement>("blockquote")) {
    const p = bq.firstElementChild;
    const text = p?.firstChild;
    if (!p || p.tagName !== "P" || !text || text.nodeType !== Node.TEXT_NODE) continue;
    const m = /^\[!(\w+)\][+-]?[ \t]*/.exec(text.textContent ?? "");
    if (!m) continue;
    const type = m[1].toLowerCase();
    bq.classList.add("callout", `callout-${type}`);
    const rest = (text.textContent ?? "").slice(m[0].length);
    const nl = rest.indexOf("\n");
    const custom = (nl >= 0 ? rest.slice(0, nl) : rest).trim();
    text.textContent = nl >= 0 ? rest.slice(nl + 1) : "";
    const title = document.createElement("div");
    title.className = "slide-callout-title";
    title.textContent = custom || CALLOUT_LABELS[type] || type;
    bq.insertBefore(title, p);
    if (!p.textContent?.trim() && p.children.length === 0) p.remove();
  }
  for (const el of root.querySelectorAll<HTMLElement>("[data-embed]")) {
    if (el.dataset.done) continue;
    el.dataset.done = "1";
    const name = el.dataset.embed ?? "";
    const width = el.dataset.width ? Number(el.dataset.width) : null;
    const label = name.split(/[\\/]/).pop() ?? name;
    if (isDrawingName(name) || isImageName(name)) {
      const img = document.createElement("img");
      img.src = attachmentUrl(isDrawingName(name) ? `${name}.svg` : name);
      img.alt = label;
      img.className = isDrawingName(name) ? "slide-img slide-drawing" : "slide-img";
      if (width) img.style.width = `${Math.round(width * 1.6)}px`;
      img.onload = refit;
      el.replaceChildren(img);
    } else if (isPdfName(name)) {
      const fig = document.createElement("figure");
      fig.className = "slide-pdf";
      const canvas = document.createElement("canvas");
      const cap = document.createElement("figcaption");
      cap.append(fileIcon(fileKind(name), 18), document.createTextNode(label));
      fig.append(canvas, cap);
      el.replaceChildren(fig);
      drawPdfPreview(name, canvas, 560).then(refit, () => fig.classList.add("slide-pdf-missing"));
    } else if (fileExtension(name)) {
      const chip = document.createElement("span");
      chip.className = "slide-file";
      chip.append(fileIcon(fileKind(name), 20), document.createTextNode(label));
      el.replaceChildren(chip);
    } else {
      // `![[Notiz]]`: an embedded note is shown by name.
      const chip = document.createElement("span");
      chip.className = "slide-file slide-note-embed";
      chip.textContent = label;
      el.replaceChildren(chip);
    }
  }
  // Task boxes are for reading only.
  for (const box of root.querySelectorAll<HTMLInputElement>("input[type=checkbox]")) {
    box.disabled = true;
    box.tabIndex = -1;
    const li = box.closest("li");
    if (!li || li.classList.contains("slide-task")) continue;
    // A loose list wraps the item in a paragraph: the box and its text go straight into the item.
    const para = box.parentElement;
    if (para && para !== li && para.tagName === "P" && para.parentElement === li) {
      para.replaceWith(...para.childNodes);
    }
    li.classList.add("slide-task", ...(box.checked ? ["done"] : []));
    // The text after the box in its own span (struck through when done, not the box).
    const text = document.createElement("span");
    text.className = "slide-task-text";
    let n = box.nextSibling;
    while (n) {
      const next = n.nextSibling;
      text.append(n);
      n = next;
    }
    box.after(text);
  }
  for (const a of root.querySelectorAll<HTMLAnchorElement>("a")) {
    a.removeAttribute("href");
    a.tabIndex = -1;
  }
}

/**
 * One slide, scaled to its box: the stage has the box's aspect at a design width of 1600 px,
 * content that is too long for it is scaled down further (never cut).
 */
export function SlideView({ slide, className = "", label }: { slide: Slide | null; className?: string; label?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const html = useMemo(() => (slide ? renderMarkdown(prepareSlideMarkdown(slide.markdown, slide)) : ""), [slide]);
  const fit = useCallback(() => {
    const b = box.current;
    const st = stage.current;
    const c = content.current;
    if (!b || !st || !c || !b.clientWidth) return;
    const scale = b.clientWidth / STAGE_W;
    const height = b.clientHeight / scale;
    st.style.width = `${STAGE_W}px`;
    st.style.height = `${height}px`;
    st.style.transform = `scale(${scale})`;
    // The content's own scale: the largest that fits. Content gets wider as it shrinks, so its
    // height depends on the scale: a short binary search.
    const inner = { width: STAGE_W - 2 * 110, height: height - 2 * 80 };
    c.style.transform = "none";
    const fits = (s: number) => {
      c.style.width = `${inner.width / s}px`;
      return fitScale({ width: c.scrollWidth * s, height: c.scrollHeight * s }, inner) >= 0.999;
    };
    let s = 1;
    if (!fits(1)) {
      let lo = 0.15;
      let hi = 1;
      for (let i = 0; i < 8; i++) {
        const mid = (lo + hi) / 2;
        if (fits(mid)) lo = mid;
        else hi = mid;
      }
      s = lo;
    }
    c.style.width = `${inner.width / s}px`;
    c.style.transform = `scale(${s})`;
    c.dataset.scale = s.toFixed(3);
  }, []);
  useLayoutEffect(() => {
    if (content.current) hydrate(content.current, fit);
    fit();
  }, [html, fit]);
  useEffect(() => {
    const b = box.current;
    if (!b) return;
    const ro = new ResizeObserver(() => fit());
    ro.observe(b);
    return () => ro.disconnect();
  }, [fit]);
  return (
    <div className={`slide-box ${className}`} ref={box} aria-label={label}>
      <div className="slide-stage" ref={stage}>
        <div className="slide-content prose" ref={content} dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    </div>
  );
}

// ------------------------------------------------------------- presenter

function useElapsed(startedAt: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(id);
  }, []);
  return now - startedAt;
}

function TimerLabel({ deck, big }: { deck: DeckState; big?: boolean }) {
  const elapsed = useElapsed(deck.startedAt);
  const over = deck.target != null && elapsed > deck.target * 60_000;
  return (
    <span className={`present-timer num ${over ? "over" : ""} ${big ? "big" : ""}`} aria-label="Vergangene Zeit">
      {elapsedLabel(elapsed)}
      {deck.target != null && <span className="present-target"> / {elapsedLabel(deck.target * 60_000)}</span>}
    </span>
  );
}

const TARGETS = [5, 10, 15, 20, 30, 45, 60];

/** Current and next slide, notes, timer and controls (overlay or presenter window). */
export function PresenterPanel({ deck, onNav, overlay }: { deck: DeckState; onNav: (n: Nav) => void; overlay?: boolean }) {
  const cur = deck.slides[deck.index] ?? null;
  const next = deck.slides[deck.index + 1] ?? null;
  const notes = useMemo(() => (cur?.notes ? renderMarkdown(cur.notes) : ""), [cur]);
  const [menu, , openMenuAt] = useMenu();
  const elapsed = useElapsed(deck.startedAt);
  const left = deck.target != null ? deck.target * 60_000 - elapsed : null;
  return (
    <div className={`presenter ${overlay ? "presenter-overlay" : ""}`} role="region" aria-label="Referentenansicht" onClick={(e) => e.stopPropagation()} onContextMenu={(e) => e.stopPropagation()}>
      <div className="presenter-main">
        <div className="presenter-label">
          Aktuelle Folie <span className="num">{deck.slides.length ? deck.index + 1 : 0} / {deck.slides.length}</span>
          {cur && <span className="faint ellipsis"> · {cur.title}</span>}
        </div>
        <SlideView slide={cur} className={`presenter-current ${deck.beamer ? "beamer" : ""}`} label="Vorschau der aktuellen Folie" />
      </div>
      <aside className="presenter-side">
        <div className="presenter-clock">
          <TimerLabel deck={deck} big />
          {left != null && <span className={`presenter-left num ${left < 0 ? "over" : ""}`}>{left < 0 ? `+${elapsedLabel(-left)} über der Zeit` : `noch ${elapsedLabel(left)}`}</span>}
          <span className="presenter-now num">{new Date().toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })} Uhr</span>
        </div>
        <div className="presenter-label">{next ? <>Nächste Folie · <span className="ellipsis">{next.title}</span></> : "Letzte Folie"}</div>
        {next ? <SlideView slide={next} className={`presenter-next ${deck.beamer ? "beamer" : ""}`} label="Vorschau der nächsten Folie" /> : <div className="presenter-next presenter-end">Ende</div>}
        <div className="presenter-label">Notizen</div>
        <div className="presenter-notes prose" aria-label="Notizen">
          {notes ? <div dangerouslySetInnerHTML={{ __html: notes }} /> : <p className="faint">Keine Notizen zu dieser Folie. Notizen stehen in einem Callout <code>&gt; [!notiz]</code> oder in einem Absatz, der mit <code>Notiz:</code> beginnt.</p>}
        </div>
        <div className="presenter-controls">
          <button type="button" className="present-btn" aria-label="Vorherige Folie" disabled={deck.index <= 0} onClick={() => onNav({ action: "prev" })}>
            <ChevronLeft size={18} />
          </button>
          <button type="button" className="present-btn" aria-label="Nächste Folie" disabled={deck.index >= deck.slides.length - 1} onClick={() => onNav({ action: "next" })}>
            <ChevronRight size={18} />
          </button>
          <button
            type="button"
            className="present-btn"
            aria-label="Zielzeit"
            onClick={(e) =>
              openMenuAt(e, [
                { label: "Ohne Zielzeit", checked: deck.target == null, onSelect: () => onNav({ action: "target", minutes: null }) },
                ...TARGETS.map((m) => ({ label: `${m} Minuten`, checked: deck.target === m, onSelect: () => onNav({ action: "target", minutes: m }) })),
                "separator" as const,
                { label: "Zeit neu starten", onSelect: () => onNav({ action: "reset" }) },
              ])
            }
          >
            <Clock size={16} />
          </button>
          <span className="grow" />
          <button type="button" className="present-btn present-end" onClick={() => onNav({ action: "end" })}>
            Beenden
          </button>
        </div>
      </aside>
      {menu}
    </div>
  );
}

/** Navigation keys shared by the slides and the presenter window. */
function keyNav(e: KeyboardEvent, typed: { current: string }): Nav | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  if (/^[0-9]$/.test(e.key)) {
    typed.current = (typed.current + e.key).slice(-4);
    return null;
  }
  const k = e.key;
  if (k === "Enter" && typed.current) {
    const t = typed.current;
    typed.current = "";
    return { action: "goto", index: Number(t) };
  }
  typed.current = "";
  if (["ArrowRight", "ArrowDown", "PageDown", " ", "Enter", "n", "N"].includes(k)) return { action: "next" };
  if (["ArrowLeft", "ArrowUp", "PageUp", "Backspace", "p", "P"].includes(k)) return { action: "prev" };
  if (k === "Home") return { action: "first" };
  if (k === "End") return { action: "last" };
  if (k === "b" || k === "B") return { action: "beamer" };
  return null;
}

// ---------------------------------------------------------------- main view

function Presentation({ pageId }: { pageId: number }) {
  const s = useApp.getState;
  const [title, setTitle] = useState("");
  const [slides, setSlides] = useState<Slide[] | null>(null);
  const [index, setIndex] = useState(0);
  const [startedAt, setStartedAt] = useState(() => Date.now());
  const [target, setTarget] = useState<number | null>(null);
  const [beamer, setBeamer] = useState(readBeamer);
  const [presenter, setPresenter] = useState<"off" | "overlay" | "window">("off");
  const [hud, setHud] = useState(true);
  const [typed, setTyped] = useState("");
  const typedRef = useRef("");
  const hudTimer = useRef(0);
  const ended = useRef(false);
  const theme = document.documentElement.dataset.theme ?? "light";

  useEffect(() => {
    api
      .page(pageId)
      .then((doc) => {
        setTitle(doc.title);
        setSlides(splitSlides(doc.content));
      })
      .catch((e) => {
        s().error("Präsentation nicht möglich", e);
        s().set({ presenting: null });
      });
    void api.presentationBegin().catch(() => {});
    return () => {
      void api.presentationEnd().catch(() => {});
    };
  }, [pageId, s]);

  const count = slides?.length ?? 0;
  const end = useCallback(() => {
    if (ended.current) return;
    ended.current = true;
    s().set({ presenting: null });
  }, [s]);

  const nav = useCallback(
    (n: Nav) => {
      switch (n.action) {
        case "next":
          setIndex((i) => Math.min(i + 1, Math.max(count - 1, 0)));
          break;
        case "prev":
          setIndex((i) => Math.max(i - 1, 0));
          break;
        case "first":
          setIndex(0);
          break;
        case "last":
          setIndex(Math.max(count - 1, 0));
          break;
        case "goto": {
          const t = jumpTarget(String(n.index), count);
          if (t != null) setIndex(t);
          break;
        }
        case "beamer":
          setBeamer((b) => {
            try {
              localStorage.setItem(BEAMER_KEY, b ? "0" : "1");
            } catch {
              /* ignore */
            }
            return !b;
          });
          break;
        case "target":
          setTarget(n.minutes);
          break;
        case "reset":
          setStartedAt(Date.now());
          break;
        case "end":
          end();
          break;
      }
    },
    [count, end],
  );

  const togglePresenter = useCallback(async () => {
    if (presenter === "window") {
      await api.presenterClose().catch(() => {});
      setPresenter("off");
      return;
    }
    if (presenter === "overlay") return setPresenter("off");
    const opened = await api.presenterOpen().catch(() => false);
    setPresenter(opened ? "window" : "overlay");
  }, [presenter]);

  // Keys: navigation, digits + Enter to jump, Esc ends; nothing reaches the app underneath.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector(".menu")) return;
      e.stopPropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        if (typedRef.current) {
          typedRef.current = "";
          setTyped("");
        } else end();
        return;
      }
      if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key === "r" || e.key === "R" || e.key === "s" || e.key === "S")) {
        e.preventDefault();
        void togglePresenter();
        return;
      }
      const n = keyNav(e, typedRef);
      setTyped(typedRef.current);
      if (/^[0-9]$/.test(e.key)) return e.preventDefault();
      if (!n) {
        // App shortcuts (Ctrl+K …) stay off while presenting.
        if (e.ctrlKey || e.metaKey) e.preventDefault();
        return;
      }
      e.preventDefault();
      nav(n);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [nav, end, togglePresenter]);

  // The presenter window mirrors the deck and steers it.
  const deck: DeckState | null = slides ? { title, slides, index, startedAt, target, beamer, theme } : null;
  const deckRef = useRef(deck);
  deckRef.current = deck;
  useEffect(() => {
    if (presenter === "window" && deck) void emitTo("presenter", "presentation://state", deck).catch(() => {});
  }, [presenter, deck]);
  useEffect(() => {
    const un = [
      on<Nav>("presentation://nav", (n) => nav(n)),
      on("presentation://hello", () => deckRef.current && void emitTo("presenter", "presentation://state", deckRef.current).catch(() => {})),
    ];
    return () => un.forEach((u) => u.then((f) => f()));
  }, [nav]);

  const wake = () => {
    setHud(true);
    window.clearTimeout(hudTimer.current);
    hudTimer.current = window.setTimeout(() => setHud(false), 2500);
  };
  useEffect(() => {
    wake();
    return () => window.clearTimeout(hudTimer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!slides || !deck) return <div className="presentation loading" aria-label="Präsentation" />;
  const cur = slides[index] ?? null;
  return (
    <div
      className={`presentation ${beamer ? "beamer" : ""} ${hud ? "hud-on" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label={`Präsentation: ${title}`}
      onMouseMove={wake}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("button, .presenter, .menu")) return;
        nav({ action: "next" });
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        if ((e.target as HTMLElement).closest(".presenter")) return;
        nav({ action: "prev" });
      }}
    >
      {count === 0 ? (
        <div className="present-empty">Diese Seite ist leer. Mit <kbd>---</kbd> zwischen Absätzen wird sie in Folien geteilt.</div>
      ) : (
        <SlideView slide={cur} className="present-slide" label={`Folie ${index + 1}`} />
      )}
      <div className="present-progress" aria-hidden>
        <span style={{ width: `${count ? ((index + 1) / count) * 100 : 0}%` }} />
      </div>
      <div className="present-corner" aria-live="polite">
        <span className="present-counter num">
          {count ? index + 1 : 0} / {count}
        </span>
        <TimerLabel deck={deck} />
        {typed && <span className="present-typed num">→ {typed}</span>}
      </div>
      <div className="present-hud" onClick={(e) => e.stopPropagation()}>
        <span className="present-title ellipsis">{title}</span>
        <button type="button" className="present-btn" aria-label="Vorherige Folie" disabled={index <= 0} onClick={() => nav({ action: "prev" })}>
          <ChevronLeft size={18} />
        </button>
        <button type="button" className="present-btn" aria-label="Nächste Folie" disabled={index >= count - 1} onClick={() => nav({ action: "next" })}>
          <ChevronRight size={18} />
        </button>
        <span className="present-sep" />
        <button type="button" className={`present-btn ${presenter !== "off" ? "on" : ""}`} aria-pressed={presenter !== "off"} onClick={() => void togglePresenter()} title="Referentenansicht (R)">
          <MonitorSpeaker size={16} /> Referentenansicht
        </button>
        <button type="button" className={`present-btn ${beamer ? "on" : ""}`} aria-pressed={beamer} onClick={() => nav({ action: "beamer" })} title="Heller Beamer-Stil (B)">
          <Sun size={16} /> Beamer
        </button>
        <button type="button" className="present-btn" aria-label="Präsentation beenden" onClick={end} title="Beenden (Esc)">
          <X size={16} />
        </button>
      </div>
      {presenter === "overlay" && <PresenterPanel deck={deck} onNav={(n) => (n.action === "end" ? end() : nav(n))} overlay />}
    </div>
  );
}

// ---------------------------------------------------------- presenter window

/** The presenter window (`index.html#presenter`): mirrors the deck of the main window. */
export function PresenterApp() {
  const [deck, setDeck] = useState<DeckState | null>(null);
  const typed = useRef("");
  useEffect(() => {
    const un = on<DeckState>("presentation://state", (d) => {
      setDeck(d);
      document.documentElement.dataset.theme = d.theme;
    });
    void un.then(() => emitTo("main", "presentation://hello", null).catch(() => {}));
    document.body.classList.add("ready", "presenter-window");
    return () => void un.then((f) => f());
  }, []);
  const send = (n: Nav) => void emitTo("main", "presentation://nav", n).catch(() => {});
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector(".menu")) return;
      if (e.key === "Escape") return void send({ action: "end" });
      const n = keyNav(e, typed);
      if (n) {
        e.preventDefault();
        send(n);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  if (!deck)
    return (
      <div className="presenter-wait">
        <PresentationIcon size={20} /> Warte auf die Präsentation…
      </div>
    );
  return <PresenterPanel deck={deck} onNav={send} />;
}
