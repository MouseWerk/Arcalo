// Inline hints for unlinked mentions (Settings → Editor → „Hinweise im Text“, off by default):
// a dotted underline under page titles the text names without a link; a click turns the
// mention into `[[Title]]` (`[[Title|text]]` for another case or inflection), undoable.
//
// The editor never scans on a keystroke: which texts are mentions comes from the core
// (`mentions_get`, after a save), and the plugin only places decorations on those texts.
// Between two saves the decorations move with the edits.

import { useEffect } from "react";
import type { Editor } from "@tiptap/core";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import { api } from "../lib/api";
import { findTerms, linkFor } from "../lib/linking";
import { t } from "../lib/i18n";
import { editorForPage } from "./reveal";

export type HintTerm = { text: string; title: string };
type HintState = { terms: HintTerm[]; deco: DecorationSet };

export const mentionHintsKey = new PluginKey<HintState>("mentionHints");

/** Inline text runs of a text block that may hold a mention (no code, no links). */
function runs(block: PMNode, start: number): { text: string; at: number }[] {
  const out: { text: string; at: number }[] = [];
  let cur: { text: string; at: number } | null = null;
  block.forEach((child, offset) => {
    const plain = child.isText && !child.marks.some((m) => m.type.name === "code" || m.type.name === "link");
    if (!plain) {
      cur = null;
      return;
    }
    if (!cur) out.push((cur = { text: "", at: start + offset }));
    cur.text += child.text ?? "";
  });
  return out;
}

function decorate(doc: PMNode, terms: HintTerm[]): DecorationSet {
  if (!terms.length) return DecorationSet.empty;
  const decos: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === "codeBlock") return false;
    if (!node.isTextblock) return true;
    for (const run of runs(node, pos + 1)) {
      for (const hit of findTerms(run.text, terms)) {
        decos.push(
          Decoration.inline(
            run.at + hit.from,
            run.at + hit.to,
            { class: "mention-hint", title: t("lm.hint", { title: hit.title }), "data-mention": hit.title },
            { title: hit.title, text: hit.text },
          ),
        );
      }
    }
    return false;
  });
  return DecorationSet.create(doc, decos);
}

/** Replaces the hinted mention at `pos` with a wiki link (one undoable step). */
function linkAt(view: EditorView, pos: number): boolean {
  const st = mentionHintsKey.getState(view.state);
  const deco = st?.deco.find(pos, pos)[0];
  if (!deco) return false;
  const { title, text } = deco.spec as HintTerm;
  const wiki = view.state.schema.nodes.wikiLink;
  if (!wiki || view.state.doc.textBetween(deco.from, deco.to) !== text) return false;
  const link = linkFor(title, text);
  view.dispatch(view.state.tr.replaceWith(deco.from, deco.to, wiki.create({ target: link.target, alias: link.alias })));
  return true;
}

export function mentionHintsPlugin(): Plugin<HintState> {
  return new Plugin<HintState>({
    key: mentionHintsKey,
    state: {
      init: () => ({ terms: [], deco: DecorationSet.empty }),
      apply(tr, value, _old, state: EditorState) {
        const terms = tr.getMeta(mentionHintsKey) as HintTerm[] | undefined;
        if (terms) return { terms, deco: decorate(state.doc, terms) };
        return tr.docChanged ? { terms: value.terms, deco: value.deco.map(tr.mapping, tr.doc) } : value;
      },
    },
    props: {
      decorations: (state) => mentionHintsKey.getState(state)?.deco,
      handleClick: (view, pos, event) => {
        if (!(event.target instanceof HTMLElement) || !event.target.closest(".mention-hint")) return false;
        return linkAt(view, pos);
      },
    },
  });
}

function setTerms(editor: Editor, terms: HintTerm[] | null) {
  if (editor.isDestroyed) return;
  const has = !!mentionHintsKey.getState(editor.state);
  if (terms == null) {
    if (has) editor.unregisterPlugin(mentionHintsKey);
    return;
  }
  if (!has) editor.registerPlugin(mentionHintsPlugin());
  editor.view.dispatch(editor.state.tr.setMeta(mentionHintsKey, terms).setMeta("addToHistory", false));
}

/**
 * Keeps the hints of a page's editor current: after loading and after each save
 * (`savedAt`), with a short pause so a burst of saves asks once.
 */
export function useMentionHints(pageId: number | undefined, savedAt: string | undefined, enabled: boolean) {
  useEffect(() => {
    if (pageId == null) return;
    let alive = true;
    const timer = window.setTimeout(() => {
      const editor = editorForPage(pageId);
      if (!editor) return;
      if (!enabled) return setTerms(editor, null);
      api
        .mentions(pageId)
        .then((r) => {
          if (!alive) return;
          const terms = r.outgoing.flatMap((g) => g.mentions.map((m) => ({ text: m.text, title: g.title })));
          const ed = editorForPage(pageId);
          if (ed) setTerms(ed, terms);
        })
        .catch(() => {});
    }, 500);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [pageId, savedAt, enabled]);
}
