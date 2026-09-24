// Add or edit an AI provider (Settings → KI): kind, address, key (credential store), local
// flag, proxy bypass, Azure's API version and deployments, a step-by-step connection test and,
// for Ollama, downloading models.

import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Download, Eye, EyeOff, KeyRound, MinusCircle, PlugZap, Trash2, XCircle } from "lucide-react";
import { api, on } from "../../lib/api";
import { useApp } from "../../store/app";
import { Badge, Button, Dialog, Field, IconButton, Input, Progress, Select, Switch } from "../../components/ui";
import { KIND_LABELS, URL_HINTS, isLoopback, needsKey, providerName, validateProvider } from "../../lib/providers";
import type { AiProvider, ProviderKind, ProviderTest, ProviderTestStep, PullProgress } from "../../lib/types";

const STEP_LABELS: Record<ProviderTestStep["id"], string> = {
  reach: "Erreichbar",
  auth: "Zugang",
  chat: "Chat",
  tools: "Werkzeuge",
  embed: "Embeddings",
};

/** Comma or line separated names → list. */
const splitNames = (s: string) =>
  s
    .split(/[,\n]/)
    .map((x) => x.trim())
    .filter(Boolean);

export function ProviderDialog({
  initial,
  isNew,
  keySet,
  hint,
  onClose,
  onSave,
}: {
  initial: AiProvider;
  isNew: boolean;
  /** A key is stored for this provider. */
  keySet: boolean;
  /** Help text of the preset. */
  hint?: string;
  onClose: () => void;
  /** The provider as edited; the key was already stored when one was entered. */
  onSave: (p: AiProvider) => void;
}) {
  const s = useApp.getState;
  const [p, setP] = useState(initial);
  const [key, setKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [hasKey, setHasKey] = useState(keySet);
  const [names, setNames] = useState(initial.models.join(", "));
  const [test, setTest] = useState<ProviderTest | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const error = validateProvider(p);
  const withNames = (): AiProvider => ({ ...p, models: splitNames(names) });
  const set = (patch: Partial<AiProvider>) => {
    setP((cur) => ({ ...cur, ...patch }));
    setTest(null);
  };
  const setKind = (kind: ProviderKind) => {
    const patch: Partial<AiProvider> = { kind };
    if (kind === "ollama" && !p.base_url.trim()) patch.base_url = "http://localhost:11434";
    if (kind === "azure" && !p.api_version.trim()) patch.api_version = "2024-10-21";
    set(patch);
  };
  const setUrl = (base_url: string) => {
    // A server on this machine is reached directly; the switch stays editable.
    const loop = isLoopback(base_url);
    set(loop !== isLoopback(p.base_url) ? { base_url, bypass_proxy: loop } : { base_url });
  };

  const storeKey = async (value: string | null) => {
    const v = await api.setProviderKey(p.id, value);
    s().set({ settings: v });
    setHasKey(value !== null);
    setKey("");
    s().toast({ tone: "success", title: value ? "API-Token gespeichert" : "API-Token entfernt", detail: v.api_key_storage });
  };

  const runTest = async () => {
    if (error) return;
    setTesting(true);
    try {
      setTest(await api.testProvider(withNames(), key.trim() || null));
    } catch (e) {
      setTest({ steps: [{ id: "reach", ok: false, detail: String(e), latency_ms: 0 }], models: [], model: null });
    } finally {
      setTesting(false);
    }
  };

  const submit = async () => {
    if (error) return;
    setSaving(true);
    try {
      if (key.trim()) await storeKey(key.trim());
      onSave(withNames());
    } catch (e) {
      s().error("Schlüssel konnte nicht gespeichert werden", e);
    } finally {
      setSaving(false);
    }
  };

  const keyNeeded = needsKey(p);
  return (
    <Dialog
      open
      onClose={onClose}
      width={560}
      title={isNew ? `${providerName(p)} hinzufügen` : `${providerName(p)} bearbeiten`}
      description={hint}
      footer={
        <>
          <Button icon={PlugZap} onClick={runTest} loading={testing} disabled={!!error} className="provider-test-btn">
            Verbindung testen
          </Button>
          <span className="grow" />
          <Button variant="ghost" onClick={onClose}>
            Abbrechen
          </Button>
          <Button variant="primary" onClick={submit} loading={saving} disabled={!!error}>
            {isNew ? "Hinzufügen" : "Übernehmen"}
          </Button>
        </>
      }
    >
      <form
        className="provider-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="provider-form-row">
          <Field label="Art">
            <Select value={p.kind} onChange={(e) => setKind(e.target.value as ProviderKind)} aria-label="Art des Anbieters">
              {(Object.keys(KIND_LABELS) as ProviderKind[]).map((k) => (
                <option key={k} value={k}>
                  {KIND_LABELS[k]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Name">
            <Input value={p.name} onChange={(e) => set({ name: e.target.value })} placeholder={KIND_LABELS[p.kind]} aria-label="Name des Anbieters" />
          </Field>
        </div>
        <Field label="Adresse" hint={error && p.base_url.trim() ? <span className="field-error">{error}</span> : URL_HINTS[p.kind]}>
          <Input value={p.base_url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" aria-label="Server-URL" data-autofocus spellCheck={false} />
        </Field>
        {p.kind === "azure" && (
          <div className="provider-form-row">
            <Field label="API-Version">
              <Input value={p.api_version} onChange={(e) => set({ api_version: e.target.value })} placeholder="2024-10-21" aria-label="API-Version" />
            </Field>
            <Field label="Deployments" hint="Namen der Deployments, mit Komma getrennt">
              <Input value={names} onChange={(e) => setNames(e.target.value)} placeholder="gpt-4o, text-embedding-3-small" aria-label="Deployments" />
            </Field>
          </div>
        )}
        {p.kind !== "ollama" && (
          <div className="field">
            <span className="field-label provider-key-label">
              {p.kind === "azure" ? "API-Schlüssel (api-key)" : "API-Schlüssel"}
              {hasKey ? <Badge tone="success">Hinterlegt</Badge> : keyNeeded ? <Badge tone="warning">Fehlt</Badge> : <Badge>Nicht nötig</Badge>}
            </span>
            <div className="provider-key">
              <div className="key-input">
                <KeyRound size={14} className="faint" />
                <input
                  type={showKey ? "text" : "password"}
                  value={key}
                  onChange={(e) => (setKey(e.target.value), setTest(null))}
                  placeholder={hasKey ? "Neuen Schlüssel eingeben, um ihn zu ersetzen" : p.kind === "litellm" ? "sk-… (Virtual Key oder Master Key)" : "sk-…"}
                  aria-label="API-Token"
                  autoComplete="off"
                  spellCheck={false}
                />
                <IconButton icon={showKey ? EyeOff : Eye} label={showKey ? "Verbergen" : "Anzeigen"} size="sm" onClick={() => setShowKey(!showKey)} />
              </div>
              {hasKey && <IconButton icon={Trash2} label="Token entfernen" onClick={() => void storeKey(null).catch((e) => s().error("Schlüssel konnte nicht entfernt werden", e))} />}
            </div>
            <span className="field-hint">Wird im Schlüsselspeicher des Systems abgelegt, nie in den Einstellungen oder im Export.</span>
          </div>
        )}
        <div className="provider-switches">
          <label className="provider-switch">
            <span>
              <span className="provider-switch-label">Lokal</span>
              <span className="provider-switch-desc">Läuft auf diesem Rechner oder im eigenen Netz: bekommt auch vertrauliche Inhalte (#privat, „Nur lokal“), Kosten 0.</span>
            </span>
            <Switch checked={p.local} onChange={(v) => set({ local: v })} label="Lokaler Anbieter" />
          </label>
          <label className="provider-switch">
            <span>
              <span className="provider-switch-label">Proxy umgehen</span>
              <span className="provider-switch-desc">Direkt verbinden statt über den Proxy aus Einstellungen → Netzwerk.</span>
            </span>
            <Switch checked={p.bypass_proxy} onChange={(v) => set({ bypass_proxy: v })} label="Proxy umgehen" />
          </label>
        </div>
        {p.kind !== "azure" && p.kind !== "ollama" && (
          <details className="provider-more">
            <summary>Weitere Modelle</summary>
            <Field label="Zusätzliche Modellnamen" hint="Für Server, die nicht alle Modelle auflisten. Mit Komma getrennt.">
              <Input value={names} onChange={(e) => setNames(e.target.value)} placeholder="meta-llama/llama-3.3-70b-instruct" aria-label="Zusätzliche Modelle" />
            </Field>
          </details>
        )}
        {test && <TestResult test={test} />}
        {p.kind === "ollama" && <OllamaModels provider={withNames()} models={test?.models ?? null} onPulled={runTest} />}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

function TestResult({ test }: { test: ProviderTest }) {
  return (
    <ul className="provider-test" aria-label="Testergebnis">
      {test.steps.map((st) => (
        <li key={st.id} className={st.ok === true ? "ok" : st.ok === false ? "fail" : "skip"} data-step={st.id}>
          {st.ok === true ? <CheckCircle2 size={14} /> : st.ok === false ? <XCircle size={14} /> : <MinusCircle size={14} />}
          <span className="provider-test-label">{STEP_LABELS[st.id]}</span>
          <span className="provider-test-detail" title={st.detail}>
            {st.detail}
          </span>
          {st.ok !== null && st.latency_ms > 0 && <span className="provider-test-ms">{st.latency_ms} ms</span>}
        </li>
      ))}
    </ul>
  );
}

/** Ollama: the models it has and downloading another one (`/api/pull`) with progress. */
function OllamaModels({ provider, models, onPulled }: { provider: AiProvider; models: string[] | null; onPulled: () => void }) {
  const s = useApp.getState;
  const [name, setName] = useState("");
  const [progress, setProgress] = useState<PullProgress | null>(null);
  const rid = useRef("");
  useEffect(() => {
    const un = on<PullProgress>("ai://pull", (p) => p.request_id === rid.current && setProgress(p));
    return () => void un.then((f) => f());
  }, []);
  const pull = async () => {
    const model = name.trim();
    if (!model) return;
    rid.current = `pull-${Date.now()}`;
    setProgress({ request_id: rid.current, status: "Starte…", total: null, completed: null });
    try {
      await api.pullOllama(rid.current, provider, model);
      s().toast({ tone: "success", title: `„${model}“ geladen` });
      setName("");
      onPulled();
    } catch (e) {
      s().error(`„${model}“ konnte nicht geladen werden`, e);
    } finally {
      setProgress(null);
    }
  };
  const share = progress?.total ? (progress.completed ?? 0) / progress.total : 0;
  return (
    <div className="field ollama-pull">
      <span className="field-label">Modell laden</span>
      {models && <span className="field-hint">{models.length ? `Vorhanden: ${models.join(", ")}` : "Noch keine Modelle geladen."}</span>}
      <div className="provider-key">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="z. B. llama3.2, qwen2.5:7b, nomic-embed-text"
          aria-label="Modell laden"
          onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), void pull())}
          disabled={!!progress}
        />
        <Button icon={Download} onClick={pull} loading={!!progress} disabled={!name.trim()}>
          Laden
        </Button>
        {progress && <IconButton icon={XCircle} label="Download abbrechen" onClick={() => void api.cancelChat(rid.current)} />}
      </div>
      {progress && (
        <div className="ollama-progress" role="status">
          <Progress value={share} />
          <span className="small faint">
            {progress.status}
            {progress.total ? ` · ${Math.round(share * 100)} %` : ""}
          </span>
        </div>
      )}
    </div>
  );
}
