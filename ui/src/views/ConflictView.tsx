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

type Conflict = Extract<MergeChunk, { kind: "conflict" }>;

const FROM: Record<"mine" | "theirs" | "both", string> = { mine: "von hier übernommen", theirs: "vom Server übernommen", both: "auf beiden Seiten gleich geändert" };

/** Lines of one side with the lines the other side lacks marked. */
function Side({ text, other, side }: { text: string; other: string; side: "mine" | "theirs" }) {
  const lines = useMemo(() => {
    const d = side === "mine" ? lineDiff(text, other).filter((l) => l.kind !== "add") : lineDiff(other, text).filter((l) => l.kind !== "del");
    return d.map((l) => ({ text: l.text, changed: l.kind !== "same" }));
  }, [text, other, side]);
  if (!text.trim()) return <div className="cf-empty">{side === "mine" ? "Hier entfernt" : "Auf dem Server entfernt"}</div>;
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
  const [open, setOpen] = useState(false);
  const lines = chunk.text.replace(/\n+$/, "").split("\n");
  const long = lines.length > 3;
  const shown = open || !long ? lines : lines.slice(0, 2);
  if (!chunk.text.trim()) return null;
  return (
    <div className={`cf-quiet ${chunk.kind === "merged" ? `cf-auto cf-from-${chunk.from}` : ""}`}>
      {chunk.kind === "merged" && (
        <div className="cf-quiet-label">
          <Check size={12} aria-hidden /> Automatisch {FROM[chunk.from]}
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
          {open ? "Weniger zeigen" : `${lines.length - 2} weitere Zeilen`}
        </button>
      )}
    </div>
  );
}

/** „Konflikt“ above a page whose Git sync conflict is undecided. */
export function ConflictBanner({ pageId }: { pageId: number }) {
  const conflict = useApp((st) => st.conflicts.find((c) => c.page_id === pageId));
  if (!conflict) return null;
  return (
    <div className="cf-banner" role="status">
      <GitMerge size={15} aria-hidden />
      <div className="cf-banner-text">
        <strong>Konflikt</strong>
        <span>Diese Seite wurde hier und auf einem anderen Rechner geändert. Beide Fassungen sind erhalten; die des Servers bleibt dort, bis du zusammenführst.</span>
      </div>
      <Button size="sm" variant="primary" onClick={() => useApp.getState().openTab({ kind: "conflict", pageId }, { newTab: true })}>
        Zusammenführen
      </Button>
    </div>
  );
}

export function ConflictView({ pageId }: { pageId: number }) {
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
      if (out.sync_error) s().toast({ tone: "warning", title: "Zusammengeführt, aber nicht synchronisiert", detail: out.sync_error });
      else s().toast({ tone: "success", title: "Konflikt gelöst", detail: out.sync ? `„${view.title}“ ist zusammengeführt und synchronisiert.` : `„${view.title}“ ist zusammengeführt.` });
      s().openTab({ kind: "page", pageId });
    } catch (e) {
      s().error("Übernehmen fehlgeschlagen", e);
      setBusy(false);
    }
  };

  if (error)
    return (
      <div className="view-scroll">
        <div className="view narrow">
          <EmptyState icon={GitMerge} title="Kein offener Konflikt" action={<Button icon={FileText} onClick={() => s().openTab({ kind: "page", pageId })}>Seite öffnen</Button>}>
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
            <h1>Konflikt zusammenführen</h1>
            <div className="view-sub">
              „{view.title}“ wurde hier und auf dem Server geändert · erkannt am {fmtDate(view.at)} um {time(view.at)}
            </div>
          </div>
          <div className="view-actions">
            <Button icon={FileText} onClick={() => s().openPage(pageId, { newTab: true })}>
              Seite öffnen
            </Button>
          </div>
        </header>

        <div className="cf-bar" role="group" aria-label="Alle Stellen">
          <span className="cf-progress">
            {conflicts.length === 0 ? "Alles lässt sich automatisch zusammenführen." : `${decided} von ${conflicts.length} ${conflicts.length === 1 ? "Stelle" : "Stellen"} entschieden`}
          </span>
          {conflicts.length > 0 && manual == null && (
            <>
              <Button size="sm" variant="ghost" onClick={() => setChoices(chooseAll(chunks, "mine"))}>
                Überall meine
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setChoices(chooseAll(chunks, "theirs"))}>
                Überall andere
              </Button>
            </>
          )}
          <Button
            size="sm"
            icon={manual == null ? Pencil : RotateCcw}
            onClick={() => setManual(manual == null ? (buildResult(chunks, choices) ?? buildResult(chunks, new Map([...chooseAll(chunks, "mine"), ...choices])) ?? view.mine) : null)}
          >
            {manual == null ? "Ergebnis bearbeiten" : "Zurück zu den Stellen"}
          </Button>
        </div>

        {manual != null ? (
          <textarea className="input cf-result" value={manual} onChange={(e) => setManual(e.target.value)} aria-label="Ergebnis" spellCheck={false} />
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
          <span className="cf-foot-note">Die bisherige Fassung bleibt als Version erhalten. Danach wird synchronisiert.</span>
          <Button variant="primary" icon={GitMerge} disabled={result == null} loading={busy} onClick={() => void apply()}>
            Übernehmen
          </Button>
        </footer>
      </div>
    </div>
  );
}

function ConflictBlock({ index, total, chunk, choice, onChoose }: { index: number; total: number; chunk: Conflict; choice: Choice | undefined; onChoose: (c: Choice) => void }) {
  const kind = choice?.kind;
  const picked = (k: "mine" | "theirs") => kind === k || kind === "both";
  const option = (k: "mine" | "theirs" | "both", label: string) => (
    <button type="button" className={`cf-choice ${kind === k ? "on" : ""}`} aria-pressed={kind === k} onClick={() => onChoose({ kind: k })}>
      {kind === k && <Check size={12} aria-hidden />}
      {label}
    </button>
  );
  return (
    <section className={`cf-conflict ${choice ? "is-decided" : ""}`} aria-label={`Stelle ${index} von ${total}`} data-conflict={index}>
      <div className="cf-conflict-head">
        <span className="cf-conflict-title">
          Stelle {index} von {total}
        </span>
        <div className="cf-choices" role="group" aria-label="Übernehmen">
          {option("mine", "Meine")}
          {option("theirs", "Andere")}
          {option("both", "Beide")}
          <button
            type="button"
            className={`cf-choice ${kind === "edit" ? "on" : ""}`}
            aria-pressed={kind === "edit"}
            onClick={() => onChoose({ kind: "edit", text: choice ? choiceText(chunk, choice) : chunk.mine })}
          >
            <Pencil size={12} aria-hidden />
            Bearbeiten
          </button>
        </div>
      </div>
      <div className="cf-sides">
        <div className={`cf-side cf-side-mine ${picked("mine") ? "is-picked" : ""}`}>
          <div className="cf-side-label">Meine · dieser Rechner</div>
          <Side text={chunk.mine} other={chunk.theirs} side="mine" />
        </div>
        <div className={`cf-side cf-side-theirs ${picked("theirs") ? "is-picked" : ""}`}>
          <div className="cf-side-label">Andere · Server</div>
          <Side text={chunk.theirs} other={chunk.mine} side="theirs" />
        </div>
      </div>
      {choice?.kind === "edit" && (
        <textarea
          className="input cf-edit"
          value={choice.text}
          onChange={(e) => onChoose({ kind: "edit", text: e.target.value })}
          aria-label={`Text für Stelle ${index}`}
          spellCheck={false}
          autoFocus
        />
      )}
    </section>
  );
}
