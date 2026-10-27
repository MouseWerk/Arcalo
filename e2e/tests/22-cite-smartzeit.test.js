// Citations in assistant answers ([n] chips → page, scrolled to and flashing the paragraph)
// and smart /zeit (a line without reference gets an AI-suggested Vorgang, booked after Enter).
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";
import { startFakeLiteLLM } from "../lib/fake-litellm.js";

const test = guarded(nodeTest, () => app);
let app, llm;
before(async () => {
  llm = await startFakeLiteLLM({ port: 4983 });
  app = await launch();
  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", {
    settings: { ...view.settings, litellm_base_url: llm.url, router: { ...view.settings.router, local_model: "firma-schnell", standard_model: "firma-standard", reasoning_model: "firma-reasoning" } },
  });
  await app.invoke("api_key_set", { key: llm.apiKey });
});
after(async () => {
  await app?.close();
  await llm?.close();
});

const openTree = async (title) => {
  for (const r of await app.$$(".sidebar .tree-row")) if ((await app.textOf(r)) === title) return r.click();
  throw new Error(`tree row ${title} not found`);
};
const pageTitle = async () => (await app.$(".pane.active > .pane-content:not([hidden]) .page-title")).getValue();
const flashed = () => app.browser.execute(() => document.querySelector(".pane.active > .pane-content:not([hidden]) .ProseMirror .cite-flash")?.textContent ?? "");
const entries = () => app.invoke("time_entries", { from: null, to: null });
const caretLine = () => app.browser.execute(() => window.getSelection().anchorNode?.parentElement?.closest("p")?.textContent ?? "");

test("answers cite numbered sources; the chip previews and opens the exact paragraph", async () => {
  await openTree("Jour fixe 22.09.");
  await app.waitFor(".pane.active > .pane-content:not([hidden]) .ProseMirror");
  await app.keys(["Control", "j"]);
  const ta = await app.waitFor(".composer textarea");
  await ta.setValue("Komponenten Mapping");
  await app.keys(["Enter"]);
  await app.waitFor(".msg-ai .msg-meta");

  // The model got numbered sources and the citation rules.
  const req = llm.requests.filter((r) => r.url === "/v1/chat/completions").pop();
  const ctx = req.body.messages.find((m) => m.role === "system" && /nummerierte Quellen/.test(m.content))?.content ?? "";
  assert.match(ctx, /\[1\] \(Seite: Architektur › Komponenten\)/);
  assert.match(ctx, /Belege jede Aussage/);

  const chip = await app.waitFor('.msg-ai .prose sup.cite[data-cite="1"]');
  assert.equal(await app.textOf(chip), "1");
  await chip.moveTo();
  await app.waitFor(".cite-card");
  assert.match(await app.text(".cite-card"), /Architektur › Komponenten/);
  assert.match(await app.text(".cite-card"), /IDoc-Empfang/);
  await app.shot("cite-preview");

  await chip.click();
  await app.browser.waitUntil(async () => (await pageTitle()) === "Architektur", { timeout: 8000, timeoutMsg: "cited page not opened" });
  await app.browser.waitUntil(async () => /Inbound: IDoc-Empfang, Mapping auf das kanonische Datenmodell/.test(await flashed()), {
    timeout: 6000,
    timeoutMsg: "cited paragraph not flashed",
  });
  // The caret sits in that paragraph.
  assert.match(await caretLine(), /Inbound/);
  await app.shot("cite-flash");
  // The flash fades.
  await app.browser.waitUntil(async () => (await flashed()) === "", { timeout: 6000, timeoutMsg: "flash stays" });

  // The „Quellen“ chip goes to the same place.
  await openTree("Jour fixe 22.09.");
  await app.browser.waitUntil(async () => (await pageTitle()) === "Jour fixe 22.09.");
  const source = await app.waitFor('.msg-ai .sources .source[data-source="1"]');
  await source.click();
  await app.browser.waitUntil(async () => (await pageTitle()) === "Architektur", { timeout: 8000 });
  await app.browser.waitUntil(async () => /Inbound: IDoc-Empfang/.test(await flashed()), { timeout: 6000, timeoutMsg: "source chip did not flash" });
});

test("smart /zeit: a line without reference asks the AI, Enter books the confirmed Vorgang", async () => {
  await app.dismissToasts();
  // A page without `vorgang:`: the line has no default reference.
  const page = await app.invoke("page_resolve", { title: "Jour fixe 22.09.", create: false });
  assert.doesNotMatch((await app.invoke("page_get", { id: page.id })).content, /^vorgang:/m);
  await openTree("Jour fixe 22.09.");
  await app.browser.waitUntil(async () => (await pageTitle()) === "Jour fixe 22.09.", { timeout: 8000 });
  await app.caretToEnd();
  await app.keys(["Enter"]);
  const before = (await entries()).length;
  await app.type("/zeit 1h Mapping Workshop");
  await app.keys(["Enter"]);

  const confirm = await app.waitFor(".zeit-confirm .zeit-confirm-target", 10000);
  assert.equal(await app.textOf(confirm), "NP-8801/1020 · Systemintegration (DEV)");
  assert.match(await app.text(".zeit-confirm"), /Grund: /);
  await app.shot("smart-zeit-confirm");
  // Nothing is booked before the confirmation.
  assert.equal((await entries()).length, before);
  const guessReq = llm.requests.filter((r) => r.url === "/v1/chat/completions").pop();
  assert.match(guessReq.body.messages[1].content, /Tätigkeit: Mapping Workshop/);
  assert.match(guessReq.body.messages[1].content, /- NP-8801\/1020 \| Systemintegration/);

  await app.keys(["Enter"]);
  await app.waitText(".toast-title", /1,00 h gebucht/);
  const all = await entries();
  assert.equal(all.length, before + 1);
  const e = all.find((x) => x.description === "Mapping Workshop");
  assert.ok(e, JSON.stringify(all.slice(-2)));
  assert.equal(e.netzplan_nr, "NP-8801");
  assert.equal(e.vorgang_nr, "1020");
  assert.equal(e.leistungsart, "DEV");
  assert.equal(e.page_id, page.id);
  await app.waitText(".pane.active > .pane-content:not([hidden]) .ProseMirror .time-chip", /NP-8801\/1020/);
  assert.equal(await app.browser.execute(() => document.querySelector(".zeit-confirm") === null), true);
});

test("smart /zeit: Esc cancels without booking, Tab opens the reference list", async () => {
  await app.dismissToasts();
  await app.caretToEnd();
  await app.keys(["Enter"]);
  const before = (await entries()).length;
  await app.type("/zeit 30m Mapping Nacharbeit");
  await app.keys(["Enter"]);
  await app.waitFor(".zeit-confirm .zeit-confirm-target", 10000);
  await app.keys(["Escape"]);
  await app.browser.waitUntil(async () => app.browser.execute(() => document.querySelector(".zeit-confirm") === null), { timeout: 4000 });
  assert.equal((await entries()).length, before, "Esc does not book");
  assert.equal(await caretLine(), "/zeit 30m Mapping Nacharbeit", "the line stays");

  await app.keys(["Enter"]);
  await app.waitFor(".zeit-confirm .zeit-confirm-target", 10000);
  await app.keys(["Tab"]);
  await app.browser.waitUntil(async () => app.browser.execute(() => [...document.querySelectorAll(".sugg-host .sugg-item")].some((e) => e.offsetParent)), {
    timeout: 6000,
    timeoutMsg: "reference list not opened",
  });
  assert.equal((await entries()).length, before, "Tab does not book");
  await app.keys(["Escape"]);
});
