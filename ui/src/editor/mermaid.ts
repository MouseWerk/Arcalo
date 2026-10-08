// Mermaid diagrams (```mermaid blocks): the library is bundled with the app and loaded on the
// first diagram only (a dynamic import, never a CDN). It runs under the app's CSP: no eval,
// `securityLevel: strict`, labels as SVG text (no <foreignObject>, so a PNG export does not taint
// its canvas); the inline <style> of the SVG is allowed by `style-src 'unsafe-inline'`.
// Diagrams follow the light/dark theme; printing renders them light.

import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { api } from "../lib/api";
import { useApp } from "../store/app";
import { t } from "../lib/i18n";
import { track } from "./lazyRender";

type Mermaid = (typeof import("mermaid"))["default"];
let lib: Promise<Mermaid> | null = null;

/** The library, loaded once. */
export function loadMermaid(): Promise<Mermaid> {
  lib ??= import("mermaid").then((m) => m.default);
  return lib;
}

export type DiagramTheme = "light" | "dark";

let printing = false;

/** Printing uses the light theme until it is over. */
export function setPrintTheme(on: boolean) {
  printing = on;
  window.dispatchEvent(new CustomEvent(DIAGRAM_THEME_EVENT));
}

/** Sent when diagrams must render again in another theme (theme switch, printing). */
export const DIAGRAM_THEME_EVENT = "arcalo:diagram-theme";

/** The theme diagrams render in now. */
export const diagramTheme = (): DiagramTheme => (!printing && document.documentElement.dataset.theme === "dark" ? "dark" : "light");

if (typeof window !== "undefined" && typeof MutationObserver !== "undefined") {
  let last = diagramTheme();
  new MutationObserver(() => {
    const now = diagramTheme();
    if (now === last) return;
    last = now;
    window.dispatchEvent(new CustomEvent(DIAGRAM_THEME_EVENT));
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
}

let seq = 0;
let queue: Promise<unknown> = Promise.resolve();

export type DiagramResult = { svg: string } | { error: string };

const message = (e: unknown) => (e instanceof Error ? e.message : typeof e === "object" && e && "message" in e ? String((e as { message: unknown }).message) : String(e)).trim();

/** Renders Mermaid source to SVG markup (one diagram at a time: the configuration is global). */
export function renderDiagram(src: string, theme: DiagramTheme = diagramTheme()): Promise<DiagramResult> {
  const run = async (): Promise<DiagramResult> => {
    if (!src.trim()) return { error: t("mmd.empty") };
    const m = await loadMermaid();
    m.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: theme === "dark" ? "dark" : "default",
      fontFamily: getComputedStyle(document.body).fontFamily || "sans-serif",
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      suppressErrorRendering: true,
    });
    const id = `arcalo-mmd-${++seq}`;
    try {
      const { svg } = await m.render(id, src);
      return { svg };
    } catch (e) {
      return { error: message(e) || t("mmd.failed") };
    } finally {
      // A failed render can leave its scratch element behind.
      document.getElementById(id)?.remove();
      document.getElementById(`d${id}`)?.remove();
    }
  };
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return track(p);
}

// ------------------------------------------------------------------ export

const fileBase = (title: string) => title.replace(/[\\/:*?"<>|]+/g, " ").trim() || "Diagramm";

/** The SVG as a standalone file (with the XML namespace). */
export function standaloneSvg(svg: string): string {
  const out = svg.includes('xmlns="http://www.w3.org/2000/svg"') ? svg : svg.replace(/^<svg/, '<svg xmlns="http://www.w3.org/2000/svg"');
  return `<?xml version="1.0" encoding="UTF-8"?>\n${out}`;
}

/** Draws the SVG on a canvas at twice its size and returns PNG bytes. */
export async function svgToPng(svg: string, background: string): Promise<Uint8Array> {
  const el = new DOMParser().parseFromString(svg, "image/svg+xml").documentElement;
  const vb = el.getAttribute("viewBox")?.split(/[\s,]+/).map(Number);
  const width = Math.ceil(vb?.[2] || parseFloat(el.getAttribute("width") ?? "") || 800);
  const height = Math.ceil(vb?.[3] || parseFloat(el.getAttribute("height") ?? "") || 600);
  el.setAttribute("width", String(width));
  el.setAttribute("height", String(height));
  const xml = new XMLSerializer().serializeToString(el);
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`;
  await img.decode();
  const scale = 2;
  const canvas = document.createElement("canvas");
  canvas.width = width * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
  if (!blob) throw new Error("PNG");
  return new Uint8Array(await blob.arrayBuffer());
}

/** Asks for an export with the path given (`detail: { source, format, path }`), as after the save dialog. */
export const DIAGRAM_EXPORT_EVENT = "arcalo:diagram-export";

if (typeof window !== "undefined") {
  window.addEventListener(DIAGRAM_EXPORT_EVENT, (e) => {
    const d = (e as CustomEvent<{ source: string; format: "svg" | "png"; path: string }>).detail;
    if (d?.source && d.path) void exportDiagram(d.source, d.format, "", d.path);
  });
}

/** „Als SVG/PNG exportieren“: save dialog, then the file (rendered light, like print). */
export async function exportDiagram(src: string, format: "svg" | "png", title: string, path?: string) {
  const s = useApp.getState();
  try {
    const res = await renderDiagram(src, "light");
    if ("error" in res) throw new Error(res.error);
    const chosen = path ?? (await saveDialog({ defaultPath: `${fileBase(title)}.${format}`, filters: [{ name: format.toUpperCase(), extensions: [format] }] }));
    if (!chosen) return;
    const file = chosen.toLowerCase().endsWith(`.${format}`) ? chosen : `${chosen}.${format}`;
    const data = format === "svg" ? new TextEncoder().encode(standaloneSvg(res.svg)) : await svgToPng(res.svg, "#ffffff");
    await api.writeDiagramFile(file, data);
    s.toast({ tone: "success", title: t("mmd.exported"), detail: file });
  } catch (e) {
    s.error(t("mmd.exportFailed"), e);
  }
}
