// Canvas export: the whole board as a standalone SVG (cards as rounded rectangles with their
// text wrapped into lines, images embedded as data URIs, edges with arrows and labels), as PNG
// (the SVG drawn at twice its size) and as a static HTML page for sharing. Colors are the
// current theme's, read from the canvas element.

import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { api } from "../../lib/api";
import { t } from "../../lib/i18n";
import { useIssueIndex } from "../../lib/jira";
import { useApp } from "../../store/app";
import { standaloneSvg, svgToPng } from "../../editor/mermaid";
import { anchor, autoSides, arrowHead, bounds, edgePath } from "../../lib/canvas/geometry";
import { baseName, cardKind, noteTitle, PRESET_COLORS, type CanvasDoc } from "../../lib/canvas/model";

const PAD = 48;
const FONT = "Inter, 'Segoe UI', system-ui, sans-serif";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

interface Palette {
  bg: string;
  card: string;
  text: string;
  muted: string;
  border: string;
  edge: string;
  accent: string;
  presets: Record<string, string>;
}

function palette(el: HTMLElement): Palette {
  const cs = getComputedStyle(el);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  const presets: Record<string, string> = {};
  for (const c of PRESET_COLORS) presets[c] = v(`--cv-c${c}`, "#888");
  return {
    bg: v("--cv-bg", "#ffffff"),
    card: v("--cv-card", "#ffffff"),
    text: v("--text", "#18181b"),
    muted: v("--text-3", "#71717a"),
    border: v("--cv-card-border", "#d4d4d8"),
    edge: v("--cv-edge", "#a1a1aa"),
    accent: v("--accent", "#6366f1"),
    presets,
  };
}

const colorOf = (p: Palette, c: string | undefined) => (c ? (p.presets[c] ?? (/^#[0-9a-f]{3,8}$/i.test(c) ? c : null)) : null);

let measureCtx: CanvasRenderingContext2D | null = null;
function measure(text: string, size: number, weight = 400): number {
  measureCtx ??= document.createElement("canvas").getContext("2d");
  if (!measureCtx) return text.length * size * 0.55;
  measureCtx.font = `${weight} ${size}px ${FONT}`;
  return measureCtx.measureText(text).width;
}

/** Word-wraps `text` into lines of at most `width` px. */
export function wrap(text: string, width: number, size: number, weight = 400): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) {
      out.push("");
      continue;
    }
    let line = "";
    for (const w of words) {
      const next = line ? `${line} ${w}` : w;
      if (measure(next, size, weight) <= width || !line) line = next;
      else {
        out.push(line);
        line = w;
      }
    }
    out.push(line);
  }
  return out;
}

interface Line {
  text: string;
  size: number;
  weight: number;
  muted?: boolean;
}

/** Markdown as styled plain lines (headings bold, list markers as dashes, links as their text). */
export function markdownLines(md: string): Line[] {
  const lines: Line[] = [];
  let fence = false;
  for (const raw of md.replace(/^---\n[\s\S]*?\n---\n?/, "").split("\n")) {
    if (raw.trim().startsWith("```")) {
      fence = !fence;
      continue;
    }
    let s = raw;
    const h = /^(#{1,6})\s+(.*)$/.exec(s);
    const inline = (x: string) =>
      x
        .replace(/!\[\[[^\]]*\]\]/g, "")
        .replace(/\[\[([^\]|#]*)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g, (_m, a, b) => b || a)
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/(\*\*|__|==|~~|`)/g, "")
        .replace(/(^|\s)[*_](\S[^*_]*)[*_]/g, "$1$2");
    if (fence) {
      lines.push({ text: s, size: 12, weight: 400, muted: true });
      continue;
    }
    if (h) {
      lines.push({ text: inline(h[2]), size: h[1].length === 1 ? 18 : h[1].length === 2 ? 16 : 14, weight: 650 });
      continue;
    }
    s = s.replace(/^(\s*)[-*+]\s+\[( |x|X)\]\s+/, (_m, ind, x) => `${ind}${x.trim() ? "[x]" : "[ ]"} `).replace(/^(\s*)[-*+]\s+/, "$1– ").replace(/^>\s?(\[![^\]]*\][+-]?\s*)?/, "");
    lines.push({ text: inline(s), size: 13, weight: 400 });
  }
  while (lines.length && !lines[lines.length - 1].text.trim()) lines.pop();
  return lines;
}

/** Lines into a box: `<text>` elements, cut at the box's height. */
function textBlock(lines: Line[], x: number, y: number, width: number, maxY: number, color: string, muted: string): string {
  let out = "";
  let at = y;
  for (const l of lines) {
    const rows = l.text.trim() ? wrap(l.text, width, l.size, l.weight) : [""];
    for (const r of rows) {
      const lh = Math.round(l.size * 1.5);
      if (at + lh > maxY) return out;
      at += lh;
      if (r) out += `<text x="${x}" y="${at - lh * 0.3}" font-size="${l.size}" font-weight="${l.weight}" fill="${l.muted ? muted : color}">${esc(r)}</text>`;
    }
  }
  return out;
}

async function imageData(name: string): Promise<string | null> {
  try {
    const buf = new Uint8Array(await api.readAttachment(name));
    let bin = "";
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    const ext = name.split(".").pop()?.toLowerCase() ?? "png";
    const mime = ext === "svg" ? "image/svg+xml" : ext === "jpg" ? "image/jpeg" : `image/${ext}`;
    return `data:${mime};base64,${btoa(bin)}`;
  } catch {
    return null;
  }
}

async function noteText(title: string): Promise<string> {
  try {
    return (await api.pageEmbed(title, null)).content ?? "";
  } catch {
    return "";
  }
}

/** The board as SVG markup (with size), in the colors of `el`'s theme. */
export async function canvasSvg(doc: CanvasDoc, el: HTMLElement): Promise<{ svg: string; width: number; height: number; background: string }> {
  const p = palette(el);
  const b = bounds(doc.nodes) ?? { x: 0, y: 0, width: 400, height: 300 };
  const x0 = b.x - PAD;
  const y0 = b.y - PAD - 24;
  const width = Math.ceil(b.width + 2 * PAD);
  const height = Math.ceil(b.height + 2 * PAD + 24);
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const parts: string[] = [];
  const cards: string[] = [];
  const issues = useIssueIndex.getState().byKey;

  for (const n of doc.nodes) {
    const kind = cardKind(n);
    const color = colorOf(p, n.color);
    const nx = n.x - x0;
    const ny = n.y - y0;
    if (kind === "group") {
      const fill = color ?? p.muted;
      parts.push(
        `<rect x="${nx}" y="${ny}" width="${n.width}" height="${n.height}" rx="14" fill="${fill}" fill-opacity="0.07" stroke="${fill}" stroke-opacity="0.45" stroke-width="1.5"/>`,
      );
      if (n.label) parts.push(`<text x="${nx + 4}" y="${ny - 10}" font-size="15" font-weight="600" fill="${color ?? p.text}">${esc(n.label)}</text>`);
      continue;
    }
    const border = color ?? p.border;
    let body = `<rect x="${nx}" y="${ny}" width="${n.width}" height="${n.height}" rx="10" fill="${p.card}" stroke="${border}" stroke-width="${color ? 2 : 1}"/>`;
    if (color) body += `<rect x="${nx}" y="${ny}" width="${n.width}" height="${n.height}" rx="10" fill="${color}" fill-opacity="0.08"/>`;
    const inner = { x: nx + 16, y: ny + 12, w: n.width - 32, max: ny + n.height - 10 };
    if (kind === "text") {
      body += textBlock(markdownLines(n.text ?? ""), inner.x, inner.y, inner.w, inner.max, p.text, p.muted);
    } else if (kind === "note") {
      const title = noteTitle(n.file ?? "");
      body += `<text x="${inner.x}" y="${ny + 26}" font-size="12" font-weight="600" fill="${p.muted}">${esc(title)}</text>`;
      body += `<line x1="${nx}" x2="${nx + n.width}" y1="${ny + 38}" y2="${ny + 38}" stroke="${p.border}"/>`;
      body += textBlock(markdownLines(await noteText(title)), inner.x, ny + 46, inner.w, inner.max, p.text, p.muted);
    } else if (kind === "image") {
      const data = await imageData(baseName(n.file ?? ""));
      if (data) body += `<image href="${data}" x="${nx + 4}" y="${ny + 4}" width="${n.width - 8}" height="${n.height - 8}" preserveAspectRatio="xMidYMid meet"/>`;
    } else if (kind === "file") {
      body += `<text x="${inner.x}" y="${ny + n.height / 2 + 5}" font-size="13" font-weight="550" fill="${p.text}">${esc(baseName(n.file ?? ""))}</text>`;
    } else if (kind === "link") {
      const title = typeof n.title === "string" && n.title ? n.title : (n.url ?? "");
      body += textBlock([{ text: title, size: 14, weight: 600 }], inner.x, inner.y, inner.w, inner.max - 18, p.text, p.muted);
      body += `<text x="${inner.x}" y="${ny + n.height - 14}" font-size="12" fill="${p.muted}">${esc(hostOf(n.url ?? ""))}</text>`;
    } else if (kind === "issue") {
      const key = String(n.issue);
      const issue = issues.get(key);
      body += `<text x="${inner.x}" y="${ny + 28}" font-size="12" font-weight="650" fill="${p.accent}">${esc(key)}</text>`;
      if (issue) body += `<text x="${nx + n.width - 16}" y="${ny + 28}" text-anchor="end" font-size="11" fill="${p.muted}">${esc(issue.status)}</text>`;
      const summary = issue?.summary ?? (typeof n.title === "string" ? n.title : "");
      body += textBlock([{ text: summary, size: 14, weight: 550 }], inner.x, ny + 36, inner.w, inner.max, p.text, p.muted);
    }
    cards.push(`<g>${body}</g>`);
  }

  const edges: string[] = [];
  for (const e of doc.edges) {
    const a = byId.get(e.fromNode);
    const z = byId.get(e.toNode);
    if (!a || !z) continue;
    const [fs, ts] = autoSides(a, z);
    const from = anchor(a, e.fromSide ?? fs);
    const to = anchor(z, e.toSide ?? ts);
    const g = edgePath({ x: from.x - x0, y: from.y - y0 }, e.fromSide ?? fs, { x: to.x - x0, y: to.y - y0 }, e.toSide ?? ts, e.path === "straight");
    const c = colorOf(p, e.color) ?? p.edge;
    edges.push(`<path d="${g.d}" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round"/>`);
    if ((e.toEnd ?? "arrow") === "arrow") edges.push(`<path d="${arrowHead(g.to, g.dirTo, 11)}" fill="${c}"/>`);
    if (e.fromEnd === "arrow") edges.push(`<path d="${arrowHead(g.from, g.dirFrom, 11)}" fill="${c}"/>`);
    if (e.label) {
      const w = measure(e.label, 12, 500) + 16;
      edges.push(`<rect x="${g.mid.x - w / 2}" y="${g.mid.y - 11}" width="${w}" height="22" rx="11" fill="${p.bg}" stroke="${c}" stroke-opacity="0.5"/>`);
      edges.push(`<text x="${g.mid.x}" y="${g.mid.y + 4}" text-anchor="middle" font-size="12" font-weight="500" fill="${p.text}">${esc(e.label)}</text>`);
    }
  }

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="${FONT}">` +
    `<rect width="100%" height="100%" fill="${p.bg}"/>${parts.join("")}${edges.join("")}${cards.join("")}</svg>`;
  return { svg, width, height, background: p.bg };
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

const fileBase = (title: string) => title.replace(/[\\/:*?"<>|]+/g, " ").trim() || "Canvas";

/** A static HTML page with the board (no scripts; only data: images). */
export function canvasHtml(title: string, svg: string, background: string): string {
  return `<!DOCTYPE html>
<html lang="${document.documentElement.lang || "de"}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>body{margin:0;background:${background};font-family:${FONT}}header{padding:20px 28px 8px;font-size:20px;font-weight:650;color:#888}main{overflow:auto;padding:8px 20px 28px}main svg{max-width:100%;height:auto}</style>
</head><body><header>${esc(title)}</header><main>${svg}</main></body></html>`;
}

export type CanvasExportFormat = "png" | "svg" | "html";

/** Asks for a target (unless `path` is given) and writes the export. */
export async function exportCanvas(doc: CanvasDoc, el: HTMLElement, title: string, format: CanvasExportFormat, path?: string) {
  const s = useApp.getState();
  try {
    const chosen = path ?? (await saveDialog({ defaultPath: `${fileBase(title)}.${format}`, filters: [{ name: format.toUpperCase(), extensions: [format] }] }));
    if (!chosen) return;
    const file = chosen.toLowerCase().endsWith(`.${format}`) ? chosen : `${chosen}.${format}`;
    const { svg, background } = await canvasSvg(doc, el);
    if (format === "html") await api.writeHtmlFile(file, canvasHtml(title, svg, background));
    else await api.writeDiagramFile(file, format === "svg" ? new TextEncoder().encode(standaloneSvg(svg)) : await svgToPng(svg, background));
    s.toast({ tone: "success", title: t("canvas.exported"), detail: file });
  } catch (e) {
    s.error(t("canvas.exportFailed"), e);
  }
}
