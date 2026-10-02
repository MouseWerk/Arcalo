// Settings → Network in English under an organization's policy (policy.json next to the
// executable; ANNALO_EXE_DIR stands in for its folder): `NetworkRoute.ai` and
// `NetworkRoute.updates` fix those services' profiles, `LockNetworkProfiles` locks the
// profiles. The UI shows them locked, saving cannot change them, and the AI test goes through
// the policy's profile.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, guarded } from "../lib/harness.js";
import { launchEnglish, germanLeftovers } from "../lib/english.js";
import { storedSettings } from "../lib/settings.js";
import { startProxy, startService } from "../lib/fake-network.js";

const test = guarded(nodeTest, () => app);
let app, dataDir, exeDir, firma, svc;

const profile = (id, name, p = {}) => ({
  id,
  name,
  mode: "none",
  http_proxy: "",
  https_proxy: "",
  socks_proxy: "",
  no_proxy: "",
  pac_url: "",
  pac_results: {},
  proxy_user: "",
  extra_ca_path: null,
  connect_timeout_secs: 10,
  read_timeout_secs: 0,
  legacy_accept_invalid_certs: false,
  ...p,
});

before(async () => {
  [firma, svc] = await Promise.all([startProxy("Firma"), startService()]);
  ({ app, dataDir } = await launchEnglish());
  // The profiles exist before the policy arrives; the user routed the AI provider to „VPN“.
  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", {
    settings: {
      ...view.settings,
      litellm_base_url: svc.url,
      providers: [{ id: "litellm", name: "LiteLLM", kind: "litellm", base_url: svc.url, local: false, enabled: true, bypass_proxy: false, api_version: "", models: [] }],
      network: {
        profiles: [profile("standard", "Standard"), profile("firma", "Firma", { mode: "manual", http_proxy: firma.address }), profile("vpn", "VPN")],
        routes: { "ai:litellm": "vpn", updates: "vpn", git_sync: "vpn" },
        trusted_hosts: [],
      },
    },
  });
  await app.close();
  exeDir = fs.mkdtempSync(path.join(os.tmpdir(), "annalo-e2e-netpolicy-"));
  fs.writeFileSync(path.join(exeDir, "policy.json"), JSON.stringify({ "NetworkRoute.ai": "Firma", "NetworkRoute.updates": "Standard", LockNetworkProfiles: 1 }));
  app = await launch({ dataDir, env: { ANNALO_LOCALE: "en-US", ANNALO_EXE_DIR: exeDir } });
});
after(async () => {
  await app?.close();
  await firma?.close();
  await svc?.close();
  for (const d of [dataDir, exeDir]) if (d) fs.rmSync(d, { recursive: true, force: true });
});

const row = (key) => `.net-svc[data-service="${key}"]`;

test("the policy fixes the routes and locks the profiles", async () => {
  const status = await app.invoke("network_status");
  assert.equal(status.policy.lock_profiles, true);
  assert.deepEqual(status.policy.routes, { ai: "firma", updates: "standard" });
  assert.ok(status.policy.origins.some((o) => o.endsWith("policy.json")), status.policy.origins.join(", "));
  const rows = await app.invoke("network_services", { network: null });
  const by = Object.fromEntries(rows.map((r) => [r.key, r]));
  assert.deepEqual([by["ai:litellm"].route.profile_id, by["ai:litellm"].locked], ["firma", true]);
  assert.deepEqual([by.updates.route.profile_id, by.updates.locked], ["standard", true]);
  assert.deepEqual([by.git_sync.route.profile_id, by.git_sync.locked], ["vpn", false], "unmanaged routes stay the user's");

  // Saving cannot change what the policy fixes; the rest is saved.
  const view = await app.invoke("settings_get");
  const net = view.settings.network;
  await app.invoke("settings_save", {
    settings: {
      ...view.settings,
      network: {
        ...net,
        profiles: [...net.profiles.map((p) => (p.id === "firma" ? { ...p, http_proxy: "127.0.0.1:1" } : p)), profile("neu", "Neu")],
        routes: { "ai:litellm": "vpn", updates: "vpn", git_sync: "standard" },
      },
    },
  });
  const s = await storedSettings(app);
  assert.deepEqual(s.network.profiles.map((p) => p.id), ["standard", "firma", "vpn"]);
  assert.equal(s.network.profiles[1].http_proxy, `http://${firma.address}`);
  assert.deepEqual(s.network.routes, { ai: "firma", git_sync: "standard" }, "updates: the policy says the default profile");
  await assert.rejects(app.invoke("proxy_password_set", { password: "x", profile: "firma" }), /managed by your organization/);
});

test("Settings → Network in English: locked rows, locked profiles, a test through the policy's profile", async () => {
  await app.keys(["Control", ","]);
  await app.click('.settings-nav-item[data-section="network"]');
  await app.waitText(".settings-head h1", /^Network$/);
  await app.waitFor(row("ai:litellm"));
  assert.match(await app.text(".net-policy"), /managed by your organization \(.*policy\.json\)/);
  const locked = await app.browser.execute((r) => {
    const box = document.querySelector(`${r} [role="combobox"]`);
    return { disabled: box?.disabled || box?.getAttribute("aria-disabled") === "true", text: box?.textContent, lock: !!document.querySelector(`${r} svg[aria-label]`) };
  }, row("ai:litellm"));
  assert.deepEqual([locked.disabled, locked.lock], [true, true]);
  assert.match(locked.text, /Firma/);
  const free = await app.browser.execute((r) => document.querySelector(`${r} [role="combobox"]`)?.disabled, row("git_sync"));
  assert.equal(free, false);
  const add = await app.browser.execute(() => [...document.querySelectorAll(".net-profiles-add button")].map((b) => [b.textContent, b.disabled]));
  assert.deepEqual(add, [["Add profile", true]]);

  const before = firma.seen.length;
  await app.click(`${row("ai:litellm")} .net-svc-test button`);
  await app.waitText(`.net-svc-result[data-for="ai:litellm"]`, new RegExp(`Connected.*via proxy 127\\.0\\.0\\.1:${firma.port}`), 20000);
  assert.ok(firma.seen.length > before);
  await app.shot("network-policy-en");
  const leftovers = await germanLeftovers(app, [/^Standard$/]);
  assert.deepEqual(leftovers, []);
});
