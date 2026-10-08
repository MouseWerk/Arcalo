// Suche nach Bedeutung (1.15): a local embedding model (a fake Ollama with a deterministic
// "meaning" embedding, e2e/lib/fake-embeddings.js) indexes the workspace in the background with
// progress in Settings → Suche; the search sidebar and the palette show pages found by meaning,
// labelled „ähnlich“ with their passage, after the exact hits; „Nur exakt“ hides them. With an
// embedding model in the cloud no #privat page and no query with a privacy marker is sent there
// (checked on the fake server's requests). Switched off, offline or without a model the search
// finds exact words only. The English UI says the same.
//
// SEMANTIC_SHOTS (a folder): also saves screenshots of the results and the settings, light and dark.

import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { launch, guarded } from "../lib/harness.js";
import { launchEnglish, germanLeftovers } from "../lib/english.js";
import { startFakeOpenAI } from "../lib/fake-openai.js";
import { meaningVector } from "../lib/fake-embeddings.js";

const test = guarded(nodeTest, () => app);
let app, local, cloud;
const SHOTS = process.env.SEMANTIC_SHOTS;
const env = { ARCALO_SEMANTIC_DELAY_SECS: "1" };
const provider = (id, name, kind, base_url, isLocal) => ({ id, name, kind, base_url, local: isLocal, enabled: true, bypass_proxy: isLocal, api_version: "", models: [] });

before(async () => {
  local = await startFakeOpenAI({ port: 4951, kind: "ollama", name: "Ollama", models: ["nomic-embed-text"], embed: meaningVector });
  cloud = await startFakeOpenAI({ port: 4952, kind: "openai", name: "Cloud", apiKey: "sk-cloud-e2e", models: ["text-embedding-3-small"], embed: meaningVector });
  app = await launch({ env, width: 1440, height: 900 });
  await addPages(app);
  await useModel(app, "ollama", "nomic-embed-text", null);
  await app.invoke("provider_key_set", { id: "cloud", key: cloud.apiKey });
});
after(async () => {
  await app?.close();
  await local?.close();
  await cloud?.close();
});

async function addPages(a) {
  const create = (title, content) => a.invoke("page_create", { parentId: null, title, icon: null, content });
  await create("Rahmenvertrag Müller", "# Rahmenvertrag\n\nAngebot Müller: Rahmenvertrag ab Januar, Laufzeit zwei Jahre.");
  await create("Dachsanierung", "# Dachsanierung\n\nKostenvoranschlag für Kunde Müller zur Sanierung des Dachs im Frühjahr.");
  await create("Sommer", "Ferien im August an der Ostsee.");
  await create("Geheimprojekt", "Geheimprojekt Zander: Kostenvoranschlag für Kunde Müller, nur intern.\n\n#privat");
}

/** Embedding model and the switch („null“ = automatic). */
async function useModel(a, providerId, model, semantic) {
  const view = await a.invoke("settings_get");
  await a.invoke("settings_save", {
    settings: {
      ...view.settings,
      providers: [provider("ollama", "Ollama", "ollama", local.url, true), provider("cloud", "Cloud", "openai", `${cloud.url}/v1`, false)],
      embedding_provider: providerId,
      embedding_model: model,
      search: { semantic },
    },
  });
}

/** Waits until the index has nothing left to do. */
async function indexed(a, timeout = 30000) {
  let last = null;
  await a.browser.waitUntil(
    async () => {
      last = await a.invoke("semantic_status");
      return last.inactive == null && !last.running && last.progress.total > 0 && last.progress.done >= last.progress.total;
    },
    { timeout, interval: 300, timeoutMsg: "index not done" },
  ).catch((e) => {
    throw new Error(`${e.message}: ${JSON.stringify(last)}`);
  });
  return last;
}

async function sidebarSearch(a, q) {
  await a.keys(["Control", "Shift", "f"]);
  await a.waitFor(".side-search input");
  const input = await a.$(".side-search input");
  await input.clearValue();
  await input.setValue(q);
}

/** The sidebar's results: title, whether found by meaning, its first snippet line. */
const results = (a) =>
  a.browser.execute(() =>
    [...document.querySelectorAll(".side-result")].map((r) => ({
      title: r.querySelector(".side-result-name")?.textContent ?? r.querySelector(".side-result-title")?.textContent.trim(),
      similar: r.classList.contains("similar"),
      label: r.querySelector(".hit-similar")?.textContent ?? null,
      snippet: r.querySelector(".side-result-snippet")?.textContent ?? "",
    })),
  );

async function shot(a, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await a.browser.pause(300);
  await a.browser.saveScreenshot(path.join(SHOTS, `${name}.png`));
}

async function theme(a, mode) {
  const view = await a.invoke("settings_get");
  await a.invoke("settings_save", { settings: { ...view.settings, theme: mode } });
  await a.browser.execute((m) => (document.documentElement.dataset.theme = m), mode);
  await a.browser.pause(400);
}

async function openSearchSettings(a, label) {
  await a.dismissToasts();
  await a.click(`.ribbon [aria-label^="${label}"]`);
  await a.click('.settings-nav-item[data-section="search"]');
  await a.waitFor(".search-model, .search-note");
}

test("the local model indexes the workspace in the background, with progress in Settings → Suche", async () => {
  const st = await indexed(app);
  assert.equal(st.local, true);
  assert.equal(st.switch_on, true, "on by itself with a local embedding model");
  assert.equal(st.automatic, true);
  assert.equal(st.progress.private_skipped, 0, "a local model indexes private pages too");
  assert.ok(local.embedded().some((t) => t.includes("Zander")), "the local model saw the private page");
  assert.equal(cloud.embedded().length, 0, "nothing went to the cloud");

  await openSearchSettings(app, "Einstellungen");
  await app.waitText(".search-index-count", /Aktuell · \d+ Abschnitte/);
  assert.match(await app.text(".search-model"), /nomic-embed-text\s*lokal · Ollama/);
  assert.equal(await app.browser.execute(() => document.querySelector('.settings [role="switch"][aria-label="Suche nach Bedeutung"]')?.getAttribute("aria-checked")), "true");
  // A new page is indexed on its own after saving.
  const before = st.progress.total;
  await app.invoke("page_create", { parentId: null, title: "Urlaubsplanung", icon: null, content: "Urlaub im Herbst planen, Vertretung klären." });
  const after = await indexed(app);
  assert.ok(after.progress.total > before, `${after.progress.total} > ${before}`);
  // „Index neu aufbauen“: everything again, with the progress shown while it runs.
  const calls = local.embedded().length;
  await app.click(".search-rebuild");
  await app.browser.waitUntil(async () => local.embedded().length - calls >= after.progress.total, { timeout: 30000, timeoutMsg: "not every chunk embedded again" });
  await indexed(app);
  await app.waitText(".search-index-count", /Aktuell/);
  await shot(app, "settings-search-light");
  await theme(app, "dark");
  await shot(app, "settings-search-dark");
  await theme(app, "light");
});

test("the sidebar finds a page by meaning, labelled „ähnlich“ with its passage, after the exact hit", async () => {
  await sidebarSearch(app, "Angebot Müller");
  await app.browser.waitUntil(async () => (await results(app)).some((r) => r.similar), { timeout: 8000, timeoutMsg: "no meaning hit" });
  const rs = await results(app);
  assert.equal(rs[0].title, "Rahmenvertrag Müller", JSON.stringify(rs));
  assert.equal(rs[0].similar, false, "the exact hit stays first");
  const kv = rs.find((r) => r.title === "Dachsanierung");
  assert.ok(kv?.similar, JSON.stringify(rs));
  assert.equal(kv.label, "ähnlich");
  assert.match(kv.snippet, /Kostenvoranschlag für Kunde Müller/);
  assert.ok(!rs.some((r) => r.title === "Sommer"), "an unrelated page is not listed");
  assert.match(await app.text(".side-result-count"), /\d+ nach Bedeutung/);
  await shot(app, "sidebar-meaning-light");
  await theme(app, "dark");
  await shot(app, "sidebar-meaning-dark");
  await theme(app, "light");
  // Opening it.
  await app.browser.execute(() => [...document.querySelectorAll(".side-result.similar")].find((r) => r.textContent.includes("Dachsanierung"))?.click());
  await app.waitFor(".pane.active .ProseMirror");
});

test("„Nur exakt“ hides the meaning hits, in the sidebar and in the palette", async () => {
  await sidebarSearch(app, "Angebot Müller");
  await app.browser.waitUntil(async () => (await results(app)).some((r) => r.similar), { timeout: 8000 });
  await app.click(".side-filter");
  await app.browser.waitUntil(async () => !(await results(app)).some((r) => r.similar), { timeout: 8000, timeoutMsg: "meaning hits still shown" });
  assert.equal(await app.browser.execute(() => document.querySelector(".side-filter")?.getAttribute("aria-pressed")), "true");
  assert.deepEqual((await results(app)).map((r) => r.title), ["Rahmenvertrag Müller"]);
  // The palette follows the same choice …
  await app.keys(["Escape"]);
  await app.keys(["Control", "k"]);
  await app.waitFor(".palette input");
  await app.type("Angebot Müller");
  await app.browser.waitUntil(async () => app.browser.execute(() => !!document.querySelector(".pal-foot .side-filter.on")), { timeout: 8000, timeoutMsg: "no exact-only toggle in the palette" });
  assert.equal(await app.browser.execute(() => document.querySelectorAll(".palette .hit-similar").length), 0);
  // … and turns it off again: the meaning hit shows there too.
  await app.click(".pal-foot .side-filter");
  await app.browser.waitUntil(
    async () => app.browser.execute(() => [...document.querySelectorAll(".palette .pal-item")].some((i) => i.querySelector(".hit-similar") && i.textContent.includes("Dachsanierung") && i.textContent.includes("Kostenvoranschlag"))),
    { timeout: 8000, timeoutMsg: "no meaning hit in the palette" },
  );
  await shot(app, "palette-meaning-light");
  await app.keys(["Escape"]);
});

test("an embedding model in the cloud never gets #privat pages or a query with a privacy marker", async () => {
  // Not local: off until switched on.
  await useModel(app, "cloud", "text-embedding-3-small", null);
  const off = await app.invoke("semantic_status");
  assert.deepEqual([off.switch_on, off.local, off.inactive], [false, false, "switched_off"]);
  assert.equal(cloud.embedded().length, 0);
  await useModel(app, "cloud", "text-embedding-3-small", true);
  const st = await indexed(app);
  assert.ok(st.progress.private_skipped > 0, JSON.stringify(st));
  const sent = cloud.embedded();
  assert.ok(sent.length > 0, "the other pages were indexed");
  assert.ok(!sent.some((t) => /Zander|#privat/i.test(t)), "a private page went to the cloud");
  // Found by meaning with the cloud model as well; the private page only by its words.
  const hits = await app.invoke("search_semantic", { query: "Angebot Müller", limit: 30 });
  assert.equal(hits.meaning, true);
  assert.ok(hits.hits.some((h) => h.kind === "similar" && h.title === "Dachsanierung"));
  assert.ok(!hits.hits.some((h) => h.kind === "similar" && h.title === "Geheimprojekt"));
  // A query that names a privacy marker stays here: exact hits only.
  const before = cloud.embedded().length;
  const priv = await app.invoke("search_semantic", { query: "Zander #privat", limit: 30 });
  assert.equal(priv.meaning, false);
  assert.equal(cloud.embedded().length, before, "the private query was sent");
  // Settings say where it runs and what stays out.
  await openSearchSettings(app, "Einstellungen");
  await app.waitText(".search-model", /nicht lokal · Cloud/);
  await app.waitText(".settings", /Abschnitte? privater Seiten (bleibt|bleiben) draußen/);
  // „Nur lokal“ stops it.
  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", { settings: { ...view.settings, privacy: { ...view.settings.privacy, local_only: true } } });
  assert.equal((await app.invoke("semantic_status")).inactive, "local_only");
  const n = cloud.embedded().length;
  assert.equal((await app.invoke("search_semantic", { query: "Angebot Müller", limit: 30 })).meaning, false);
  assert.equal(cloud.embedded().length, n);
  const v2 = await app.invoke("settings_get");
  await app.invoke("settings_save", { settings: { ...v2.settings, privacy: { ...v2.settings.privacy, local_only: false } } });
});

test("switched off, offline or without a model the search finds exact words only", async () => {
  await useModel(app, "ollama", "nomic-embed-text", null);
  await indexed(app);
  // Switched off.
  await useModel(app, "ollama", "nomic-embed-text", false);
  assert.equal((await app.invoke("semantic_status")).inactive, "switched_off");
  await sidebarSearch(app, "Angebot Müller");
  await app.browser.waitUntil(async () => (await results(app)).length > 0, { timeout: 8000 });
  await app.browser.pause(800);
  assert.ok(!(await results(app)).some((r) => r.similar), "meaning hits while switched off");
  assert.equal(await app.browser.execute(() => !!document.querySelector(".side-filter")), false, "no exact-only toggle without meaning hits");
  await openSearchSettings(app, "Einstellungen");
  await app.waitText(".settings", /Aus: Die Suche findet nur exakte Wörter\./);
  // Offline: the model does not answer; exact hits come anyway, without waiting long.
  await useModel(app, "ollama", "nomic-embed-text", null);
  await local.stop();
  const t0 = Date.now();
  const r = await app.invoke("search_semantic", { query: "Ferien Ostsee", limit: 30 });
  assert.equal(r.meaning, false);
  assert.ok(r.hits.some((h) => h.title === "Sommer"), "the exact hit");
  assert.ok(Date.now() - t0 < 4000, `took ${Date.now() - t0} ms`);
  await local.start();
  // Without an embedding model: a quiet hint how to get one.
  await useModel(app, "ollama", null, null);
  assert.equal((await app.invoke("semantic_status")).inactive, "no_model");
  await openSearchSettings(app, "Einstellungen");
  await app.waitText(".search-note", /Ohne Embedding-Modell findet die Suche nur exakte Wörter/);
  assert.equal(await app.browser.execute(() => document.querySelector('.settings [role="switch"][aria-label="Suche nach Bedeutung"]')?.disabled), true);
  await shot(app, "settings-search-no-model-light");
});

test("in English: the label, the filter and Settings → Search", async () => {
  await app.close();
  app = null;
  let dataDir;
  ({ app, dataDir } = await launchEnglish({ env, width: 1440, height: 900 }));
  try {
    await addPages(app);
    await useModel(app, "ollama", "nomic-embed-text", null);
    await indexed(app);
    await sidebarSearch(app, "Angebot Müller");
    await app.browser.waitUntil(async () => (await results(app)).some((r) => r.similar), { timeout: 8000, timeoutMsg: "no meaning hit" });
    const kv = (await results(app)).find((r) => r.similar);
    assert.equal(kv.label, "similar");
    assert.equal(await app.text(".side-filter"), "Exact only");
    assert.match(await app.text(".side-result-count"), /\d+ by meaning/);
    await shot(app, "sidebar-meaning-en");
    await openSearchSettings(app, "Settings");
    await app.waitText(".search-index-count", /Up to date · \d+ sections/);
    assert.match(await app.text(".settings-head h1"), /^Search$/);
    // The page titles and passages are the user's German content.
    const left = await germanLeftovers(app, [/Müller|Dachsanierung|Rahmenvertrag|Geheimprojekt|Sommer|Kostenvoranschlag|Angebot|Ferien|Urlaub/]);
    assert.deepEqual(left, []);
    await shot(app, "settings-search-en");
  } finally {
    await app.close();
    app = null;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
