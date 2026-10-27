// The guided Git sync setup with a fake GitLab (groups and subgroups, a pasted project page, an
// expired token, a token that may not create projects) and a fake Gitea (its server address,
// pages of 50, a repository with other files: the notes go to a branch of their own), another
// server checked with git alone, and the manual form („Manuell einrichten“).
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";
import { startFakeProvider } from "../lib/fake-gitprovider.js";
import { checked, fill, mode, onStep, openBackupSettings, openSetup, primary, problem, shots } from "../lib/gitsetup.js";

const test = guarded(nodeTest, () => app);
let app;
let gl;
let gt;
before(async () => {
  app = await launch();
  gl = await startFakeProvider({ flavor: "gitlab", token: "glpat-e2eSetup4711" });
  for (let i = 0; i < 3; i++) gl.repos.push({ owner: "mia/arbeit", name: `liste-${i}`, push: true, bare: null, private: true, description: null, updated: "2026-01-01T00:00:00Z" });
  gl.addRepo("notizen", { repoOwner: "mia/privat" });
  gt = await startFakeProvider({ flavor: "gitea", token: "gitea_e2eSetup4711" });
  for (let i = 0; i < 58; i++) gt.repos.push({ owner: "mia", name: `alt-${String(i).padStart(2, "0")}`, push: true, bare: null, private: true, description: null, updated: "2026-01-01T00:00:00Z" });
  gt.addRepo("projekt", { files: { "README.md": "# Projekt\n", "plan.txt": "x" } });
});
after(async () => {
  await app?.close();
  await gl?.close();
  await gt?.close();
});

/** „Jetzt synchronisieren“ at the end of the setup; waits for the commit on the fake server. */
const sync = async (fake, repo, branch) => {
  await app.click(".dialog-foot .btn-primary");
  await app.browser.waitUntil(async () => fake.log(repo, branch).length > 0, { timeout: 40000, timeoutMsg: `nothing uploaded to ${branch}` });
  await app.dismissToasts();
};

test("GitLab: a pasted project page, an expired token, a token that may not create", async () => {
  await openSetup(app);
  await fill(app, '.gs-body input[aria-label="Oder füge die Adresse eines Repositorys ein"]', `${gl.base}/mia/privat/notizen/-/tree/main`);
  // The host names no provider: GitLab is chosen, the pasted server becomes its address.
  await app.click('.gs-provider[data-provider="gitlab"]');
  assert.equal(await app.browser.execute(() => document.querySelector('.gs-body input[aria-label="Serveradresse"]').value), gl.base);
  await app.waitText(".gs-note", /Erkannt: mia\/privat\/notizen auf 127\.0\.0\.1/);
  await primary(app);
  await onStep(app, "Token");
  await app.click(".gs-token-page");
  await app.browser.waitUntil(async () => app.opened().includes(`${gl.base}/-/user_settings/personal_access_tokens?name=Arcalo&scopes=read_repository,write_repository,read_api`), { timeoutMsg: `token page: ${app.opened().join(", ")}` });

  await fill(app, '.gs-body input[aria-label="Zugangstoken"]', "glpat-e2eSetup4711");
  gl.state.expired = true;
  await primary(app);
  let p = await problem(app);
  assert.equal(p.kind, "token_expired");
  assert.match(p.text, /Lege einen neuen Token an/);
  gl.state.expired = false;
  await primary(app);
  await onStep(app, "Repository");
  // The pasted project is picked from the list.
  await app.browser.waitUntil(async () => (await app.browser.execute(() => document.querySelector('.gs-repo[aria-selected="true"] .gs-repo-name')?.textContent)) === "mia/privat/notizen", { timeoutMsg: "the pasted project is not picked" });
  await shots(app, "gitlab-repos");

  // Creating a project needs the scope „api“.
  gl.state.gitlabScopes = ["read_repository", "write_repository", "read_api"];
  await mode(app, 1);
  await primary(app);
  p = await problem(app);
  assert.equal(p.kind, "token_scope");
  assert.match(p.text, /Bereichen an: api\./);
  gl.state.gitlabScopes = ["read_repository", "write_repository", "read_api", "api"];

  await mode(app, 0);
  await primary(app);
  await onStep(app, "Prüfen");
  assert.deepEqual(Object.values(await checked(app)), ["ok", "ok", "ok", "ok", "ok", "ok"]);
  await primary(app);
  await app.waitFor(".gs-done");
  const repo = gl.find("mia/privat", "notizen");
  assert.equal((await app.invoke("settings_get")).settings.git_sync.remote_url, gl.cloneUrl(repo));
  await sync(gl, repo, "main");
  assert.ok(gl.files(repo).includes(".gitattributes"));
});

test("Gitea: the server address first, pages of 50, a repository with other files", async () => {
  await openSetup(app);
  await app.click('.gs-provider[data-provider="gitea"]');
  await fill(app, '.gs-body input[aria-label="Serveradresse"]', "");
  assert.equal(await app.browser.execute(() => document.querySelector(".gs-primary").disabled), true, "a Gitea needs its address");
  await fill(app, '.gs-body input[aria-label="Serveradresse"]', gt.base);
  await primary(app);
  await onStep(app, "Token");
  await app.click(".gs-token-page");
  await app.browser.waitUntil(async () => app.opened().includes(`${gt.base}/user/settings/applications`), { timeoutMsg: "token page" });
  // The token of the GitLab is stored; this server needs its own.
  await fill(app, '.gs-body input[aria-label="Zugangstoken"]', "gitea_e2eSetup4711");
  await primary(app);
  await onStep(app, "Repository");
  await app.waitText(".gs-count", /^59 Repositorys$/);
  const pages = gt.seen.filter((r) => r.path === "/api/v1/user/repos").map((r) => new URLSearchParams(r.query).get("page"));
  assert.deepEqual(pages, ["1", "2"]);
  assert.ok(gt.seen.filter((r) => r.path.startsWith("/api/")).every((r) => r.authorization === "token gitea_e2eSetup4711"));
  await fill(app, ".gs-search input", "projekt");
  await app.browser.waitUntil(async () => (await app.$$(".gs-repo")).length === 1);
  await app.click(".gs-repo");
  await primary(app);
  await checked(app);
  await app.waitText(".gs-check", /^Branch: arcalo$/);
  await app.waitText(".gs-callout", /andere Dateien/);
  await shots(app, "gitea-check-other");
  await primary(app);
  await app.waitFor(".gs-done");
  const view = await app.invoke("settings_get");
  assert.equal(view.settings.git_sync.branch, "arcalo");
  const repo = gt.find("mia", "projekt");
  await sync(gt, repo, "arcalo");
  // The other files stay as they were.
  assert.equal(gt.log(repo, "main").length, 1);
  assert.deepEqual(gt.files(repo, "main").sort(), ["README.md", "plan.txt"]);
});

test("another server: the address, the token, and git checks it", async () => {
  const repo = gt.addRepo("roh");
  await openSetup(app);
  await app.click('.gs-provider[data-provider="other"]');
  await primary(app);
  await onStep(app, "Token");
  assert.equal(await app.$$(".gs-token-page").then((l) => l.length), 0, "no token page for another server");
  await fill(app, '.gs-body input[aria-label="Zugangstoken"]', "gitea_e2eSetup4711");
  await primary(app);
  await onStep(app, "Repository");
  await fill(app, '.gs-body input[aria-label="Adresse des Repositorys"]', gt.cloneUrl(repo));
  await primary(app);
  await onStep(app, "Prüfen");
  const states = await checked(app);
  assert.deepEqual(states, { git: "ok", write: "unknown", branch: "ok" });
  await app.waitText(".gs-check", /Schreibrecht: wird beim ersten Hochladen geprüft/);
  await app.waitText(".gs-callout", /Das Repository ist leer/);
  await shots(app, "other-check");
  await primary(app);
  await app.waitFor(".gs-done");
  assert.equal((await app.invoke("settings_get")).settings.git_sync.remote_url, gt.cloneUrl(repo));
  await app.click(".dialog-foot .btn:not(.btn-primary)");
});

test("the manual form stays reachable", async () => {
  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", { settings: { ...view.settings, git_sync: { ...view.settings.git_sync, remote_url: "", enabled: false } } });
  await openBackupSettings(app);
  await app.browser.waitUntil(async () => app.browser.execute(() => !document.querySelector('input[aria-label="Remote-URL"]')), { timeoutMsg: "the form shows without an address" });
  await app.waitFor(".gs-manual-open");
  await app.shot("gitsetup-entry");
  // From the setup's footer: the setup closes, the form opens.
  await openSetup(app);
  await app.click(".gs-manual");
  await app.browser.waitUntil(async () => app.browser.execute(() => !document.querySelector(".gs-body")));
  const url = await app.waitFor('input[aria-label="Remote-URL"]');
  await url.scrollIntoView({ block: "center" });
  const repo = gt.find("mia", "roh");
  await url.click();
  await url.setValue(gt.cloneUrl(repo));
  await app.keys(["Enter"]);
  await app.browser.waitUntil(async () => (await app.invoke("settings_get")).settings.git_sync.remote_url === gt.cloneUrl(repo), { timeoutMsg: "the address was not saved" });
  // Its connection test still works (git ls-remote with the stored token).
  const t = await app.invoke("git_sync_test", { url: null, token: null });
  assert.equal(t.ok, true, t.error);
});
