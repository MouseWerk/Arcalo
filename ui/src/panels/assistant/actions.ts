// What an answer can be turned into: the clipboard, the open page, a new page.

import { api } from "../../lib/api";
import { t } from "../../lib/i18n";
import { aiRange, appendMarkdown, insertMarkdownBelow } from "../../editor/ai-insert";
import { editorForPage } from "../../editor/reveal";
import { flushAllEditors, reloadEditors } from "../../editor/NoteEditor";
import { useApp } from "../../store/app";
import { currentPage, privateTag, useChat } from "../../store/chat";

export function copyText(text: string, done?: () => void) {
  const s = useApp.getState();
  navigator.clipboard.writeText(text).then(
    () => (done ? done() : s.toast({ tone: "success", title: t("chat.copied") })),
    (err) => s.error(t("chat.copyFailed"), err),
  );
}

/** A title from the answer's first line. */
export const answerTitle = (text: string) => text.split("\n").find((l) => l.trim())?.replace(/^#+\s*/, "").replace(/[*_`]/g, "").slice(0, 60).trim() || t("chat.answerTitle");

/**
 * Inserts the answer into the open page: below the block with the cursor (one undo step), or at
 * the end when the page has no cursor; without an editor through the saved page.
 */
export async function insertIntoPage(text: string) {
  const s = useApp.getState();
  const page = currentPage();
  if (!page) {
    s.toast({ tone: "info", title: t("chat.noPageOpen") });
    return;
  }
  const md = useChat.getState().private ? `${text.trim()}\n\n${privateTag()}` : text.trim();
  const editor = editorForPage(page.id);
  if (editor && !editor.isDestroyed) {
    const range = editor.isFocused || !editor.state.selection.empty ? aiRange(editor) : null;
    const ok = range ? insertMarkdownBelow(editor, range, md) : appendMarkdown(editor, md);
    if (ok) {
      s.toast({ tone: "success", title: t("chat.inserted", { title: page.title }) });
      return;
    }
  }
  try {
    await flushAllEditors();
    const doc = await api.page(page.id);
    await api.savePage(page.id, `${doc.content.trimEnd()}\n\n${md}\n`);
    reloadEditors([page.id]);
    s.toast({ tone: "success", title: t("chat.inserted", { title: page.title }) });
  } catch (err) {
    s.error(t("chat.insertFailed"), err);
  }
}

/** „Als Seite speichern“ / „In neue Seite einfügen“ (weekly report with its title). */
export async function saveAnswerAsPage(text: string, pageTitle?: string) {
  const s = useApp.getState();
  const content = useChat.getState().private ? `${text.trim()}\n\n${privateTag()}\n` : text;
  try {
    const p = await api.createPage(pageTitle ?? answerTitle(text), null, pageTitle ? "file-text" : "sparkles", content);
    await s.refreshTree();
    s.openPage(p.id, { newTab: true });
  } catch (e) {
    s.error(t("chat.pageFailed"), e);
  }
}
