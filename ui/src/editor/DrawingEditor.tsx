// The drawing editor: Excalidraw in a full-window overlay. Lazy-loaded (drawings.tsx), so
// Excalidraw is not part of the main bundle. Saves the scene and an SVG preview while
// drawing (debounced) and when closed with „Fertig“ or Esc.

import { useCallback, useEffect, useRef, useState } from "react";
import { Excalidraw, MainMenu, WelcomeScreen, exportToSvg, hashElementsVersion, serializeAsJSON } from "@excalidraw/excalidraw";
import type { AppState, BinaryFiles, ExcalidrawImperativeAPI, ExcalidrawInitialDataState, LibraryItems } from "@excalidraw/excalidraw/types";
import "@excalidraw/excalidraw/index.css";
import { api, errorText } from "../lib/api";
import { currentLang } from "../lib/i18n";
import { useApp } from "../store/app";
import { DRAWING_SAVED_EVENT, drawingLabel } from "./drawing";

const SAVE_DELAY = 800;
/** Shapes the user added to Excalidraw's library, kept across drawings. */
const LIBRARY_KEY = "annalo.excalidraw.library";

type Status = "saved" | "saving" | "dirty" | "error";
type Elements = ReturnType<ExcalidrawImperativeAPI["getSceneElements"]>;

const appTheme = (): "dark" | "light" => (document.documentElement.dataset.theme === "dark" ? "dark" : "light");

function loadLibrary(): LibraryItems {
  try {
    const raw = localStorage.getItem(LIBRARY_KEY);
    return raw ? (JSON.parse(raw) as LibraryItems) : [];
  } catch {
    return [];
  }
}

/** Identifies what is worth saving: the visible elements' versions and the attached images. */
const sceneKey = (elements: Elements, files: BinaryFiles) => `${hashElementsVersion(elements.filter((e) => !e.isDeleted))}:${Object.keys(files).length}`;

/**
 * Excalidraw subsets the fonts it inlines into an SVG with WebAssembly, which the app's CSP does
 * not allow (no `unsafe-eval`). It then inlines the whole font files instead (a few 10 kB) and
 * logs that as an error; those two expected messages are dropped while exporting.
 */
const EXPECTED_EXPORT_LOGS = /^(Skipped glyph subsetting|Failed to use workers for subsetting)/;

async function quietExport<T>(run: () => Promise<T>): Promise<T> {
  const { error, warn } = console;
  const filter =
    (log: (...a: unknown[]) => void) =>
    (...a: unknown[]) =>
      typeof a[0] === "string" && EXPECTED_EXPORT_LOGS.test(a[0]) ? undefined : log(...a);
  console.error = filter(error);
  console.warn = filter(warn);
  try {
    return await run();
  } finally {
    console.error = error;
    console.warn = warn;
  }
}

/** Scene JSON and SVG preview (`null` for an empty drawing, so the note shows the placeholder). */
async function render(elements: Elements, appState: AppState, files: BinaryFiles): Promise<{ scene: string; svg: string | null }> {
  const scene = serializeAsJSON(elements, appState, files, "local");
  if (!elements.length) return { scene, svg: null };
  // Transparent background: the note's own background shows through (dark mode inverts it via CSS).
  const svg = await quietExport<SVGSVGElement>(() => exportToSvg({ elements, appState: { ...appState, exportBackground: false, exportWithDarkMode: false }, files, exportPadding: 12 }));
  return { scene, svg: svg.outerHTML };
}

export default function DrawingEditor({ name, onClose }: { name: string; onClose: () => void }) {
  const [initial, setInitial] = useState<ExcalidrawInitialDataState | null>(null);
  const [theme, setTheme] = useState(appTheme);
  const [status, setStatus] = useState<Status>("saved");
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const savedKey = useRef<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const queue = useRef<Promise<boolean>>(Promise.resolve(true));
  const closing = useRef(false);
  const overlay = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    api
      .readDrawing(name)
      .then((raw) => JSON.parse(raw) as ExcalidrawInitialDataState)
      // Missing (e.g. an embed from an imported vault without the file): start empty.
      .catch(() => ({ elements: [] }) as ExcalidrawInitialDataState)
      .then((data) => {
        if (!alive) return;
        setInitial({ ...data, appState: { ...data.appState, theme: appTheme() }, libraryItems: loadLibrary(), scrollToContent: true });
      });
    return () => {
      alive = false;
    };
  }, [name]);

  // Follow the app's light/dark switch while the editor is open.
  useEffect(() => {
    const obs = new MutationObserver(() => setTheme(appTheme()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, []);

  /** Saves if the scene changed since the last save; resolves `false` on failure. */
  const save = useCallback((): Promise<boolean> => {
    window.clearTimeout(timer.current);
    queue.current = queue.current.then(async () => {
      const x = apiRef.current;
      if (!x) return true;
      const elements = x.getSceneElements();
      const files = x.getFiles();
      const key = sceneKey(elements, files);
      if (key === savedKey.current) {
        setStatus((s) => (s === "dirty" ? "saved" : s));
        return true;
      }
      setStatus("saving");
      try {
        const out = await render(elements, x.getAppState(), files);
        await api.saveDrawing(name, out.scene, out.svg);
        savedKey.current = key;
        window.dispatchEvent(new CustomEvent(DRAWING_SAVED_EVENT, { detail: { name } }));
        setStatus((s) => (s === "saving" ? "saved" : s));
        return true;
      } catch (e) {
        setStatus("error");
        useApp.getState().toast({ tone: "danger", title: "Zeichnung nicht gespeichert", detail: errorText(e) });
        return false;
      }
    });
    return queue.current;
  }, [name]);

  const onChange = useCallback(
    (elements: Elements, _appState: AppState, files: BinaryFiles) => {
      const key = sceneKey(elements, files);
      // The first change after loading only reflects the loaded scene.
      if (savedKey.current === null) savedKey.current = key;
      if (key === savedKey.current || closing.current) return;
      setStatus("dirty");
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void save(), SAVE_DELAY);
    },
    [save],
  );

  const close = useCallback(async () => {
    if (closing.current) return;
    closing.current = true;
    if (await save()) onClose();
    else closing.current = false;
  }, [save, onClose]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  // Modal: keys aimed at something behind the overlay (e.g. the note that still had the focus)
  // go nowhere, so typing never edits the note underneath. WebKit also inserts typed text at the
  // document selection even when the focus is elsewhere, so a selection left in the note is dropped.
  useEffect(() => {
    const dropOutsideSelection = () => {
      const sel = window.getSelection();
      if (sel?.anchorNode && !overlay.current?.contains(sel.anchorNode)) sel.removeAllRanges();
    };
    const active = document.activeElement;
    if (active instanceof HTMLElement && !overlay.current?.contains(active)) active.blur();
    dropOutsideSelection();
    const onKey = (e: KeyboardEvent) => {
      const root = overlay.current;
      if (!root) return;
      dropOutsideSelection();
      if (e.target instanceof Node && root.contains(e.target)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      root.querySelector<HTMLElement>(".excalidraw")?.focus();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const onKeyDownCapture = (e: React.KeyboardEvent) => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    // Esc first leaves text or line editing, drops the active tool or closes Excalidraw's own menus; only then the editor.
    const s = apiRef.current?.getAppState();
    const busy = !!s && (!!s.editingTextElement || !!s.newElement || !!s.editingLinearElement || !!s.openDialog || !!s.openMenu || !!s.openPopup || s.activeTool.type !== "selection");
    if (busy) return;
    e.preventDefault();
    e.stopPropagation();
    void close();
  };

  const statusText = { saved: "Gespeichert", saving: "Speichert…", dirty: "Ungespeichert", error: "Nicht gespeichert" }[status];

  return (
    // Keys stay inside the overlay: the app's global shortcuts (Ctrl K, Ctrl N, …) must not fire while drawing.
    <div
      ref={overlay}
      className="drawing-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={`Zeichnung ${drawingLabel(name)}`}
      onKeyDownCapture={onKeyDownCapture}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <header className="drawing-header">
        <span className="drawing-title">{drawingLabel(name)}</span>
        <span className={`drawing-status is-${status}`} aria-live="polite">
          {statusText}
        </span>
        <button type="button" className="btn btn-primary drawing-done" onClick={() => void close()}>
          Fertig
        </button>
      </header>
      <div className="drawing-canvas">
        {initial && (
          <Excalidraw
            initialData={initial}
            excalidrawAPI={(x) => (apiRef.current = x)}
            onChange={onChange}
            onLibraryChange={(items) => {
              try {
                localStorage.setItem(LIBRARY_KEY, JSON.stringify(items));
              } catch {
                /* library stays for this session */
              }
            }}
            theme={theme}
            langCode={currentLang() === "de" ? "de-DE" : "en"}
            name={drawingLabel(name)}
            autoFocus
            aiEnabled={false}
            UIOptions={{
              // Loading/saving files and image export happen through the note, not Excalidraw's file dialogs.
              canvasActions: { loadScene: false, saveToActiveFile: false, export: false, saveAsImage: false, toggleTheme: null },
              tools: { image: true },
            }}
          >
            <MainMenu>
              <MainMenu.DefaultItems.ClearCanvas />
              <MainMenu.DefaultItems.Help />
              <MainMenu.Separator />
              <MainMenu.DefaultItems.ChangeCanvasBackground />
            </MainMenu>
            <WelcomeScreen>
              <WelcomeScreen.Hints.MenuHint />
              <WelcomeScreen.Hints.ToolbarHint />
              <WelcomeScreen.Hints.HelpHint />
            </WelcomeScreen>
          </Excalidraw>
        )}
      </div>
    </div>
  );
}
