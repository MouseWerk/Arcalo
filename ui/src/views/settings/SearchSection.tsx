// Settings → Suche: „Suche nach Bedeutung“ (on by itself with a local embedding model), which
// model it uses and where that runs, the index with its progress and „Index neu aufbauen“.
// Without an embedding model (or offline) the search finds exact words only; a quiet hint says
// how to change that.

import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button, Progress, Switch } from "../../components/ui";
import { api, on } from "../../lib/api";
import { openSettingsSection } from "../../lib/calnav";
import { fileSize } from "../../lib/format";
import { useT, t as tr } from "../../lib/i18n";
import { useApp } from "../../store/app";
import { useAi } from "../../lib/aiswitch";
import type { SemanticStatus, Settings } from "../../lib/types";
import { Group, Row, SectionHead, StatusNote, type SectionProps } from "./common";

/** The switch as shown: the stored choice, else on exactly with a local embedding model. */
export function semanticSwitch(s: Settings): { on: boolean; local: boolean; model: string | null; provider: string | null } {
  const model = s.embedding_model?.trim() || null;
  const provider = s.providers.find((p) => p.id === s.embedding_provider.trim()) ?? null;
  const local = !!model && !!provider?.local;
  return { on: s.search?.semantic ?? local, local, model, provider: provider?.name || provider?.id || null };
}

export function SearchPrefsSection({ draft, update }: SectionProps) {
  const t = useT();
  const [status, setStatus] = useState<SemanticStatus | null>(null);
  const aiOn = useAi();
  const sw = semanticSwitch(draft);
  const set = (v: boolean) => update({ search: { ...draft.search, semantic: v } });
  // The state after every change of the settings that decide it (they are saved at once).
  const deps = [draft.search?.semantic, draft.embedding_model, draft.embedding_provider, draft.privacy.local_only, JSON.stringify(draft.providers.map((p) => [p.id, p.local, p.enabled]))].join("|");
  useEffect(() => {
    let alive = true;
    const load = () => api.semanticStatus().then((s) => alive && setStatus(s), () => {});
    const timer = setTimeout(load, 250);
    load();
    const un = on<SemanticStatus>("semantic://status", (s) => alive && setStatus(s));
    return () => {
      alive = false;
      clearTimeout(timer);
      void un.then((f) => f());
    };
  }, [deps]);

  const rebuild = async () => {
    try {
      setStatus(await api.semanticRebuild());
      useApp.getState().toast({ tone: "success", title: tr("set.search.rebuildStarted") });
    } catch (e) {
      useApp.getState().error(tr("set.search.rebuildFailed"), e);
    }
  };

  const p = status?.progress;
  const inactive = status?.inactive ?? (sw.model ? null : "no_model");
  const active = sw.on && !!sw.model && inactive == null;
  const where = sw.local ? t("set.search.whereLocal", { provider: sw.provider ?? "" }) : t("set.search.whereCloud", { provider: sw.provider ?? "" });
  // „KI verwenden“ off: no embeddings, so no search by meaning; the search finds words as before.
  if (!aiOn)
    return (
      <>
        <SectionHead title={t("set.search.title")} intro={t("set.search.intro")} />
        <Group title={t("set.search.meaning")}>
          <div className="search-note">
            <StatusNote tone="neutral">{t("set.search.noAi")}</StatusNote>
          </div>
        </Group>
      </>
    );
  return (
    <>
      <SectionHead title={t("set.search.title")} intro={t("set.search.intro")} />
      <Group title={t("set.search.meaning")}>
        <Row label={t("set.search.semantic")} description={t("set.search.semanticDesc")} keywords={t("set.search.keywords")}>
          <Switch label={t("set.search.semantic")} checked={sw.on && !!sw.model} disabled={!sw.model} onChange={set} />
        </Row>
        {!sw.model ? (
          <div className="search-note">
            <StatusNote tone="info">{t("set.search.noModel")}</StatusNote>
            <Button size="sm" variant="ghost" onClick={() => openSettingsSection("ai")}>
              {t("set.search.toAi")}
            </Button>
          </div>
        ) : (
          <Row label={t("set.search.model")} description={sw.local ? t("set.search.localDesc") : t("set.search.cloudDesc")}>
            <span className="search-model">
              <span className="search-model-name">{sw.model}</span>
              <span className="faint">{where}</span>
            </span>
          </Row>
        )}
        {sw.model && inactive === "local_only" && (
          <div className="search-note">
            <StatusNote tone="info">{t("set.search.localOnly")}</StatusNote>
          </div>
        )}
        {sw.model && inactive === "provider_off" && (
          <div className="search-note">
            <StatusNote tone="warning">{t("set.search.providerOff")}</StatusNote>
          </div>
        )}
        {active && (
          <Row label={t("set.search.index")} description={t("set.search.indexDesc")} stack>
            <div className="search-index">
              {p && p.total > 0 && <Progress value={p.done / p.total} />}
              <div className="search-index-line">
                <span className="search-index-count" role="status">
                  {!p
                    ? "…"
                    : p.total === 0
                      ? t("set.search.empty")
                      : status?.running
                        ? t("set.search.running", { done: p.done, total: p.total })
                        : p.done >= p.total
                          ? t("set.search.ready", { n: p.total })
                          : t("set.search.partial", { done: p.done, total: p.total })}
                  {status && status.memory > 0 && <span className="faint"> · {t("set.search.memory", { size: fileSize(status.memory) })}</span>}
                </span>
                <Button size="sm" variant="ghost" icon={RefreshCw} className="search-rebuild" onClick={() => void rebuild()} disabled={status?.running}>
                  {t("set.search.rebuild")}
                </Button>
              </div>
              {p && p.private_skipped > 0 && <StatusNote tone="neutral">{t("set.search.privateSkipped", { n: p.private_skipped })}</StatusNote>}
              {status?.offline && <StatusNote tone="warning">{t("set.search.offline")}</StatusNote>}
              {status?.error && !status.offline && <StatusNote tone="danger">{status.error}</StatusNote>}
            </div>
          </Row>
        )}
        {!active && sw.model && !sw.on && (
          <div className="search-note">
            <StatusNote tone="neutral">{t("set.search.offHint")}</StatusNote>
          </div>
        )}
      </Group>
    </>
  );
}
