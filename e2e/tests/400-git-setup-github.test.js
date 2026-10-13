// The guided Git sync setup with a fake GitHub (Enterprise form, on 127.0.0.1) that also serves
// its repositories over HTTP: provider, the token page with the scope ticked, a wrong token in
// plain words, the list (two pages, search), pick, check (server, token, rights, git, branch,
// content), save (address, branch, switched on; the token only in the credential store), sync;
// then a new private repository, a name that exists, what the check says about existing content
// and a read-only repository. Screenshots of each step in light and dark at 900 and 1280 px.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";
import { startFakeProvider } from "../lib/fake-gitprovider.js";
import { checked, fill, mode, onStep, openSetup, pick, primary, problem, shots } from "../lib/gitsetup.js";

const test = guarded(nodeTest, () => app);
let app;
let gh;
before(async () => {
  app = await launch();
  gh = await startFakeProvider({ flavor: "github" });
  // A long list (two pages of 100) of repositories that only the API knows, and the real ones.
  for (let i = 0; i < 118; i++) gh.repos.push({ owner: "mia", name: `projekt-${String(i).padStart(3, "0")}`, push: true, bare: null, private: i % 3 !== 0, description: i % 4 ? null : "Ein altes Projekt", updated: "2026-01-01T00:00:00Z" });
  gh.addRepo("notizen");
  gh.addRepo("arcalo-alt", { files: { ".gitattributes": gh.MARKER, "Notiz.md": "# Notiz vom Laptop\n" } });
  gh.addRepo("website", { files: { "README.md": "# Website\n", "index.html": "<h1>x</h1>" } });
  gh.addRepo("lesen", { push: false });
});
after(async () => {
  await app?.close();
  await gh?.close();
});

const TOKEN = "ghp_e2eSetupToken4711";

test("provider, token page and a wrong token in plain words", async () => {
  await openSetup(app);
  await onStep(app, "Anbieter");
  // Nothing is chosen yet; „Manuell einrichten“ is always there.
  assert.equal(await app.browser.execute(() => document.querySelector(".gs-primary").disabled), true);
  assert.ok(await app.$(".gs-manual"));
  await shots(app, "1-provider");
  await app.click('.gs-provider[data-provider="github"]');
  await fill(app, '.gs-body input[aria-label="Serveradresse"]', gh.base);
  await primary(app);
  await onStep(app, "Token");
  await shots(app, "2-token");

  // The token page with the scope already ticked (GitHub Enterprise: the server's own page).
  await app.click(".gs-token-page");
  await app.browser.waitUntil(async () => app.opened().some((u) => u === `${gh.base}/settings/tokens/new?scopes=repo&description=Arcalo`), { timeoutMsg: `token page not opened: ${app.opened().join(", ")}` });

  await fill(app, '.gs-body input[aria-label="Zugangstoken"]', "ghp_falsch");
  await primary(app);
  const p = await problem(app);
  assert.equal(p.kind, "token_invalid");
  assert.match(p.title, /Der Server nimmt den Token nicht an/);
  assert.match(p.text, /vollständig kopiert/);
  assert.ok(!p.text.includes("ghp_falsch"), "the token is never shown");
  await shots(app, "2-token-wrong");
});

test("the list of repositories, search and the check of an empty one", async () => {
  // Typed like a user.
  const field = await app.$('.gs-body input[aria-label="Zugangstoken"]');
  await fill(app, '.gs-body input[aria-label="Zugangstoken"]', "");
  await field.click();
  await app.type(TOKEN);
  await primary(app);
  await onStep(app, "Repository");
  await app.waitText(".gs-note", /Angemeldet als mia/);
  await app.waitText(".gs-count", /^122 Repositorys$/);
  const pages = gh.seen.filter((r) => r.path === "/api/v3/user/repos").map((r) => new URLSearchParams(r.query).get("page"));
  assert.deepEqual(pages, ["1", "2"], "both pages");
  await shots(app, "3-repos");
  await fill(app, ".gs-search input", "alt");
  await app.waitText(".gs-count", /^(\d+) Repositorys?$/);
  assert.ok((await app.$$(".gs-repo")).length < 122);
  await pick(app, "mia/notizen");
  await primary(app);
  await onStep(app, "Prüfen");
  const states = await checked(app);
  assert.deepEqual(states, { server: "ok", token: "ok", repository: "ok", write: "ok", git: "ok", branch: "ok" });
  await app.waitText(".gs-check", /^Branch: main$/);
  await app.waitText(".gs-callout", /Das Repository ist leer/);
  await shots(app, "4-check-empty");
});

test("save stores address, branch and the token (only in the credential store); sync now uploads", async () => {
  await primary(app);
  await app.waitFor(".gs-done");
  await app.waitText(".gs-done", new RegExp(`mia/notizen`));
  const view = await app.invoke("settings_get");
  assert.equal(view.settings.git_sync.remote_url, gh.cloneUrl(gh.find("mia", "notizen")));
  assert.equal(view.settings.git_sync.branch, "main");
  assert.equal(view.settings.git_sync.enabled, true);
  assert.ok(!JSON.stringify(view).includes(TOKEN), "the token is not in the settings");
  assert.equal((await app.invoke("git_sync_status")).token_set, true);
  await shots(app, "5-done");
  // „Jetzt synchronisieren“: the first sync uploads the notes with the stored token.
  await app.click(".dialog-foot .btn-primary");
  await app.browser.waitUntil(async () => gh.log(gh.find("mia", "notizen")).length === 1, { timeout: 30000, timeoutMsg: "nothing uploaded" });
  assert.ok(gh.files(gh.find("mia", "notizen")).includes(".gitattributes"));
  await app.dismissToasts();
  // The token went in headers only, never into an address; every API request named the app.
  for (const r of gh.seen) {
    assert.ok(!`${r.path}${r.query}`.includes(TOKEN), `token in ${r.path}`);
    if (r.path.startsWith("/api/")) assert.match(r.userAgent, /^Arcalo\//);
  }
  // The token is never in the log either.
  const fs = await import("node:fs");
  const path = await import("node:path");
  const log = fs.readFileSync(path.join(app.dataDir, "logs", "arcalo.log"), "utf8");
  assert.ok(log.includes("setup:"), "the setup logs what it did");
  assert.ok(!log.includes(TOKEN), "token in the log");
});

test("a new private repository, and a name that exists already", async () => {
  await openSetup(app);
  // Set up again: provider and server come from the saved address.
  await app.click('.gs-provider[data-provider="github"]');
  assert.equal(await app.browser.execute(() => document.querySelector('.gs-body input[aria-label="Serveradresse"]').value), gh.base);
  await primary(app);
  await onStep(app, "Token");
  await app.waitText(".field-hint", /Ein Token ist schon gespeichert/);
  // The stored token is used when the field stays empty.
  await primary(app);
  await onStep(app, "Repository");
  await mode(app, 1);
  assert.equal(await app.browser.execute(() => document.querySelector('.gs-body input[aria-label="Name des neuen Repositorys"]').value), "arcalo-notizen");
  await shots(app, "3-create");
  await primary(app);
  await onStep(app, "Prüfen");
  assert.deepEqual(Object.values(await checked(app)), ["ok", "ok", "ok", "ok", "ok", "ok"]);
  const made = gh.find("mia", "arcalo-notizen");
  assert.ok(made, "created on the server");
  assert.equal(made.private, true);
  await primary(app);
  await app.waitFor(".gs-done");
  assert.equal((await app.invoke("settings_get")).settings.git_sync.remote_url, gh.cloneUrl(made));
  await app.click(".dialog-foot .btn:not(.btn-primary)");

  await openSetup(app);
  await app.click('.gs-provider[data-provider="github"]');
  await primary(app);
  await primary(app);
  await onStep(app, "Repository");
  await mode(app, 1);
  await primary(app);
  const p = await problem(app);
  assert.equal(p.kind, "exists");
  assert.match(p.title, /Ein Repository mit diesem Namen gibt es schon/);
  await shots(app, "3-create-exists");
  // A name a repository cannot have is not sent.
  await fill(app, '.gs-body input[aria-label="Name des neuen Repositorys"]', "mein repo");
  assert.equal(await app.browser.execute(() => document.querySelector(".gs-primary").disabled), true);
});

test("existing content is explained before the first sync; read only stops with the fix", async () => {
  await mode(app, 0);
  await pick(app, "mia/arcalo-alt");
  await primary(app);
  await checked(app);
  await app.waitText(".gs-callout", /enthält schon Notizen aus Arcalo.*übernimmt sie und führt sie mit deinen zusammen.*Überschrieben wird nichts/s);
  await app.waitText(".gs-check", /^Branch: main$/);
  await shots(app, "4-check-arcalo");

  await app.click(".dialog-foot .btn:not(.btn-primary):not(.gs-manual)");
  await onStep(app, "Repository");
  await pick(app, "mia/website");
  await primary(app);
  await checked(app);
  await app.waitText(".gs-callout", /andere Dateien.*eigenen Branch „arcalo“.*Überschrieben wird nichts/s);
  await app.waitText(".gs-check", /^Branch: arcalo$/);
  await shots(app, "4-check-other");

  await app.click(".dialog-foot .btn:not(.btn-primary):not(.gs-manual)");
  await pick(app, "mia/lesen");
  await primary(app);
  const states = await checked(app);
  assert.equal(states.write, "fail");
  assert.equal(states.git, "skipped");
  const p = await problem(app);
  assert.equal(p.kind, "no_write");
  assert.match(p.title, /Dieses Repository darfst du nur lesen/);
  assert.match(p.text, /Anderes Repository wählen/);
  await shots(app, "4-check-readonly");
  await app.keys(["Escape"]);
  // Nothing of this was saved.
  assert.equal((await app.invoke("settings_get")).settings.git_sync.remote_url, gh.cloneUrl(gh.find("mia", "arcalo-notizen")));
});
