// Highlights in the PDF viewer: the colored bars over a page, the bar that appears over a text
// selection („Markieren“ in a color), the popover of a highlight (color, note, „In Notiz
// übernehmen“, delete) and taking highlights into a note as quotes that link back
// (`[[Bericht.pdf#page=12&hl=7|S. 12]]`, see `arcalo_core::pdfmarks`).

import { useEffect, useRef, useState } from "react";
import { FileInput, Highlighter, Trash2 } from "lucide-react";
import type { MenuEntry } from "../components/ui";
import { IconButton } from "../components/ui";
import { api } from "../lib/api";
import { useApp } from "../store/app";
import { HIGHLIGHT_COLORS, pageRects } from "../lib/linking";
import type { PdfHighlight, PdfRect } from "../lib/types";
import { flushAllEditors, reloadEditors } from "./NoteEditor";
import { appendMarkdown, insertMarkdownBelow } from "./ai-insert";
import { editorForPage } from "./reveal";
import { t, useT } from "../lib/i18n";
import type { TKey } from "../lib/i18n";
import { isComposing } from "../lib/ime";

const colorKey = (c: string) => `pdfh.${c}` as TKey;

/** The bars of a page's highlights (positions in fractions of the page). */
export function HighlightLayer({ marks, flash, onOpen }: { marks: PdfHighlight[]; flash: number | null; onOpen: (h: PdfHighlight, el: HTMLElement) => void }) {
  if (!marks.length) return null;
  return (
    <div className="pdf-marks">
      {marks.flatMap((h) =>
        h.rects.map((r, i) => (
          <div
            key={`${h.id}-${i}`}
            className={`pdf-mark is-${h.color} ${flash === h.id ? "is-flash" : ""}`}
            data-mark-id={h.id}
            data-tooltip={h.note || undefined}
            style={{ left: `${r[0] * 100}%`, top: `${r[1] * 100}%`, width: `${r[2] * 100}%`, height: `${r[3] * 100}%` }}
            onClick={(e) => onOpen(h, e.currentTarget)}
          />
        )),
      )}
    </div>
  );
}

/** A text selection inside one page: its page, text and rects. */
export type PdfSelection = { page: number; text: string; rects: PdfRect[]; x: number; y: number };

/** Reads the current text selection of the viewer (`null` when there is none in a page). */
export function readSelection(scroller: HTMLElement): PdfSelection | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  const startEl = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
  const pageEl = startEl?.closest<HTMLElement>(".pdf-page");
  if (!pageEl || !scroller.contains(pageEl)) return null;
  const text = sel.toString().trim();
  if (!text) return null;
  const box = pageEl.getBoundingClientRect();
  // Rects of other pages (a selection across a page break) are left out.
  const client = [...range.getClientRects()].filter((r) => r.top >= box.top - 2 && r.bottom <= box.bottom + 2);
  const rects = pageRects(client, box);
  if (!rects.length) return null;
  const last = client[client.length - 1];
  return { page: Number(pageEl.dataset.page), text, rects, x: last.right, y: last.bottom };
}

/** The bar over a selection: one swatch per color. */
export function SelectionBar({ sel, onPick }: { sel: PdfSelection; onPick: (color: string) => void }) {
  useT();
  return (
    <div className="pdf-selbar" style={{ left: Math.max(8, Math.min(sel.x - 120, window.innerWidth - 260)), top: Math.max(8, Math.min(sel.y + 6, window.innerHeight - 44)) }} role="toolbar" aria-label={t("pdfh.highlight")} onMouseDown={(e) => e.preventDefault()}>
      <Highlighter size={13} aria-hidden className="faint" />
      <span className="pdf-selbar-label">{t("pdfh.highlight")}</span>
      {HIGHLIGHT_COLORS.map((c) => (
        <button key={c} type="button" className={`pdf-swatch is-${c}`} aria-label={t("pdfh.colorLabel", { color: t(colorKey(c)) })} data-tooltip={t(colorKey(c))} onClick={() => onPick(c)} />
      ))}
    </div>
  );
}

/** Inserts Markdown into a page: at the caret of its open editor (undoable there), else appended. */
async function insertIntoPage(pageId: number, md: string) {
  const editor = editorForPage(pageId);
  if (editor && !editor.isDestroyed) {
    const sel = editor.state.selection;
    const ok = sel.from > 1 ? insertMarkdownBelow(editor, { from: sel.from, to: sel.to }, md) : appendMarkdown(editor, md);
    if (ok) return;
  }
  await flushAllEditors();
  await api.appendToPage(pageId, md);
  reloadEditors([pageId]);
}

/** „In Notiz übernehmen“: one highlight (`id`) or all of the file as quotes into `pageId`. */
export async function takeIntoNote(name: string, id: number | null, pageId: number) {
  const s = useApp.getState();
  try {
    const md = await api.pdfHighlightMarkdown(name, id);
    await insertIntoPage(pageId, md);
    const title = s.pages.get(pageId)?.title ?? s.activeDoc?.title ?? "";
    s.toast({ tone: "success", title: t("pdfh.added", { title }) });
  } catch (e) {
    s.error(t("pdfh.insertFailed"), e);
  }
}

/** The note highlights go into by default: the page of the focused pane. */
export const currentNote = (): number | null => useApp.getState().activeDoc?.id ?? null;

/** Menu entries of recently edited notes (for „In andere Seite…“). */
export function pageChoices(run: (pageId: number) => void): MenuEntry[] {
  const pages = [...useApp.getState().pages.values()].filter((p) => p.deleted_at == null && p.kind !== "canvas");
  pages.sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""));
  return pages.slice(0, 10).map((p) => ({ label: p.title, onSelect: () => run(p.id) }));
}

/** The popover of a highlight: color, note, take into a note, delete. */
export function HighlightPopover({
  h,
  at,
  onChange,
  onDelete,
  onTake,
  onTakeElsewhere,
  onClose,
}: {
  h: PdfHighlight;
  at: { x: number; y: number };
  onChange: (h: PdfHighlight) => void;
  onDelete: () => void;
  onTake: () => void;
  onTakeElsewhere: (el: HTMLElement) => void;
  onClose: () => void;
}) {
  useT();
  const [note, setNote] = useState(h.note);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => setNote(h.note), [h.id, h.note]);
  useEffect(() => {
    const down = (e: MouseEvent) => {
      const el = e.target as Element | null;
      if (box.current && el && !box.current.contains(el) && !el.closest(".menu")) onClose();
    };
    window.addEventListener("mousedown", down, true);
    return () => window.removeEventListener("mousedown", down, true);
  }, [onClose]);
  const save = (patch: { color?: string; note?: string }) =>
    api.updatePdfHighlight(h.id, patch).then(onChange, (e) => useApp.getState().error(t("pdfh.failed"), e));
  return (
    <div
      ref={box}
      className="pdf-hl-pop"
      style={{ left: Math.max(8, Math.min(at.x - 140, window.innerWidth - 300)), top: Math.min(at.y + 8, window.innerHeight - 220) }}
      role="dialog"
      aria-label={t("pdfh.note")}
      onKeyDown={(e) => {
        if (isComposing(e)) return;
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="pdf-hl-pop-colors">
        {HIGHLIGHT_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            className={`pdf-swatch is-${c} ${h.color === c ? "on" : ""}`}
            aria-label={t("pdfh.colorLabel", { color: t(colorKey(c)) })}
            aria-pressed={h.color === c}
            onClick={() => void save({ color: c })}
          />
        ))}
        <span className="spacer" />
        <IconButton icon={Trash2} label={t("pdfh.delete")} size="sm" onClick={onDelete} className="pdf-hl-delete" />
      </div>
      <textarea
        className="input pdf-hl-note"
        placeholder={t("pdfh.notePh")}
        aria-label={t("pdfh.note")}
        rows={2}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onBlur={() => note !== h.note && void save({ note })}
        onKeyDown={(e) => {
          if (isComposing(e)) return;
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void save({ note });
          }
        }}
      />
      <div className="pdf-hl-pop-actions">
        <button type="button" className="btn btn-secondary btn-sm pdf-hl-take" onClick={onTake}>
          <FileInput size={14} aria-hidden />
          <span>{t("pdfh.toNote")}</span>
        </button>
        <button type="button" className="btn btn-ghost btn-sm pdf-hl-elsewhere" onClick={(e) => onTakeElsewhere(e.currentTarget)}>
          <span>{t("pdfh.toPage")}</span>
        </button>
      </div>
    </div>
  );
}

/** Whether any of the first pages has text (a scan has none). */
export async function hasTextLayer(pageText: (n: number) => Promise<string[]>, pages: number): Promise<boolean> {
  for (let n = 1; n <= Math.min(pages, 3); n++) if ((await pageText(n)).some((s) => s.trim())) return true;
  return false;
}
