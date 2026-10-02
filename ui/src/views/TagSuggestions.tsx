// Tag suggestions under the page properties: „Vorschlag: #projekt-x“ chips with accept and
// dismiss. Local suggestions come from similar and linked pages; „Tags mit KI vorschlagen“
// asks the model (tags of the vocabulary, new ones marked „neu“).

import { useEffect, useState } from "react";
import { Hash, Sparkles, X } from "lucide-react";
import { api } from "../lib/api";
import { useApp } from "../store/app";
import { addTagToFrontmatter } from "../lib/linking";
import { Spinner } from "../components/ui";
import type { TagSuggestion } from "../lib/types";
import { t as tr, useT } from "../lib/i18n";

export function TagSuggestions({ pageId, tags, fm, onFm }: { pageId: number; tags: string[]; fm: string; onFm: (next: string) => void }) {
  useT();
  const enabled = useApp((s) => s.settings?.settings.editor?.tag_suggestions !== false);
  const aiReady = useApp((s) => (s.settings?.settings.providers ?? []).some((p) => p.enabled !== false));
  const [list, setList] = useState<TagSuggestion[]>([]);
  const [asking, setAsking] = useState(false);
  const s = useApp.getState;
  const tagKey = tags.join(",");

  useEffect(() => {
    if (!enabled) return setList([]);
    let alive = true;
    const timer = window.setTimeout(() => {
      api.tagSuggestions(pageId).then((l) => alive && setList((cur) => [...l, ...cur.filter((c) => c.new && !l.some((x) => x.tag === c.tag))]), () => {});
    }, 300);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [enabled, pageId, tagKey]);

  useEffect(() => setList([]), [pageId]);

  if (!enabled) return null;
  const have = new Set(tags.map((x) => x.toLowerCase()));
  const shown = list.filter((x) => !have.has(x.tag));
  // Without suggestions, the AI button only shows on pages without tags (no row on every page).
  if (!shown.length && (!aiReady || tags.length > 0)) return null;

  const accept = (tag: string) => {
    onFm(addTagToFrontmatter(fm, tag));
    setList((l) => l.filter((x) => x.tag !== tag));
    s().toast({ tone: "success", title: tr("ts.added", { tag }) });
  };
  const dismiss = (tag: string) => {
    setList((l) => l.filter((x) => x.tag !== tag));
    api.dismissTag(pageId, tag).catch(() => {});
  };
  const askAi = async () => {
    setAsking(true);
    try {
      const ai = await api.tagSuggestionsAi(pageId);
      if (!ai.length) s().toast({ tone: "info", title: tr("ts.aiNone") });
      setList((l) => [...ai, ...l.filter((x) => !ai.some((a) => a.tag === x.tag))]);
    } catch (e) {
      s().error(tr("ts.aiFailed"), e);
    } finally {
      setAsking(false);
    }
  };

  return (
    <div className="tag-suggest" aria-label={tr("ts.suggestion")}>
      {shown.length > 0 && <span className="tag-suggest-label faint">{tr("ts.suggestion")}</span>}
      {shown.map((x) => (
        <span key={x.tag} className={`tag-suggest-chip ${x.new ? "is-new" : ""}`} data-tag={x.tag}>
          <button
            type="button"
            className="tag-suggest-accept"
            onClick={() => accept(x.tag)}
            title={x.new ? `${tr("ts.accept", { tag: x.tag })} – ${tr("ts.newTitle")}` : x.pages ? `${tr("ts.accept", { tag: x.tag })} – ${tr("ts.why", { n: x.pages })}` : tr("ts.accept", { tag: x.tag })}
          >
            <Hash size={11} />
            {x.tag}
            {x.new && <span className="tag-suggest-new">{tr("ts.new")}</span>}
          </button>
          <button type="button" className="tag-suggest-dismiss" onClick={() => dismiss(x.tag)} aria-label={tr("ts.dismiss", { tag: x.tag })} title={tr("ts.dismiss", { tag: x.tag })}>
            <X size={11} />
          </button>
        </span>
      ))}
      {aiReady && (
        <button type="button" className="tag-suggest-ai" onClick={() => void askAi()} disabled={asking} title={tr("ts.ai")}>
          {asking ? <Spinner size={11} /> : <Sparkles size={11} />}
          {asking ? tr("ts.aiBusy") : tr("ts.ai")}
        </button>
      )}
    </div>
  );
}
