import { describe, expect, it } from "vitest";
import { addProfile, blankProfile, duplicateProfile, fingerprint, profileId, removeProfile, routeOf, routeText, setRoute, trustCertificate, untrust, upgradeNetwork } from "./network";
import type { NetworkSettings, RouteInfo } from "./types";

const base = (): NetworkSettings => ({ profiles: [{ ...blankProfile("standard", "Standard"), mode: "system" }], routes: {}, trusted_hosts: [] });

describe("proxy profiles", () => {
  it("get unique ids like the core gives them", () => {
    const net = base();
    expect(profileId("Firma VPN", net.profiles)).toBe("firma-vpn");
    expect(profileId("Büro Köln", net.profiles)).toBe("buro-koln");
    expect(profileId("Standard", net.profiles)).toBe("standard-2");
    expect(profileId("  !!  ", net.profiles)).toBe("profil");
    const two = addProfile(addProfile(net, "Firma"), "Firma");
    expect(two.profiles.map((p) => p.id)).toEqual(["standard", "firma", "firma-2"]);
    expect(two.profiles[1].mode).toBe("none");
  });

  it("duplicate, remove (routes go back to the default) and never remove the default", () => {
    let net = addProfile(base(), "Firma");
    net = { ...net, profiles: net.profiles.map((p) => (p.id === "firma" ? { ...p, mode: "manual", http_proxy: "firma:8080" } : p)) };
    net = duplicateProfile(net, "firma", "Firma (Kopie)");
    expect(net.profiles[2]).toMatchObject({ id: "firma-kopie", name: "Firma (Kopie)", http_proxy: "firma:8080" });
    net = setRoute(setRoute(net, "ai:litellm", "firma"), "jira:intern", "firma-kopie");
    expect(routeOf(net, "ai:litellm")).toBe("firma");
    expect(routeOf(net, "ai:openai")).toBeNull();
    net = removeProfile(net, "firma");
    expect(net.routes).toEqual({ "jira:intern": "firma-kopie" });
    expect(removeProfile(net, "standard")).toBe(net);
    expect(routeOf(setRoute(net, "jira:intern", null), "jira:intern")).toBeNull();
    // A group route applies to every service of the group.
    expect(routeOf({ ...net, routes: { ai: "firma-kopie" } }, "ai:x")).toBe("firma-kopie");
  });
});

describe("routes and certificates", () => {
  const r = (p: Partial<RouteInfo>): RouteInfo => ({ profile_id: "standard", profile_name: "Standard", mode: "manual", proxy: null, pac_answer: null, bypassed: false, insecure: false, ...p });
  it("words the route", () => {
    const w = { via: "über Proxy", direct: "direkt" };
    expect(routeText(r({ proxy: "http://firma:8080" }), w)).toBe("über Proxy firma:8080");
    expect(routeText(r({}), w)).toBe("direkt");
    expect(routeText(r({ mode: "pac", pac_answer: "DIRECT" }), w)).toBe("PAC → DIRECT");
  });

  it("trusts a certificate once and removes it again", () => {
    const c = { host: "git.firma.de", sha256: "ab".repeat(32), spki_sha256: "x", subject: "Git", issuer: "Git", not_after: "2030-01-01", self_signed: true };
    let net = trustCertificate(base(), c);
    expect(trustCertificate(net, c)).toBe(net);
    expect(net.trusted_hosts).toEqual([{ host: "git.firma.de", sha256: c.sha256, spki_sha256: "x", subject: "Git", not_after: "2030-01-01" }]);
    expect(fingerprint(c.sha256).startsWith("AB:AB:")).toBe(true);
    expect(fingerprint(c.sha256, true)).toBe("AB:AB:AB:AB…AB:AB:AB:AB");
    net = untrust(net, "git.firma.de", c.sha256);
    expect(net.trusted_hosts).toEqual([]);
  });
});

describe("network settings of 1.9", () => {
  it("become the default profile, like the core's migration", () => {
    const old = { mode: "manual", http_proxy: "p:8080", no_proxy: "x", timeout_secs: 12, accept_invalid_certs: true, apply_to: { ai: true, git: true, updates: false, tools: true } };
    const n = upgradeNetwork(old) as unknown as NetworkSettings;
    expect(n.profiles[0]).toEqual({ id: "standard", name: "Standard", mode: "manual", http_proxy: "p:8080", no_proxy: "x", connect_timeout_secs: 12, legacy_accept_invalid_certs: true });
    expect(n.profiles[1]).toMatchObject({ id: "standard-system", mode: "system", legacy_accept_invalid_certs: true });
    expect(n.routes).toEqual({ updates: "standard-system", release_notes: "standard-system", voice_models: "standard-system" });
    const current = base() as unknown as Record<string, unknown>;
    expect(upgradeNetwork(current)).toBe(current);
  });
});
