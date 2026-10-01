// Settings → KI: the AI providers (status, add/edit, Ollama detection), which provider and
// model each tier uses, and the price table for providers that do not report costs.

import { useContext, useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Cloud, Cpu, MoreHorizontal, Pencil, Plus, RefreshCw, RotateCcw, Server, Trash2 } from "lucide-react";
import { api } from "../../lib/api";
import { useApp } from "../../store/app";
import { Badge, Button, IconButton, Input, Select, Switch, useMenu } from "../../components/ui";
import { t as tr, useT, type TKey } from "../../lib/i18n";
import { numberLocale } from "../../lib/format";
import {
  KIND_LABELS,
  PRESETS,
  autoAssignTiers,
  findProvider,
  fromPreset,
  localTierNotLocal,
  missingTiers,
  needsKey,
  priceFor,
  providerName,
  setTier,
  tierRef,
  type ProviderPreset,
} from "../../lib/providers";
import type { AiProvider, ConnectionTest, EmbeddingStatus, OllamaDetect, PriceRule, RouterConfig, Settings, Tier } from "../../lib/types";
import { FilterContext, Group, NumberInput, Row, Unfiltered, matches, type SectionProps } from "./common";
import { ProviderDialog } from "./ProviderDialog";

type Status = { state: "checking" } | { state: "done"; test: ConnectionTest };

const TIER_ROWS: { tier: Tier; label: "set.ai.local" | "set.ai.standard" | "set.ai.reasoning"; aria: TKey }[] = [
  { tier: "local", label: "set.ai.local", aria: "aip.aria.local" },
  { tier: "standard", label: "set.ai.standard", aria: "aip.aria.standard" },
  { tier: "reasoning", label: "set.ai.reasoning", aria: "aip.aria.reasoning" },
];

export function AiProvidersSection({ draft, update }: SectionProps) {
  const t = useT();
  const view = useApp((s) => s.settings)!;
  const [status, setStatus] = useState<Record<string, Status>>({});
  const [editing, setEditing] = useState<{ provider: AiProvider; isNew: boolean; hint?: string } | null>(null);
  const [ollama, setOllama] = useState<OllamaDetect | null>(null);
  const [round, setRound] = useState(0);
  const [menu, , openMenuAt] = useMenu();
  const providers = draft.providers;
  const router = draft.router;
  const setRouter = (p: Partial<RouterConfig>) => update({ router: { ...router, ...p } });
  const setProviders = (next: AiProvider[]) => update({ providers: next });

  // Status and model list of every provider; again when a provider or a key changes.
  const watch = JSON.stringify([providers, view.provider_keys, round]);
  useEffect(() => {
    let live = true;
    for (const p of providers) {
      if (!p.enabled) continue;
      setStatus((cur) => ({ ...cur, [p.id]: { state: "checking" } }));
      api
        .providerModels(p)
        .catch((e): ConnectionTest => ({ ok: false, latency_ms: 0, models: [], embedding_models: [], error: String(e) }))
        .then((test) => live && setStatus((cur) => ({ ...cur, [p.id]: { state: "done", test } })));
    }
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watch]);

  // An Ollama on this machine that is not configured yet is offered.
  const hasOllama = providers.some((p) => p.kind === "ollama");
  useEffect(() => {
    if (hasOllama) return setOllama(null);
    let live = true;
    api.detectOllama().then(
      (d) => live && setOllama(d.found ? d : null),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [hasOllama]);

  const lists: Record<string, string[]> = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const [id, st] of Object.entries(status)) if (st.state === "done" && st.test.ok) out[id] = st.test.models;
    return out;
  }, [status]);
  // The models of each provider that compute embeddings: the only ones the embedding picker offers.
  const embedLists: Record<string, string[]> = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const [id, st] of Object.entries(status)) if (st.state === "done" && st.test.ok) out[id] = st.test.embedding_models ?? [];
    return out;
  }, [status]);

  // Whether the saved embedding model is used by the assistant (a chat model or one that failed is not).
  const [embedStatus, setEmbedStatus] = useState<EmbeddingStatus | null>(null);
  const savedEmbed = `${view.settings.embedding_provider}/${view.settings.embedding_model ?? ""}`;
  useEffect(() => {
    let live = true;
    api.embeddingStatus().then(
      (st) => live && setEmbedStatus(st),
      () => live && setEmbedStatus(null),
    );
    return () => {
      live = false;
    };
  }, [savedEmbed, round]);
  const embedProblem =
    embedStatus && !embedStatus.usable && embedStatus.reason && embedStatus.model === draft.embedding_model && embedStatus.provider === draft.embedding_provider ? embedStatus.reason : null;

  const add = (preset: ProviderPreset) => setEditing({ provider: fromPreset(preset, providers), isNew: true, hint: preset.hint });
  const addMenu = (e: React.MouseEvent) =>
    openMenuAt(
      e,
      // Every entry has an icon: this computer, a cloud service, or a gateway/server of your own.
      PRESETS.map((p) => ({ label: p.label, icon: p.local ? Cpu : p.key === "litellm" || p.key === "custom" ? Server : Cloud, onSelect: () => add(p) })),
    );
  const move = (i: number, d: -1 | 1) => {
    const next = [...providers];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    setProviders(next);
  };
  const saveProvider = (p: AiProvider) => {
    const i = providers.findIndex((x) => x.id === p.id);
    const next = i >= 0 ? providers.map((x, j) => (j === i ? p : x)) : [...providers, p];
    const patch: Partial<Settings> = { providers: next };
    // The first provider of a fresh list takes the tiers that point nowhere.
    if (!providers.length) patch.router = { ...router, local_provider: p.id, standard_provider: p.id, reasoning_provider: p.id };
    update(patch);
    setEditing(null);
    setRound((r) => r + 1);
  };
  const rowMenu = (e: React.MouseEvent, p: AiProvider, i: number) =>
    openMenuAt(e, [
      { label: t("set.ai.editProvider"), icon: Pencil, onSelect: () => setEditing({ provider: p, isNew: false }) },
      { label: t("common.up"), icon: ArrowUp, disabled: i === 0, onSelect: () => move(i, -1) },
      { label: t("common.down"), icon: ArrowDown, disabled: i === providers.length - 1, onSelect: () => move(i, 1) },
      "separator",
      { label: t("common.remove"), icon: Trash2, danger: true, onSelect: () => setProviders(providers.filter((x) => x.id !== p.id)) },
    ]);

  const missing = missingTiers(router, providers, lists).filter((tier) => {
    // Only tiers whose provider answered (unknown lists are not "missing").
    const p = findProvider(providers, tierRef(router, tier).provider);
    return !p || !p.enabled || !!lists[p.id];
  });
  const cloudLocal = localTierNotLocal(draft);

  return (
    <>
      <Group title={t("set.ai.providers")} description={t("aip.providersDesc")}>
        {ollama && (
          <Unfiltered>
            <div className="provider-found" role="status">
              <Cpu size={15} />
              <span title={ollama.url}>
                <strong>{t("set.ai.ollamaFound")}</strong>
                <span className="faint"> · {t("aip.modelCount", { n: ollama.models.length })}</span>
              </span>
              <Button size="sm" variant="primary" icon={Plus} onClick={() => add(PRESETS.find((p) => p.key === "ollama")!)}>
                {t("common.add")}
              </Button>
            </div>
          </Unfiltered>
        )}
        {providers.map((p, i) => (
          <ProviderRow
            key={p.id}
            provider={p}
            status={status[p.id]}
            keySet={view.provider_keys.includes(p.id)}
            onToggle={(enabled) => setProviders(providers.map((x) => (x.id === p.id ? { ...x, enabled } : x)))}
            onEdit={() => setEditing({ provider: p, isNew: false })}
            onMenu={(e) => rowMenu(e, p, i)}
          />
        ))}
        <Unfiltered>
          {!providers.length && <p className="faint small provider-empty">{t("aip.none")}</p>}
          <div className="provider-actions">
            <Button icon={Plus} onClick={addMenu} aria-haspopup="menu">
              {t("set.ai.addProvider")}
            </Button>
            <IconButton icon={RefreshCw} label={t("set.ai.checkProviders")} onClick={() => setRound((r) => r + 1)} />
          </div>
        </Unfiltered>
      </Group>

      <Group title={t("set.ai.models")} description={t("aip.modelsDesc")}>
        {missing.length > 0 && Object.keys(lists).length > 0 && (
          <div className="warn-note model-missing" role="status">
            <span>
              {t("aip.missing", { n: missing.length, list: missing.map((tier) => tierRef(router, tier).model || t("aip.empty")).join(", ") })}
            </span>
            <Button variant="secondary" size="sm" onClick={() => setRouter(autoAssignTiers(router, providers, lists))}>
              {t("aip.autoAssign")}
            </Button>
          </div>
        )}
        <Row label={t("set.ai.autoRoute")} description={t("aip.autoRouteDesc")}>
          <Switch checked={draft.auto_route} onChange={(v) => update({ auto_route: v })} label={t("aip.autoRouteAria")} />
        </Row>
        {TIER_ROWS.map(({ tier, label, aria }) => {
          const r = tierRef(router, tier);
          const desc =
            tier === "local"
              ? cloudLocal && providers.length > 1
                ? t("aip.localNotLocal", { name: providerName(cloudLocal) })
                : t("aip.localDesc")
              : tier === "standard"
                ? draft.auto_route
                  ? t("aip.standardDesc")
                  : t("aip.standardAll")
                : t("aip.reasoningDesc");
          return (
            <Row key={tier} label={t(label)} description={desc} keywords="Modell Anbieter">
              <ModelPicker label={t(aria)} providers={providers} lists={lists} embedLists={embedLists} value={r} prices={draft.prices} onChange={(v) => setRouter(setTier(tier, v.provider, v.model))} />
            </Row>
          );
        })}
        <Row
          label={t("set.ai.embeddings")}
          description={t("aip.embedDesc")}
          keywords="Modell Anbieter Stichwortsuche"
        >
          <ModelPicker
            label={t("aip.embedModel")}
            providers={providers}
            lists={lists}
            embedLists={embedLists}
            value={{ provider: draft.embedding_provider, model: draft.embedding_model ?? "" }}
            onChange={(v) => update({ embedding_provider: v.provider, embedding_model: v.model || null })}
            problem={embedProblem}
            embedding
          />
        </Row>
      </Group>

      <PriceGroup draft={draft} update={update} />

      {menu}
      {editing && (
        <ProviderDialog
          initial={editing.provider}
          isNew={editing.isNew}
          hint={editing.hint}
          keySet={view.provider_keys.includes(editing.provider.id)}
          onClose={() => {
            setEditing(null);
            // A key stored or removed in the dialog changes the status.
            setRound((r) => r + 1);
          }}
          onSave={saveProvider}
        />
      )}
    </>
  );
}

function ProviderRow({
  provider: p,
  status,
  keySet,
  onToggle,
  onEdit,
  onMenu,
}: {
  provider: AiProvider;
  status: Status | undefined;
  keySet: boolean;
  onToggle: (v: boolean) => void;
  onEdit: () => void;
  onMenu: (e: React.MouseEvent) => void;
}) {
  const t = useT();
  const query = useContext(FilterContext);
  if (!matches(query, providerName(p), p.base_url, KIND_LABELS[p.kind], t("set.ai.providers"))) return null;
  const name = providerName(p);
  const test = status?.state === "done" ? status.test : null;
  const tone = !p.enabled ? "off" : !test ? "checking" : test.ok ? "ok" : "fail";
  return (
    <div className={`set-row provider-row ${p.enabled ? "" : "disabled"}`} data-provider={p.id}>
      <span className={`provider-dot ${tone}`} aria-hidden />
      <div className="set-row-text">
        <div className="set-row-label provider-name">
          {name}
          {p.local && <Badge tone="success">{t("set.ai.localBadge")}</Badge>}
          {p.enabled && needsKey(p) && !keySet && <Badge tone="warning">{t("set.ai.noKey")}</Badge>}
        </div>
        <div className="set-row-desc provider-meta">
          <span className={`conn ${tone === "ok" ? "ok" : tone === "fail" ? "fail" : ""}`} title={test ? (test.error ?? t("aip.ms", { n: test.latency_ms })) : ""}>
            {!p.enabled ? t("set.ai.off") : !test ? t("common.checking") : test.ok ? t("set.ai.connected", { n: test.models.length }) : t("set.ai.noConnection")}
          </span>
          <span>{KIND_LABELS[p.kind]}</span>
          <span className="mono provider-url" title={p.base_url}>
            {p.base_url}
          </span>
        </div>
      </div>
      <div className="set-row-control">
        <Switch checked={p.enabled} onChange={onToggle} label={`${name}: ${t("set.ai.providerActive")}`} />
        <IconButton icon={Pencil} label={t("aip.edit", { name })} onClick={onEdit} />
        <IconButton icon={MoreHorizontal} label={t("aip.more", { name })} aria-haspopup="menu" onClick={onMenu} />
      </div>
    </div>
  );
}

/** Provider and model of a tier (or of the embeddings); the provider select only with several providers. */
function ModelPicker({
  label,
  providers,
  lists,
  embedLists,
  value,
  onChange,
  prices,
  problem,
  embedding,
}: {
  label: string;
  providers: AiProvider[];
  lists: Record<string, string[]>;
  embedLists: Record<string, string[]>;
  value: { provider: string; model: string };
  onChange: (v: { provider: string; model: string }) => void;
  prices?: PriceRule[];
  /** Why the chosen model is not used (embeddings: a chat model, or it failed). */
  problem?: string | null;
  embedding?: boolean;
}) {
  const provider = findProvider(providers, value.provider);
  const pid = provider?.id ?? "";
  const all = lists[pid] ?? [];
  const embeds = embedLists[pid] ?? [];
  // Embeddings: only embedding models; tiers: everything else.
  const models = embedding ? embeds : all.filter((m) => !embeds.includes(m) || m === value.model);
  // A chat model chosen as embedding model (older settings) stays visible, marked.
  const notEmbedding = !!embedding && !!value.model && all.includes(value.model) && !embeds.includes(value.model);
  const missing = !!value.model && all.length > 0 && !all.includes(value.model);
  const price = prices && value.model ? priceFor(prices, provider, value.model) : null;
  useT();
  const perM = (x: number) => x.toLocaleString(numberLocale(), { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 3 });
  return (
    <div className="model-picker">
      <div className="model-picker-row">
        {providers.length > 1 && (
          <Select
            value={pid}
            onChange={(e) => {
              const id = e.target.value;
              const list = embedding ? (embedLists[id] ?? []) : (lists[id] ?? []).filter((m) => !(embedLists[id] ?? []).includes(m));
              const keep = list.includes(value.model) ? value.model : (list[0] ?? (embedding ? "" : value.model));
              onChange({ provider: id, model: keep });
            }}
            aria-label={tr("aip.providerFor", { label })}
            className="model-picker-provider"
          >
            {!provider && <option value="">{tr("aip.chooseProvider")}</option>}
            {providers.map((p) => (
              <option key={p.id} value={p.id} disabled={!p.enabled && p.id !== pid}>
                {providerName(p)}
                {p.enabled ? "" : ` (${tr("set.ai.off")})`}
              </option>
            ))}
          </Select>
        )}
        {models.length || (embedding && all.length) ? (
          <Select value={value.model} onChange={(e) => onChange({ provider: pid, model: e.target.value })} aria-label={label} className="model-picker-model">
            {embedding && <option value="">{tr("aip.noneKeyword")}</option>}
            {!embedding && !value.model && <option value="">{tr("aip.chooseModel")}</option>}
            {missing && <option value={value.model}>{tr("aip.notAtProvider", { model: value.model })}</option>}
            {notEmbedding && <option value={value.model}>{tr("aip.notEmbedding", { model: value.model })}</option>}
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </Select>
        ) : (
          <Input
            value={value.model}
            onChange={(e) => onChange({ provider: pid, model: e.target.value })}
            placeholder={embedding ? tr("aip.noneKeyword") : tr("aip.modelName")}
            aria-label={label}
            className="model-picker-model"
          />
        )}
      </div>
      {missing ? (
        <span className="warn-note small">{tr("aip.modelMissing")}</span>
      ) : notEmbedding ? (
        <span className="warn-note small">{tr("aip.chatNotEmbed")}</span>
      ) : problem ? (
        <span className="warn-note small embed-problem">{problem}</span>
      ) : embedding && all.length > 0 && !embeds.length ? (
        <span className="faint small">{tr("aip.noEmbedModels")}</span>
      ) : (
        price && !embedding && <span className="faint small model-picker-price">{provider?.local ? tr("aip.freeLocal") : tr("aip.perMTok", { input: perM(price.input), output: perM(price.output) })}</span>
      )}
    </div>
  );
}

function PriceGroup({ draft, update }: SectionProps) {
  const t = useT();
  const s = useApp.getState;
  const rules = draft.prices;
  const set = (i: number, patch: Partial<PriceRule>) => update({ prices: rules.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  const defaults = async () => {
    try {
      const d = await api.settingsDefaults("ai");
      update({ prices: d.prices });
    } catch (e) {
      s().error(t("aip.defaultsFailed"), e);
    }
  };
  return (
    <Group title={t("set.ai.prices")} description={t("aip.pricesDesc")}>
      <Row
        stack
        label={t("set.ai.priceTable")}
        description={t("aip.priceTableDesc")}
        keywords="Kosten Preis Tokens"
      >
        <div className="price-editor">
          <div className="price-table" role="table" aria-label={t("set.ai.priceTable")}>
            <div className="price-row price-head" role="row">
              <span role="columnheader">{t("set.ai.model")}</span>
              <span role="columnheader">{t("set.ai.provider")}</span>
              <span role="columnheader">{t("set.ai.input")}</span>
              <span role="columnheader">{t("set.ai.output")}</span>
              <span />
            </div>
            {rules.map((r, i) => (
              <div className="price-row" role="row" key={i}>
                <Input value={r.model} onChange={(e) => set(i, { model: e.target.value })} placeholder="gpt-4o*" aria-label={t("aip.row.model", { n: i + 1 })} className="mono" />
                <Select value={r.provider} onChange={(e) => set(i, { provider: e.target.value })} aria-label={t("aip.row.provider", { n: i + 1 })}>
                  <option value="">{t("set.ai.anyProvider")}</option>
                  {draft.providers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {providerName(p)}
                    </option>
                  ))}
                  {r.provider && !draft.providers.some((p) => p.id === r.provider) && <option value={r.provider}>{r.provider}</option>}
                </Select>
                <NumberInput value={r.input_per_mtok} min={0} max={1000} step={0.01} onCommit={(v) => set(i, { input_per_mtok: v })} aria-label={t("aip.row.input", { n: i + 1 })} />
                <NumberInput value={r.output_per_mtok} min={0} max={1000} step={0.01} onCommit={(v) => set(i, { output_per_mtok: v })} aria-label={t("aip.row.output", { n: i + 1 })} />
                <IconButton icon={Trash2} label={t("aip.row.remove", { n: i + 1 })} size="sm" onClick={() => update({ prices: rules.filter((_, j) => j !== i) })} />
              </div>
            ))}
          </div>
          <div className="provider-actions">
            <Button icon={Plus} size="sm" onClick={() => update({ prices: [...rules, { provider: "", model: "", input_per_mtok: 0, output_per_mtok: 0 }] })}>
              {t("set.ai.addPrice")}
            </Button>
            <Button icon={RotateCcw} size="sm" variant="ghost" onClick={defaults}>
              {t("set.ai.defaultPrices")}
            </Button>
          </div>
        </div>
      </Row>
    </Group>
  );
}
