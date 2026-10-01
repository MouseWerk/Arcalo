// Typing aids of Settings → Editor: typographic quotes („…“ ‚…‘ –), automatic closing
// brackets, the Tab width in code blocks and line numbers in code blocks. The preferences
// are read on every keystroke, so changes apply without reopening a page.

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { currentLang } from "../lib/i18n";

export interface TypingPrefs {
  smartQuotes: boolean;
  autoPair: boolean;
  tabSize: number;
  lineNumbers: boolean;
}

export const TYPING_DEFAULTS: TypingPrefs = { smartQuotes: false, autoPair: false, tabSize: 4, lineNumbers: false };

const OPENERS = /[\s([{—–/-]$/;

/**
 * The typographic replacement for a typed `"` or `'` given the text before the caret in the
 * same block, in the display language: „…“ and ‚…‘ in German, “…” and ‘…’ in English, and ’ as
 * apostrophe inside words.
 */
export function smartQuote(ch: '"' | "'", before: string, lang: "de" | "en" = currentLang()): string {
  const atStart = before === "" || OPENERS.test(before);
  const [dOpen, dClose, sOpen, sClose] = lang === "en" ? ["“", "”", "‘", "’"] : ["„", "“", "‚", "‘"];
  if (ch === '"') return atStart ? dOpen : dClose;
  if (atStart) return sOpen;
  // A letter before: apostrophe (geht’s), unless a single quote is still open in this block.
  const open = before.lastIndexOf(sOpen);
  const close = lang === "en" ? -1 : Math.max(before.lastIndexOf(sClose), -1);
  if (/[\p{L}\p{N}]$/u.test(before) && !(open > close)) return "’";
  return sClose;
}

/** " - " typed as "space hyphen space" becomes " – " (en dash). */
export const dashBefore = (before: string) => / -$/.test(before);

const PAIRS: Record<string, string> = { "(": ")", "[": "]", "{": "}" };

function inCode(state: EditorState, pos: number): boolean {
  const $pos = state.doc.resolve(pos);
  if ($pos.parent.type.spec.code) return true;
  const code = state.schema.marks.code;
  return !!code && (!!code.isInSet(state.storedMarks ?? $pos.marks()) || !!code.isInSet($pos.marks()));
}

/** "1\n2\n3" for a code block with three lines (shown by CSS as the gutter). */
export const lineNumbers = (text: string) =>
  Array.from({ length: text.split("\n").length }, (_, i) => String(i + 1)).join("\n");

const numbersKey = new PluginKey("codeLineNumbers");

export const TypingAids = Extension.create<{ prefs: () => TypingPrefs }>({
  name: "typingAids",
  addOptions() {
    return { prefs: () => TYPING_DEFAULTS };
  },

  addKeyboardShortcuts() {
    return {
      // Tab in a code block inserts spaces (Settings → Editor → Tabulatorbreite).
      Tab: ({ editor }) => {
        if (!editor.isActive("codeBlock")) return false;
        const n = Math.min(8, Math.max(2, this.options.prefs().tabSize || 4));
        return editor.commands.insertContent(" ".repeat(n));
      },
    };
  },

  addProseMirrorPlugins() {
    const prefs = () => this.options.prefs();
    return [
      new Plugin({
        key: new PluginKey("typingAids"),
        props: {
          handleTextInput: (view, from, to, text) => {
            const p = prefs();
            if (!p.smartQuotes && !p.autoPair) return false;
            const { state } = view;
            if (inCode(state, from)) return false;
            const $from = state.doc.resolve(from);
            const before = $from.parent.textBetween(0, $from.parentOffset, undefined, "￼");
            if (p.smartQuotes && (text === '"' || text === "'")) {
              view.dispatch(state.tr.insertText(smartQuote(text, before), from, to));
              return true;
            }
            if (p.smartQuotes && text === " " && from === to && dashBefore(before)) {
              view.dispatch(state.tr.insertText("– ", from - 1, to));
              return true;
            }
            if (p.autoPair && from === to) {
              const next = $from.parent.textBetween($from.parentOffset, Math.min($from.parent.content.size, $from.parentOffset + 1), undefined, "\ufffc");
              // Typing the closing bracket that was inserted: step over it.
              if ((text === ")" || text === "]" || text === "}") && next === text) {
                view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, from + 1)));
                return true;
              }
              // "[[" starts a wiki link: replace the paired "]" of the first "[".
              if (text === "[" && before.endsWith("[")) {
                if (next !== "]") return false;
                const tr = state.tr.insertText("[", from, from + 1);
                view.dispatch(tr.setSelection(TextSelection.create(tr.doc, from + 1)));
                return true;
              }
              const close = PAIRS[text];
              if (close && (next === "" || /\s/.test(next))) {
                const tr = state.tr.insertText(text + close, from, to);
                view.dispatch(tr.setSelection(TextSelection.create(tr.doc, from + 1)));
                return true;
              }
            }
            return false;
          },
        },
      }),
      new Plugin({
        key: numbersKey,
        props: {
          decorations: (state) => {
            if (!prefs().lineNumbers) return null;
            const decos: Decoration[] = [];
            state.doc.descendants((node, pos) => {
              if (node.type.name === "codeBlock") {
                decos.push(Decoration.node(pos, pos + node.nodeSize, { "data-line-numbers": lineNumbers(node.textContent), class: "with-line-numbers" }));
                return false;
              }
              return true;
            });
            return DecorationSet.create(state.doc, decos);
          },
        },
      }),
    ];
  },
});
