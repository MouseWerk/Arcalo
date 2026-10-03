// Duplicate hints: „Ähnliche Seite: X (82 % ähnlich)“ in the page header with „Vergleichen“
// (both texts side by side, the version diff's line diff), „Zusammenführen“ (undoable) and
// „Ignorieren“; and „Doppelte Seiten finden“, the list of all likely duplicate pairs.

import { useEffect, useMemo, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Columns2, Copy, EyeOff, Merge } from "lucide-react";
import { api } from "../lib/api";
import { useApp } from "../store/app";
import { Button, Dialog, Spinner } from "../components/ui";
import { flushAllEditors, reloadEditors } from "../editor/NoteEditor";
import { collapseDiff, lineDiff, type DiffRow } from "../lib/linediff";
import type { DuplicateHint as Hint, DuplicatePair } from "../lib/types";
import { t as tr, useT } from "../lib/i18n";

const pct = (score: number) => Math.round(score * 100);

/** Diff rows as side-by-side pairs: changed runs of the left and the right text line up. */
export function sideBySide(rows: DiffRow[]): ({ kind: "skip"; count: number } | { kind: "row"; left: string | null; right: string | null; changed: boolean })[] {
  const out: ({ kind: "skip"; count: number } | { kind: "row"; left: string | null; right: string | null; changed: boolean })[] = [];
  let dels: string[] = [];
  let adds: string[] = [];
  const flush = () => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) out.push({ kind: "row", left: dels[i] ?? null, right: adds[i] ?? null, changed: true });
    dels = [];
    adds = [];
  };
  for (const r of rows) {
    if (r.kind === "del") dels.push(r.text);
    else if (r.kind === "add") adds.push(r.text);
    else {
      flush();
      out.push(r.kind === "skip" ? r : { kind: "row", left: r.text, right: r.text, changed: false });
    }
  }
  flush();
  return out;
}

export function CompareDialog({ left, right, onClose }: { left: { id: number; title: string }; right: { id: number; title: string }; onClose: () => void }) {
  const t = useT();
  const [texts, setTexts] = useState<[string, string] | null>(null);
  useEffect(() => {
    let alive = true;
    flushAllEditors()
      .catch(() => {})
      .then(() => Promise.all([api.page(left.id), api.page(right.id)]))
      .then(([a, b]) => alive && setTexts([a.content, b.content]))
      .catch((e) => useApp.getState().error(t("dup.compareFailed"), e));
    return () => {
      alive = false;
    };
  }, [left.id, right.id, t]);
  const rows = useMemo(() => (texts ? sideBySide(collapseDiff(lineDiff(texts[0], texts[1]), 2, 6)) : null), [texts]);
  return (
    <Dialog open onClose={onClose} title={t("dup.compareTitle")} description={t("dup.compareDesc", { a: left.title, b: right.title })} width={1040} footer={<Button onClick={onClose}>{t("common.close")}</Button>}>
      {!rows ? (
        <div className="center-fill">
          <Spinner />
        </div>
      ) : (
        <div className="compare" role="table" aria-label={t("dup.compareTitle")}>
          <div className="compare-head" role="row">
            <span role="columnheader">{left.title}</span>
            <span role="columnheader">{right.title}</span>
          </div>
          <div className="compare-body">
            {rows.map((r, i) =>
              r.kind === "skip" ? (
                <div key={i} className="compare-skip faint">
                  … {t("ver.unchanged", { n: r.count })}
                </div>
              ) : (
                <div key={i} className={`compare-row ${r.changed ? "is-changed" : ""}`} role="row">
                  <pre className={r.changed && r.left != null ? "diff-del" : ""}>{r.left ?? ""}</pre>
                  <pre className={r.changed && r.right != null ? "diff-add" : ""}>{r.right ?? ""}</pre>
                </div>
              ),
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}

/** Merges `other` into `keep` after asking; the toast offers „Rückgängig“. Resolves to whether it merged. */
export async function mergeInto(keep: { id: number; title: string }, other: { id: number; title: string }): Promise<boolean> {
  const s = useApp.getState;
  const ok = await s().confirm({
    title: tr("dup.mergeTitle"),
    message: tr("dup.mergeMessage", { keep: keep.title, other: other.title }),
    confirmLabel: tr("dup.merge"),
  });
  if (!ok) return false;
  try {
    await flushAllEditors();
    const out = await api.mergePages(keep.id, other.id);
    await s().refreshTree();
    reloadEditors(out.changed);
    s().toast({
      tone: "success",
      title: tr("dup.merged", { keep: keep.title, other: other.title }),
      detail: out.relinked ? tr("dup.relinked", { n: out.relinked }) : undefined,
      action: {
        label: tr("common.undo"),
        run: async () => {
          try {
            await flushAllEditors();
            const changed = await api.undoMerge();
            await s().refreshTree();
            reloadEditors(changed);
            s().toast({ tone: "success", title: tr("dup.undone") });
          } catch (e) {
            s().error(tr("dup.undoFailed"), e);
          }
        },
      },
    });
    return true;
  } catch (e) {
    s().error(tr("dup.failed"), e);
    return false;
  }
}

/** The hint in the page header (the most similar page). */
export function DuplicateHint({ page, savedAt }: { page: { id: number; title: string }; savedAt: string }) {
  useT();
  const enabled = useApp((s) => s.settings?.settings.editor?.duplicate_hints !== false);
  const [hints, setHints] = useState<Hint[]>([]);
  const [comparing, setComparing] = useState(false);
  const s = useApp.getState;

  useEffect(() => {
    if (!enabled) return setHints([]);
    let alive = true;
    const timer = window.setTimeout(() => api.duplicates(page.id).then((h) => alive && setHints(h), () => {}), 400);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [enabled, page.id, savedAt]);

  const top = hints[0];
  if (!enabled || !top) return null;
  const other = { id: top.page_id, title: top.title };
  const ignore = () => {
    setHints((h) => h.slice(1));
    api.ignoreDuplicate(page.id, top.page_id).catch((e) => s().error(tr("dup.failed"), e));
  };
  return (
    <div className="dup-hint" role="note" data-page={top.page_id}>
      <Copy size={14} className="dup-hint-icon" aria-hidden />
      <span className="dup-hint-text">
        {tr("dup.label")}{" "}
        <button type="button" className="dup-hint-title" onClick={(e) => s().openPage(top.page_id, { newTab: e.ctrlKey || e.metaKey })}>
          {top.title}
        </button>{" "}
        <span className="faint dup-hint-pct">({tr("dup.pct", { pct: pct(top.score) })})</span>
        {hints.length > 1 && (
          <button type="button" className="dup-hint-more faint" onClick={openDuplicates}>
            {tr("dup.more", { n: hints.length - 1 })}
          </button>
        )}
      </span>
      <span className="dup-hint-actions">
        <Button size="sm" variant="ghost" icon={Columns2} onClick={() => setComparing(true)} className="dup-compare">
          {tr("dup.compare")}
        </Button>
        <Button size="sm" variant="ghost" icon={Merge} onClick={() => void mergeInto(page, other).then((ok) => ok && setHints((h) => h.slice(1)))} className="dup-merge">
          {tr("dup.merge")}
        </Button>
        <Button size="sm" variant="ghost" icon={EyeOff} onClick={ignore} className="dup-ignore">
          {tr("dup.ignore")}
        </Button>
      </span>
      {comparing && <CompareDialog left={page} right={other} onClose={() => setComparing(false)} />}
    </div>
  );
}

function DuplicatesDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [pairs, setPairs] = useState<DuplicatePair[] | null>(null);
  const [comparing, setComparing] = useState<DuplicatePair | null>(null);
  const s = useApp.getState;
  const load = () =>
    flushAllEditors()
      .catch(() => {})
      .then(() => api.allDuplicates())
      .then(setPairs, (e) => {
        s().error(t("dup.loadFailed"), e);
        setPairs([]);
      });
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const open = (id: number) => {
    s().openPage(id);
    onClose();
  };
  return (
    <Dialog open onClose={onClose} title={t("dup.findTitle")} description={t("dup.findDesc")} width={720} footer={<Button onClick={onClose}>{t("common.close")}</Button>}>
      {pairs == null ? (
        <div className="center-fill">
          <Spinner />
        </div>
      ) : pairs.length === 0 ? (
        <p className="faint dup-list-empty">{t("dup.none")}</p>
      ) : (
        <ul className="dup-list">
          {pairs.map((p) => (
            <li key={`${p.a}-${p.b}`} className="dup-pair">
              <span className="dup-pair-titles">
                <button type="button" className="link-btn" onClick={() => open(p.a)}>
                  {p.a_title}
                </button>
                <span className="faint">↔</span>
                <button type="button" className="link-btn" onClick={() => open(p.b)}>
                  {p.b_title}
                </button>
              </span>
              <span className="dup-pair-score num faint">{t("dup.pct", { pct: pct(p.score) })}</span>
              <span className="dup-pair-actions">
                <Button size="sm" variant="ghost" icon={Columns2} onClick={() => setComparing(p)}>
                  {t("dup.compare")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={Merge}
                  onClick={() => void mergeInto({ id: p.a, title: p.a_title }, { id: p.b, title: p.b_title }).then((ok) => void (ok && load()))}
                >
                  {t("dup.merge")}
                </Button>
                <Button size="sm" variant="ghost" icon={EyeOff} onClick={() => void api.ignoreDuplicate(p.a, p.b).then(load, (e) => useApp.getState().error(t("common.actionFailed"), e))}>
                  {t("dup.ignore")}
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {comparing && <CompareDialog left={{ id: comparing.a, title: comparing.a_title }} right={{ id: comparing.b, title: comparing.b_title }} onClose={() => setComparing(null)} />}
    </Dialog>
  );
}

let root: Root | null = null;

/** „Doppelte Seiten finden“ (command palette). */
export function openDuplicates() {
  if (!root) {
    const host = document.createElement("div");
    host.className = "dup-host";
    document.body.append(host);
    root = createRoot(host);
  }
  root.render(<DuplicatesDialog key={Date.now()} onClose={() => root?.render(null)} />);
}
