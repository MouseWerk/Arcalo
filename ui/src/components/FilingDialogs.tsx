// Ordner & Ablage dialogs: „Aufräumen …“ (dry run with checkboxes, apply in one step, undo in
// the toast) and „Verschieben nach …“ (fuzzy folder picker for one or many pages).

import { useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { ArrowRight, CornerDownRight, FolderPlus, Home, ListChecks, Wand2 } from "lucide-react";
import { Badge, Button, Dialog, EmptyState, Input, Spinner } from "./ui";
import { PageIcon } from "./icons";
import { useApp } from "../store/app";
import { t as tr, useT, type TKey } from "../lib/i18n";
import { filingApi, folderOptions, fuzzyScore, pickFolders, type MoveOutcome, type TidyMove } from "../lib/filing";

const s = useApp.getState;

interface FilingDialogState {
  tidy: { scope: number | null; title?: string } | null;
  move: number[] | null;
}
const useFilingDialogs = create<FilingDialogState>(() => ({ tidy: null, move: null }));

/** Opens „Aufräumen …“ for the whole workspace or the pages below a folder. */
export const openTidyUp = (scope: number | null = null, title?: string) => useFilingDialogs.setState({ tidy: { scope, title } });
/** Opens „Verschieben nach …“ for these pages. */
export const openMoveTo = (ids: number[]) => ids.length && useFilingDialogs.setState({ move: ids });

/** „Rückgängig“ of the last tidy-up or bulk move. */
export async function undoLastMove() {
  try {
    const last = await filingApi.lastMove();
    if (!last) {
      s().toast({ tone: "info", title: tr("fl.nothingToUndo") });
      return;
    }
    const n = await filingApi.undoMove();
    await s().refreshTree();
    s().toast({ tone: "info", title: tr("fl.undone", { n }) });
  } catch (e) {
    s().error(tr("fl.undoFailed"), e);
  }
}

/** The toast after a move, with „Rückgängig“. */
export function toastMoved(out: MoveOutcome) {
  if (!out.moved) return;
  s().toast({
    tone: "success",
    title: tr("fl.moved", { n: out.moved }),
    detail: out.folders ? tr("fl.foldersCreated", { n: out.folders }) : undefined,
    action: { label: tr("fl.undo"), run: () => void undoLastMove() },
  });
}

/** Moves pages (the sidebar's multi-select, drag and „Verschieben nach …“). */
export async function movePages(ids: number[], parentId: number | null) {
  try {
    const out = await filingApi.movePages(ids, parentId);
    await s().refreshTree();
    toastMoved(out);
    return out;
  } catch (e) {
    s().error(tr("sb.moveFailed"), e);
    return null;
  }
}

/** Mounted once in the main window. */
export function FilingHost() {
  const tidy = useFilingDialogs((st) => st.tidy);
  const move = useFilingDialogs((st) => st.move);
  return (
    <>
      {tidy && <TidyDialog scope={tidy.scope} title={tidy.title} onClose={() => useFilingDialogs.setState({ tidy: null })} />}
      {move && <MoveDialog ids={move} onClose={() => useFilingDialogs.setState({ move: null })} />}
    </>
  );
}

function TidyDialog({ scope, title, onClose }: { scope: number | null; title?: string; onClose: () => void }) {
  const t = useT();
  const [plan, setPlan] = useState<TidyMove[] | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    filingApi.tidyPlan(scope).then(
      (p) => {
        setPlan(p);
        setPicked(new Set(p.map((m) => m.page_id)));
      },
      (e) => {
        s().error(tr("fl.tidyFailed"), e);
        onClose();
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);
  const rules = s().settings?.settings.filing?.rules ?? [];
  const toggle = (id: number) => {
    const next = new Set(picked);
    next.has(id) ? next.delete(id) : next.add(id);
    setPicked(next);
  };
  const apply = async () => {
    setBusy(true);
    try {
      const out = await filingApi.tidyApply(scope, [...picked]);
      await s().refreshTree();
      onClose();
      toastMoved(out);
    } catch (e) {
      s().error(tr("fl.tidyFailed"), e);
    } finally {
      setBusy(false);
    }
  };
  const all = plan?.length ?? 0;
  return (
    <Dialog
      open
      onClose={onClose}
      width={720}
      title={title ? t("fl.tidyTitleIn", { title }) : t("fl.tidyTitle")}
      description={all ? t("fl.tidyDesc") : undefined}
      footer={
        plan && all > 0 ? (
          <>
            <Button variant="ghost" icon={ListChecks} onClick={() => setPicked(picked.size === all ? new Set() : new Set(plan.map((m) => m.page_id)))}>
              {picked.size === all ? t("fl.selectNone") : t("fl.selectAll")}
            </Button>
            <span className="tidy-grow" />
            <Button onClick={onClose}>{t("common.cancel")}</Button>
            <Button variant="primary" icon={Wand2} disabled={!picked.size || busy} onClick={apply} className="tidy-apply">
              {t("fl.apply", { n: picked.size })}
            </Button>
          </>
        ) : (
          <Button onClick={onClose}>{t("common.close")}</Button>
        )
      }
    >
      {plan == null ? (
        <div className="tidy-loading">
          <Spinner /> {t("fl.tidyLoading")}
        </div>
      ) : all === 0 ? (
        <EmptyState icon={Wand2} title={t("fl.tidyEmpty")} />
      ) : (
        <ul className="tidy-list" role="list">
          {plan.map((m) => {
            const ruleNo = m.rule ? rules.findIndex((r) => r.id === m.rule) + 1 : 0;
            return (
              <li key={m.page_id} className={`tidy-row ${picked.has(m.page_id) ? "" : "off"}`}>
                <label>
                  <input type="checkbox" className="check" checked={picked.has(m.page_id)} onChange={() => toggle(m.page_id)} aria-label={m.title} />
                  <PageIcon name={m.icon} size={15} className="tidy-icon" />
                  <span className="tidy-title">{m.title}</span>
                </label>
                <div className="tidy-paths">
                  <span className="tidy-from">{m.from || t("fl.topLevel")}</span>
                  <ArrowRight size={13} className="tidy-arrow" aria-hidden />
                  <span className="tidy-to">{m.to || t("fl.topLevel")}</span>
                  {m.creates && <Badge tone="info">{t("fl.newFolder")}</Badge>}
                  {ruleNo > 0 && <Badge tone="accent">{t("fl.rule.n", { n: ruleNo })}</Badge>}
                  {m.kind && !m.rule && <Badge>{t(`fl.type.${m.kind}` as TKey)}</Badge>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Dialog>
  );
}

function MoveDialog({ ids, onClose }: { ids: number[]; onClose: () => void }) {
  const t = useT();
  const tree = useApp((st) => st.tree);
  const pages = useApp((st) => st.pages);
  const [q, setQ] = useState("");
  const [cursor, setCursor] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  // Not into a moved page or below it.
  const blocked = useMemo(() => {
    const out = new Set<number>();
    const add = (id: number) => {
      out.add(id);
      pages.get(id)?.children.forEach((c) => add(c.id));
    };
    ids.forEach(add);
    return out;
  }, [ids, pages]);
  const options = useMemo(() => folderOptions(tree).filter((o) => o.id == null || !blocked.has(o.id)), [tree, blocked]);
  const folders = useMemo(() => new Set([...pages.values()].filter((p) => p.children.length).map((p) => p.id)), [pages]);
  const hits = useMemo(() => pickFolders(options, q, folders), [options, q, folders]);
  // The top level first without a query, else last (and only when it matches).
  const top = { id: null as number | null, path: t("fl.topLevel"), title: t("fl.topLevel"), icon: null, depth: 0 };
  const targets = !q.trim() ? [top, ...hits] : fuzzyScore(q, top.title) > 0 ? [...hits, top] : hits;
  useEffect(() => setCursor(0), [q]);
  useEffect(() => {
    list.current?.querySelector(".move-opt.cursor")?.scrollIntoView({ block: "nearest" });
  }, [cursor]);
  const choose = async (parent: number | null) => {
    onClose();
    await movePages(ids, parent);
  };
  const first = pages.get(ids[0]);
  return (
    <Dialog
      open
      onClose={onClose}
      width={520}
      title={t("fl.moveTitle")}
      description={ids.length === 1 && first ? t("fl.moveDescOne", { title: first.title }) : t("fl.moveDescMany", { n: ids.length })}
    >
      <Input
        className="move-search"
        value={q}
        placeholder={t("fl.searchFolder")}
        aria-label={t("fl.searchFolder")}
        aria-controls="move-targets"
        data-autofocus
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") (e.preventDefault(), setCursor((c) => Math.min(c + 1, targets.length - 1)));
          else if (e.key === "ArrowUp") (e.preventDefault(), setCursor((c) => Math.max(c - 1, 0)));
          else if (e.key === "Enter") (e.preventDefault(), targets[cursor] && choose(targets[cursor].id));
        }}
      />
      <div className="move-list" role="listbox" id="move-targets" aria-label={t("fl.targets")} ref={list}>
        {targets.map((o, i) => (
          <div
            key={o.id ?? "top"}
            role="option"
            aria-selected={i === cursor}
            className={`move-opt ${i === cursor ? "cursor" : ""}`}
            data-id={o.id ?? ""}
            onMouseEnter={() => setCursor(i)}
            onClick={() => choose(o.id)}
          >
            {o.id == null ? <Home size={15} className="move-icon" /> : folders.has(o.id) ? <PageIcon name={o.icon} size={15} className="move-icon" /> : <CornerDownRight size={15} className="move-icon" />}
            <span className="move-title">{o.title}</span>
            {o.id != null && o.depth > 0 && <span className="move-path">{o.path.slice(0, o.path.length - o.title.length - 3)}</span>}
          </div>
        ))}
        {hits.length === 0 && q.trim() && (
          <div className="move-empty">
            <FolderPlus size={14} /> {t("fl.noFolder")}
          </div>
        )}
      </div>
    </Dialog>
  );
}
