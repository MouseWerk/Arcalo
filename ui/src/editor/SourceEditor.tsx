// Markdown source mode: the page's file as it is (properties included), in a plain text editor.
// Saves like the visual editor (debounced, one after another) and keeps other panes in sync
// through the same events.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import type { PageDoc, SavedPage } from "../lib/types";
import { useApp } from "../store/app";
import { splitFrontmatter } from "./extensions";
import { markdownStats } from "../lib/plaintext";
import { keepUnsaved, registerFlusher, saveDelay, takeUnsaved, trackSave } from "./saves";
import { SaveFailed } from "./SaveFailed";
import { merge3 } from "../lib/merge3";
import { t } from "../lib/i18n";
import { useSourceChips } from "./sourceChips";
import { isComposing } from "../lib/ime";
import { LONG_TEXT, pacer } from "../lib/pace";

const INDENT = "  ";

/** What Enter continues on the next line: the list marker of `line`, or null. */
export function continuation(line: string): { prefix: string; empty: boolean } | null {
  const m = line.match(/^(\s*)([-*+]|\d+[.)])(\s+)(\[[ xX]\]\s+)?/);
  if (!m) return null;
  const [all, indent, marker, gap, box] = m;
  const next = /^\d/.test(marker) ? `${parseInt(marker, 10) + 1}${marker.slice(-1)}` : marker;
  return { prefix: `${indent}${next}${gap}${box ? "[ ] " : ""}`, empty: line.trim().length === all.trim().length };
}

/** The headings of Markdown source (ATX, outside code blocks and properties) with their offset. */
export function sourceOutline(text: string): { level: number; text: string; pos: number }[] {
  const out: { level: number; text: string; pos: number }[] = [];
  let fence: string | null = null;
  let pos = 0;
  const lines = text.split("\n");
  // The properties block at the top is not part of the outline.
  let i = 0;
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((l, k) => k > 0 && l.trim() === "---");
    if (end > 0) {
      for (; i <= end; i++) pos += lines[i].length + 1;
    }
  }
  for (; i < lines.length; i++) {
    const line = lines[i];
    const f = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (f) fence = fence === null ? f[1][0] : fence === f[1][0] ? null : fence;
    else if (fence === null) {
      const h = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
      if (h) out.push({ level: h[1].length, text: h[2], pos });
    }
    pos += line.length + 1;
  }
  return out;
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

export function SourceEditor({ doc, onSaved, active = true }: { doc: PageDoc; onSaved: (d: SavedPage & { content: string }) => void; active?: boolean }) {
  const [value, setValue] = useState(doc.content);
  // What the text box starts with (React does not hold its text, see below), and whether it got it.
  const initial = useRef(value).current;
  const filled = useRef(false);
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
  // Gone (tab closed, mode switch): failed edits are kept by `keepUnsaved` instead.
  const unmounted = useRef(false);
  const failed = useRef(false);
  // A failed save shows the same note as in the visual editor until a retry works.
  const [status, setStatus] = useState<"saved" | "failed">("saved");

  const save = () => {
    window.clearTimeout(timer.current);
    if (!dirty.current) return saving.current ?? Promise.resolve();
    dirty.current = false;
    const content = latest.current;
    // A booked `/zeit` chip removed (or back): its booking follows, as in the rich editor.
    chips.checked(content);
    const mergesBefore = merges.current;
    const p: Promise<void> = (saving.current ?? Promise.resolve())
      .then(() => api.savePage(doc.id, content))
      .then((saved) => {
        failed.current = false;
        if (!unmounted.current) setStatus("saved");
        if (merges.current === mergesBefore) base.current = content;
        cb.current({ ...saved, content });
        window.dispatchEvent(new CustomEvent("arcalo:page-saved", { detail: { id: doc.id, content, from: instance.current } }));
      })
      .catch((e) => {
        dirty.current = true;
        // Reported once per failure series, not on every retry.
        if (!failed.current) useApp.getState().error(t("editor.saveFailed"), e);
        failed.current = true;
        if (unmounted.current) return keepUnsaved(doc.id, content, api.savePage);
        setStatus("failed");
        // Try again later; the edits stay in the editor meanwhile.
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(save, 5000);
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
    chips.absorbed(base.current, theirs);
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
    timer.current = window.setTimeout(save, saveDelay());
  };
  /** `next` as an edit of the user (the chip put back by „Rückgängig“), saved as typed text is. */
  const edit = (next: string) => {
    replaceText(next);
    dirty.current = true;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(save, saveDelay());
  };
  const chips = useSourceChips(doc.id, () => latest.current, edit, mapCaret);
  const chipsRef = useRef(chips);
  chipsRef.current = chips;
  // Which chips the text shows and its word count (status bar, the text without properties): at once in short
  // texts, after a pause in typing in long ones (both scan the whole text).
  const pace = useState(pacer)[0];
  const activeRef = useRef(active);
  activeRef.current = active;
  useEffect(() => {
    pace.run(value.length, () => {
      const text = latest.current;
      chipsRef.current.shown(text);
      if (activeRef.current) useApp.getState().set({ editorStats: markdownStats(splitFrontmatter(text).body) });
    });
  }, [value, active, pace]);
  useEffect(() => () => pace.cancel(), [pace]);

  const absorbRef = useRef(absorb);
  absorbRef.current = absorb;

  useEffect(() => {
    unmounted.current = false;
    // Edits of an earlier editor of this page that could not be saved: shown and saved from here.
    const kept = takeUnsaved(doc.id);
    if (kept !== undefined && kept !== latest.current) {
      replaceText(kept);
      dirty.current = true;
      timer.current = window.setTimeout(save, saveDelay());
    }
    const unregister = registerFlusher(async () => {
      await save();
      if (dirty.current) throw new Error(t("ne.changesNotSaved"));
    });
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
    window.addEventListener("arcalo:page-saved", onSaved);
    window.addEventListener("arcalo:flush-page", onFlushPage);
    window.addEventListener("arcalo:reload-pages", onReload);
    window.addEventListener("blur", save);
    return () => {
      unregister();
      window.removeEventListener("arcalo:page-saved", onSaved);
      window.removeEventListener("arcalo:flush-page", onFlushPage);
      window.removeEventListener("arcalo:reload-pages", onReload);
      window.removeEventListener("blur", save);
      save();
      unmounted.current = true;
      window.clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.id]);

  useEffect(() => {
    if (active) return () => useApp.getState().set({ editorStats: null });
  }, [active]);
  // The outline panel lists the headings of the source text; a click puts the caret on the line.
  useEffect(() => {
    if (!active) return;
    const t = window.setTimeout(() => useApp.getState().set({ outline: sourceOutline(value) }), value.length < 20_000 ? 0 : 300);
    return () => window.clearTimeout(t);
  }, [value, active]);
  useEffect(() => {
    if (!active) return;
    const scrollToPos = (pos: number) => {
      const el = ref.current;
      if (!el) return;
      el.focus({ preventScroll: true });
      el.setSelectionRange(pos, pos);
      // The text box grows with its text: the page scrolls to the line (by its share of the lines).
      const lines = el.value.split("\n").length;
      const line = el.value.slice(0, pos).split("\n").length - 1;
      const sc = el.closest(".page-scroll");
      if (sc) {
        const y = el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop + (el.scrollHeight * line) / Math.max(1, lines);
        sc.scrollTo({ top: Math.max(0, y - sc.clientHeight / 3), behavior: "instant" });
      }
    };
    useApp.getState().set({ outline: sourceOutline(latest.current), scrollToPos });
    return () => {
      const st = useApp.getState();
      if (st.scrollToPos === scrollToPos) st.set({ scrollToPos: null, outline: [] });
    };
  }, [active]);
  // The page view fetched the page anew (after a mode switch, a reload): show that, unless
  // there are own edits.
  useEffect(() => {
    if (busy() || doc.content === latest.current) return;
    chips.absorbed(base.current, doc.content);
    base.current = doc.content;
    replaceText(doc.content);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.content]);

  // Grows with its text: the page scrolls, not the text box. Fitting it anew lays the whole text out twice; in a
  // long text a key only grows it when needed, and the exact fit (also shrinking) follows in a pause.
  const fitPace = useState(pacer)[0];
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    };
    if (value.length < LONG_TEXT || !el.style.height) return fit();
    if (el.scrollHeight > el.clientHeight) el.style.height = `${el.scrollHeight}px`;
    fitPace.run(value.length, fit);
  }, [value, fitPace]);
  useEffect(() => () => fitPace.cancel(), [fitPace]);

  // Typed text: the text box has it already.
  const typed = (next: string) => {
    setValue(next);
    dirty.current = true;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(save, saveDelay());
  };
  /** Text changed by a key we handle (Tab, Enter in a list): into the text box, then as typed. */
  const change = (next: string, caret: [number, number]) => {
    if (ref.current) ref.current.value = next;
    typed(next);
    requestAnimationFrame(() => ref.current?.setSelectionRange(caret[0], caret[1]));
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (isComposing(e)) return;
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

  // The text box gets its text once, from here, and is rendered once (per language). React sets a text box's
  // default value (the whole text, as the box's child) whenever it renders a controlled one and after every
  // key for one with a default value, which in a long text costs more than the key itself. Changes go into
  // the box directly (`replaceText`, `change`).
  const keys = useRef({ typed, onKeyDown });
  keys.current = { typed, onKeyDown };
  const label = t("editor.source");
  const box = useMemo(
    () => (
      <textarea
        ref={(el) => {
          if (el && !filled.current) {
            el.value = initial;
            filled.current = true;
          }
          ref.current = el;
        }}
        className="source-text"
        spellCheck={false}
        aria-label={label}
        onChange={(e) => keys.current.typed(e.target.value)}
        onKeyDown={(e) => keys.current.onKeyDown(e)}
        // Other editors of this page store their edits first, so we continue from them.
        onFocus={() => window.dispatchEvent(new CustomEvent("arcalo:flush-page", { detail: { id: doc.id, from: instance.current } }))}
      />
    ),
    [initial, label, doc.id],
  );

  return (
    <div className="source-editor" data-save-status={status}>
      {status === "failed" && <SaveFailed />}
      {box}
    </div>
  );
}
