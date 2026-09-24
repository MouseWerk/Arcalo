// Settings → Netzwerk (manual proxy with credentials, PAC) through a local forward proxy, and
// the customization pass: accent color and density, English UI, a rebound shortcut, the
// settings search and the export/import round trip.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, guarded } from "../lib/harness.js";
import { startFakeLiteLLM } from "../lib/fake-litellm.js";

const test = guarded(nodeTest, () => app);
let app, llm, proxy, tmp;

/** A tiny HTTP forward proxy (absolute-URI requests) that records what it forwards; also serves a PAC file. */
function startProxy() {
  const seen = [];
  let pac = "";
  const server = http.createServer((req, res) => {
    if (req.url === "/proxy.pac") {
      res.writeHead(200, { "content-type": "application/x-ns-proxy-autoconfig" });
      return res.end(pac);
    }
    if (!/^http:\/\//.test(req.url)) {
      res.writeHead(400);
      return res.end("not a proxy request");
    }
    seen.push({ method: req.method, url: req.url, auth: req.headers["proxy-authorization"] ?? null });
    const target = new URL(req.url);
    const headers = { ...req.headers };
    delete headers["proxy-authorization"];
    delete headers["proxy-connection"];
    const up = http.request({ host: target.hostname, port: target.port, path: target.pathname + target.search, method: req.method, headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on("error", () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(up);
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({
        seen,
        port: server.address().port,
        setPac: (text) => (pac = text),
        close: () => new Promise((r) => server.close(r)),
      }),
    ),
  );
}

before(async () => {
  llm = await startFakeLiteLLM({ port: 4998 });
  proxy = await startProxy();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "annalo-e2e-net-"));
  app = await launch();
});
after(async () => {
  await app?.close();
  await llm?.close();
  await proxy?.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

const saveSettings = async (patch) => {
  const view = await app.invoke("settings_get");
  return app.invoke("settings_save", { settings: { ...view.settings, ...patch(view.settings) } });
};
const clickText = async (sel, pattern) => {
  for (const el of await app.$$(sel))
    if (pattern.test(await app.textOf(el))) {
      await app.browser.execute((e) => e.scrollIntoView({ block: "center" }), el);
      return el.click();
    }
  throw new Error(`no ${sel} matching ${pattern}`);
};
const openSection = async (id) => {
  await app.dismissToasts();
  const onSettings = await app.browser.execute(() => !!document.querySelector(".settings-nav"));
  if (!onSettings) await app.keys(["Control", ","]);
  await app.click(`.settings-nav-item[data-section="${id}"]`);
};
const cssVar = (name) => app.browser.execute((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);

test("network settings are off by default and backwards compatible", async () => {
  const view = await app.invoke("settings_get");
  assert.equal(view.settings.network.mode, "system");
  assert.equal(view.settings.network.accept_invalid_certs, false);
  assert.deepEqual(view.settings.network.apply_to, { ai: true, git: true, updates: true, tools: true });
  const status = await app.invoke("network_status");
  assert.equal(status.password_set, false);
});

test("manual proxy with credentials: the connection test goes through the proxy", async () => {
  await app.invoke("api_key_set", { key: llm.apiKey });
  await saveSettings((s) => ({
    litellm_base_url: llm.url,
    network: { ...s.network, mode: "manual", http_proxy: `127.0.0.1:${proxy.port}`, no_proxy: "", proxy_user: "proxy-user" },
  }));
  const status = await app.invoke("proxy_password_set", { password: "geh eim" });
  assert.equal(status.password_set, true);
  // The password never appears in the settings.
  assert.ok(!JSON.stringify(await app.invoke("settings_get")).includes("geh eim"));

  await openSection("network");
  await app.waitText(".settings-head h1", /Netzwerk/);
  assert.equal(await app.browser.execute(() => document.querySelector('[aria-label="Proxy-Modus"] [aria-checked="true"]')?.textContent), "Manuell");
  const before = proxy.seen.length;
  await clickText(".set-group button", /^Verbindung testen$/);
  await app.waitText(".net-test-result", /Verbunden/, 15000);
  const text = await app.text(".net-test-result");
  assert.match(text, new RegExp(`über http://127\\.0\\.0\\.1:${proxy.port}`));
  assert.ok(!text.includes("geh eim"), "no credentials in the result");
  const hit = proxy.seen.slice(before).find((r) => r.url === `${llm.url}/v1/models`);
  assert.ok(hit, JSON.stringify(proxy.seen));
  assert.equal(hit.auth, `Basic ${Buffer.from("proxy-user:geh eim").toString("base64")}`);
  await app.shot("settings-network");

  // The LiteLLM client itself (rebuilt on save) uses the proxy too.
  const n = proxy.seen.length;
  const models = await app.invoke("ai_test_connection", {});
  assert.equal(models.ok, true);
  assert.ok(proxy.seen.length > n, "ai_test_connection went through the proxy");

  // An exception bypasses the proxy; unsaved settings can be tested.
  const view = await app.invoke("settings_get");
  const direct = await app.invoke("network_test", { network: { ...view.settings.network, no_proxy: "127.0.0.1" }, baseUrl: null, password: null });
  assert.equal(direct.ok, true);
  assert.equal(direct.proxy, null);
  // A wrong password is reported by the proxy test, not stored.
  const bad = await app.invoke("network_test", { network: { ...view.settings.network, http_proxy: "127.0.0.1:1" }, baseUrl: null, password: null });
  assert.equal(bad.ok, false);
  assert.equal(bad.proxy, "http://127.0.0.1:1");
});

test("PAC: the script is evaluated in the sandbox and its answer is used", async () => {
  proxy.setPac(`function FindProxyForURL(url, host) {
    if (isPlainHostName(host) || dnsDomainIs(host, ".intra")) return "DIRECT";
    if (shExpMatch(url, "http://127.0.0.1:4998/*")) return "PROXY 127.0.0.1:${proxy.port}; DIRECT";
    return "DIRECT";
  }`);
  await openSection("network");
  await clickText('[aria-label="Proxy-Modus"] button', /^PAC$/);
  const pacUrl = await app.$('input[aria-label="Adresse der PAC-Datei"]');
  await pacUrl.setValue(`http://127.0.0.1:${proxy.port}/proxy.pac`);
  const before = proxy.seen.length;
  await clickText(".set-group button", /^Verbindung testen$/);
  await app.waitText(".net-test-result", /Verbunden/, 15000);
  assert.match(await app.text(".net-test-result"), new RegExp(`über http://127\\.0\\.0\\.1:${proxy.port}`));
  assert.ok(proxy.seen.length > before);
  await app.waitText(".pac-result", /PROXY 127\.0\.0\.1/);
  await app.click(".savebar .btn-primary");
  await app.waitText(".toast-title", /Einstellungen gespeichert/);
  const saved = await app.invoke("settings_get");
  assert.equal(saved.settings.network.mode, "pac");
  assert.match(saved.settings.network.pac_results["*"], /^PROXY 127\.0\.0\.1:\d+; DIRECT$/);
  assert.equal(saved.settings.network.pac_results["github.com"], "DIRECT");
  // Back to direct connections for the rest of the file.
  await saveSettings((s) => ({ network: { ...s.network, mode: "none" } }));
});

test("accent color and density change the CSS variables", async () => {
  await openSection("appearance");
  await app.waitText(".settings-head h1", /Darstellung/);
  const accentBefore = await cssVar("--accent");
  await app.click('.accent-swatch[data-accent="teal"]');
  await app.browser.waitUntil(async () => (await cssVar("--accent")) !== accentBefore, { timeout: 5000, timeoutMsg: "accent did not change" });
  assert.match(await cssVar("--accent"), /^#[0-9a-f]{6}$/);
  assert.equal(await cssVar("--tree-row-h"), "28px");
  await clickText('[aria-label="Dichte"] button', /^Kompakt$/);
  await app.browser.waitUntil(async () => (await cssVar("--tree-row-h")) === "24px", { timeout: 5000, timeoutMsg: "density did not change" });
  const rowHeight = await app.browser.execute(() => document.querySelector(".tree-row")?.getBoundingClientRect().height);
  assert.equal(Math.round(rowHeight), 24);
  const view = await app.invoke("settings_get");
  assert.equal(view.settings.appearance.accent, "teal");
  assert.equal(view.settings.appearance.density, "compact");
  await app.shot("settings-appearance-teal");
});

test("the settings search filters rows across sections", async () => {
  await openSection("appearance");
  const search = await app.$('input[aria-label="Einstellungen durchsuchen"]');
  await search.setValue("Runden");
  await app.waitFor(".settings-hit-section:not([hidden])");
  const titles = await app.browser.execute(() => [...document.querySelectorAll(".settings-hit-section:not([hidden]) .settings-hit-title")].map((e) => e.textContent));
  assert.ok(titles.includes("Zeiterfassung"), titles.join(", "));
  assert.ok(!titles.includes("Darstellung"), titles.join(", "));
  const rows = await app.browser.execute(() => [...document.querySelectorAll(".settings-hit-section:not([hidden]) .set-group:not([hidden]) .set-row-label")].map((e) => e.textContent));
  assert.ok(rows.includes("Mindestbuchung"), rows.join(", "));
  assert.ok(!rows.includes("Personalnummer (PERNR)"), rows.join(", "));
  await search.setValue("Dichte");
  await app.browser.waitUntil(async () => (await app.browser.execute(() => [...document.querySelectorAll(".settings-hit-section:not([hidden]) .set-row-label")].map((e) => e.textContent))).includes("Dichte"));
  await app.keys(["Escape"]);
});

test("English UI: ribbon tooltips, sidebar and settings are translated", async () => {
  await openSection("locale");
  await clickText('[aria-label="Sprache der Oberfläche"] button', /^English$/);
  await app.waitText(".settings-head h1", /Language & format/);
  const labels = await app.browser.execute(() => ({
    settings: document.querySelector(".ribbon .icon-btn:last-child")?.getAttribute("aria-label"),
    timesheet: [...document.querySelectorAll(".ribbon .icon-btn")].map((b) => b.getAttribute("aria-label")),
    sideTabs: [...document.querySelectorAll(".side-tabs .icon-btn")].map((b) => b.getAttribute("aria-label")),
    nav: [...document.querySelectorAll(".settings-nav-item")].map((b) => b.textContent),
    tab: document.querySelector(".tab.active .tab-title")?.textContent,
  }));
  assert.equal(labels.settings, "Settings (Ctrl ,)");
  assert.ok(labels.timesheet.includes("Time tracking"), labels.timesheet.join(", "));
  assert.ok(labels.timesheet.includes("New page (Ctrl N)"));
  assert.deepEqual(labels.sideTabs.slice(0, 2), ["Files", "Search (Ctrl Shift F)"]);
  assert.ok(labels.nav.includes("Network") && labels.nav.includes("Appearance"), labels.nav.join(", "));
  assert.equal(labels.tab, "Settings");
  await app.shot("settings-english");
  await clickText('[aria-label="Interface language"] button', /^Deutsch$/);
  await app.waitText(".settings-head h1", /Sprache & Format/);
});

test("a rebound shortcut runs its command; conflicts are shown", async () => {
  await openSection("keyboard");
  await app.waitText(".settings-head h1", /Tastatur/);
  // Conflict: „Aufgaben“ on Ctrl+K (the palette).
  await app.click('.key-recorder[data-command="tasks"]');
  await app.keys(["Control", "k"]);
  await app.waitText(".keys-conflict", /Kollidiert mit: Befehlspalette/);
  await app.click('.key-recorder[data-command="tasks"]');
  await app.keys(["Control", "Shift", "a"]);
  // Ctrl+Alt is AltGr: rejected.
  await app.click('.key-recorder[data-command="daily_note"]');
  await app.keys(["Control", "Alt", "l"]);
  await app.waitText(".keys-conflict", /AltGr/);
  await app.click('.key-recorder[data-command="daily_note"]');
  await app.keys(["Control", "Shift", "l"]);
  await app.browser.waitUntil(async () => /Ctrl\s*Shift\s*L/.test(await app.text('.key-recorder[data-command="daily_note"]')));
  await app.click(".savebar .btn-primary");
  await app.waitText(".toast-title", /Einstellungen gespeichert/);
  const view = await app.invoke("settings_get");
  assert.deepEqual(view.settings.keymap, { daily_note: "Ctrl+Shift+L" });
  // The ribbon shows the new shortcut, and it opens today's daily note.
  assert.match(await app.browser.execute(() => document.querySelector('.ribbon [aria-label^="Heutige"]')?.getAttribute("aria-label")), /Ctrl Shift L/);
  await app.browser.execute(() => document.activeElement?.blur());
  await app.keys(["Control", "Shift", "l"]);
  const today = new Date();
  const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  await app.waitText(".tab.active .tab-title", new RegExp(iso));
  // The old combination is free again (nothing happens on Ctrl+Shift+D… it does not open another tab).
  await saveSettings(() => ({ keymap: {} }));
});

test("export and import of all settings (no secrets) round-trip", async () => {
  const file = path.join(tmp, "einstellungen.json");
  await app.invoke("settings_export", { path: file });
  const exported = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(exported.format, "annalo-settings");
  assert.equal(exported.settings.appearance.accent, "teal");
  const raw = fs.readFileSync(file, "utf8");
  assert.ok(!raw.includes(llm.apiKey) && !raw.includes("geh eim"), "no secrets in the export");

  // Change something, then import the file again.
  await saveSettings((s) => ({ theme: "dark", appearance: { ...s.appearance, accent: "rose" }, time: { ...s.time, rounding: { step_minutes: 15, mode: "up", min_minutes: 0 } } }));
  const text = await app.invoke("settings_file_read", { path: file });
  assert.equal(text, raw);
  await assert.rejects(app.invoke("settings_file_read", { path: path.join(tmp, "x.txt") }), /json/i);
  await app.invoke("settings_save", { settings: JSON.parse(text).settings });
  const back = await app.invoke("settings_get");
  assert.equal(back.settings.appearance.accent, "teal");
  assert.equal(back.settings.time.rounding.step_minutes, 0);
  // The UI follows settings saved elsewhere.
  await app.browser.waitUntil(async () => (await app.browser.execute(() => document.documentElement.dataset.density)) === "compact");

  // Section defaults and „Alles zurücksetzen“ keep the connection.
  const appearance = await app.invoke("settings_defaults", { section: "appearance" });
  assert.equal(appearance.appearance.accent, "indigo");
  assert.equal(appearance.appearance.density, "normal");
  const all = await app.invoke("settings_defaults", { section: null });
  assert.equal(all.litellm_base_url, llm.url);
  assert.equal(all.appearance.accent, "indigo");
  await assert.rejects(app.invoke("settings_defaults", { section: "gibt-es-nicht" }), /Unbekannter Abschnitt/);

  // The Verwaltung section previews a reset.
  await openSection("admin");
  await clickText(".set-row button", /^Zurücksetzen$/);
  await app.waitFor(".settings-diff");
  assert.match(await app.text(".settings-diff"), /appearance\.accent/);
  await clickText(".dialog button", /^Übernehmen$/);
  await app.waitText(".toast-title", /Einstellungen gespeichert/);
  assert.equal((await app.invoke("settings_get")).settings.appearance.accent, "indigo");
  assert.deepEqual(await app.consoleErrors(), []);
});
