// Settings → Netzwerk, a network per service: two local forward proxies and a mock service.
// The AI provider goes through profile A, a Jira site through profile B (chosen in the
// services table): each proxy sees only its service, also for the real requests of the app.
// The per-service „Testen“ buttons, and a self-signed HTTPS server that is rejected until it is
// trusted per host („Zertifikat anzeigen und vertrauen“), while another certificate of the
// same host stays rejected.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";
import { settingsSettled, storedSettings } from "../lib/settings.js";
import { startProxy, startService, startTls } from "../lib/fake-network.js";

const test = guarded(nodeTest, () => app);
let app, proxyA, proxyB, svc, tls, tls2;

before(async () => {
  [proxyA, proxyB, svc, tls, tls2] = await Promise.all([startProxy("A"), startProxy("B"), startService(), startTls("selbst.firma.test"), startTls("anderer.firma.test")]);
  app = await launch();
});
after(async () => {
  await app?.close();
  for (const s of [proxyA, proxyB, svc, tls, tls2]) await s?.close();
});

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
const site = (p = {}) => ({ id: "corp", name: "Corp Jira", color: "", kind: "server", url: "", email: "", enabled: true, log_work: false, allow_writes: false, ...p });
const row = (key) => `.net-svc[data-service="${key}"]`;
const openNetwork = async () => {
  await app.dismissToasts();
  const onSettings = await app.browser.execute(() => !!document.querySelector(".pane-content:not([hidden]) .settings-nav"));
  if (!onSettings) await app.keys(["Control", ","]);
  // Opened afresh, so sites added since appear in the table.
  else await app.click('.settings-nav-item[data-section="appearance"]');
  await app.click('.settings-nav-item[data-section="network"]');
  await app.waitText(".settings-head h1", /Netzwerk/);
};
const runRowTest = async (key) => {
  const sel = `${row(key)} .net-svc-test button`;
  await app.browser.execute((s) => document.querySelector(s)?.scrollIntoView({ block: "center" }), sel);
  await app.click(sel);
  await app.browser.waitUntil(() => app.browser.execute((k) => !!document.querySelector(`.net-svc-result[data-for="${k}"].ok, .net-svc-result[data-for="${k}"].fail`), key), {
    timeout: 20000,
    timeoutMsg: `no test result for ${key}`,
  });
  return app.browser.execute((k) => {
    const el = document.querySelector(`.net-svc-result[data-for="${k}"]`);
    return { ok: el.classList.contains("ok"), text: el.textContent };
  }, key);
};

test("one profile „Standard“ by default; every service uses it", async () => {
  const s = await storedSettings(app);
  assert.equal(s.network.profiles.length, 1);
  assert.deepEqual([s.network.profiles[0].id, s.network.profiles[0].name, s.network.profiles[0].mode], ["standard", "Standard", "system"]);
  assert.deepEqual(s.network.routes, {});
  assert.equal(s.network.profiles[0].legacy_accept_invalid_certs, false);
  const rows = await app.invoke("network_services", { network: null });
  const keys = rows.map((r) => r.key);
  for (const k of ["updates", "release_notes", "git_sync", "voice_models", "link_preview", "http_tool"]) assert.ok(keys.includes(k), keys.join(","));
  assert.ok(rows.every((r) => r.route.profile_id === "standard" && !r.locked));
});

test("AI through profile A, Jira through profile B: each proxy sees only its service", async () => {
  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", {
    settings: {
      ...view.settings,
      litellm_base_url: svc.url,
      providers: [{ id: "litellm", name: "LiteLLM", kind: "litellm", base_url: svc.url, local: false, enabled: true, bypass_proxy: false, api_version: "", models: [] }],
      network: {
        profiles: [profile("standard", "Standard"), profile("proxy-a", "Proxy A", { mode: "manual", http_proxy: proxyA.address }), profile("proxy-b", "Proxy B", { mode: "manual", http_proxy: proxyB.address })],
        routes: { "ai:litellm": "proxy-a" },
        trusted_hosts: [],
      },
    },
  });
  await app.invoke("jira_site_save", { site: site({ id: "", url: svc.url }), token: "pat-123" });
  const corp = `jira:${(await storedSettings(app)).jira.sites[0].id}`;
  await openNetwork();
  await app.waitFor(row(corp));
  // The Jira site's profile is chosen in the table.
  await app.browser.execute((s) => document.querySelector(s)?.scrollIntoView({ block: "center" }), `${row(corp)} [role="combobox"]`);
  await app.click(`${row(corp)} [role="combobox"]`);
  const list = await app.browser.waitUntil(() => app.browser.execute((s) => document.querySelector(s)?.getAttribute("aria-controls"), `${row(corp)} [role="combobox"]`), { timeoutMsg: "profile list not open" });
  await app.click(`#${list} [role="option"][data-value="proxy-b"]`);
  await settingsSettled(app);
  await app.browser.waitUntil(async () => (await storedSettings(app)).network.routes[corp] === "proxy-b", { timeout: 8000, timeoutMsg: "route not stored" });
  const since = svc.seen.length;
  await app.waitText(`${row(corp)} .net-svc-route`, new RegExp(`über Proxy 127\\.0\\.0\\.1:${proxyB.port}`));
  assert.match(await app.text(`${row("ai:litellm")} .net-svc-route`), new RegExp(`über Proxy 127\\.0\\.0\\.1:${proxyA.port}`));
  assert.match(await app.text(`${row("updates")} .net-svc-route`), /direkt/);

  const a = await runRowTest("ai:litellm");
  assert.ok(a.ok, a.text);
  assert.match(a.text, new RegExp(`Verbunden.*über Proxy 127\\.0\\.0\\.1:${proxyA.port}`));
  const j = await runRowTest(corp);
  assert.ok(j.ok, j.text);
  assert.match(j.text, new RegExp(`über Proxy 127\\.0\\.0\\.1:${proxyB.port}`));
  await app.shot("network-services");

  // The app's own requests take the same routes.
  const models = await app.invoke("ai_test_connection", {});
  assert.equal(models.ok, true, JSON.stringify(models));
  await app.invoke("jira_test", { site: (await storedSettings(app)).jira.sites[0], token: "pat-123" });
  assert.ok(proxyA.seen.length >= 2 && proxyA.seen.every((r) => !r.path.startsWith("/rest/")), JSON.stringify(proxyA.seen));
  assert.ok(proxyB.seen.length >= 2 && proxyB.seen.every((r) => r.path.startsWith("/rest/api/2/")), JSON.stringify(proxyB.seen));
  // From the route on (the site synced directly once when it was added, before it had one).
  const later = svc.seen.slice(since);
  assert.ok(later.length >= 4 && later.every((r) => (r.path.startsWith("/rest/") ? r.via === "B" : r.via === "A")), JSON.stringify(later));
});

test("a self-signed server: rejected, shown, trusted per host; another certificate of the host stays rejected", async () => {
  await app.invoke("jira_site_save", { site: site({ id: "", name: "Intern TLS", url: tls.url }), token: "pat-1" });
  await app.invoke("jira_site_save", { site: site({ id: "", name: "Intern Zwei", url: tls2.url }), token: "pat-2" });
  const ids = (await storedSettings(app)).jira.sites.map((s) => s.id);
  const [one, two] = [ids.find((i) => i.startsWith("intern-tls")), ids.find((i) => i.startsWith("intern-zwei"))];
  assert.ok(one && two, ids.join(","));
  await openNetwork();
  await app.waitFor(row(`jira:${one}`));
  const r = await runRowTest(`jira:${one}`);
  assert.equal(r.ok, false, r.text);
  assert.equal(tls.seen.length, 0, "nothing was sent to the untrusted server");
  await app.click(`.net-svc-result[data-for="jira:${one}"] button`);
  await app.waitFor(".dialog .net-cert");
  const fp = await app.text(".dialog .net-cert-fp");
  assert.equal(fp.replace(/:/g, "").toLowerCase(), tls.sha256);
  assert.match(await app.text(".dialog .net-cert"), /selbst\.firma\.test/);
  await app.shot("network-certificate");
  for (const b of await app.$$(".dialog button")) if ((await app.textOf(b)) === "Diesem Server vertrauen") await b.click();
  await settingsSettled(app);
  await app.browser.waitUntil(async () => (await storedSettings(app)).network.trusted_hosts.length === 1, { timeout: 8000, timeoutMsg: "not trusted" });
  const trusted = (await storedSettings(app)).network.trusted_hosts[0];
  assert.deepEqual([trusted.host, trusted.sha256], ["127.0.0.1", tls.sha256]);
  await app.waitText(".net-trusted-row", /127\.0\.0\.1/);
  const again = await runRowTest(`jira:${one}`);
  assert.ok(again.ok, again.text);
  assert.ok(tls.seen.includes("/rest/api/2/serverInfo"));
  // The same host with another certificate: rejected (pinned), and offered again.
  const other = await app.invoke("network_service_test", { service: `jira:${two}`, network: null, password: null });
  assert.equal(other.ok, false);
  assert.match(other.error, /Fingerabdruck|fingerprint/);
  assert.equal(other.certificate.sha256, tls2.sha256);
  assert.equal(tls2.seen.length, 0);
});
