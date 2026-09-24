// The Markdown note editor (TipTap, live preview, autosave).

import { useEffect, useRef, useState } from "react";
import { EditorContent, useEditor, useEditorState, type Editor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Bold, Code, Highlighter, Italic, Link2, Sparkles, Strikethrough, SquareArrowOutUpRight } from "lucide-react";
import { api, attachmentUrl, errorText, uploadAttachment } from "../lib/api";
import { insertTemplate } from "../components/Templates";
import { insertDrawing, openDrawing } from "./drawings";
import { useApp } from "../store/app";
import { hoursFromMinutes } from "../lib/format";
import { pageSuggestItem, splitFrontmatter, type LinkSuggestItem } from "./extensions";
import { buildExtensions, toMarkdown } from "./schema";
import { zeitLaItems, zeitRefItems } from "./zeit-source";
import { IconButton } from "../components/ui";
import { findKey } from "./find";
import { TableToolbar } from "./TableToolbar";
import { InlineAiBar } from "./InlineAiBar";
import { aiRange, type AiRange } from "./ai-insert";
import { registerEditor } from "./reveal";
import type { TypingPrefs } from "./typing";
import { spellcheckAttrs } from "../lib/prefs";
import { ZeitConfirm, type ZeitChoice } from "./ZeitConfirm";
import { lacksReference, referenceOffset } from "./zeit-suggest";
import type { ZeitGuess } from "../lib/types";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import type { PageDoc } from "../lib/types";
import { keys } from "../lib/shortcut";

/** Where a `/zeit` line is in the document: position of its paragraph, or -1. */
function findLine(editor: Editor, line: string): number {
  let at = -1;
  editor.state.doc.descendants((node, pos) => {
    if (at >= 0) return false;
    if (node.type.name === "paragraph" && node.textContent.trim() === line.trim()) {
      at = pos;
      return false;
    }
    return true;
  });
  return at;
}

/** „Anderen wählen“: puts the caret where the reference goes, which opens the /zeit autocomplete. */
function chooseOtherRef(editor: Editor, line: string) {
  const at = findLine(editor, line);
  if (at < 0 || editor.isDestroyed) return;
  const node = editor.state.doc.nodeAt(at)!;
  const off = referenceOffset(node.textContent);
  if (off < 0) return;
  const pos = at + 1 + off;
  editor.chain().focus().insertContentAt(pos, " ").setTextSelection(pos).run();
}

const NO_REF_HINT = "Schreibe die Referenz dazu, z. B. /zeit NP-8801/1020 2h Beschreibung.";

/** Autosave delay after the last change (Settings → Editor, 250–3000 ms). */
const saveDelay = () => Math.min(3000, Math.max(250, useApp.getState().settings?.settings.editor?.autosave_ms ?? 450));
const editorPrefs = () => useApp.getState().settings?.settings.editor;
const typingPrefs = (): TypingPrefs => {
  const e = editorPrefs();
  return { smartQuotes: !!e?.smart_quotes, autoPair: !!e?.auto_pair, tabSize: e?.tab_size ?? 4, lineNumbers: !!e?.code_line_numbers };
};

export interface NoteEditorHandle {
  editor: Editor | null;
  flush: () => Promise<void>;
  /** Replaces the page's frontmatter (property editor); saved like any other edit. */
  setFrontmatter: (fm: string) => void;
}

/** Asks the page view of `pageId` for „Besprechung zusammenfassen“ (slash command). */
export const MEETING_SUMMARY_EVENT = "annalo:meeting-summary";

// Flush handles of all mounted editors (rename, window close).
const flushers = new Set<() => Promise<void>>();

/** Saves pending edits of every open editor; rejects if one of them could not be saved. */
export async function flushAllEditors() {
  await Promise.all([...flushers].map((f) => f()));
}

/** Editors showing one of `ids` (all when omitted) refetch their page, unless they hold unsaved edits. */
export function reloadEditors(ids?: number[]) {
  window.dispatchEvent(new CustomEvent("annalo:reload-pages", { detail: { ids } }));
}

export function NoteEditor({
  doc,
  onSaved,
  onOpenLink,
  onOpenTag,
  handleRef,
  onFrontmatter,
  active = true,
}: {
  active?: boolean;
  doc: PageDoc;
  onSaved: (doc: PageDoc) => void;
  onOpenLink: (target: string, newTab: boolean) => void;
  onOpenTag: (tag: string) => void;
  /** The frontmatter changed from outside (another pane, a reload). */
  onFrontmatter?: (fm: string) => void;
  handleRef?: (h: NoteEditorHandle) => void;
}) {
  const frontmatter = useRef(splitFrontmatter(doc.content).frontmatter);
  const saveTimer = useRef<number | undefined>(undefined);
  const dirty = useRef(false);
  const saving = useRef<Promise<void> | null>(null);
  const editorRef = useRef<Editor | null>(null);
  const [status, setStatus] = useState<"saved" | "dirty" | "saving">("saved");
  const [linkDraft, setLinkDraft] = useState<string | null>(null);
  const cb = useRef({ onSaved, onOpenLink, onOpenTag, onFrontmatter });
  cb.current = { onSaved, onOpenLink, onOpenTag, onFrontmatter };
  const activeRef = useRef(active);
  activeRef.current = active;
  const instance = useRef(Math.random().toString(36).slice(2));
  // Inline AI bar: the range it works on (null = closed); `seq` remounts it per opening.
  const [ai, setAi] = useState<{ range: AiRange; seq: number } | null>(null);
  const aiOpen = useRef(false);
  aiOpen.current = ai !== null;
  // Smart /zeit: the pending confirmation of an AI-suggested reference.
  const [zeitAsk, setZeitAsk] = useState<{ id: number; pos: number; guess: ZeitGuess | null; resolve: (c: ZeitChoice) => void } | null>(null);
  const zeitSeq = useRef(0);
  const [zeitPos, setZeitPos] = useState<{ top: number; left: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const openAi = (editor: Editor) => {
    const range = aiRange(editor);
    if (range) setAi((cur) => ({ range, seq: (cur?.seq ?? 0) + 1 }));
  };

  // Another pane saved this page while we had edits: reload once ours are stored.
  const foreignPending = useRef(false);
  const busy = () => dirty.current || saving.current !== null;

  const apply = (editor: Editor, content: string) => {
    const { frontmatter: fm, body } = splitFrontmatter(content);
    if (fm !== frontmatter.current) {
      frontmatter.current = fm;
      cb.current.onFrontmatter?.(fm);
    }
    if (toMarkdown(editor) === body) return;
    const { from, to } = editor.state.selection;
    editor.commands.setContent(body, { contentType: "markdown", emitUpdate: false });
    const max = editor.state.doc.content.size;
    editor.commands.setTextSelection({ from: Math.min(from, max), to: Math.min(to, max) });
    if (activeRef.current) publishOutline(editor);
  };

  const reload = async (editor: Editor) => {
    if (busy()) return void (foreignPending.current = true);
    foreignPending.current = false;
    try {
      const fresh = await api.page(doc.id);
      if (editor.isDestroyed) return;
      if (busy()) return void (foreignPending.current = true);
      apply(editor, fresh.content);
    } catch {
      /* page gone: the view shows that */
    }
  };

  const save = async (editor: Editor) => {
    if (!dirty.current) return;
    dirty.current = false;
    setStatus("saving");
    const md = frontmatter.current + toMarkdown(editor);
    // Saves run one after another so an older one never lands last.
    const p: Promise<void> = (saving.current ?? Promise.resolve())
      .then(() => api.savePage(doc.id, md))
      .then((saved) => {
        cb.current.onSaved(saved);
        // Other panes showing the same page pick up the new content.
        window.dispatchEvent(new CustomEvent("annalo:page-saved", { detail: { id: doc.id, content: md, from: instance.current } }));
        setStatus(dirty.current ? "dirty" : "saved");
      })
      .catch((e) => {
        dirty.current = true;
        setStatus("dirty");
        useApp.getState().error("Speichern fehlgeschlagen", e);
        // Try again later; the edits stay in the editor meanwhile.
        window.clearTimeout(saveTimer.current);
        saveTimer.current = window.setTimeout(() => save(editor), 5000);
      })
      .finally(() => {
        if (saving.current !== p) return;
        saving.current = null;
        if (foreignPending.current && !dirty.current && !editor.isDestroyed) reload(editor);
      });
    saving.current = p;
    await p;
  };

  const editor = useEditor(
    {
      extensions: buildExtensions({
        onOpenLink: (t, newTab) => cb.current.onOpenLink(t, newTab),
        onOpenTag: (t) => cb.current.onOpenTag(t),
        isKnown: (t) => {
          const lower = t.toLowerCase();
          for (const p of useApp.getState().pages.values()) if (p.title.toLowerCase() === lower) return true;
          return false;
        },
        searchPages: async (q) => {
          const pages = [...useApp.getState().pages.values()];
          const lower = q.toLowerCase().trim();
          const matches = pages
            .filter((p) => p.id !== doc.id && (!lower || p.title.toLowerCase().includes(lower)))
            .sort((a, b) => {
              const as = a.title.toLowerCase().startsWith(lower) ? 0 : 1;
              const bs = b.title.toLowerCase().startsWith(lower) ? 0 : 1;
              return as - bs || b.updated_at.localeCompare(a.updated_at);
            })
            .slice(0, 8)
            .map((p) => pageSuggestItem(p, p.parent_id ? useApp.getState().pages.get(p.parent_id)?.title : undefined));
          const items: LinkSuggestItem[] = matches;
          if (lower && !pages.some((p) => p.title.toLowerCase() === lower)) {
            items.push({ id: "create", title: `„${q.trim()}“ neu verlinken`, subtitle: "Seite wird beim Öffnen angelegt", target: q.trim(), create: true });
          }
          return items;
        },
        book: async (line) => {
          try {
            // The server books on the page's saved `vorgang:`: store pending edits (e.g. a
            // just-changed property) first so the default reference is not a stale one.
            const ed = editorRef.current;
            if (ed) {
              window.clearTimeout(saveTimer.current);
              await save(ed);
              await saving.current;
            }
            // Smart /zeit: `/zeit 2h text` without reference on a page without linked Vorgang.
            let aiError: unknown = null;
            if (ed && lacksReference(line)) {
              const id = ++zeitSeq.current;
              let settle!: (c: ZeitChoice) => void;
              const choice = new Promise<ZeitChoice>((r) => (settle = r));
              let settled = false;
              const resolve = (c: ZeitChoice) => {
                if (settled) return;
                settled = true;
                setZeitAsk((cur) => (cur?.id === id ? null : cur));
                settle(c);
              };
              setZeitAsk({ id, pos: Math.max(0, findLine(ed, line)), guess: null, resolve });
              let guess: ZeitGuess | null = null;
              try {
                guess = await api.zeitSuggestAi(line, doc.id);
              } catch (e) {
                aiError = e;
              }
              if (settled) return null; // cancelled while the AI was thinking
              if (!guess) resolve("cancel");
              else {
                setZeitAsk((cur) => (cur?.id === id ? { ...cur, guess } : cur));
                const c = await choice;
                if (c === "other") {
                  window.setTimeout(() => chooseOtherRef(ed, line), 0);
                  return null;
                }
                if (c !== "book") return null;
                line = guess.line;
              }
            }
            let out;
            try {
              out = await api.logTime(line, doc.id);
            } catch (e) {
              if (aiError === null) throw e;
              useApp.getState().toast({ tone: "danger", title: "Buchung fehlgeschlagen", detail: `${errorText(e)}. ${NO_REF_HINT} (KI-Vorschlag nicht möglich: ${errorText(aiError)})` });
              return null;
            }
            const s = useApp.getState();
            s.bumpEntries();
            s.alerts(out.alerts);
            const target = out.reference || (line.trim().split(/\s+/)[1] ?? "");
            s.toast({ tone: "success", title: `${hoursFromMinutes(out.entry.duration_minutes)} h gebucht`, detail: `${target}${out.entry.description ? " · " + out.entry.description : ""}` });
            return { entryId: out.entry.id, hours: hoursFromMinutes(out.entry.duration_minutes), target, text: out.entry.description };
          } catch (e) {
            useApp.getState().error("Buchung fehlgeschlagen", e);
            return null;
          }
        },
        zeitRefs: zeitRefItems,
        zeitLeistungsarten: zeitLaItems,
        attachmentUrl,
        uploadImage: async (file) => {
          try {
            return (await uploadAttachment(file)).name;
          } catch (e) {
            useApp.getState().error("Bild nicht gespeichert", e);
            return null;
          }
        },
        onPickImage: (editor) => {
          const input = document.createElement("input");
          input.type = "file";
          input.accept = "image/png,image/jpeg,image/gif,image/webp,image/svg+xml";
          input.multiple = true;
          input.onchange = async () => {
            for (const file of input.files ?? []) {
              try {
                const saved = await uploadAttachment(file);
                if (!editor.isDestroyed) editor.chain().focus().insertContent({ type: "imageEmbed", attrs: { name: saved.name } }).run();
              } catch (e) {
                useApp.getState().error("Bild nicht gespeichert", e);
              }
            }
          };
          input.click();
        },
        onPickTemplate: (editor) => insertTemplate(editor, useApp.getState().pages.get(doc.id)?.title ?? doc.title),
        onInsertDrawing: insertDrawing,
        onOpenDrawing: openDrawing,
        onAi: (editor) => openAi(editor),
        onSummary: () => window.dispatchEvent(new CustomEvent(MEETING_SUMMARY_EVENT, { detail: { id: doc.id } })),
        typing: typingPrefs,
        onZeitLost: (res) =>
          useApp.getState().toast({ tone: "warning", title: "Gebucht, aber Zeile nicht mehr gefunden", detail: `${res.hours} h · ${res.target} – kein Chip eingefügt` }),
      }),
      content: splitFrontmatter(doc.content).body,
      contentType: "markdown",
      editorProps: {
        // Settings → Editor: spell check language (re-read on every update).
        attributes: () => ({ class: "prose", ...spellcheckAttrs(editorPrefs()?.spellcheck), "aria-label": "Notiz", style: `tab-size: ${editorPrefs()?.tab_size ?? 4}` }),
        // Ctrl+J on a selection: inline AI instead of the assistant panel (App's global Ctrl+J).
        handleKeyDown: (view, event) => {
          if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey || event.key.toLowerCase() !== "j") return false;
          if (view.state.selection.empty || !editorRef.current) return false;
          event.preventDefault();
          event.stopPropagation();
          openAi(editorRef.current);
          return true;
        },
        handleClickOn: (_view, _pos, _node, _nodePos, event) => {
          const a = (event.target as HTMLElement).closest<HTMLAnchorElement>("a[href]");
          if (a && !a.dataset.wikilink && (event.ctrlKey || event.metaKey)) {
            openUrl(a.href).catch(() => {});
            return true;
          }
          return false;
        },
      },
      onUpdate: ({ editor }) => {
        dirty.current = true;
        setStatus("dirty");
        window.clearTimeout(saveTimer.current);
        saveTimer.current = window.setTimeout(() => save(editor), saveDelay());
        if (activeRef.current) publishOutline(editor);
      },
      onCreate: ({ editor }) => activeRef.current && publishOutline(editor),
      // Other panes with this page store their edits first, so we continue from them.
      onFocus: () => window.dispatchEvent(new CustomEvent("annalo:flush-page", { detail: { id: doc.id, from: instance.current } })),
    },
    [doc.id],
  );

  useEffect(() => {
    editorRef.current = editor;
    if (!editor) return;
    const flushNow = async () => {
      window.clearTimeout(saveTimer.current);
      await save(editor);
      await saving.current;
      if (dirty.current) throw new Error("Änderungen konnten nicht gespeichert werden");
    };
    const setFrontmatter = (fm: string) => {
      if (fm === frontmatter.current) return;
      // Like focusing the editor: other panes with this page store their edits first.
      window.dispatchEvent(new CustomEvent("annalo:flush-page", { detail: { id: doc.id, from: instance.current } }));
      frontmatter.current = fm;
      dirty.current = true;
      setStatus("dirty");
      window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => save(editor), saveDelay());
    };
    handleRef?.({ editor, flush: flushNow, setFrontmatter });
    flushers.add(flushNow);
    const unregister = registerEditor(doc.id, editor);
    const flush = () => {
      window.clearTimeout(saveTimer.current);
      save(editor);
    };
    window.addEventListener("blur", flush);
    return () => {
      unregister();
      flushers.delete(flushNow);
      window.removeEventListener("blur", flush);
      flush();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  // The focused pane owns the outline panel.
  useEffect(() => {
    if (!editor || !active) return;
    publishOutline(editor);
    useApp.getState().set({
      scrollToPos: (pos) => {
        editor.chain().focus().setTextSelection(pos + 1).run();
        const dom = editor.view.domAtPos(pos + 1).node as HTMLElement;
        (dom.nodeType === 1 ? dom : dom.parentElement)?.scrollIntoView({ behavior: "smooth", block: "center" });
      },
    });
  }, [editor, active]);

  // Same page open in another pane: take over its saved content unless we have unsaved
  // (or in-flight) edits; then reload after our own save. Renames reload all pages.
  useEffect(() => {
    if (!editor) return;
    const onSaved = (e: Event) => {
      const d = (e as CustomEvent<{ id: number; content: string; from: string }>).detail;
      if (d.id !== doc.id || d.from === instance.current) return;
      if (busy()) foreignPending.current = true;
      else apply(editor, d.content);
    };
    const onReload = (e: Event) => {
      const ids = (e as CustomEvent<{ ids?: number[] }>).detail?.ids;
      if (!ids || ids.includes(doc.id)) reload(editor);
    };
    const onFlushPage = (e: Event) => {
      const d = (e as CustomEvent<{ id: number; from: string }>).detail;
      if (d.id !== doc.id || d.from === instance.current) return;
      window.clearTimeout(saveTimer.current);
      save(editor);
    };
    window.addEventListener("annalo:page-saved", onSaved);
    window.addEventListener("annalo:reload-pages", onReload);
    window.addEventListener("annalo:flush-page", onFlushPage);
    return () => {
      window.removeEventListener("annalo:page-saved", onSaved);
      window.removeEventListener("annalo:reload-pages", onReload);
      window.removeEventListener("annalo:flush-page", onFlushPage);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, doc.id]);

  // The smart /zeit confirmation sits below its line.
  useEffect(() => {
    if (!editor || !zeitAsk) return setZeitPos(null);
    const wrap = wrapRef.current;
    if (!wrap) return;
    try {
      const box = wrap.getBoundingClientRect();
      const c = editor.view.coordsAtPos(Math.min(zeitAsk.pos + 1, editor.state.doc.content.size));
      setZeitPos({ top: c.bottom - box.top + 6, left: Math.max(0, Math.min(c.left - box.left, box.width - 420)) });
    } catch {
      setZeitPos({ top: 0, left: 0 });
    }
  }, [editor, zeitAsk]);
  // Leaving the page cancels an open confirmation.
  const zeitAskRef = useRef(zeitAsk);
  zeitAskRef.current = zeitAsk;
  useEffect(() => () => zeitAskRef.current?.resolve("cancel"), []);

  // Ctrl+F: find in this page.
  const [find, setFind] = useState<string | null>(null);
  const findInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "f" && activeRef.current) {
        e.preventDefault();
        const sel = editor?.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to, " ").trim();
        setFind((f) => (sel && sel.length < 60 ? sel : (f ?? "")));
        setTimeout(() => findInput.current?.select(), 10);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editor]);
  useEffect(() => {
    if (!editor) return;
    editor.commands.setFindQuery(find ?? "");
  }, [find, editor]);
  const ui = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      if (!e) return null;
      const f = findKey.getState(e.state);
      return {
        bold: e.isActive("bold"),
        italic: e.isActive("italic"),
        strike: e.isActive("strike"),
        code: e.isActive("code"),
        highlight: e.isActive("highlight"),
        link: e.isActive("link"),
        findIndex: f?.index ?? 0,
        findCount: f?.matches.length ?? 0,
      };
    },
  });
  const closeFind = () => {
    setFind(null);
    editor?.commands.focus();
  };

  return (
    <div className="editor-wrap" data-save-status={status} ref={wrapRef}>
      {zeitAsk && zeitPos && <ZeitConfirm guess={zeitAsk.guess} onChoice={zeitAsk.resolve} style={{ top: zeitPos.top, left: zeitPos.left }} />}
      {find !== null && (
        <div className="find-anchor">
          <div className="find-bar" role="search">
          <Search size={14} className="faint" />
          <input
            ref={findInput}
            value={find}
            placeholder="In Seite suchen"
            aria-label="In Seite suchen"
            onChange={(e) => setFind(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                editor?.commands.findStep(e.shiftKey ? -1 : 1);
              } else if (e.key === "Escape") {
                e.preventDefault();
                closeFind();
              }
            }}
          />
          <span className="find-count num">{find ? (ui?.findCount ? `${ui.findIndex + 1}/${ui.findCount}` : "0") : ""}</span>
          <IconButton icon={ChevronUp} label="Vorheriger Treffer" size={24} iconSize={14} onClick={() => editor?.commands.findStep(-1)} />
          <IconButton icon={ChevronDown} label="Nächster Treffer" size={24} iconSize={14} onClick={() => editor?.commands.findStep(1)} />
          <IconButton icon={X} label="Schließen" size={24} iconSize={14} onClick={closeFind} />
        </div>
        </div>
      )}
      {editor && (
        <BubbleMenu editor={editor} className="bubble" shouldShow={({ editor: e, state }) => find === null && !aiOpen.current && !state.selection.empty && !e.isActive("codeBlock") && !e.isActive("wikiLink") && !e.isActive("timeEntry") && !e.isActive("imageEmbed") && !e.isActive("image")}>
          <IconButton icon={Bold} label={`Fett (${keys("Mod B")})`} active={ui?.bold} onClick={() => editor.chain().focus().toggleBold().run()} tooltipSide="top" />
          <IconButton icon={Italic} label={`Kursiv (${keys("Mod I")})`} active={ui?.italic} onClick={() => editor.chain().focus().toggleItalic().run()} tooltipSide="top" />
          <IconButton icon={Strikethrough} label="Durchgestrichen" active={ui?.strike} onClick={() => editor.chain().focus().toggleStrike().run()} tooltipSide="top" />
          <IconButton icon={Code} label="Code" active={ui?.code} onClick={() => editor.chain().focus().toggleCode().run()} tooltipSide="top" />
          <IconButton icon={Highlighter} label="Hervorheben" active={ui?.highlight} onClick={() => editor.chain().focus().toggleHighlight().run()} tooltipSide="top" />
          <span className="bubble-sep" />
          <button type="button" className="bubble-ai" aria-label={`Mit KI bearbeiten (${keys("Mod J")})`} data-tooltip={`Mit KI bearbeiten (${keys("Mod J")})`} data-tooltip-side="top" onClick={() => openAi(editor)}>
            <Sparkles size={14} strokeWidth={1.75} aria-hidden />
            KI
          </button>
          <span className="bubble-sep" />
          <IconButton
            icon={Link2}
            label="Als Seitenlink [[ ]]"
            onClick={() => {
              const { from, to } = editor.state.selection;
              const text = editor.state.doc.textBetween(from, to, " ").trim();
              if (!text) return;
              editor.chain().focus().insertContentAt({ from, to }, { type: "wikiLink", attrs: { target: text } }).run();
            }}
            tooltipSide="top"
          />
          {linkDraft === null ? (
            <IconButton
              icon={SquareArrowOutUpRight}
              label={ui?.link ? "Weblink entfernen" : "Weblink"}
              active={ui?.link}
              onClick={() => (editor.isActive("link") ? editor.chain().focus().unsetLink().run() : setLinkDraft("https://"))}
              tooltipSide="top"
            />
          ) : (
            <input
              className="bubble-input"
              autoFocus
              value={linkDraft}
              aria-label="URL"
              onChange={(e) => setLinkDraft(e.target.value)}
              onBlur={() => setLinkDraft(null)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (/^(https?:\/\/|mailto:)\S+/.test(linkDraft)) editor.chain().focus().setLink({ href: linkDraft }).run();
                  setLinkDraft(null);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setLinkDraft(null);
                  editor.commands.focus();
                }
              }}
            />
          )}
        </BubbleMenu>
      )}
      {editor && <TableToolbar editor={editor} hidden={find !== null} />}
      {editor && ai && (
        <InlineAiBar
          key={ai.seq}
          editor={editor}
          range={ai.range}
          pageId={doc.id}
          beforeRun={async () => {
            window.clearTimeout(saveTimer.current);
            await save(editor);
            await saving.current;
          }}
          onClose={() => setAi(null)}
        />
      )}
      <EditorContent editor={editor} />
    </div>
  );
}

function publishOutline(editor: Editor) {
  const outline: { level: number; text: string; pos: number }[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === "heading") outline.push({ level: node.attrs.level, text: node.textContent, pos });
    return node.type.name !== "heading";
  });
  const text = editor.state.doc.textBetween(0, editor.state.doc.content.size, " ", " ");
  const words = text.split(/\s+/).filter(Boolean).length;
  useApp.getState().set({ outline, editorStats: { words, chars: text.replace(/\s/g, "").length } });
}
