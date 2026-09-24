// Settings → Netzwerk: proxy (none, system, manual, PAC), exceptions, proxy credentials,
// an additional root CA, timeouts, which connections use it, and a connection test.

import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Eye, EyeOff, FileKey2, KeyRound, Loader2, PlugZap, Trash2, XCircle } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Badge, Button, IconButton, Input, Segmented, Switch, TextArea } from "../../components/ui";
import { api, errorText } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { UPDATE_URL, resolvePac } from "../../lib/pac";
import { useApp } from "../../store/app";
import type { NetworkSettings, NetworkStatus, NetworkTest, ProxyMode, Settings } from "../../lib/types";
import { Group, NumberInput, Row, SectionHead, Unfiltered, type SectionProps } from "./common";

/** Evaluates the PAC for the app's hosts and returns the settings with the answers. */
export async function withPacResults(s: Settings): Promise<Settings> {
  const net = s.network;
  if (net.mode !== "pac" || !net.pac_url.trim()) return s;
  const pac = await api.fetchPac(net.pac_url.trim(), net);
  const providers = s.providers.filter((p) => p.enabled).map((p) => p.base_url);
  const others = [UPDATE_URL, s.git_sync.remote_url, ...providers].filter((u) => /^https?:\/\//i.test(u));
  const pac_results = await resolvePac(pac, s.litellm_base_url, others);
  return { ...s, network: { ...net, pac_results } };
}

export function NetworkSection({ draft, update }: SectionProps) {
  const t = useT();
  const net = draft.network;
  const set = (p: Partial<NetworkSettings>) => update({ network: { ...net, ...p } });
  const [status, setStatus] = useState<NetworkStatus | null>(null);
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [test, setTest] = useState<NetworkTest | null>(null);
  const [testing, setTesting] = useState(false);
  const [pacError, setPacError] = useState<string | null>(null);
  const [caError, setCaError] = useState<string | null>(null);
  const [ca, setCa] = useState<NetworkStatus["ca"]>(null);
  const s = useApp.getState;

  const reload = () =>
    api.networkStatus().then((st) => {
      setStatus(st);
      if (net.extra_ca_path) {
        setCa(st.ca);
        setCaError(st.ca_error);
      }
    }, () => setStatus(null));
  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!net.extra_ca_path) {
      setCa(null);
      setCaError(null);
      return;
    }
    api.caInfo(net.extra_ca_path).then((i) => (setCa(i), setCaError(null)), (e) => (setCa(null), setCaError(errorText(e))));
  }, [net.extra_ca_path]);

  const savePassword = async (value: string | null) => {
    try {
      setStatus(await api.setProxyPassword(value));
      setPassword("");
      s().toast({ tone: "success", title: value ? t("net.passwordSaved") : t("net.passwordRemoved") });
    } catch (e) {
      s().error(t("net.passwordFailed"), e);
    }
  };

  const runTest = async () => {
    setTesting(true);
    setPacError(null);
    try {
      let settings = draft;
      if (net.mode === "pac") {
        try {
          settings = await withPacResults(draft);
          update({ network: settings.network });
        } catch (e) {
          setPacError(errorText(e));
          throw e;
        }
      }
      setTest(await api.networkTest(settings.network, settings.litellm_base_url, password.trim() || null));
    } catch (e) {
      setTest({ ok: false, url: `${draft.litellm_base_url}/v1/models`, proxy: null, status: null, latency_ms: 0, error: errorText(e) });
    } finally {
      setTesting(false);
    }
  };

  const pickCa = async () => {
    const r = await openDialog({ multiple: false, directory: false, title: t("net.caPick"), filters: [{ name: t("net.caFiles"), extensions: ["pem", "crt", "cer", "der"] }] });
    if (typeof r === "string") set({ extra_ca_path: r });
  };

  const sys = status?.system;
  const modes: { value: ProxyMode; label: string }[] = [
    { value: "none", label: t("net.none") },
    { value: "system", label: t("net.system") },
    { value: "manual", label: t("net.manual") },
    { value: "pac", label: "PAC" },
  ];
  const usesProxy = net.mode !== "none";
  return (
    <>
      <SectionHead title={t("set.network.title")} intro={t("set.network.intro")} />
      <Group title={t("net.proxy")}>
        <Row label={t("net.mode")}>
          <Segmented label={t("net.mode")} value={net.mode} options={modes} onChange={(v) => set({ mode: v })} />
        </Row>
        {net.mode === "system" && (
          <Row
            label={t("net.systemProxy")}
            description={
              sys ? (
                <span className="net-system">
                  {sys.https || sys.http || sys.socks ? (
                    <>
                      <span className="mono">{[...new Set([sys.http, sys.https, sys.socks].filter(Boolean))].join(" · ")}</span>
                      {sys.bypass && <span className="faint"> · {t("net.exceptions")}: {sys.bypass.split(/[,;\s]+/).filter(Boolean).join(", ")}</span>}
                    </>
                  ) : (
                    <span>{t("net.systemDirect")}</span>
                  )}
                  <span className="faint"> ({sys.source})</span>
                  {sys.pac_url && <span className="warn-note"> {t("net.systemPac", { url: sys.pac_url })}</span>}
                </span>
              ) : undefined
            }
          >
            <span />
          </Row>
        )}
        {net.mode === "manual" && (
          <>
            <Row label={t("net.httpProxy")} description={t("net.hostPort")}>
              <Input value={net.http_proxy} onChange={(e) => set({ http_proxy: e.target.value })} placeholder="proxy.firma.de:8080" aria-label={t("net.httpProxy")} className="mono w-360" />
            </Row>
            <Row label={t("net.httpsProxy")} description={t("net.httpsProxyDesc")}>
              <Input value={net.https_proxy} onChange={(e) => set({ https_proxy: e.target.value })} placeholder={net.http_proxy || "proxy.firma.de:8080"} aria-label={t("net.httpsProxy")} className="mono w-360" />
            </Row>
            <Row label={t("net.socksProxy")} description={t("net.socksProxyDesc")}>
              <Input value={net.socks_proxy} onChange={(e) => set({ socks_proxy: e.target.value })} placeholder="socks5://socks.firma.de:1080" aria-label={t("net.socksProxy")} className="mono w-360" />
            </Row>
          </>
        )}
        {net.mode === "pac" && (
          <Row stack label={t("net.pacUrl")} description={t("net.pacDesc")}>
            <Input value={net.pac_url} onChange={(e) => set({ pac_url: e.target.value })} placeholder="http://wpad.firma.de/proxy.pac" aria-label={t("net.pacUrl")} className="mono grow" />
          </Row>
        )}
        {net.mode === "pac" && (
          <Unfiltered>
            {Object.keys(net.pac_results).length > 0 && (
              <div className="pac-results small">
                {Object.entries(net.pac_results).map(([host, answer]) => (
                  <div key={host} className="pac-result">
                    <span className="mono">{host === "*" ? t("net.pacDefault") : host}</span>
                    <span className="faint">→</span>
                    <span className="mono">{answer}</span>
                  </div>
                ))}
              </div>
            )}
            {pacError && <p className="error-note small">{t("net.pacError", { error: pacError })}</p>}
          </Unfiltered>
        )}
        {(net.mode === "manual" || net.mode === "pac") && (
          <Row stack label={t("net.noProxy")} description={t("net.noProxyDesc")}>
            <TextArea rows={2} value={net.no_proxy} onChange={(e) => set({ no_proxy: e.target.value })} placeholder="localhost, 127.0.0.1, *.firma.local, 10.0.0.0/8, <local>" aria-label={t("net.noProxy")} className="mono" />
          </Row>
        )}
      </Group>

      {usesProxy && (
        <Group title={t("net.auth")} description={t("net.authDesc")}>
          <Row label={t("net.user")}>
            <Input value={net.proxy_user} onChange={(e) => set({ proxy_user: e.target.value })} aria-label={t("net.user")} autoComplete="off" />
          </Row>
          <Row
            stack
            label={t("net.password")}
            description={
              <>
                {status?.password_set ? <Badge tone="success">{t("net.stored")}</Badge> : <Badge>{t("net.notSet")}</Badge>}
                <span>{t("net.passwordDesc")}</span>
              </>
            }
          >
            <div className="key-input">
              <KeyRound size={14} className="faint" />
              <input
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={status?.password_set ? t("net.passwordReplace") : ""}
                aria-label={t("net.password")}
                autoComplete="off"
                spellCheck={false}
                onKeyDown={(e) => e.key === "Enter" && password && savePassword(password)}
              />
              <IconButton icon={showPassword ? EyeOff : Eye} label={showPassword ? t("common.hide") : t("common.show")} size="sm" onClick={() => setShowPassword(!showPassword)} />
            </div>
            <Button variant="primary" onClick={() => savePassword(password)} disabled={!password}>
              {t("common.save")}
            </Button>
            {status?.password_set && <IconButton icon={Trash2} label={t("net.passwordRemove")} onClick={() => savePassword(null)} />}
          </Row>
        </Group>
      )}

      <Group title={t("net.certs")}>
        <Row
          label={t("net.extraCa")}
          description={
            net.extra_ca_path ? (
              <span className="net-ca">
                <span className="mono selectable">{net.extra_ca_path}</span>
                {ca && (
                  <span className="ca-info">
                    {t("net.caCount", { n: ca.count })}
                    {ca.subject ? ` · ${ca.subject}` : ""}
                    {ca.not_after ? ` · ${t("net.caUntil", { date: ca.not_after })}` : ""}
                  </span>
                )}
                {caError && <span className="mirror-error">{caError}</span>}
              </span>
            ) : (
              t("net.extraCaDesc")
            )
          }
        >
          <Button icon={FileKey2} onClick={pickCa}>
            {t("net.caChoose")}
          </Button>
          {net.extra_ca_path && (
            <Button variant="ghost" onClick={() => set({ extra_ca_path: null })}>
              {t("common.remove")}
            </Button>
          )}
        </Row>
        <Row
          label={t("net.invalidCerts")}
          description={
            <span className={net.accept_invalid_certs ? "danger-note" : ""}>
              <AlertTriangle size={13} /> {t("net.invalidCertsDesc")}
            </span>
          }
        >
          <Switch label={t("net.invalidCerts")} checked={net.accept_invalid_certs} onChange={(v) => set({ accept_invalid_certs: v })} />
        </Row>
        {net.accept_invalid_certs && (
          <Unfiltered>
            <div className="net-danger" role="alert">
              <AlertTriangle size={16} />
              <span>{t("net.invalidCertsWarning")}</span>
            </div>
          </Unfiltered>
        )}
      </Group>

      <Group title={t("net.advanced")}>
        <Row label={t("net.timeout")} description={t("net.timeoutDesc")}>
          <div className="unit-input">
            <NumberInput min={1} max={600} value={net.timeout_secs} onCommit={(v) => set({ timeout_secs: v })} aria-label={t("net.timeout")} />
            <span className="faint">{t("unit.seconds")}</span>
          </div>
        </Row>
        <Row stack label={t("net.applyTo")} description={t("net.applyToDesc")}>
          <div className="apply-to">
            {(["ai", "git", "updates", "tools"] as const).map((k) => (
              <label key={k} className="row-gap small">
                <input type="checkbox" className="check" checked={net.apply_to[k]} onChange={(e) => set({ apply_to: { ...net.apply_to, [k]: e.target.checked } })} aria-label={t(`net.apply.${k}` as const)} />
                {t(`net.apply.${k}` as const)}
              </label>
            ))}
          </div>
        </Row>
      </Group>

      <Group title={t("net.test")} description={t("net.testDesc")}>
        <Row label={t("net.testRow")} description={<span className="mono small">{`${draft.litellm_base_url}/v1/models`}</span>}>
          <div className={`conn ${test ? (test.ok ? "ok" : "fail") : ""}`}>
            {testing ? (
              <>
                <Loader2 size={14} className="spin" /> {t("common.checking")}
              </>
            ) : test ? (
              <span className="net-test-result">
                {test.ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />}{" "}
                {test.ok ? t("net.testOk", { ms: test.latency_ms }) : t("net.testFail")} · {test.proxy ? t("net.via", { proxy: test.proxy }) : t("net.direct")}
              </span>
            ) : null}
          </div>
          <Button icon={PlugZap} onClick={runTest} disabled={testing}>
            {t("net.testButton")}
          </Button>
        </Row>
        {test && !test.ok && test.error && (
          <Unfiltered>
            <p className="error-note mono small">{test.error}</p>
          </Unfiltered>
        )}
        <Unfiltered>
          <p className="faint small">{t("net.limits")}</p>
        </Unfiltered>
      </Group>
    </>
  );
}
