// pdf.js for PDF previews in notes and the PDF viewer, loaded on first use (a lazy chunk, not part
// of app start). It runs without a web worker: the CSP keeps `worker-src 'none'`, and pdf.js then
// parses in the main thread ("fake worker", set up by preloading the worker module as
// `globalThis.pdfjsWorker`, so no Worker is even attempted). The legacy build carries polyfills for
// older WebViews (macOS 11). PDFs come through IPC (`attachment_read`), the standard fonts from
// `public/pdfjs/` (scripts/pdfjs-assets.mjs): nothing is fetched from the network.

import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import { api } from "./api";

type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let lib: Promise<PdfJs> | null = null;

export function loadPdfjs(): Promise<PdfJs> {
  if (!lib) {
    lib = (async () => {
      (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
      return import("pdfjs-dist/legacy/build/pdf.mjs");
    })();
    lib.catch(() => (lib = null));
  }
  return lib;
}

/** Opens a PDF of the attachments folder; the caller destroys it. */
export async function openPdf(name: string): Promise<PDFDocumentProxy> {
  const [pdfjs, data] = await Promise.all([loadPdfjs(), api.readAttachment(name)]);
  const assets = new URL(`${import.meta.env.BASE_URL}pdfjs/`, document.baseURI).href;
  return pdfjs.getDocument({
    data: new Uint8Array(data),
    standardFontDataUrl: `${assets}standard_fonts/`,
    // Only the JavaScript fallbacks of the image decoders are bundled: the CSP allows no WebAssembly.
    wasmUrl: `${assets}wasm/`,
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
