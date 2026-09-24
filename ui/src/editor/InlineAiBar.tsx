// Inline AI (Ctrl+J on a selection, „KI“ in the bubble menu, /KI bearbeiten): a small bar at the
// selection with preset actions and a free instruction. The answer streams into a preview and is
// then put into the note as Markdown, in one undoable step.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { ArrowUp, CornerDownLeft, RotateCcw, Replace, Sparkles, Square, X } from "lucide-react";
import { Button, IconButton } from "../components/ui";
import { renderMarkdown } from "../lib/markdown";
import { WRITE_PRESETS, inlinePresets, transformInstruction, writeInstruction } from "../lib/aitext";
import { useApp } from "../store/app";
import { useAiTransform } from "../lib/useAiTransform";
import { usd } from "../lib/format";
import { insertMarkdownBelow, rangeMarkdown, replaceWithMarkdown, type AiRange } from "./ai-insert";
import { keys } from "../lib/shortcut";

const BAR_WIDTH = 560;

export function InlineAiBar({
  editor,
  range: initial,
  pageId,
  beforeRun,
  onClose,
}: {
  editor: Editor;
  range: AiRange;
  pageId: number;
  /** Stores pending edits first, so the page's privacy markers are current. */
  beforeRun?: () => Promise<void>;
  onClose: () => void;
}) {
  const ai = useAiTransform();
  const [input, setInput] = useState("");
  const [last, setLast] = useState<string | null>(null);
  const range = useRef(initial);
  const source = useRef(rangeMarkdown(editor, initial));
  const root = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  // Nothing selected on an empty line: write new text there, with the page as context.
  const writing = useRef(!source.current.trim());
  const initialEmpty = useRef(writing.current).current;

  // Marks the text being worked on (the selection is hidden while the bar has the focus);
  // edits elsewhere in the note move the range along.
  useEffect(() => {
    const key = new PluginKey<AiRange>("aiTarget");
    editor.registerPlugin(
      new Plugin<AiRange>({
        key,
        state: {
          init: () => range.current,
          apply: (tr, r) => {
            if (!tr.docChanged) return r;
            const from = tr.mapping.map(r.from);
            const next = { from, to: Math.max(from, tr.mapping.map(r.to, -1)) };
            range.current = next;
            return next;
          },
        },
        props: {
          decorations: (state) => {
            const r = key.getState(state);
            return r && r.to > r.from ? DecorationSet.create(state.doc, [Decoration.inline(r.from, r.to, { class: "ai-target" })]) : null;
          },
        },
      }),
    );
    return () => {
      if (!editor.isDestroyed) editor.unregisterPlugin(key);
    };
  }, [editor]);

  // Below the selection, inside the editor (scrolls with the text); above it when there is
  // more room there. Placed again whenever the bar grows (the answer streams in) and kept in view.
  useLayoutEffect(() => {
    const el = root.current;
    const wrap = el?.offsetParent as HTMLElement | null;
    if (!el || !wrap) return;
    const place = () => {
      if (editor.isDestroyed) return;
      const box = wrap.getBoundingClientRect();
      const r = range.current;
      const size = editor.state.doc.content.size;
      const start = editor.view.coordsAtPos(Math.min(r.from + 1, size));
      const end = editor.view.coordsAtPos(Math.max(r.from, Math.min(r.to - 1, size)));
      const width = Math.min(BAR_WIDTH, box.width);
      const h = el.offsetHeight;
      const scroller = wrap.closest(".page-scroll")?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight };
      const below = scroller.bottom - end.bottom;
      const above = start.top - scroller.top;
      const up = below < h + 16 && above > below;
      const top = up ? Math.max(0, start.top - box.top - h - 8) : end.bottom - box.top + 8;
      setPos((cur) => (cur && cur.top === top && cur.width === width ? cur : { top, left: Math.max(0, Math.min(start.left - box.left, box.width - width)), width }));
      requestAnimationFrame(() => el.scrollIntoView({ block: "nearest", behavior: "smooth" }));
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  const close = (refocus = true) => {
    ai.reset();
    onClose();
    if (refocus && !editor.isDestroyed) editor.chain().focus().setTextSelection(range.current).run();
  };

  // A click outside closes the bar as long as there is nothing to lose.
  const hasResult = !!ai.text;
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node) && !ai.busy && !hasResult) close(false);
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  });

  const custom = inlinePresets(useApp((st) => st.settings?.settings.ai?.inline_presets));
  const presets = writing.current ? WRITE_PRESETS : custom;
  const done = !ai.busy && !!ai.text && !ai.error;
  const run = async (instruction: string) => {
    setLast(instruction);
    await beforeRun?.().catch(() => {});
    if (writing.current) {
      const all = { from: 0, to: editor.state.doc.content.size };
      ai.run(writeInstruction(instruction), rangeMarkdown(editor, all), pageId);
    } else ai.run(instruction, source.current, pageId);
  };
  const submit = (presetOrText: string) => {
    const instruction = transformInstruction(presetOrText, presets);
    if (instruction && !ai.busy) run(instruction);
  };
  const submitInput = () => {
    if (!input.trim()) return;
    // Follow-up on a result: refine that result instead of the original text.
    if (done) {
      source.current = ai.text;
      writing.current = false;
    }
    submit(input);
    setInput("");
  };

  const apply = (mode: "replace" | "below") => {
    if (!ai.text || editor.isDestroyed) return;
    const ok = mode === "replace" ? replaceWithMarkdown(editor, range.current, ai.text) : insertMarkdownBelow(editor, range.current, ai.text);
    if (!ok) return;
    ai.reset();
    onClose();
    editor.commands.focus();
  };

  return (
    <div
      ref={root}
      className="ai-bar"
      role="dialog"
      aria-label="KI-Bearbeitung"
      style={pos ? { top: pos.top, left: pos.left, width: pos.width } : { visibility: "hidden", width: BAR_WIDTH }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          if (ai.busy) ai.cancel();
          close();
        } else if (done && (e.ctrlKey || e.metaKey) && e.key === "Enter") {
          e.preventDefault();
          apply("replace");
        }
      }}
    >
      <div className="ai-bar-input">
        <Sparkles size={15} className="ai-bar-icon" />
        <input
          ref={inputRef}
          value={input}
          placeholder={ai.text ? "Weiter anpassen…" : writing.current ? "KI schreiben lassen, z. B. „Agenda für das Kick-off“" : "KI anweisen, z. B. „Als E-Mail an das Team“"}
          aria-label="Anweisung an die KI"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !(e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              submitInput();
            }
          }}
        />
        {ai.busy ? (
          <IconButton icon={Square} label="Stoppen" size={26} iconSize={12} onClick={() => ai.cancel()} />
        ) : (
          <IconButton icon={ArrowUp} label="Ausführen" size={26} iconSize={15} disabled={!input.trim()} onClick={submitInput} />
        )}
      </div>
      {!ai.busy && !ai.text && !ai.error && (
        <div className="ai-bar-presets" role="group" aria-label="KI-Aktionen">
          {presets.map((p) => (
            <button key={p.id} type="button" className="ai-chip" onClick={() => submit(p.id)}>
              {p.label}
            </button>
          ))}
        </div>
      )}
      {(ai.busy || ai.text || ai.error) && (
        <div className="ai-bar-preview" aria-live="polite">
          {ai.error ? (
            <div className="msg-error">
              <div>Die Anfrage ist fehlgeschlagen.</div>
              <div className="faint small mono">{ai.error}</div>
            </div>
          ) : ai.busy && !ai.text ? (
            <div className="thinking">
              <span />
              <span />
              <span />
            </div>
          ) : (
            <div className={`prose prose-chat ${ai.busy ? "streaming" : ""}`} dangerouslySetInnerHTML={{ __html: renderMarkdown(ai.text) }} />
          )}
          {ai.cancelled && <div className="faint small">Abgebrochen</div>}
        </div>
      )}
      {(done || ai.error || ai.cancelled) && (
        <div className="ai-bar-actions">
          {done && (
            <>
              <Button size="sm" variant="primary" icon={writing.current || !source.current.trim() ? CornerDownLeft : Replace} onClick={() => apply("replace")}>
                {initialEmpty ? "Einfügen" : "Ersetzen"}
              </Button>
              {!initialEmpty && (
                <Button size="sm" icon={CornerDownLeft} onClick={() => apply("below")}>
                  Darunter einfügen
                </Button>
              )}
            </>
          )}
          <Button size="sm" variant="ghost" icon={RotateCcw} disabled={!last} onClick={() => last && run(last)}>
            Erneut
          </Button>
          <span className="grow" />
          <Button size="sm" variant="ghost" icon={X} onClick={() => close()}>
            Verwerfen
          </Button>
        </div>
      )}
      <div className="ai-bar-foot faint">
        {ai.meta ? (
          <span title={ai.meta.reasons.join("\n")}>
            <span className={`tier-dot tier-${ai.meta.tier}`} /> {ai.meta.model}
            {" · "}
            {ai.meta.tokens.toLocaleString("de-DE")} Tokens{ai.meta.exact ? "" : " (geschätzt)"}
            {ai.meta.cost > 0 && ` · ${usd(ai.meta.cost)}`}
          </span>
        ) : (
          <span>{ai.busy ? "Wird erstellt…" : initialEmpty ? "Neuer Text an dieser Stelle" : "Auswahl wird mit KI bearbeitet"}</span>
        )}
        <span className="grow" />
        <span>{done ? `${keys("Mod Enter")} ${initialEmpty ? "einfügen" : "ersetzen"} · ` : ""}Esc verwerfen</span>
      </div>
    </div>
  );
}
