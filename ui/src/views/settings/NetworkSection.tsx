// Settings → Netzwerk: proxy profiles (direct, system, manual, PAC) with exceptions,
// credentials, extra root CAs and timeouts; the profile of each service with its route and
// a real test per service; servers trusted by certificate fingerprint.

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Copy, Eye, EyeOff, FileKey2, KeyRound, Loader2, Lock, Pencil, PlugZap, Plus, ShieldCheck, Trash2, XCircle } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Badge, Button, Dialog, IconButton, Input, Segmented, Select, Switch, TextArea } from "../../components/ui";
import { api, errorText } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { resolvePac } from "../../lib/pac";
import { useApp } from "../../store/app";
import { fmtDate } from "../../lib/format";
import type { CaInfo, CertDetails, NetworkSettings, NetworkStatus, NetworkTest, ProxyMode, ProxyProfile, ServiceRow, Settings } from "../../lib/types";
import { CommitInput, Group, NumberInput, Row, SectionHead, Unfiltered, type SectionProps } from "./common";
import { checkProxy, checkUrl } from "../../lib/settingsApply";
import { DEFAULT_PROFILE, addProfile, duplicateProfile, fingerprint, pacTargets, removeProfile, routeOf, routeText, setRoute, trustCertificate, untrust, updateProfile } from "../../lib/network";
import { isKey } from "../../lib/ime";

/** Evaluates the PAC of every PAC profile for the app's hosts and returns the settings with the answers. */
export async function withPacResults(s: Settings): Promise<Settings> {
  const net = s.network;
  if (!net.profiles.some((p) => p.mode === "pac" && p.pac_url.trim())) return s;
  const profiles: ProxyProfile[] = [];
  for (const p of net.profiles) {
    if (p.mode !== "pac" || !p.pac_url.trim()) {
      profiles.push(p);
      continue;
    }
    const pac = await api.fetchPac(p.pac_url.trim(), p);
    profiles.push({ ...p, pac_results: await resolvePac(pac, s.litellm_base_url, pacTargets(s)) });
  }
  return { ...s, network: { ...net, profiles } };
}

/** Whether any profile uses PAC (its answers are computed before saving). */
export const usesPac = (s: Settings) => s.network.profiles.some((p) => p.mode === "pac" && !!p.pac_url.trim());

/** `YYYY-MM-DD` of a certificate in the chosen date format. */
const day = (iso: string) => fmtDate(`${iso}T00:00:00`);

const MODE_KEY: Record<ProxyMode, "net.none" | "net.system" | "net.manual" | "net.pac"> = { none: "net.none", system: "net.system", manual: "net.manual", pac: "net.pac" };

export function NetworkSection({ draft, update }: SectionProps) {
  const t = useT();
  const net = draft.network;
  const setNet = (n: NetworkSettings) => update({ network: n });
  const [status, setStatus] = useState<NetworkStatus | null>(null);
  const [selected, setSelected] = useState<string>(DEFAULT_PROFILE);
  const [rows, setRows] = useState<ServiceRow[] | null>(null);
  const [tests, setTests] = useState<Record<string, NetworkTest | "busy">>({});
  const [cert, setCert] = useState<CertDetails | null>(null);
  const [pacError, setPacError] = useState<string | null>(null);
  const s = useApp.getState;
  const policy = status?.policy;
  const locked = !!policy?.lock_profiles;
  const profile = net.profiles.find((p) => p.id === selected) ?? net.profiles[0];

  const reload = () => api.networkStatus().then(setStatus, () => setStatus(null));
  useEffect(() => {
    reload();
  }, []);
  // The routes follow the draft (unsaved changes included).
  const netKey = JSON.stringify([net, draft.providers, draft.jira?.sites, draft.calendar?.sources, draft.git_sync?.remote_url]);
  useEffect(() => {
    let live = true;
    api.networkServices(net).then((r) => live && setRows(r), () => live && setRows(null));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [netKey]);

  const words = { via: t("net.viaProxy"), direct: t("net.direct") };
  const profileOptions = useMemo(
    () => [{ value: "", label: t("net.useDefault") }, ...net.profiles.map((p) => ({ value: p.id, label: p.name }))],
    [net.profiles, t],
  );

  const runTest = async (row: ServiceRow) => {
    setTests((m) => ({ ...m, [row.key]: "busy" }));
    setPacError(null);
    let network = net;
    try {
      if (usesPac(draft)) {
        try {
          const next = await withPacResults(draft);
          network = next.network;
          if (JSON.stringify(next.network) !== JSON.stringify(net)) setNet(next.network);
        } catch (e) {
          setPacError(errorText(e));
        }
      }
      const r = await api.networkServiceTest(row.key, network, null);
      setTests((m) => ({ ...m, [row.key]: r }));
    } catch (e) {
      setTests((m) => ({ ...m, [row.key]: { ok: false, url: row.target ?? "", proxy: null, route: null, status: null, latency_ms: 0, error: errorText(e), certificate: null } }));
    }
  };

  const serviceLabel = (r: ServiceRow) => {
    const base = t(`net.svc.${r.group}` as const);
    return r.name ? `${base}: ${r.name}` : base;
  };

  const profileSummary = (p: ProxyProfile) => {
    if (p.mode === "manual") return [p.https_proxy, p.http_proxy, p.socks_proxy].find(Boolean)?.replace(/^[a-z0-9]+:\/\//i, "") ?? t("net.manual");
    if (p.mode === "pac") return p.pac_url ? `PAC · ${p.pac_url}` : "PAC";
    return t(MODE_KEY[p.mode]);
  };

  const legacy = net.profiles.filter((p) => p.legacy_accept_invalid_certs);

  return (
    <>
      <SectionHead title={t("set.network.title")} intro={t("set.network.intro")} help="network" />
      {policy && policy.origins.length > 0 && (
        <Unfiltered>
          <p className="net-policy small">
            <Lock size={13} /> {t("net.policyNote", { origin: policy.origins.join(", ") })}
          </p>
        </Unfiltered>
      )}
      {legacy.length > 0 && (
        <Unfiltered>
          <div className="net-danger" role="alert">
            <AlertTriangle size={16} />
            <span>{t("net.legacyWarning", { profiles: legacy.map((p) => p.name).join(", ") })}</span>
          </div>
        </Unfiltered>
      )}

      <Group title={t("net.profiles")} description={t("net.profilesDesc")}>
        <Unfiltered>
          <div className="net-profiles" role="list" aria-label={t("net.profiles")}>
            {net.profiles.map((p) => (
              <div key={p.id} role="listitem" className={`net-profile${p.id === profile?.id ? " selected" : ""}`} data-profile={p.id}>
                <button type="button" className="net-profile-main" onClick={() => setSelected(p.id)} aria-pressed={p.id === profile?.id}>
                  <span className="net-profile-name">{p.name}</span>
                  <span className="net-profile-mode faint mono">{profileSummary(p)}</span>
                </button>
                <span className="net-profile-badges">
                  {p.id === DEFAULT_PROFILE && <Badge tone="accent">{t("net.defaultBadge")}</Badge>}
                  {p.legacy_accept_invalid_certs && (
                    <Badge tone="danger" title={t("net.insecureTitle")}>
                      {t("net.insecure")}
                    </Badge>
                  )}
                </span>
                <span className="net-profile-actions">
                  <IconButton icon={Pencil} size="sm" label={t("net.editProfile", { name: p.name })} onClick={() => setSelected(p.id)} />
                  <IconButton icon={Copy} size="sm" label={t("net.duplicateProfile", { name: p.name })} disabled={locked} onClick={() => setNet(duplicateProfile(net, p.id, t("net.copyName", { name: p.name })))} />
                  <IconButton
                    icon={Trash2}
                    size="sm"
                    label={t("net.deleteProfile", { name: p.name })}
                    disabled={locked || p.id === DEFAULT_PROFILE}
                    onClick={() => {
                      setNet(removeProfile(net, p.id));
                      if (selected === p.id) setSelected(DEFAULT_PROFILE);
                    }}
                  />
                </span>
              </div>
            ))}
          </div>
          <div className="net-profiles-add">
            <Button
              icon={Plus}
              disabled={locked}
              onClick={() => {
                const next = addProfile(net, t("net.newProfileName", { n: net.profiles.length }));
                setNet(next);
                setSelected(next.profiles[next.profiles.length - 1].id);
              }}
            >
              {t("net.addProfile")}
            </Button>
          </div>
        </Unfiltered>
      </Group>

      {profile && (
        <ProfileEditor
          key={profile.id}
          profile={profile}
          status={status}
          locked={locked}
          onStatus={setStatus}
          onChange={(patch) => setNet(updateProfile(net, profile.id, patch))}
          pacError={pacError}
        />
      )}

      <Group title={t("net.services")} description={t("net.servicesDesc")}>
        <Unfiltered>
          <div className="net-services" role="table" aria-label={t("net.services")}>
            <div className="net-svc-head" role="row">
              <span role="columnheader">{t("net.colService")}</span>
              <span role="columnheader">{t("net.colProfile")}</span>
              <span role="columnheader">{t("net.colRoute")}</span>
              <span role="columnheader" />
            </div>
            {(rows ?? []).map((r) => {
              const test = tests[r.key];
              const explicit = routeOf(net, r.key);
              return (
                <div key={r.key} className="net-svc" role="row" data-service={r.key}>
                  <span className="net-svc-name" role="cell">
                    <span>{serviceLabel(r)}</span>
                    {r.target && <span className="faint mono small net-svc-target">{r.target}</span>}
                  </span>
                  <span className="net-svc-profile" role="cell">
                    <Select
                      value={r.locked ? r.route.profile_id : explicit ?? ""}
                      disabled={r.locked}
                      options={profileOptions}
                      onChange={(e) => setNet(setRoute(net, r.key, e.target.value || null))}
                      aria-label={t("net.profileOf", { service: serviceLabel(r) })}
                    />
                    {r.locked && <Lock size={13} className="faint" aria-label={t("net.lockedByPolicy")} />}
                  </span>
                  <span className="net-svc-route small" role="cell">
                    <span className="mono">{routeText(r.route, words)}</span>
                    {r.route.insecure && <Badge tone="danger">{t("net.insecure")}</Badge>}
                  </span>
                  <span className="net-svc-test" role="cell">
                    <Button size="sm" icon={PlugZap} disabled={!r.target || test === "busy"} onClick={() => runTest(r)} title={r.target ? undefined : t("net.noTarget")}>
                      {t("net.testShort")}
                    </Button>
                  </span>
                  {test && (
                    <span className={`net-svc-result small ${test === "busy" ? "" : test.ok ? "ok" : "fail"}`} role="cell" data-for={r.key}>
                      {test === "busy" ? (
                        <>
                          <Loader2 size={13} className="spin" /> {t("common.checking")}
                        </>
                      ) : (
                        <>
                          {test.ok ? <CheckCircle2 size={13} /> : <XCircle size={13} />}{" "}
                          {test.ok ? t("net.testOk", { ms: test.latency_ms }) : t("net.testFail")}
                          {test.route ? ` · ${routeText(test.route, words)}` : ""}
                          {!test.ok && test.error && <span className="net-svc-error mono">{test.error}</span>}
                          {test.certificate && (
                            <Button size="sm" variant="ghost" icon={ShieldCheck} onClick={() => setCert(test.certificate)}>
                              {t("net.showCert")}
                            </Button>
                          )}
                        </>
                      )}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </Unfiltered>
      </Group>

      <Group title={t("net.trusted")} description={t("net.trustedDesc")}>
        <Unfiltered>
          {net.trusted_hosts.length === 0 ? (
            <p className="faint small">{t("net.trustedNone")}</p>
          ) : (
            <div className="net-trusted" role="list" aria-label={t("net.trusted")}>
              {net.trusted_hosts.map((h) => (
                <div key={`${h.host}-${h.sha256}`} className="net-trusted-row" role="listitem" data-host={h.host}>
                  <ShieldCheck size={14} className="faint" />
                  <span className="mono">{h.host}</span>
                  <span className="faint small">{[h.subject, h.not_after ? t("net.caUntil", { date: day(h.not_after) }) : null].filter(Boolean).join(" · ")}</span>
                  <span className="mono small faint" title={fingerprint(h.sha256)}>
                    {fingerprint(h.sha256, true)}
                  </span>
                  <IconButton icon={Trash2} size="sm" label={t("net.untrust", { host: h.host })} onClick={() => setNet(untrust(net, h.host, h.sha256))} />
                </div>
              ))}
            </div>
          )}
          <p className="faint small">{t("net.limits")}</p>
        </Unfiltered>
      </Group>

      <Dialog
        open={!!cert}
        onClose={() => setCert(null)}
        title={t("net.certTitle")}
        description={cert ? t("net.certIntro", { host: cert.host }) : undefined}
        width={560}
        footer={
          <>
            <Button variant="ghost" onClick={() => setCert(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              icon={ShieldCheck}
              onClick={() => {
                if (cert) {
                  setNet(trustCertificate(net, cert));
                  s().toast({ tone: "success", title: t("net.trustedToast", { host: cert.host }) });
                }
                setCert(null);
              }}
            >
              {t("net.trustThis")}
            </Button>
          </>
        }
      >
        {cert && (
          <dl className="net-cert">
            <dt>{t("net.certHost")}</dt>
            <dd className="mono">{cert.host}</dd>
            <dt>{t("net.certSubject")}</dt>
            <dd>{cert.subject ?? "–"}</dd>
            <dt>{t("net.certIssuer")}</dt>
            <dd>
              {cert.issuer ?? "–"}
              {cert.self_signed && <Badge tone="warning">{t("net.selfSigned")}</Badge>}
            </dd>
            <dt>{t("net.certUntil")}</dt>
            <dd>{cert.not_after ? day(cert.not_after) : "–"}</dd>
            <dt>SHA-256</dt>
            <dd className="mono selectable net-cert-fp">{fingerprint(cert.sha256)}</dd>
          </dl>
        )}
        <p className="faint small">{t("net.certHint")}</p>
      </Dialog>
    </>
  );
}

/** The fields of one profile. */
function ProfileEditor({
  profile: p,
  status,
  locked,
  onStatus,
  onChange,
  pacError,
}: {
  profile: ProxyProfile;
  status: NetworkStatus | null;
  locked: boolean;
  onStatus: (s: NetworkStatus) => void;
  onChange: (patch: Partial<ProxyProfile>) => void;
  pacError: string | null;
}) {
  const t = useT();
  const s = useApp.getState;
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [ca, setCa] = useState<CaInfo | null>(null);
  const [caError, setCaError] = useState<string | null>(null);
  const [converting, setConverting] = useState(false);
  const set = (patch: Partial<ProxyProfile>) => !locked && onChange(patch);
  const passwordSet = !!status?.passwords.includes(p.id);

  useEffect(() => {
    if (!p.extra_ca_path) {
      setCa(null);
      setCaError(null);
      return;
    }
    api.caInfo(p.extra_ca_path).then((i) => (setCa(i), setCaError(null)), (e) => (setCa(null), setCaError(errorText(e))));
  }, [p.extra_ca_path]);

  const savePassword = async (value: string | null) => {
    try {
      onStatus(await api.setProxyPassword(value, p.id));
      setPassword("");
      s().toast({ tone: "success", title: value ? t("net.passwordSaved") : t("net.passwordRemoved") });
    } catch (e) {
      s().error(t("net.passwordFailed"), e);
    }
  };

  const pickCa = async () => {
    const r = await openDialog({ multiple: false, directory: false, title: t("net.caPick"), filters: [{ name: t("net.caFiles"), extensions: ["pem", "crt", "cer", "der"] }] });
    if (typeof r === "string") set({ extra_ca_path: r });
  };

  /** „In vertraute Server umwandeln“: the servers on this profile whose certificate fails the check become trusted ones. */
  const convert = async () => {
    setConverting(true);
    try {
      const probes = await api.networkLegacyProbe(p.id);
      const certs = probes.filter((x) => !x.valid && x.certificate).map((x) => x.certificate!);
      const settings = useApp.getState().settings?.settings;
      if (!settings) return;
      let n = settings.network;
      for (const c of certs) n = trustCertificate(n, c);
      n = updateProfile(n, p.id, { legacy_accept_invalid_certs: false });
      const saved = await api.saveSettings({ ...settings, network: n });
      useApp.getState().set({ settings: saved });
      s().toast({ tone: "success", title: t("net.converted", { n: certs.length }), detail: certs.map((c) => c.host).join(", ") || undefined });
    } catch (e) {
      s().error(t("net.convertFailed"), e);
    } finally {
      setConverting(false);
    }
  };

  const sys = status?.system;
  const modes: { value: ProxyMode; label: string }[] = [
    { value: "none", label: t("net.none") },
    { value: "system", label: t("net.system") },
    { value: "manual", label: t("net.manual") },
    { value: "pac", label: t("net.pac") },
  ];
  return (
    <Group title={t("net.profileTitle", { name: p.name })}>
      {locked && (
        <Unfiltered>
          <p className="net-policy small">
            <Lock size={13} /> {t("net.profilesLocked")}
          </p>
        </Unfiltered>
      )}
      <Row label={t("net.profileName")}>
        <CommitInput value={p.name} onCommit={(v) => v.trim() && set({ name: v.trim() })} disabled={locked} aria-label={t("net.profileName")} className="w-240" />
      </Row>
      <Row label={t("net.mode")}>
        <Segmented label={t("net.mode")} value={p.mode} options={modes} onChange={(v) => set({ mode: v })} />
      </Row>
      {p.mode === "system" && (
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
      {p.mode === "manual" && (
        <>
          <Row label={t("net.httpProxy")} description={t("net.hostPort")}>
            <CommitInput value={p.http_proxy} onCommit={(v) => set({ http_proxy: v })} validate={(v) => (checkProxy(v) ? t("settings.err.url") : null)} placeholder={t("net.proxyPh")} aria-label={t("net.httpProxy")} className="mono w-360" disabled={locked} />
          </Row>
          <Row label={t("net.httpsProxy")} description={t("net.httpsProxyDesc")}>
            <CommitInput value={p.https_proxy} onCommit={(v) => set({ https_proxy: v })} validate={(v) => (checkProxy(v) ? t("settings.err.url") : null)} placeholder={p.http_proxy || t("net.proxyPh")} aria-label={t("net.httpsProxy")} className="mono w-360" disabled={locked} />
          </Row>
          <Row label={t("net.socksProxy")} description={t("net.socksProxyDesc")}>
            <CommitInput value={p.socks_proxy} onCommit={(v) => set({ socks_proxy: v })} validate={(v) => (checkProxy(v, ["socks5", "socks5h", "socks4", "socks4a", "socks"]) ? t("settings.err.url") : null)} placeholder={t("net.socksPh")} aria-label={t("net.socksProxy")} className="mono w-360" disabled={locked} />
          </Row>
        </>
      )}
      {p.mode === "pac" && (
        <Row stack label={t("net.pacUrl")} description={t("net.pacDesc")}>
          <CommitInput value={p.pac_url} onCommit={(v) => set({ pac_url: v })} validate={(v) => (checkUrl(v, { schemes: ["http", "https", "file"] }) ? t("settings.err.url") : null)} placeholder="http://wpad.firma.de/proxy.pac" aria-label={t("net.pacUrl")} className="mono grow" disabled={locked} />
        </Row>
      )}
      {p.mode === "pac" && (
        <Unfiltered>
          {Object.keys(p.pac_results).length > 0 && (
            <div className="pac-results small">
              {Object.entries(p.pac_results).map(([host, answer]) => (
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
      {(p.mode === "manual" || p.mode === "pac") && (
        <Row stack label={t("net.noProxy")} description={t("net.noProxyDesc")}>
          <TextArea rows={2} value={p.no_proxy} onChange={(e) => set({ no_proxy: e.target.value })} placeholder={t("net.noProxyPh")} aria-label={t("net.noProxy")} className="mono" disabled={locked} />
        </Row>
      )}
      {p.mode !== "none" && (
        <>
          <Row label={t("net.user")} description={t("net.authDesc")}>
            <Input value={p.proxy_user} onChange={(e) => set({ proxy_user: e.target.value })} aria-label={t("net.user")} autoComplete="off" disabled={locked} />
          </Row>
          <Row
            stack
            label={t("net.password")}
            description={
              <>
                {passwordSet ? <Badge tone="success">{t("net.stored")}</Badge> : <Badge>{t("net.notSet")}</Badge>}
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
                placeholder={passwordSet ? t("net.passwordReplace") : ""}
                aria-label={t("net.password")}
                autoComplete="off"
                spellCheck={false}
                disabled={locked}
                onKeyDown={(e) => isKey(e, "Enter") && password && savePassword(password)}
              />
              <IconButton icon={showPassword ? EyeOff : Eye} label={showPassword ? t("common.hide") : t("common.show")} size="sm" onClick={() => setShowPassword(!showPassword)} />
            </div>
            <Button variant="primary" onClick={() => savePassword(password)} disabled={!password || locked}>
              {t("common.save")}
            </Button>
            {passwordSet && !locked && <IconButton icon={Trash2} label={t("net.passwordRemove")} onClick={() => savePassword(null)} />}
          </Row>
        </>
      )}
      <Row
        label={t("net.extraCa")}
        description={
          p.extra_ca_path ? (
            <span className="net-ca">
              <span className="mono selectable">{p.extra_ca_path}</span>
              {ca && (
                <span className="ca-info">
                  {t("net.caCount", { n: ca.count })}
                  {ca.subject ? ` · ${ca.subject}` : ""}
                  {ca.not_after ? ` · ${t("net.caUntil", { date: day(ca.not_after) })}` : ""}
                </span>
              )}
              {caError && <span className="mirror-error">{caError}</span>}
            </span>
          ) : (
            t("net.extraCaDesc")
          )
        }
      >
        <Button icon={FileKey2} onClick={pickCa} disabled={locked}>
          {t("net.caChoose")}
        </Button>
        {p.extra_ca_path && !locked && (
          <Button variant="ghost" onClick={() => set({ extra_ca_path: null })}>
            {t("common.remove")}
          </Button>
        )}
      </Row>
      <Row label={t("net.timeout")} description={t("net.timeoutDesc")}>
        <div className="unit-input">
          <NumberInput min={1} max={600} value={p.connect_timeout_secs} onCommit={(v) => set({ connect_timeout_secs: v })} aria-label={t("net.timeout")} disabled={locked} />
          <span className="faint">{t("unit.seconds")}</span>
        </div>
      </Row>
      <Row label={t("net.readTimeout")} description={t("net.readTimeoutDesc")}>
        <div className="unit-input">
          <NumberInput min={0} max={3600} value={p.read_timeout_secs} onCommit={(v) => set({ read_timeout_secs: v })} aria-label={t("net.readTimeout")} disabled={locked} />
          <span className="faint">{t("unit.seconds")}</span>
        </div>
      </Row>
      {p.legacy_accept_invalid_certs && (
        <Row
          label={t("net.invalidCerts")}
          description={
            <span className="danger-note">
              <AlertTriangle size={13} /> {t("net.legacyDesc")}
            </span>
          }
        >
          <Button icon={ShieldCheck} loading={converting} onClick={convert} disabled={locked}>
            {t("net.convert")}
          </Button>
          <Switch label={t("net.invalidCerts")} checked={p.legacy_accept_invalid_certs} disabled={locked} onChange={(v) => set({ legacy_accept_invalid_certs: v })} />
        </Row>
      )}
    </Group>
  );
}
