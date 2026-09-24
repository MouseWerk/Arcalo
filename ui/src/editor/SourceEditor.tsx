// Markdown source mode: the page's file as it is (properties included), in a plain text editor.
// Saves like the visual editor (debounced, one after another) and keeps other panes in sync
// through the same events.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import type { PageDoc } from "../lib/types";
import { useApp } from "../store/app";
import { registerFlusher } from "./NoteEditor";

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

export function SourceEditor({ doc, onSaved }: { doc: PageDoc; onSaved: (d: PageDoc) => void }) {
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

  const save = () => {
    window.clearTimeout(timer.current);
    if (!dirty.current) return saving.current ?? Promise.resolve();
    dirty.current = false;
    const content = latest.current;
    const p: Promise<void> = (saving.current ?? Promise.resolve())
      .then(() => api.savePage(doc.id, content))
      .then((saved) => {
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
    return p;
  };

  useEffect(() => {
    const unregister = registerFlusher(save);
    const onSaved = (e: Event) => {
      const d = (e as CustomEvent<{ id: number; content: string; from: string }>).detail;
      if (d.id === doc.id && d.from !== instance.current && !dirty.current) setValue(d.content);
    };
    window.addEventListener("annalo:page-saved", onSaved);
    window.addEventListener("blur", save);
    return () => {
      unregister();
      window.removeEventListener("annalo:page-saved", onSaved);
      window.removeEventListener("blur", save);
      save();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.id]);

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
      />
    </div>
  );
}
