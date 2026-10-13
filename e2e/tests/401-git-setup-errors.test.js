// Every way the guided Git sync setup can fail, in plain words with the fix: a sign-in page instead
// of the API, a server error, the rate limit, an expired token, a server that cannot be reached,
// an untrusted certificate, no answer in time, a proxy that refuses, a token without the scope,
// git refusing the token, a repository that is gone, an SSH address; and the kinds only a
// command can produce (a bad address or name, no token). Fake servers on 127.0.0.1 only.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { launch, guarded } from "../lib/harness.js";
import { startFakeProvider, startRefusingProxy } from "../lib/fake-gitprovider.js";
import { startTls } from "../lib/fake-network.js";
import { checked, fill, mode, onStep, openSetup, pick, primary, problem, shots } from "../lib/gitsetup.js";

const test = guarded(nodeTest, () => app);
let app;
let gh;
let tls;
let proxy;
let closedPort;
before(async () => {
  app = await launch();
  gh = await startFakeProvider({ flavor: "github" });
  gh.addRepo("notizen");
  tls = await startTls("git.firma.test");
  proxy = await startRefusingProxy();
  // A port nobody listens on.
  const s = net.createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  closedPort = s.address().port;
  await new Promise((r) => s.close(r));
});
after(async () => {
  await app?.close();
  await gh?.close();
  await tls?.close();
  await proxy?.close();
});

const TOKEN = "ghp_e2eSetupToken4711";
const TOKEN_FIELD = '.gs-body input[aria-label="Zugangstoken"]';

/** From the token step back to the first one, a new server address, on to the token step. */
async function server(web) {
  await app.click(".dialog-foot .btn:not(.btn-primary):not(.gs-manual)");
  await onStep(app, "Anbieter");
  await fill(app, '.gs-body input[aria-label="Serveradresse"]', web);
  await primary(app);
  await onStep(app, "Token");
}

/** The token step's „Weiter“ fails with `kind`; its words are `title`. */
async function failsWith(kind, title, timeout) {
  await primary(app);
  const p = await problem(app, timeout);
  assert.equal(p.kind, kind, p.text);
  assert.match(p.title, title);
  assert.ok(!p.text.includes(TOKEN), "the token is never shown");
  return p;
}

async function saveNetwork(patch) {
  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", { settings: { ...view.settings, network: { ...view.settings.network, ...patch } } });
}

test("failures while the token is checked", async () => {
  await openSetup(app);
  await app.click('.gs-provider[data-provider="github"]');
  await fill(app, '.gs-body input[aria-label="Serveradresse"]', gh.base);
  await primary(app);
  await onStep(app, "Token");
  await fill(app, TOKEN_FIELD, TOKEN);

  gh.state.html = true;
  await failsWith("not_api", /Unter dieser Adresse antwortet kein Server dieses Anbieters/);
  gh.state.html = false;

  gh.state.fail = { status: 502, times: 1 };
  const p = await failsWith("server", /Der Server meldet einen Fehler \(502\)/);
  assert.match(p.text, /Versuche es später noch einmal/);

  gh.state.fail = { status: 403, times: 1, body: { message: "API rate limit exceeded for user." }, headers: { "x-ratelimit-remaining": "0" } };
  await failsWith("rate_limited", /Der Server nimmt gerade keine weiteren Anfragen an/);

  gh.state.fail = { status: 401, times: 1, body: { message: "Token has expired" } };
  await failsWith("token_expired", /Der Token ist abgelaufen/);
  await shots(app, "error-token-expired");

  await server(`http://127.0.0.1:${closedPort}`);
  await failsWith("unreachable", /Der Server ist nicht erreichbar/);

  await server(tls.url);
  const cert = await failsWith("certificate", /Dem Zertifikat des Servers wird nicht vertraut/);
  assert.match(cert.text, /Einstellungen → Netzwerk/);
  await shots(app, "error-certificate");

  // The Git sync's route through a proxy that wants a sign-in.
  const before = (await app.invoke("settings_get")).settings.network;
  await saveNetwork({
    profiles: [...before.profiles, { ...before.profiles[0], id: "firma", name: "Firma", mode: "manual", http_proxy: proxy.address, https_proxy: "", socks_proxy: "", no_proxy: "", pac_url: "", pac_results: {} }],
    routes: { ...before.routes, git_sync: "firma" },
  });
  await server(gh.base);
  await failsWith("proxy", /Der Proxy lässt die Verbindung nicht durch/);
  assert.ok(proxy.seen.some((u) => u.startsWith(`${gh.base}/api/v3/user`)), "the request went to the proxy");

  // No answer in time: the profile's timeout (10 s at least for the setup).
  await saveNetwork({ ...before, profiles: before.profiles.map((p) => ({ ...p, connect_timeout_secs: 1 })) });
  gh.state.delay = 13000;
  const started = Date.now();
  await failsWith("timeout", /Der Server antwortet nicht rechtzeitig/, 40000);
  assert.ok(Date.now() - started < 30000, "gave up after the timeout");
  gh.state.delay = 0;
  await saveNetwork(before);

  // A wrong token, then the right one.
  await fill(app, TOKEN_FIELD, "ghp_falsch");
  await failsWith("token_invalid", /Der Server nimmt den Token nicht an/);
  await fill(app, TOKEN_FIELD, TOKEN);
  await primary(app);
  await onStep(app, "Repository");
});

/** Back from the check and check again (the check's main button saves when it passed). */
async function recheck() {
  await app.click(".dialog-foot .btn:not(.btn-primary):not(.gs-manual)");
  await onStep(app, "Repository");
  await primary(app);
  await onStep(app, "Prüfen");
  return checked(app);
}

test("failures of the check before saving", async () => {
  await pick(app, "mia/notizen");
  await primary(app);
  await onStep(app, "Prüfen");
  assert.deepEqual(Object.values(await checked(app)), ["ok", "ok", "ok", "ok", "ok", "ok"]);

  // A classic token without „repo“.
  gh.state.scopes = "read:user, gist";
  let states = await recheck();
  assert.equal(states.write, "fail");
  let p = await problem(app);
  assert.equal(p.kind, "token_scope");
  assert.match(p.title, /Dem Token fehlt eine Berechtigung/);
  assert.match(p.text, /Bereichen an: repo/);
  assert.match(p.text, /Token ändern/);
  await shots(app, "error-token-scope");
  gh.state.scopes = "repo";

  // The API takes the token, git does not (e.g. a token for the API only).
  gh.state.gitToken = "ghp_nurFuerGit";
  states = await recheck();
  assert.deepEqual([states.write, states.git, states.branch], ["ok", "fail", "skipped"]);
  p = await problem(app);
  assert.equal(p.kind, "token_invalid");
  assert.ok(!p.text.includes(TOKEN));
  gh.state.gitToken = null;

  // The repository is gone (renamed on the server).
  gh.find("mia", "notizen").name = "umbenannt";
  states = await recheck();
  assert.equal(states.repository, "fail");
  p = await problem(app);
  assert.equal(p.kind, "not_found");
  assert.match(p.title, /Repository nicht gefunden, oder der Token hat keinen Zugriff darauf/);
  assert.match(p.text, /Anderes Repository wählen/);
  await shots(app, "error-not-found");
  gh.find("mia", "umbenannt").name = "notizen";

  // „Erneut prüfen“ after the fix.
  await primary(app);
  await app.browser.waitUntil(async () => !(await app.browser.execute(() => !!document.querySelector(".gs-problem"))), { timeout: 20000, timeoutMsg: "the problem stayed" });
  assert.deepEqual(Object.values(await checked(app)), ["ok", "ok", "ok", "ok", "ok", "ok"]);
});

test("an SSH address is shown with the HTTPS one to use", async () => {
  await app.click(".dialog-foot .btn:not(.btn-primary):not(.gs-manual)");
  await onStep(app, "Repository");
  await mode(app, 2);
  await fill(app, '.gs-body input[aria-label="Adresse des Repositorys"]', "git@github.com:mia/notizen.git");
  await app.waitText(".gs-callout-warn", /Das ist eine SSH-Adresse.*https:\/\/github\.com\/mia\/notizen\.git/s);
  assert.equal(await app.browser.execute(() => document.querySelector(".gs-primary").disabled), true);
  await shots(app, "error-ssh");
  await app.browser.execute(() => [...document.querySelectorAll(".gs-callout-warn button")].find((b) => /HTTPS-Adresse verwenden/.test(b.textContent)).click());
  assert.equal(await app.browser.execute(() => document.querySelector('.gs-body input[aria-label="Adresse des Repositorys"]').value), "https://github.com/mia/notizen.git");
  await app.keys(["Escape"]);
});

test("the kinds only a request can produce", async () => {
  const github = { provider: "github", web: gh.base };
  let a = await app.invoke("git_setup_account", { server: { provider: "gitlab", web: "ftp://git.firma.de" }, token: TOKEN });
  assert.equal(a.problem.kind, "bad_address");
  a = await app.invoke("git_setup_create", { server: github, token: TOKEN, name: "kein name" });
  assert.equal(a.problem.kind, "bad_name");
  assert.equal(gh.find("mia", "kein name"), undefined, "nothing was created");
  // No token typed and none stored.
  assert.equal((await app.invoke("git_sync_status")).token_set, false);
  const c = await app.invoke("git_setup_check", { server: github, target: { url: gh.cloneUrl(gh.find("mia", "notizen")), owner: "mia", name: "notizen" }, token: null });
  assert.equal(c.problem.kind, "token_missing");
  assert.equal(c.steps.find((s) => s.id === "token").state, "fail");
  const ssh = await app.invoke("git_setup_check", { server: { provider: "other", web: "" }, target: { url: "git@git.firma.de:team/notizen.git", owner: null, name: null }, token: TOKEN });
  assert.equal(ssh.problem.kind, "ssh");
  // The token never reaches the settings, and nothing was saved.
  const view = await app.invoke("settings_get");
  assert.ok(!JSON.stringify(view).includes(TOKEN));
  assert.equal(view.settings.git_sync.remote_url, "");
});
