// The pieces of a canvas board: cards (text, note, image, file, link, Jira issue, group), the
// edge layer (SVG) with its labels, and the minimap. Cards are memoized on their node object:
// a drag re-renders only the cards that move.

import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import DOMPurify from "dompurify";
import { ExternalLink, FileText, Globe, Paperclip } from "lucide-react";
import { attachmentUrl } from "../../lib/api";
import { renderMarkdown } from "../../lib/markdown";
import { t } from "../../lib/i18n";
import { jiraApi, useIssueIndex } from "../../lib/jira";
import { hydrate, mountPageEmbed, type EmbedHost } from "../../editor/embedView";
import { renderPageHtml, type AttachmentSource } from "../../editor/shareHtml";
import { anchor, arrowHead, autoSides, bounds, edgePath, HANDLES, type Point, type Rect } from "../../lib/canvas/geometry";
import { baseName, colorValue, noteTitle, SIDES, type CanvasEdge, type CanvasNode, type CardKind, type Side } from "../../lib/canvas/model";

const NO_FILES: AttachmentSource = { read: async () => null, size: async () => null };

/** Rendered Markdown of text cards, by text (shared by all canvases while the app runs). */
const htmlCache = new Map<string, string>();
const remember = (text: string, html: string) => {
  if (htmlCache.size > 800) htmlCache.delete(htmlCache.keys().next().value!);
  htmlCache.set(text, html);
  return html;
};
/** Syntax only the note renderer knows: callouts, embeds, highlights, footnotes, columns, TOC. */
const RICH = /\[!|!\[\[|==|\[\^|<!--|\[TOC\]/;
/** Plain Markdown renders at once (hundreds of cards); the rest like a note, asynchronously. */
function quickHtml(text: string): string | null {
  const hit = htmlCache.get(text);
  if (hit != null) return hit;
  return RICH.test(text) ? null : remember(text, renderMarkdown(text));
}
async function markdownHtml(text: string): Promise<string> {
  const quick = quickHtml(text);
  if (quick != null) return quick;
  return remember(text, DOMPurify.sanitize(await renderPageHtml(text, { id: "cv", files: NO_FILES, anchors: new Map(), live: { imageUrl: attachmentUrl } })));
}

/** Callbacks the cards share (one stable object per board). */
export interface CardHost {
  embed: EmbedHost;
  onText: (id: string, text: string) => void;
  onEndEdit: () => void;
  onLabel: (id: string, label: string) => void;
  openNote: (title: string, newTab: boolean) => void;
}

function Markdown({ text, host }: { text: string; host: EmbedHost }) {
  const ref = useRef<HTMLDivElement>(null);
  const [html, setHtml] = useState(() => quickHtml(text));
  useEffect(() => {
    let alive = true;
    const quick = quickHtml(text);
    if (quick != null) return setHtml(quick);
    void markdownHtml(text).then((h) => alive && setHtml(h));
    return () => {
      alive = false;
    };
  }, [text]);
  useEffect(() => {
    if (!ref.current || html == null) return;
    return hydrate(ref.current, host, "");
  }, [html, host]);
  if (!text.trim()) return <p className="cv-placeholder">{t("canvas.text.empty")}</p>;
  return <div ref={ref} className="prose cv-md" dangerouslySetInnerHTML={{ __html: html ?? "" }} />;
}

function TextEditor({ node, host }: { node: CanvasNode; host: CardHost }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  return (
    <textarea
      ref={ref}
      className="cv-text-input"
      value={node.text ?? ""}
      placeholder={t("canvas.text.placeholder")}
      spellCheck
      onChange={(e) => host.onText(node.id, e.target.value)}
      onBlur={() => host.onEndEdit()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape" || (e.key === "Enter" && (e.ctrlKey || e.metaKey))) {
          e.preventDefault();
          host.onEndEdit();
        }
      }}
    />
  );
}

function NoteBody({ node, host }: { node: CanvasNode; host: CardHost }) {
  const ref = useRef<HTMLDivElement>(null);
  const title = noteTitle(node.file ?? "");
  const anchorName = typeof node.subpath === "string" && node.subpath.startsWith("#") ? node.subpath.slice(1) : null;
  useEffect(() => {
    if (!ref.current) return;
    return mountPageEmbed(ref.current, { target: title, anchor: anchorName, alt: null }, host.embed);
  }, [title, anchorName, host]);
  return (
    <>
      <div className="cv-note-head">
        <FileText size={13} aria-hidden />
        <span className="cv-note-title">{title}</span>
        <button
          type="button"
          className="cv-note-open"
          title={t("canvas.note.open")}
          aria-label={t("canvas.note.open")}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => host.openNote(title, e.ctrlKey || e.metaKey)}
        >
          <ExternalLink size={13} />
        </button>
      </div>
      <div ref={ref} className="cv-note-body cv-scroll" />
    </>
  );
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
};

/** Issues asked from Jira once while the app runs (cards of issues outside the cache). */
const fetched = new Set<string>();

function IssueBody({ node }: { node: CanvasNode }) {
  const key = String(node.issue ?? "");
  const issue = useIssueIndex((s) => s.byKey.get(key));
  const known = useIssueIndex((s) => s.projects.size > 0);
  useEffect(() => {
    if (issue || !known || !key || fetched.has(key)) return;
    fetched.add(key);
    // Cached for chips from then on; the index reloads with it.
    void jiraApi
      .fetch(key)
      .then(() => useIssueIndex.getState().load())
      .catch(() => {});
  }, [issue, known, key]);
  const summary = issue?.summary ?? (typeof node.title === "string" ? node.title : "");
  return (
    <div className="cv-issue">
      <div className="cv-issue-top">
        <span className={`cv-issue-key${issue ? ` cat-${issue.status_category}` : ""}`}>{key}</span>
        {issue && (
          <span className="cv-issue-status">
            <span className={`cv-dot cat-${issue.status_category}`} aria-hidden />
            {issue.status}
          </span>
        )}
      </div>
      <div className="cv-issue-summary">{summary || t("canvas.issue.unknown")}</div>
      {issue && (issue.assignee || issue.issue_type) && <div className="cv-issue-meta">{[issue.issue_type, issue.assignee].filter(Boolean).join(" · ")}</div>}
    </div>
  );
}

function LinkBody({ node }: { node: CanvasNode }) {
  const url = node.url ?? "";
  const title = typeof node.title === "string" && node.title ? node.title : hostOf(url);
  return (
    <div className="cv-link">
      <span className="cv-link-icon" aria-hidden>
        <Globe size={16} />
      </span>
      <div className="cv-link-text">
        <div className="cv-link-title">{title}</div>
        <div className="cv-link-url">{url}</div>
      </div>
    </div>
  );
}

/** Far out, a card shows only what can be read at that size: its first line, large. */
function lodBody(kind: CardKind, node: CanvasNode): ReactNode {
  const first = (s: string) => s.split("\n").map((l) => l.replace(/^[#>\-*+\s]+|\[\[|\]\]|\*\*/g, "").trim()).find(Boolean) ?? "";
  const label =
    kind === "text" ? first(node.text ?? "") : kind === "note" ? noteTitle(node.file ?? "") : kind === "issue" ? String(node.issue ?? "") : kind === "link" ? (typeof node.title === "string" && node.title) || hostOf(node.url ?? "") : baseName(node.file ?? "");
  if (kind === "image") return <img className="cv-image" src={attachmentUrl(baseName(node.file ?? ""))} alt="" draggable={false} />;
  return <div className="cv-lod">{label}</div>;
}

function body(kind: CardKind, node: CanvasNode, editing: boolean, host: CardHost): ReactNode {
  switch (kind) {
    case "text":
      return editing ? <TextEditor node={node} host={host} /> : <div className="cv-text cv-scroll"><Markdown text={node.type === "text" ? (node.text ?? "") : `${node.type}`} host={host.embed} /></div>;
    case "note":
      return <NoteBody node={node} host={host} />;
    case "image":
      return <img className="cv-image" src={attachmentUrl(baseName(node.file ?? ""))} alt={baseName(node.file ?? "")} draggable={false} />;
    case "file":
      return (
        <div className="cv-file">
          <Paperclip size={16} aria-hidden />
          <span className="cv-file-name">{baseName(node.file ?? "")}</span>
        </div>
      );
    case "link":
      return <LinkBody node={node} />;
    case "issue":
      return <IssueBody node={node} />;
    default:
      return null;
  }
}

/** A card (not a group). Its geometry comes from the node; the board moves the world, not the card. */
export const Card = memo(function Card({ node, kind, selected, single, editing, lod, host }: { node: CanvasNode; kind: CardKind; selected: boolean; single: boolean; editing: boolean; lod: boolean; host: CardHost }) {
  const color = colorValue(node.color);
  return (
    <div
      className={`cv-card cv-${kind}${selected ? " is-selected" : ""}${editing ? " is-editing" : ""}${color ? " has-color" : ""}`}
      data-node={node.id}
      data-kind={kind}
      style={{ transform: `translate(${node.x}px, ${node.y}px)`, width: node.width, height: node.height, ...(color ? { ["--cv-color" as string]: color } : {}) }}
    >
      <div className="cv-card-inner">{lod && !editing ? lodBody(kind, node) : body(kind, node, editing, host)}</div>
      {!editing && SIDES.map((s) => <div key={s} className={`cv-connect cv-connect-${s}`} data-connect={s} />)}
      {selected && single && !editing && HANDLES.map((h) => <div key={h} className={`cv-handle cv-handle-${h}`} data-handle={h} />)}
    </div>
  );
});

/** A group: a labelled frame below the cards. */
export const Group = memo(function Group({ node, selected, single, editing, host }: { node: CanvasNode; selected: boolean; single: boolean; editing: boolean; host: CardHost }) {
  const color = colorValue(node.color);
  return (
    <div
      className={`cv-group${selected ? " is-selected" : ""}${color ? " has-color" : ""}`}
      data-node={node.id}
      data-kind="group"
      style={{ transform: `translate(${node.x}px, ${node.y}px)`, width: node.width, height: node.height, ...(color ? { ["--cv-color" as string]: color } : {}) }}
    >
      {editing ? (
        <input
          className="cv-group-input"
          autoFocus
          defaultValue={node.label ?? ""}
          aria-label={t("canvas.group.label")}
          onPointerDown={(e) => e.stopPropagation()}
          onBlur={(e) => host.onLabel(node.id, e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter" || e.key === "Escape") (e.target as HTMLInputElement).blur();
          }}
        />
      ) : (
        <div className="cv-group-label">{node.label || t("canvas.group.unnamed")}</div>
      )}
      {selected && single && HANDLES.map((h) => <div key={h} className={`cv-handle cv-handle-${h}`} data-handle={h} />)}
    </div>
  );
});

export interface EdgeDraft {
  from: Point;
  fromSide: Side;
  to: Point;
}

/** Where an edge runs: stored sides, or facing sides chosen from the cards' positions. */
export function edgeGeometry(e: CanvasEdge, a: Rect, b: Rect) {
  const [fs, ts] = autoSides(a, b);
  const fromSide = e.fromSide ?? fs;
  const toSide = e.toSide ?? ts;
  return edgePath(anchor(a, fromSide), fromSide, anchor(b, toSide), toSide, e.path === "straight");
}

/** All edges in one SVG (with a wide transparent stroke to hit them), plus a connection being drawn. */
export const EdgeLayer = memo(function EdgeLayer({ edges, nodes, selected, draft }: { edges: CanvasEdge[]; nodes: Map<string, CanvasNode>; selected: Set<string>; draft: EdgeDraft | null }) {
  return (
    <svg className="cv-edges" aria-hidden>
      {edges.map((e) => {
        const a = nodes.get(e.fromNode);
        const b = nodes.get(e.toNode);
        if (!a || !b) return null;
        const g = edgeGeometry(e, a, b);
        const color = colorValue(e.color);
        return (
          <g key={e.id} className={`cv-edge${selected.has(e.id) ? " is-selected" : ""}`} data-edge={e.id} style={color ? { ["--cv-color" as string]: color } : undefined}>
            <path className="cv-edge-hit" d={g.d} />
            <path className="cv-edge-line" d={g.d} />
            {(e.toEnd ?? "arrow") === "arrow" && <path className="cv-edge-arrow" d={arrowHead(g.to, g.dirTo, 11)} />}
            {e.fromEnd === "arrow" && <path className="cv-edge-arrow" d={arrowHead(g.from, g.dirFrom, 11)} />}
          </g>
        );
      })}
      {draft && <path className="cv-edge-draft" d={edgePath(draft.from, draft.fromSide, draft.to, oppositeOf(draft.fromSide, draft.from, draft.to)).d} />}
    </svg>
  );
});

function oppositeOf(side: Side, from: Point, to: Point): Side {
  if (side === "left" || side === "right") return to.x >= from.x ? "left" : "right";
  return to.y >= from.y ? "top" : "bottom";
}

/** Edge labels as HTML (crisp text), centered on the edges. */
export const EdgeLabels = memo(function EdgeLabels({ edges, nodes, selected, editing, onLabel }: { edges: CanvasEdge[]; nodes: Map<string, CanvasNode>; selected: Set<string>; editing: string | null; onLabel: (id: string, label: string) => void }) {
  return (
    <>
      {edges.map((e) => {
        if (!e.label && editing !== e.id) return null;
        const a = nodes.get(e.fromNode);
        const b = nodes.get(e.toNode);
        if (!a || !b) return null;
        const { mid } = edgeGeometry(e, a, b);
        const color = colorValue(e.color);
        return (
          <div key={e.id} className={`cv-edge-label${selected.has(e.id) ? " is-selected" : ""}`} data-edge={e.id} style={{ transform: `translate(${mid.x}px, ${mid.y}px) translate(-50%, -50%)`, ...(color ? { ["--cv-color" as string]: color } : {}) }}>
            {editing === e.id ? (
              <input
                autoFocus
                className="cv-edge-input"
                defaultValue={e.label ?? ""}
                aria-label={t("canvas.edge.label")}
                onPointerDown={(ev) => ev.stopPropagation()}
                onBlur={(ev) => onLabel(e.id, ev.target.value)}
                onKeyDown={(ev) => {
                  ev.stopPropagation();
                  if (ev.key === "Enter" || ev.key === "Escape") (ev.target as HTMLInputElement).blur();
                }}
              />
            ) : (
              e.label
            )}
          </div>
        );
      })}
    </>
  );
});

/** The overview in the corner: every card as a block, the visible part as a frame; a click jumps there. */
export function Minimap({ nodes, view, width, height, onJump }: { nodes: CanvasNode[]; view: Rect; width: number; height: number; onJump: (p: Point) => void }) {
  // The map spans the cards (with a margin); the visible part is clipped to it. The cards' layer
  // depends on the cards only, so panning redraws just the frame.
  const { x1, y1, scale, ox, oy } = useMemo(() => {
    const b = bounds(nodes) ?? { x: 0, y: 0, width: 1, height: 1 };
    const m = Math.max(b.width, b.height) * 0.08;
    const x1 = b.x - m;
    const y1 = b.y - m;
    const w = b.width + 2 * m;
    const h = b.height + 2 * m;
    const scale = Math.min(width / Math.max(1, w), height / Math.max(1, h));
    return { x1, y1, scale, ox: (width - w * scale) / 2, oy: (height - h * scale) / 2 };
  }, [nodes, width, height]);
  const box = (r: Rect) => ({ x: ox + (r.x - x1) * scale, y: oy + (r.y - y1) * scale, width: Math.max(1.5, r.width * scale), height: Math.max(1.5, r.height * scale) });
  const cards = useMemo(
    () =>
      nodes.map((n) => {
        const b = { x: ox + (n.x - x1) * scale, y: oy + (n.y - y1) * scale, width: Math.max(1.5, n.width * scale), height: Math.max(1.5, n.height * scale) };
        const color = colorValue(n.color);
        return <rect key={n.id} {...b} rx={n.type === "group" ? 2 : 1.5} className={n.type === "group" ? "cv-mm-group" : "cv-mm-card"} style={color ? { fill: color } : undefined} />;
      }),
    [nodes, x1, y1, scale, ox, oy],
  );
  const v = box(view);
  const vx = Math.max(0, v.x);
  const vy = Math.max(0, v.y);
  const frame = { x: vx, y: vy, width: Math.max(4, Math.min(width, v.x + v.width) - vx), height: Math.max(4, Math.min(height, v.y + v.height) - vy) };
  const jump = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    onJump({ x: x1 + (e.clientX - r.left - ox) / scale, y: y1 + (e.clientY - r.top - oy) / scale });
  };
  return (
    <svg
      className="cv-minimap"
      width={width}
      height={height}
      role="img"
      aria-label={t("canvas.minimap")}
      onPointerDown={(e) => {
        e.stopPropagation();
        e.currentTarget.setPointerCapture(e.pointerId);
        jump(e);
      }}
      onPointerMove={(e) => e.buttons === 1 && jump(e)}
    >
      {cards}
      <rect {...frame} rx={2} className="cv-mm-view" />
    </svg>
  );
}
