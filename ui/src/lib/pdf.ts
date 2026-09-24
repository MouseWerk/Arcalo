// pdf.js for PDF previews in notes and the PDF viewer, loaded on first use (a lazy chunk, not part
// of app start). Parsing runs in one shared Web Worker, so a large PDF never blocks the UI: the
// worker script is copied to `public/pdfjs/pdf.worker.js` (scripts/pdfjs-assets.mjs) and served
// from the app's own origin, which is all the CSP allows (`worker-src 'self'`). Should the worker
// not start, pdf.js falls back to parsing in the main thread by itself. The legacy build carries
// polyfills for older WebViews (macOS 11). PDFs come through IPC (`attachment_read`); standard
// fonts and the CMaps for Chinese, Japanese and Korean text come from `public/pdfjs/`: nothing is
// fetched from the network.

import type { PDFDocumentProxy, PDFPageProxy, PDFWorker } from "pdfjs-dist/legacy/build/pdf.mjs";
import { api } from "./api";

type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let lib: Promise<PdfJs> | null = null;
let worker: PDFWorker | null = null;

const assets = () => new URL(`${import.meta.env.BASE_URL}pdfjs/`, document.baseURI).href;

export function loadPdfjs(): Promise<PdfJs> {
  if (!lib) {
    lib = import("pdfjs-dist/legacy/build/pdf.mjs").then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = `${assets()}pdf.worker.js`;
      return pdfjs;
    });
    lib.catch(() => (lib = null));
  }
  return lib;
}

/** The worker all documents share (one parser thread instead of one per PDF). */
async function sharedWorker(pdfjs: PdfJs): Promise<PDFWorker> {
  if (!worker || worker.destroyed) worker = new pdfjs.PDFWorker();
  await worker.promise;
  return worker;
}

/** Where pdf.js parses: in its Web Worker, or in the main thread when the worker could not start. */
export async function pdfWorkerKind(): Promise<"worker" | "main"> {
  const w = await sharedWorker(await loadPdfjs());
  return typeof Worker !== "undefined" && w.port instanceof Worker ? "worker" : "main";
}

/** Opens a PDF of the attachments folder; the caller destroys it (`doc.loadingTask.destroy()`). */
export async function openPdf(name: string): Promise<PDFDocumentProxy> {
  const [pdfjs, data] = await Promise.all([loadPdfjs(), api.readAttachment(name)]);
  const base = assets();
  return pdfjs.getDocument({
    data: new Uint8Array(data),
    worker: await sharedWorker(pdfjs),
    // CJK text in fonts that are not embedded needs the character maps.
    cMapUrl: `${base}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${base}standard_fonts/`,
    // Only the JavaScript fallbacks of the image decoders are bundled: the CSP allows no WebAssembly.
    wasmUrl: `${base}wasm/`,
    enableXfa: false,
    verbosity: 0,
  }).promise;
}

/** Renders `page` into `canvas` at `scale` (CSS pixels per PDF point), sharp on HiDPI screens. */
export async function renderPage(page: PDFPageProxy, canvas: HTMLCanvasElement, scale: number): Promise<void> {
  const ratio = window.devicePixelRatio || 1;
  const viewport = page.getViewport({ scale: scale * ratio });
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  canvas.style.width = `${Math.floor(viewport.width / ratio)}px`;
  canvas.style.height = `${Math.floor(viewport.height / ratio)}px`;
  await page.render({ canvas, viewport }).promise;
}

/** First pages already rendered, per name (switching notes does not parse the PDF again). */
const previews = new Map<string, Promise<{ image: HTMLCanvasElement; pages: number }>>();
const MAX_PREVIEWS = 24;

async function renderPreview(name: string, width: number) {
  const doc = await openPdf(name);
  try {
    const page = await doc.getPage(1);
    const image = document.createElement("canvas");
    await renderPage(page, image, width / page.getViewport({ scale: 1 }).width);
    return { image, pages: doc.numPages };
  } finally {
    void doc.loadingTask.destroy();
  }
}

/** Draws the first page of `name` into `canvas` (`width` CSS pixels wide); resolves to the page count. */
export async function drawPdfPreview(name: string, canvas: HTMLCanvasElement, width: number): Promise<number> {
  let entry = previews.get(name);
  if (!entry) {
    entry = renderPreview(name, width);
    previews.set(name, entry);
    entry.catch(() => previews.delete(name));
    if (previews.size > MAX_PREVIEWS) previews.delete(previews.keys().next().value!);
  }
  const { image, pages } = await entry;
  canvas.width = image.width;
  canvas.height = image.height;
  canvas.style.width = image.style.width;
  canvas.getContext("2d")?.drawImage(image, 0, 0);
  return pages;
}

/** Forgets the cached first page of `name` (the file was renamed or deleted). */
export function forgetPdfPreview(name: string) {
  previews.delete(name);
}
