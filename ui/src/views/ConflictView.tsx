// Conflict view of a page the Git sync found changed here and on the server: the block merge
// from the shell, unchanged and automatically merged blocks muted, every conflict with both
// versions side by side (changed lines marked). Per conflict „Meine“, „Andere“, „Beide“ or an
// own text; „Übernehmen“ saves the result (the previous content stays a version) and syncs.

import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, ChevronRight, FileText, GitMerge, Pencil, RotateCcw } from "lucide-react";
import { api, errorText } from "../lib/api";
import type { GitConflictView, MergeChunk } from "../lib/types";
import { useApp } from "../store/app";
import { Button, EmptyState, Spinner } from "../components/ui";
import { fmtDate, time } from "../lib/format";
import { lineDiff } from "../lib/linediff";
import { buildResult, choiceText, chooseAll, conflictIndexes, type Choice } from "../lib/conflict";
import { reloadEditors } from "../editor/NoteEditor";
import { t, useT, type TKey } from "../lib/i18n";

type Conflict = Extract<MergeChunk, { kind: "conflict" }>;

const FROM: Record<"mine" | "theirs" | "both", TKey> = { mine: "cf.auto.mine", theirs: "cf.auto.theirs", both: "cf.auto.both" };

/** Lines of one side with the lines the other side lacks marked. */
function Side({ text, other, side }: { text: string; other: string; side: "mine" | "theirs" }) {
  useT();
  const lines = useMemo(() => {
    const d = side === "mine" ? lineDiff(text, other).filter((l) => l.kind !== "add") : lineDiff(other, text).filter((l) => l.kind !== "del");
    return d.map((l) => ({ text: l.text, changed: l.kind !== "same" }));
  }, [text, other, side]);
  if (!text.trim()) return <div className="cf-empty">{side === "mine" ? t("cf.removedHere") : t("cf.removedServer")}</div>;
  return (
    <div className="cf-lines">
      {lines.map((l, i) => (
        <div key={i} className={`cf-line ${l.changed ? `cf-changed cf-${side}` : ""}`}>
          {l.text || " "}
        </div>
      ))}
    </div>
  );
}

/** An unchanged or automatically merged stretch, folded to a few lines. */
function Quiet({ chunk }: { chunk: Exclude<MergeChunk, Conflict> }) {
  useT();
  const [open, setOpen] = useState(false);
  const lines = chunk.text.replace(/\n+$/, "").split("\n");
  const long = lines.length > 3;
  const shown = open || !long ? lines : lines.slice(0, 2);
  if (!chunk.text.trim()) return null;
  return (
    <div className={`cf-quiet ${chunk.kind === "merged" ? `cf-auto cf-from-${chunk.from}` : ""}`}>
      {chunk.kind === "merged" && (
        <div className="cf-quiet-label">
          <Check size={12} aria-hidden /> {t(FROM[chunk.from])}
        </div>
      )}
      <div className="cf-lines">
        {shown.map((l, i) => (
          <div key={i} className="cf-line">
            {l || " "}
          </div>
        ))}
      </div>
      {long && (
        <button type="button" className="cf-fold" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
          {open ? t("common.showLess") : t("cf.moreLines", { n: lines.length - 2 })}
        </button>
      )}
    </div>
  );
}

/** „Konflikt“ above a page whose Git sync conflict is undecided. */
export function ConflictBanner({ pageId }: { pageId: number }) {
  useT();
  const conflict = useApp((st) => st.conflicts.find((c) => c.page_id === pageId));
  if (!conflict) return null;
  return (
    <div className="cf-banner" role="status">
      <GitMerge size={15} aria-hidden />
      <div className="cf-banner-text">
        <strong>{t("cf.conflict")}</strong>
        <span>{t("cf.bannerText")}</span>
      </div>
      <Button size="sm" variant="primary" onClick={() => useApp.getState().openTab({ kind: "conflict", pageId }, { newTab: true })}>
        {t("app.merge")}
      </Button>
    </div>
  );
}

export function ConflictView({ pageId }: { pageId: number }) {
  useT();
  const [view, setView] = useState<GitConflictView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [choices, setChoices] = useState<Map<number, Choice>>(new Map());
  const [manual, setManual] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const s = useApp.getState;
  useEffect(() => {
    api.gitConflict(pageId).then(setView, (e) => setError(errorText(e)));
  }, [pageId]);

  const chunks = view?.merge.chunks ?? [];
  const conflicts = conflictIndexes(chunks);
  const decided = conflicts.filter((i) => choices.has(i)).length;
  const result = manual ?? buildResult(chunks, choices);
  const choose = (i: number, c: Choice) => setChoices((m) => new Map(m).set(i, c));

  const apply = async () => {
    if (result == null || !view) return;
    setBusy(true);
    try {
      const out = await api.resolveGitConflict(pageId, result);
      reloadEditors([pageId]);
      await s().refreshConflicts();
      if (out.sync_error) s().toast({ tone: "warning", title: t("cf.mergedNotSynced"), detail: out.sync_error });
      else s().toast({ tone: "success", title: t("cf.solved"), detail: out.sync ? t("cf.mergedSynced", { title: view.title }) : t("cf.merged", { title: view.title }) });
      s().openTab({ kind: "page", pageId });
    } catch (e) {
      s().error(t("cf.applyFailed"), e);
      setBusy(false);
    }
  };

  if (error)
    return (
      <div className="view-scroll">
        <div className="view narrow">
          <EmptyState icon={GitMerge} title={t("cf.none")} action={<Button icon={FileText} onClick={() => s().openTab({ kind: "page", pageId })}>{t("cf.openPage")}</Button>}>
            {error}
          </EmptyState>
        </div>
      </div>
    );
  if (!view) return <Spinner />;

  return (
    <div className="view-scroll cf-scroll">
      <div className="view cf-view">
        <header className="view-header">
          <div>
            <h1>{t("cf.title")}</h1>
            <div className="view-sub">{t("cf.sub", { title: view.title, date: fmtDate(view.at), time: time(view.at) })}</div>
          </div>
          <div className="view-actions">
            <Button icon={FileText} onClick={() => s().openPage(pageId, { newTab: true })}>
              {t("cf.openPage")}
            </Button>
          </div>
        </header>

        <div className="cf-bar" role="group" aria-label={t("cf.all")}>
          <span className="cf-progress">
            {conflicts.length === 0 ? t("cf.allAuto") : t("cf.decided", { decided, n: conflicts.length })}
          </span>
          {conflicts.length > 0 && manual == null && (
            <>
              <Button size="sm" variant="ghost" onClick={() => setChoices(chooseAll(chunks, "mine"))}>
                {t("cf.allMine")}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setChoices(chooseAll(chunks, "theirs"))}>
                {t("cf.allTheirs")}
              </Button>
            </>
          )}
          <Button
            size="sm"
            icon={manual == null ? Pencil : RotateCcw}
            onClick={() => setManual(manual == null ? (buildResult(chunks, choices) ?? buildResult(chunks, new Map([...chooseAll(chunks, "mine"), ...choices])) ?? view.mine) : null)}
          >
            {manual == null ? t("cf.editResult") : t("cf.backToSpots")}
          </Button>
        </div>

        {manual != null ? (
          <textarea className="input cf-result" value={manual} onChange={(e) => setManual(e.target.value)} aria-label={t("cf.result")} spellCheck={false} />
        ) : (
          <div className="cf-chunks">
            {chunks.map((c, i) =>
              c.kind === "conflict" ? (
                <ConflictBlock key={i} index={conflicts.indexOf(i) + 1} total={conflicts.length} chunk={c} choice={choices.get(i)} onChoose={(x) => choose(i, x)} />
              ) : (
                <Quiet key={i} chunk={c} />
              ),
            )}
          </div>
        )}

        <footer className="cf-foot">
          <span className="cf-foot-note">{t("cf.footNote")}</span>
          <Button variant="primary" icon={GitMerge} disabled={result == null} loading={busy} onClick={() => void apply()}>
            {t("cf.apply")}
          </Button>
        </footer>
      </div>
    </div>
  );
}

function ConflictBlock({ index, total, chunk, choice, onChoose }: { index: number; total: number; chunk: Conflict; choice: Choice | undefined; onChoose: (c: Choice) => void }) {
  useT();
  const kind = choice?.kind;
  const picked = (k: "mine" | "theirs") => kind === k || kind === "both";
  const option = (k: "mine" | "theirs" | "both", label: string) => (
    <button type="button" className={`cf-choice ${kind === k ? "on" : ""}`} aria-pressed={kind === k} onClick={() => onChoose({ kind: k })}>
      {kind === k && <Check size={12} aria-hidden />}
      {label}
    </button>
  );
  return (
    <section className={`cf-conflict ${choice ? "is-decided" : ""}`} aria-label={t("cf.spot", { index, total })} data-conflict={index}>
      <div className="cf-conflict-head">
        <span className="cf-conflict-title">{t("cf.spot", { index, total })}</span>
        <div className="cf-choices" role="group" aria-label={t("cf.apply")}>
          {option("mine", t("cf.mine"))}
          {option("theirs", t("cf.theirs"))}
          {option("both", t("cf.both"))}
          <button
            type="button"
            className={`cf-choice ${kind === "edit" ? "on" : ""}`}
            aria-pressed={kind === "edit"}
            onClick={() => onChoose({ kind: "edit", text: choice ? choiceText(chunk, choice) : chunk.mine })}
          >
            <Pencil size={12} aria-hidden />
            {t("links.editShort")}
          </button>
        </div>
      </div>
      <div className="cf-sides">
        <div className={`cf-side cf-side-mine ${picked("mine") ? "is-picked" : ""}`}>
          <div className="cf-side-label">{t("cf.mineLabel")}</div>
          <Side text={chunk.mine} other={chunk.theirs} side="mine" />
        </div>
        <div className={`cf-side cf-side-theirs ${picked("theirs") ? "is-picked" : ""}`}>
          <div className="cf-side-label">{t("cf.theirsLabel")}</div>
          <Side text={chunk.theirs} other={chunk.mine} side="theirs" />
        </div>
      </div>
      {choice?.kind === "edit" && (
        <textarea
          className="input cf-edit"
          value={choice.text}
          onChange={(e) => onChoose({ kind: "edit", text: e.target.value })}
          aria-label={t("cf.textFor", { index })}
          spellCheck={false}
          autoFocus
        />
      )}
    </section>
  );
}
