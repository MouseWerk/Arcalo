// Smart paste: spreadsheet rows become a table, a Teams chat copy a list, a lone URL a link
// with the page's title, a stack trace or log a code block (classifiers in paste.ts).
// A small „Als Text einfügen“ hint undoes it into a plain paste; Ctrl+Shift+V always pastes
// plain text. Files (images, attachments) stay with `AttachmentDrop`.

import { Extension, type Editor, type JSONContent } from "@tiptap/core";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import { closeHistory } from "@tiptap/pm/history";
import { classifyPaste, type ChatMessage, type PasteKind } from "./paste";

export interface SmartPasteOptions {
  /** Title of a web page (Rust `link_title`); null or the URL itself when there is none. */
  fetchTitle: ((url: string) => Promise<string | null>) | null;
}

interface Hint {
  from: number;
  to: number;
  /** The clipboard's plain text. */
  text: string;
  /** Pasted link waiting for its title. */
  url: string | null;
  /** A pasted link (its range is replaced directly; the title is set outside the history). */
  link: boolean;
  id: number;
}

interface PasteState {
  hint: Hint | null;
  decos: DecorationSet;
}

const key = new PluginKey<PasteState>("smartPaste");
const HINT_MS = 6000;

// ---------------------------------------------------------------- content

const lineContent = (text: string): JSONContent[] =>
  text.split("\n").flatMap((line, i) => [...(i ? [{ type: "hardBreak" }] : []), ...(line ? [{ type: "text", text: line }] : [])]);

export function tableContent(rows: string[][]): JSONContent {
  return {
    type: "table",
    content: rows.map((row, r) => ({
      type: "tableRow",
      content: row.map((cell) => ({ type: r === 0 ? "tableHeader" : "tableCell", content: [{ type: "paragraph", content: lineContent(cell) }] })),
    })),
  };
}

/** `- **Name** (10:32): Nachricht` per message; further lines as line breaks. */
export function chatContent(messages: ChatMessage[]): JSONContent {
  return {
    type: "bulletList",
    content: messages.map((m) => ({
      type: "listItem",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: m.name, marks: [{ type: "bold" }] },
            { type: "text", text: `${m.time ? ` (${m.time})` : ""}: ` },
            ...lineContent(m.lines.join("\n")),
          ],
        },
      ],
    })),
  };
}

export function pasteContent(kind: PasteKind): JSONContent | JSONContent[] {
  switch (kind.kind) {
    case "table":
      return tableContent(kind.rows);
    case "chat":
      return chatContent(kind.messages);
    case "code":
      return { type: "codeBlock", attrs: { language: kind.language }, content: [{ type: "text", text: kind.code }] };
    case "url":
      return { type: "text", text: kind.url, marks: [{ type: "link", attrs: { href: kind.url } }] };
  }
}

/** Cleans a fetched title: one line, at most 200 characters. */
export function cleanTitle(title: string | null, url: string): string | null {
  const t = (title ?? "").replace(/\s+/g, " ").trim();
  if (!t || t === url) return null;
  return t.length > 200 ? `${t.slice(0, 199)}…` : t;
}

// ------------------------------------------------------------- chat times

// `**Name** (10:32):` at the start of a list item: the time is shown small and muted.
const CHAT_TIME = /^ \(\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AaPp]\.?[Mm]\.?)?\)(?=:)/;

function chatTimes(doc: PMNode): DecorationSet {
  const decos: Decoration[] = [];
  doc.descendants((node, pos, parent) => {
    if (node.type.name !== "paragraph") return !node.isTextblock;
    if (parent?.type.name !== "listItem" || node.childCount < 2) return false;
    const [a, b] = [node.child(0), node.child(1)];
    if (!a.isText || !a.marks.some((m) => m.type.name === "bold") || !b.isText || b.marks.length) return false;
    const m = CHAT_TIME.exec(b.text ?? "");
    if (m) {
      const from = pos + 1 + a.nodeSize + 1;
      decos.push(Decoration.inline(from, from + m[0].length - 1, { class: "chat-time" }));
    }
    return false;
  });
  return DecorationSet.create(doc, decos);
}

// ------------------------------------------------------------------ plugin

let forcePlain = false;

/** Pastes `text` as plain text, bypassing the smart paste. */
function pastePlain(view: EditorView, text: string) {
  forcePlain = true;
  try {
    view.pasteText(text);
  } finally {
    forcePlain = false;
  }
}

function insert(editor: Editor, view: EditorView, kind: PasteKind, text: string, seq: number): Hint | null {
  const { from, to } = view.state.selection;
  const size = view.state.doc.content.size;
  // A history step of its own: „Als Text einfügen“ undoes exactly the paste, not the typing before it.
  const ok = editor
    .chain()
    .command(({ tr }) => (closeHistory(tr), true))
    .insertContent(pasteContent(kind), { updateSelection: true })
    .scrollIntoView()
    .run();
  if (!ok) return null;
  const end = from + (view.state.doc.content.size - size) + (to - from);
  return { from, to: Math.min(end, view.state.doc.content.size), text, url: kind.kind === "url" ? kind.url : null, link: kind.kind === "url", id: seq };
}

export const SmartPaste = Extension.create<SmartPasteOptions>({
  name: "smartPaste",
  addOptions() {
    return { fetchTitle: null };
  },
  addProseMirrorPlugins() {
    const editor = this.editor;
    const { fetchTitle } = this.options;
    let seq = 0;
    const setHint = (view: EditorView, hint: Hint | null) => view.dispatch(view.state.tr.setMeta(key, { hint }).setMeta("addToHistory", false));

    const loadTitle = (view: EditorView, hint: Hint) => {
      if (!fetchTitle || !hint.url) return;
      const url = hint.url;
      fetchTitle(url)
        .then((raw) => {
          const title = cleanTitle(raw, url);
          if (!title || view.isDestroyed) return;
          const cur = key.getState(view.state)?.hint;
          // Only while the pasted link is untouched.
          if (!cur || cur.id !== hint.id) return;
          if (view.state.doc.textBetween(cur.from, cur.to, "") !== url) return;
          const link = view.state.schema.marks.link.create({ href: url });
          const tr = view.state.tr.replaceWith(cur.from, cur.to, view.state.schema.text(title, [link]));
          tr.setMeta(key, { hint: { ...cur, to: cur.from + title.length, url: null } }).setMeta("addToHistory", false);
          view.dispatch(tr);
        })
        .catch(() => {});
    };

    return [
      new Plugin<PasteState>({
        key,
        state: {
          init: (_, { doc }): PasteState => ({ hint: null, decos: chatTimes(doc) }),
          apply(tr, old, _prev, next: EditorState): PasteState {
            const meta = tr.getMeta(key) as { hint: Hint | null } | undefined;
            const decos = tr.docChanged ? chatTimes(tr.doc) : old.decos;
            if (meta) return { hint: meta.hint, decos };
            if (!old.hint) return { hint: null, decos };
            // Any other edit ends the offer.
            if (tr.docChanged) return { hint: null, decos };
            const h = old.hint;
            return { hint: h.to <= next.doc.content.size ? h : null, decos };
          },
        },
        props: {
          decorations(state) {
            return key.getState(state)?.decos;
          },
          handlePaste(view, event) {
            if (forcePlain) return false;
            const input = (view as unknown as { input?: { shiftKey?: boolean; lastKeyCode?: number } }).input;
            // Ctrl+Shift+V (not Shift+Insert): ProseMirror pastes plain text.
            if (input?.shiftKey && input.lastKeyCode !== 45) return false;
            const data = event.clipboardData;
            if (!data || data.files?.length) return false;
            if (view.state.selection.$from.parent.type.spec.code) return false;
            const text = data.getData("text/plain");
            const kind = classifyPaste(text, data.getData("text/html"));
            if (!kind) return false;
            // A URL onto a selection: the link extension turns the selection into a link.
            if (kind.kind === "url" && !view.state.selection.empty) return false;
            // Block content inside a table cell or a heading stays a normal paste.
            if (kind.kind !== "url" && (editor.isActive("table") || view.state.selection.$from.parent.type.name === "heading")) return false;
            event.preventDefault();
            const hint = insert(editor, view, kind, text, ++seq);
            if (!hint) return false;
            setHint(view, hint);
            loadTitle(view, hint);
            return true;
          },
        },
        view(view) {
          let el: HTMLButtonElement | null = null;
          let shownId = -1;
          let timer: number | undefined;
          const remove = () => {
            window.clearTimeout(timer);
            el?.remove();
            el = null;
            shownId = -1;
          };
          const place = (hint: Hint) => {
            if (!el) return;
            try {
              const c = view.coordsAtPos(Math.min(hint.to, view.state.doc.content.size));
              el.style.left = `${Math.max(8, Math.min(c.left, window.innerWidth - el.offsetWidth - 8))}px`;
              el.style.top = `${Math.min(c.bottom + 6, window.innerHeight - el.offsetHeight - 8)}px`;
            } catch {
              remove();
            }
          };
          const show = (hint: Hint) => {
            remove();
            el = document.createElement("button");
            el.type = "button";
            el.className = "paste-hint";
            el.innerHTML =
              '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 12v-1h6v1"/><path d="M11 17h2"/><path d="M12 11v6"/><rect width="8" height="4" x="8" y="2" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/></svg>';
            el.append("Als Text einfügen");
            el.addEventListener("mousedown", (e) => {
              e.preventDefault();
              const cur = key.getState(view.state)?.hint;
              remove();
              if (!cur) return;
              setHint(view, null);
              if (cur.link) {
                // The link (maybe already titled) becomes the plain URL.
                view.dispatch(view.state.tr.replaceWith(cur.from, cur.to, view.state.schema.text(cur.text.trim())));
              } else {
                // Undo the smart paste, then paste the same text plain.
                if (editor.can().undo()) editor.commands.undo();
                else view.dispatch(view.state.tr.delete(cur.from, cur.to));
                pastePlain(view, cur.text);
              }
              view.focus();
            });
            document.body.append(el);
            shownId = hint.id;
            place(hint);
            timer = window.setTimeout(() => {
              if (key.getState(view.state)?.hint?.id === hint.id) setHint(view, null);
            }, HINT_MS);
          };
          const onScroll = () => {
            const hint = key.getState(view.state)?.hint;
            if (el && hint) place(hint);
          };
          window.addEventListener("scroll", onScroll, true);
          return {
            update(v) {
              const hint = key.getState(v.state)?.hint ?? null;
              if (!hint) return remove();
              if (hint.id !== shownId) show(hint);
              else place(hint);
            },
            destroy() {
              remove();
              window.removeEventListener("scroll", onScroll, true);
            },
          };
        },
      }),
    ];
  },
});
