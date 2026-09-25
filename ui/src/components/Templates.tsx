// Template picker: "Vorlage einfügen" (slash menu) and "Neue Seite aus Vorlage…" (palette).
// Templates are the pages below the top-level page „Vorlagen“.

import { useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import type { Editor } from "@tiptap/core";
import { LayoutTemplate } from "lucide-react";
import { api } from "../lib/api";
import { useApp } from "../store/app";
import { fuzzyIncludes } from "../editor/extensions";
import { PageIcon } from "./icons";
import { Button, Dialog, EmptyState, Input, Spinner } from "./ui";
import type { Page } from "../lib/types";
import { currentLang, t as tr, useT } from "../lib/i18n";

type Mode = "insert" | "page";
interface Pick {
  template: Page;
  title: string;
}
interface Request {
  id: number;
  mode: Mode;
  resolve: (pick: Pick | null) => void;
}

const usePicker = create<{ req: Request | null }>(() => ({ req: null }));
let seq = 0;

function pickTemplate(mode: Mode): Promise<Pick | null> {
  usePicker.getState().req?.resolve(null);
  return new Promise((resolve) =>
    usePicker.setState({
      req: {
        id: ++seq,
        mode,
        resolve: (pick) => {
          usePicker.setState({ req: null });
          resolve(pick);
        },
      },
    }),
  );
}

/** Inserts a rendered template at the caret of `editor`. */
export async function insertTemplate(editor: Editor, pageTitle: string) {
  const { from, to } = editor.state.selection;
  const pick = await pickTemplate("insert");
  if (!pick || editor.isDestroyed) return;
  try {
    const md = await api.renderTemplate(pick.template.id, pageTitle);
    editor.chain().focus().setTextSelection({ from, to }).insertContent(md, { contentType: "markdown" }).run();
  } catch (e) {
    useApp.getState().error(tr("tpl.insertFailed"), e);
  }
}

/** Asks for a template and a title, then creates and opens the page. */
export async function newPageFromTemplate(parentId: number | null = null) {
  const pick = await pickTemplate("page");
  if (!pick) return;
  const s = useApp.getState();
  try {
    const page = await api.pageFromTemplate(pick.template.id, pick.title, parentId);
    await s.refreshTree();
    s.openPage(page.id);
  } catch (e) {
    s.error(tr("tpl.pageFailed"), e);
  }
}

const today = () => new Date().toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });

export function TemplateHost() {
  const req = usePicker((s) => s.req);
  // A fresh picker per request, so no list or selection of the last one shows up.
  return req ? <TemplatePicker key={req.id} req={req} /> : null;
}

function TemplatePicker({ req }: { req: Request }) {
  useT();
  const [templates, setTemplates] = useState<Page[] | null>(null);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const [title, setTitle] = useState("");
  const [titleTouched, setTitleTouched] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const keyRef = useRef<((e: KeyboardEvent) => void) | null>(null);

  // Arrow keys and Enter pick a template wherever the focus is (the editor may take it back
  // while the dialog opens); the inputs handle their own keys.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest?.(".tpl-picker input, .dialog-foot")) return;
      // Other buttons (close, empty-state action) keep their own Enter/Space.
      if (target?.closest?.("button, a, [role=button]") && !target.closest(".tpl-list")) return;
      keyRef.current?.(e);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [req]);

  useEffect(() => {
    api
      .templates()
      .then(setTemplates)
      .catch((e) => {
        useApp.getState().error(tr("tpl.loadFailed"), e);
        setTemplates([]);
      });
  }, [req]);

  // The list may arrive after the dialog placed the focus: move it there unless a title is asked for.
  useEffect(() => {
    if (templates?.length && req.mode === "insert") pickerRef.current?.querySelector<HTMLElement>("input, .tpl-list")?.focus();
  }, [templates, req]);

  const shown = useMemo(() => (templates ?? []).filter((t) => !q.trim() || fuzzyIncludes(t.title, q.trim())), [templates, q]);
  const current = shown[Math.min(sel, shown.length - 1)];
  useEffect(() => {
    if (req.mode === "page" && current && !titleTouched) setTitle(`${current.title} ${today()}`);
  }, [current, req, titleTouched]);

  const isPage = req.mode === "page";
  const close = () => req.resolve(null);
  const choose = (t: Page | undefined) => {
    if (!t) return;
    if (isPage && !title.trim()) return;
    req.resolve({ template: t, title: title.trim() });
  };
  const openTemplates = async () => {
    close();
    const s = useApp.getState();
    try {
      const root = await api.templatesRoot();
      await s.refreshTree();
      s.openPage(root.id);
    } catch (e) {
      s.error(tr("tpl.openFailed"), e);
    }
  };
  const onKey = (e: { key: string; preventDefault: () => void; stopPropagation: () => void }) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      const n = Math.max(shown.length, 1);
      setSel((v) => (Math.min(v, n - 1) + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
    } else if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      choose(current);
    }
  };
  keyRef.current = onKey;

  return (
    <Dialog
      open
      onClose={close}
      title={isPage ? tr("tpl.newPage") : tr("tpl.insert")}
      description={tr("tpl.desc", currentLang() === "de" ? { a: "{{datum}}", b: "{{zeit}}", c: "{{titel}}" } : { a: "{{date}}", b: "{{time}}", c: "{{title}}" })}
      width={500}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            {tr("common.cancel")}
          </Button>
          <Button variant="primary" onClick={() => choose(current)} disabled={!current || (isPage && !title.trim())}>
            {isPage ? tr("common.create") : tr("slash.sec.insert")}
          </Button>
        </>
      }
    >
      <div className="tpl-picker" ref={pickerRef}>
        {isPage && (
          <label className="field">
            <span className="field-label">{tr("tpl.title")}</span>
            <Input
              value={title}
              onChange={(e) => (setTitle(e.target.value), setTitleTouched(true))}
              onKeyDown={onKey}
              aria-label={tr("tpl.titleLabel")}
              data-autofocus
              spellCheck
            />
          </label>
        )}
        {templates && templates.length > 3 && <Input value={q} onChange={(e) => (setQ(e.target.value), setSel(0))} onKeyDown={onKey} placeholder={tr("tpl.searchPh")} aria-label={tr("tpl.search")} data-autofocus={isPage ? undefined : ""} />}
        {templates === null ? (
          <div className="center-fill tpl-loading">
            <Spinner />
          </div>
        ) : templates.length === 0 ? (
          <EmptyState icon={LayoutTemplate} title={tr("tpl.none")} action={<Button onClick={openTemplates}>{tr("tpl.openFolder")}</Button>}>
            {tr("tpl.noneText")}
          </EmptyState>
        ) : (
          <div className="tpl-list" role="listbox" aria-label={tr("set.notes.templates")} tabIndex={-1} data-autofocus={isPage ? undefined : ""}>
            {shown.map((t, i) => (
              <button
                key={t.id}
                type="button"
                role="option"
                aria-selected={t === current}
                className={`sugg-item ${t === current ? "sel" : ""}`}
                onMouseMove={() => sel !== i && setSel(i)}
                onClick={() => (isPage ? setSel(i) : choose(t))}
                onDoubleClick={() => choose(t)}
              >
                <span className="sugg-icon">
                  <PageIcon name={t.icon} size={15} />
                </span>
                <span className="sugg-text">
                  <span className="sugg-title">{t.title}</span>
                </span>
              </button>
            ))}
            {shown.length === 0 && <div className="sugg-empty">{tr("tpl.notFound")}</div>}
          </div>
        )}
      </div>
    </Dialog>
  );
}
