// „Nicht verlinkte Erwähnungen“ in the links panel: page titles the open page names without a
// link, and other pages that name the open page without linking it. „Verlinken“ turns one
// mention (or all of a page) into `[[Title]]`; „Ignorieren“ stops suggesting the term there.

import { useCallback, useEffect, useState } from "react";
import { EyeOff, Link2 } from "lucide-react";
import { api } from "../lib/api";
import { useApp } from "../store/app";
import { PageIcon } from "../components/icons";
import { flushAllEditors, reloadEditors } from "../editor/NoteEditor";
import type { Mention, MentionGroup, MentionReport } from "../lib/types";
import { t as tr, useT } from "../lib/i18n";

function Snippet({ m }: { m: Mention }) {
  return (
    <span className="mention-context faint small">
      {m.before}
      <mark>{m.text}</mark>
      {m.after}
    </span>
  );
}

export function UnlinkedMentions({ pageId, title }: { pageId: number; title: string }) {
  useT();
  const enabled = useApp((s) => s.settings?.settings.editor?.link_suggestions !== false);
  const [report, setReport] = useState<MentionReport | null>(null);
  const [busy, setBusy] = useState(false);
  const s = useApp.getState;

  const load = useCallback(() => {
    api.mentions(pageId).then(setReport, (e) => s().error(tr("lm.loadFailed"), e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId]);

  useEffect(() => {
    if (!enabled) return;
    setReport(null);
    load();
    // Any save can add or remove a mention (here or in another page); ask again after a pause.
    let timer = 0;
    const again = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(load, 700);
    };
    window.addEventListener("annalo:page-saved", again);
    window.addEventListener("annalo:reload-pages", again);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("annalo:page-saved", again);
      window.removeEventListener("annalo:reload-pages", again);
    };
  }, [enabled, load, title]);

  if (!enabled) return null;

  const link = async (source: number, target: number, start: number | null) => {
    setBusy(true);
    try {
      await flushAllEditors();
      const n = await api.linkMentions(source, target, start);
      reloadEditors([source]);
      s().toast({ tone: "success", title: tr("lm.linked", { n }) });
    } catch (e) {
      s().error(tr("lm.linkFailed"), e);
    } finally {
      setBusy(false);
      load();
    }
  };
  const ignore = async (page: number, term: string) => {
    try {
      await api.ignoreMention(page, term);
    } finally {
      load();
    }
  };

  const group = (g: MentionGroup, outgoing: boolean) => {
    const source = outgoing ? pageId : g.page_id;
    const target = outgoing ? g.page_id : pageId;
    return (
      <div key={`${outgoing ? "o" : "i"}${g.page_id}`} className="mention-group" data-page={g.page_id}>
        <div className="mention-group-head">
          <button type="button" className="mention-page" onClick={() => s().openPage(g.page_id)} title={g.title}>
            <PageIcon name={g.icon} size={14} />
            <span>{g.title}</span>
          </button>
          {g.mentions.length > 1 && (
            <button type="button" className="mention-btn mention-link-all" disabled={busy} onClick={() => void link(source, target, null)}>
              {tr("lm.linkAll")}
            </button>
          )}
        </div>
        {g.mentions.map((m) => (
          <div key={m.start} className="mention-item">
            <Snippet m={m} />
            <span className="mention-actions">
              <button type="button" className="mention-btn mention-link" disabled={busy} onClick={() => void link(source, target, m.start)}>
                <Link2 size={12} /> {tr("lm.link")}
              </button>
              <button
                type="button"
                className="mention-btn mention-ignore"
                title={tr("lm.ignoreTitle", { term: m.text })}
                aria-label={tr("lm.ignoreTitle", { term: m.text })}
                onClick={() => void ignore(source, m.text)}
              >
                <EyeOff size={12} />
              </button>
            </span>
          </div>
        ))}
      </div>
    );
  };

  const count = report ? report.outgoing.length + report.incoming.length : 0;
  return (
    <section className="mentions" aria-label={tr("lm.title")}>
      <h3>
        {tr("lm.title")} <span className="faint">{report ? count : ""}</span>
      </h3>
      {report && count === 0 && <p className="faint small">{tr("lm.none")}</p>}
      {report && report.outgoing.length > 0 && (
        <>
          <h4 className="mention-sub faint">{tr("lm.here")}</h4>
          {report.outgoing.map((g) => group(g, true))}
        </>
      )}
      {report && report.incoming.length > 0 && (
        <>
          <h4 className="mention-sub faint">{tr("lm.elsewhere")}</h4>
          {report.incoming.map((g) => group(g, false))}
        </>
      )}
    </section>
  );
}
