// Markdown source mode: the page's file as it is (properties included), in a plain text editor.
// Saves like the visual editor (debounced, one after another) and keeps other panes in sync
// through the same events.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import type { PageDoc } from "../lib/types";
import { useApp } from "../store/app";
import { splitFrontmatter } from "./extensions";
import { markdownStats } from "../lib/plaintext";
import { registerFlusher, trackSave } from "./NoteEditor";
import { merge3 } from "../lib/merge3";

const SAVE_MS = 700;
const INDENT = "  ";

/** What Enter continues on the next line: the list marker of `line`, or null. */
export function continuation(line: string): { prefix: string; empty: boolean } | null {
  const m = line.match(/^(\s*)([-*+]|\d+[.)])(\s+)(\[[ xX]\]\s+)?/);
  if (!m) return null;
  const [all, indent, marker, gap, box] = m;
  const next = /^\d/.test(marker) ? `${parseInt(marker, 10) + 1}${marker.slice(-1)}` : marker;
  return { prefix: `${indent}${next}${gap}${box ? "[ ] " : ""}`, empty: line.trim().length === all.trim().length };
}

/** Where a caret at `at` in `a` belongs in `b` (text before it that did not change keeps it). */
export function mapCaret(a: string, b: string, at: number): number {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  if (at <= head) return at;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  if (at >= a.length - tail) return at + b.length - a.length;
  // Inside the changed part: behind its new text.
  return b.length - tail;
}

export function SourceEditor({ doc, onSaved, active = true }: { doc: PageDoc; onSaved: (d: PageDoc) => void; active?: boolean }) {
  const [value, setValue] = useState(doc.content);
  const ref = useRef<HTMLTextAreaElement>(null);
  const dirty = useRef(false);
  const latest = useRef(value);
  const timer = useRef<number | undefined>(undefined);
  const saving = useRef<Promise<void> | null>(null);
  const instance = useRef(`source-${Math.random().toString(36).slice(2)}`);
  const cb = useRef(onSaved);
  cb.current = onSaved;
  latest.current = value;
  // The page as last stored in common with other panes: the base when both changed it.
  const base = useRef(doc.content);
  const merges = useRef(0);
  const busy = () => dirty.current || saving.current !== null;

  const save = () => {
    window.clearTimeout(timer.current);
    if (!dirty.current) return saving.current ?? Promise.resolve();
    dirty.current = false;
    const content = latest.current;
    const mergesBefore = merges.current;
    const p: Promise<void> = (saving.current ?? Promise.resolve())
      .then(() => api.savePage(doc.id, content))
      .then((saved) => {
        if (merges.current === mergesBefore) base.current = content;
        cb.current(saved);
        window.dispatchEvent(new CustomEvent("annalo:page-saved", { detail: { id: doc.id, content, from: instance.current } }));
      })
      .catch((e) => {
        dirty.current = true;
        useApp.getState().error("Speichern fehlgeschlagen", e);
      })
      .finally(() => {
        if (saving.current === p) saving.current = null;
      });
    saving.current = p;
    trackSave(p);
    return p;
  };

  /** Shows `next` instead of the current text; the caret stays with the text around it. */
  const replaceText = (next: string) => {
    const el = ref.current;
    const prev = latest.current;
    const sel = el && document.activeElement === el ? [mapCaret(prev, next, el.selectionStart), mapCaret(prev, next, el.selectionEnd)] : null;
    latest.current = next;
    // Into the text box right away: a key pressed before React renders works on the new text.
    if (el) el.value = next;
    if (el && sel) el.setSelectionRange(sel[0], sel[1]);
    setValue(next);
  };

  // Content of another pane: taken over as it is, or merged with our unsaved (or still
  // saving) edits, which are then saved again.
  const absorb = (theirs: string) => {
    if (!busy()) {
      base.current = theirs;
      if (theirs !== latest.current) replaceText(theirs);
      return;
    }
    const merged = merge3(base.current, latest.current, theirs);
    base.current = theirs;
    merges.current++;
    replaceText(merged);
    dirty.current = true;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(save, SAVE_MS);
  };
  const absorbRef = useRef(absorb);
  absorbRef.current = absorb;

  useEffect(() => {
    const unregister = registerFlusher(save);
    const onSaved = (e: Event) => {
      const d = (e as CustomEvent<{ id: number; content: string; from: string }>).detail;
      if (d.id === doc.id && d.from !== instance.current) absorbRef.current(d.content);
    };
    // Another editor of this page is about to change it: store our edits first.
    const onFlushPage = (e: Event) => {
      const d = (e as CustomEvent<{ id: number; from: string }>).detail;
      if (d.id === doc.id && d.from !== instance.current) save();
    };
    const onReload = (e: Event) => {
      const ids = (e as CustomEvent<{ ids?: number[] }>).detail?.ids;
      if (ids && !ids.includes(doc.id)) return;
      api
        .page(doc.id)
        .then((fresh) => absorbRef.current(fresh.content))
        .catch(() => {});
    };
    window.addEventListener("annalo:page-saved", onSaved);
    window.addEventListener("annalo:flush-page", onFlushPage);
    window.addEventListener("annalo:reload-pages", onReload);
    window.addEventListener("blur", save);
    return () => {
      unregister();
      window.removeEventListener("annalo:page-saved", onSaved);
      window.removeEventListener("annalo:flush-page", onFlushPage);
      window.removeEventListener("annalo:reload-pages", onReload);
      window.removeEventListener("blur", save);
      save();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.id]);

  // The focused pane's editor feeds the word count in the status bar (the text without properties).
  useEffect(() => {
    if (active) useApp.getState().set({ editorStats: markdownStats(splitFrontmatter(value).body) });
  }, [value, active]);
  useEffect(() => {
    if (active) return () => useApp.getState().set({ editorStats: null });
  }, [active]);
  // The page view fetched the page anew (after a mode switch, a reload): show that, unless
  // there are own edits.
  useEffect(() => {
    if (busy() || doc.content === latest.current) return;
    base.current = doc.content;
    replaceText(doc.content);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.content]);

  // Grows with its text: the page scrolls, not the text box.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  const change = (next: string, caret?: [number, number]) => {
    setValue(next);
    dirty.current = true;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(save, SAVE_MS);
    if (caret) requestAnimationFrame(() => ref.current?.setSelectionRange(caret[0], caret[1]));
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    const { selectionStart: a, selectionEnd: b, value: v } = el;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      save();
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      const start = v.lastIndexOf("\n", a - 1) + 1;
      const end = b > a && v[b - 1] === "\n" ? b - 1 : b;
      const lines = v.slice(start, end).split("\n");
      const out = e.shiftKey ? lines.map((l) => l.replace(/^ {1,2}|^\t/, "")) : lines.map((l) => INDENT + l);
      const text = out.join("\n");
      const moved = e.shiftKey ? Math.max(start, a - (lines[0].length - out[0].length)) : a + INDENT.length;
      change(v.slice(0, start) + text + v.slice(end), a === b ? [moved, moved] : [start, start + text.length]);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && a === b) {
      const start = v.lastIndexOf("\n", a - 1) + 1;
      const cont = continuation(v.slice(start, a));
      if (!cont) return;
      e.preventDefault();
      // Enter on an empty list item ends the list.
      if (cont.empty) return change(v.slice(0, start) + v.slice(a), [start, start]);
      const insert = `\n${cont.prefix}`;
      change(v.slice(0, a) + insert + v.slice(b), [a + insert.length, a + insert.length]);
    }
  };

  return (
    <div className="source-editor">
      <textarea
        ref={ref}
        className="source-text"
        value={value}
        spellCheck={false}
        aria-label="Markdown-Quelltext"
        onChange={(e) => change(e.target.value)}
        onKeyDown={onKeyDown}
        // Other editors of this page store their edits first, so we continue from them.
        onFocus={() => window.dispatchEvent(new CustomEvent("annalo:flush-page", { detail: { id: doc.id, from: instance.current } }))}
      />
    </div>
  );
}
