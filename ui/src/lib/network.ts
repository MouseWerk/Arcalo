// Settings → Netzwerk: proxy profiles, the profile of each service, trusted servers. The
// core decides the routes (annalo_core::network); this file edits the settings and words them.

import type { CertDetails, NetworkSettings, ProxyProfile, RouteInfo, Settings } from "./types";
import { UPDATE_URL } from "./pac";

export const DEFAULT_PROFILE = "standard";

/** A new profile's settings (direct, no exceptions beyond the local ones). */
export function blankProfile(id: string, name: string): ProxyProfile {
  return {
    id,
    name,
    mode: "none",
    http_proxy: "",
    https_proxy: "",
    socks_proxy: "",
    no_proxy: "localhost, 127.0.0.1, ::1",
    pac_url: "",
    pac_results: {},
    proxy_user: "",
    extra_ca_path: null,
    connect_timeout_secs: 30,
    read_timeout_secs: 0,
    legacy_accept_invalid_certs: false,
  };
}

/** `Firma VPN` → `firma-vpn`, unique among `profiles` (as the core does). */
export function profileId(name: string, profiles: ProxyProfile[]): string {
  const map: Record<string, string> = { ä: "a", ö: "o", ü: "u", ß: "s" };
  let base = "";
  for (const ch of name.trim().toLowerCase()) {
    const c = map[ch] ?? ch;
    if (/[a-z0-9]/.test(c)) base += c;
    else if (base && !base.endsWith("-")) base += "-";
  }
  base = base.replace(/-+$/, "") || "profil";
  if (base === DEFAULT_PROFILE) base = "standard-2";
  let id = base;
  for (let i = 2; profiles.some((p) => p.id === id); i++) id = `${base}-${i}`;
  return id;
}

export function addProfile(net: NetworkSettings, name: string): NetworkSettings {
  const p = blankProfile(profileId(name, net.profiles), name);
  return { ...net, profiles: [...net.profiles, p] };
}

export function duplicateProfile(net: NetworkSettings, id: string, name: string): NetworkSettings {
  const src = net.profiles.find((p) => p.id === id);
  if (!src) return net;
  const copy: ProxyProfile = { ...src, pac_results: { ...src.pac_results }, id: profileId(name, net.profiles), name };
  return { ...net, profiles: [...net.profiles, copy] };
}

/** Removes a profile (never the default one); services routed to it go back to the default. */
export function removeProfile(net: NetworkSettings, id: string): NetworkSettings {
  if (id === DEFAULT_PROFILE) return net;
  const routes = Object.fromEntries(Object.entries(net.routes).filter(([, v]) => v !== id));
  return { ...net, profiles: net.profiles.filter((p) => p.id !== id), routes };
}

export function updateProfile(net: NetworkSettings, id: string, patch: Partial<ProxyProfile>): NetworkSettings {
  return { ...net, profiles: net.profiles.map((p) => (p.id === id ? { ...p, ...patch } : p)) };
}

/** `profile` null: the service follows the default profile (or its group's route). */
export function setRoute(net: NetworkSettings, key: string, profile: string | null): NetworkSettings {
  const routes = { ...net.routes };
  if (profile === null) delete routes[key];
  else routes[key] = profile;
  return { ...net, routes };
}

/** The explicit profile of a service row (its own key, else its group), or null. */
export function routeOf(net: NetworkSettings, key: string): string | null {
  const group = key.split(":")[0];
  const id = net.routes[key] ?? net.routes[group];
  return id && net.profiles.some((p) => p.id === id) ? id : null;
}

/** „Diesem Server vertrauen“: adds the certificate (replacing nothing; a host may have several). */
export function trustCertificate(net: NetworkSettings, c: CertDetails): NetworkSettings {
  if (net.trusted_hosts.some((h) => h.host === c.host && h.sha256 === c.sha256)) return net;
  const entry = { host: c.host, sha256: c.sha256, spki_sha256: c.spki_sha256, subject: c.subject, not_after: c.not_after };
  return { ...net, trusted_hosts: [...net.trusted_hosts, entry] };
}

export function untrust(net: NetworkSettings, host: string, sha256: string): NetworkSettings {
  return { ...net, trusted_hosts: net.trusted_hosts.filter((h) => !(h.host === host && h.sha256 === sha256)) };
}

/** `ab12cd…` → `AB:12:CD…`, optionally shortened to the first and last bytes. */
export function fingerprint(sha256: string, short = false): string {
  const pairs = (sha256.toUpperCase().match(/.{2}/g) ?? []);
  if (short && pairs.length > 8) return `${pairs.slice(0, 4).join(":")}…${pairs.slice(-4).join(":")}`;
  return pairs.join(":");
}

export type RouteWords = { via: string; direct: string };

/** „über Proxy firma:8080“ / „direkt“ / „PAC → DIRECT“, with the translated words. */
export function routeText(r: RouteInfo, w: RouteWords): string {
  if (r.pac_answer) return `PAC → ${r.pac_answer}`;
  if (r.proxy) return `${w.via} ${r.proxy.replace(/^[a-z0-9]+:\/\//i, "")}`;
  return w.direct;
}

/** The PAC profiles' answers are computed for these hosts (the core has no JS engine). */
export function pacTargets(s: Settings): string[] {
  const providers = s.providers.filter((p) => p.enabled).map((p) => p.base_url);
  const sites = (s.jira?.sites ?? []).filter((x) => x.enabled).map((x) => x.url);
  return [UPDATE_URL, s.git_sync.remote_url, ...providers, ...sites].filter((u) => /^https?:\/\//i.test(u));
}

const FLAT = ["mode", "http_proxy", "https_proxy", "socks_proxy", "no_proxy", "pac_url", "pac_results", "proxy_user", "extra_ca_path"] as const;

/**
 * A network section of 1.9 and older (one setting) in the profile shape, as the core's
 * migration does it: the default profile, the certificate switch as its legacy flag, and
 * connections that did not use the settings on a copy in mode `system`.
 */
export function upgradeNetwork(raw: Record<string, unknown>): Record<string, unknown> {
  if (!("mode" in raw) || "profiles" in raw) return raw;
  const profile: Record<string, unknown> = { id: DEFAULT_PROFILE, name: "Standard" };
  for (const k of FLAT) if (k in raw) profile[k] = raw[k];
  if (typeof raw.timeout_secs === "number") profile.connect_timeout_secs = raw.timeout_secs;
  if (raw.accept_invalid_certs === true) profile.legacy_accept_invalid_certs = true;
  const applyTo = (raw.apply_to ?? {}) as Record<string, unknown>;
  const groups: Record<string, string[]> = {
    ai: ["ai"],
    git: ["git_sync"],
    updates: ["updates", "release_notes", "voice_models"],
    tools: ["http_tool", "link_preview", "jira", "ics"],
  };
  const off = Object.keys(groups).filter((k) => applyTo[k] === false);
  const profiles: Record<string, unknown>[] = [profile];
  const routes: Record<string, string> = {};
  if (off.length) {
    profiles.push({ ...profile, id: "standard-system", name: "Standard (System)", mode: "system" });
    for (const k of off) for (const g of groups[k]) routes[g] = "standard-system";
  }
  const out: Record<string, unknown> = { profiles, routes };
  if (Array.isArray(raw.trusted_hosts)) out.trusted_hosts = raw.trusted_hosts;
  return out;
}
