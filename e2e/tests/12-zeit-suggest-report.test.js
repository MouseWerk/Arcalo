import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";
import { startFakeLiteLLM } from "../lib/fake-litellm.js";

const test = guarded(nodeTest, () => app);
let app, llm;
before(async () => {
  llm = await startFakeLiteLLM({ port: 4987 });
  app = await launch();
});
after(async () => {
  await app?.close();
  await llm?.close();
});

const entries = () => app.invoke("time_entries", { from: null, to: null });
const openTree = async (title) => {
  for (const r of await app.$$(".sidebar .tree-row")) if ((await app.textOf(r)) === title) return r.click();
  throw new Error(`no ${title}`);
};
/** Text of the paragraph holding the caret. */
const caretLine = () => app.browser.execute(() => window.getSelection().anchorNode?.parentElement?.closest("p")?.textContent ?? "");
const popupItems = () => app.browser.execute(() => [...document.querySelectorAll(".sugg-host .sugg-item")].filter((e) => e.offsetParent).map((e) => e.innerText.replace(/\s+/g, " ").trim()));
const popupOpen = () => app.browser.execute(() => [...document.querySelectorAll(".sugg-host")].some((h) => getComputedStyle(h).display !== "none"));
const waitItems = (pattern) =>
  app.browser.waitUntil(async () => (await popupItems()).some((t) => pattern.test(t)), { timeout: 8000, timeoutMsg: `no popup item matching ${pattern}` });

test("/zeit suggests Netzplan/Vorgang, Enter picks it, then books", async () => {
  await openTree("Jour fixe 22.09.");
  await app.caretToEnd();
  await app.keys(["Enter"]);
  await app.type("/zeit NP-88");
  await waitItems(/^NP-8801\/1020 · Systemintegration .*h (offen|über Plan)$/);
  const items = await popupItems();
  // The most recently booked reference comes first.
  const last = (await entries()).sort((a, b) => b.start_time.localeCompare(a.start_time))[0];
  assert.ok(items[0].startsWith(`${last.netzplan_nr}/${last.vorgang_nr} · `), items.join("\n"));
  assert.ok(items.some((t) => /^NP-8802\/2010 · Key-User-Schulung/.test(t)), items.join("\n"));
  await app.shot("zeit-suggest");
  // Typing narrows the list (description text matches too).
  await app.type("01/102");
  await app.browser.waitUntil(async () => (await popupItems()).length === 1, { timeout: 4000, timeoutMsg: `narrowed to ${JSON.stringify(await popupItems())}` });
  await app.keys(["Enter"]);
  await app.browser.waitUntil(async () => (await caretLine()) === "/zeit NP-8801/1020 ", { timeout: 4000, timeoutMsg: `line is ${await caretLine()}` });
  assert.equal((await entries()).filter((e) => e.description === "Test").length, 0, "Enter picked, did not book");

  // Leistungsart after '#'.
  await app.type("1h #TE");
  await waitItems(/^#TEST/);
  await app.keys(["Enter"]);
  await app.browser.waitUntil(async () => (await caretLine()) === "/zeit NP-8801/1020 1h #TEST ", { timeout: 4000 });

  const before = (await entries()).length;
  await app.type("Test");
  await app.keys(["Enter"]);
  await app.waitText(".toast-title", /1,00 h gebucht/);
  const all = await entries();
  assert.equal(all.length, before + 1);
  const e = all.find((x) => x.description === "Test");
  assert.equal(e.netzplan_nr, "NP-8801");
  assert.equal(e.vorgang_nr, "1020");
  assert.equal(e.leistungsart, "TEST");
  assert.equal(e.duration_minutes, 60);
  await app.waitFor(".ProseMirror .time-chip");
  // After booking the caret waits on the new line below the chip.
  await app.browser.waitUntil(async () => (await caretLine()) === "", { timeoutMsg: "caret not below the chip" });
});

test("/zeit: the booked reference is suggested first; Escape closes the popup", async () => {
  await app.dismissToasts();
  await app.caretToEnd();
  assert.equal(await caretLine(), "", "caret on the empty line below the chip");
  await app.type("/zeit ");
  await waitItems(/^NP-8801\/1020/);
  assert.match((await popupItems())[0], /^NP-8801\/1020/);
  await app.type("schulung");
  await waitItems(/^NP-8802\/2010 · /);
  await app.keys(["Tab"]);
  await app.browser.waitUntil(async () => (await caretLine()) === "/zeit NP-8802/2010 ", { timeout: 4000 });

  await app.type("30m #CONS");
  await waitItems(/^#CONSULTING/);
  await app.keys(["Escape"]);
  await app.browser.waitUntil(async () => !(await popupOpen()), { timeout: 4000, timeoutMsg: "popup still open" });
  await app.type("ULTING Escape-Test");
  await app.keys(["Enter"]);
  await app.waitText(".toast-title", /0,50 h gebucht/);
  const e = (await entries()).find((x) => x.description === "Escape-Test");
  assert.equal(e.leistungsart, "CONSULTING");
  assert.equal(e.vorgang_nr, "2010");
});

test("time_summary tool sums the week", async () => {
  const today = new Date();
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  // Yesterday too: a 1 h booking made shortly after midnight starts on the previous day.
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  const out = JSON.parse(await app.invoke("ai_run_workspace_tool", { name: "time_summary", arguments: JSON.stringify({ from: iso(yesterday), to: iso(today) }) }));
  const item = out.items.find((i) => i.label === "NP-8801/1020");
  assert.ok(item.hours >= 1, JSON.stringify(out));
  assert.ok(item.descriptions.includes("Test"));
  assert.ok(out.days.length >= 1 && out.days.length <= 2, JSON.stringify(out.days));
  await assert.rejects(app.invoke("ai_run_workspace_tool", { name: "time_summary", arguments: JSON.stringify({ from: "gestern", to: iso(today) }) }));
});

test("palette „Wochenbericht erstellen“ asks the assistant with time_summary", async () => {
  const view = await app.invoke("settings_get");
  const settings = { ...view.settings, litellm_base_url: llm.url, router: { ...view.settings.router, local_model: "firma-schnell", standard_model: "firma-standard", reasoning_model: "firma-reasoning" } };
  await app.invoke("settings_save", { settings });
  await app.invoke("api_key_set", { key: llm.apiKey });

  await app.keys(["Control", "k"]);
  const input = await app.waitFor(".palette input");
  await input.setValue("Wochenbericht");
  await app.waitText(".pal-item.sel", /Wochenbericht erstellen/);
  await app.keys(["Enter"]);
  await app.waitFor(".msg-ai .msg-meta", 15000);

  const req = llm.requests.filter((r) => r.url === "/v1/chat/completions").pop();
  const tools = (req.body.tools ?? []).map((t) => t.function.name);
  assert.ok(tools.includes("time_summary"), tools.join(","));
  assert.ok(tools.includes("list_tasks"));
  const user = req.body.messages.filter((m) => m.role === "user").pop().content;
  assert.match(user, /Status-E-Mail/);
  assert.match(user, /KW \d+/);
  assert.match(user, /time_summary \(from "\d{4}-\d{2}-\d{2}", to "\d{4}-\d{2}-\d{2}"\)/);
  assert.match(user, /list_tasks \(status "done", changed_since "\d{4}-\d{2}-\d{2}"\)/);
  // The bubble shows a short label, not the internal prompt.
  assert.match(await app.text(".msg-user"), /^Wochenbericht KW \d+$/);
  await app.shot("weekly-report");

  // „In neue Seite einfügen“ creates „Wochenbericht KW nn“ with the answer.
  const kw = user.match(/KW (\d+)/)[1];
  const clicked = await app.browser.execute(() => {
    const b = document.querySelector('.msg-ai [aria-label="In neue Seite einfügen"]');
    b?.click();
    return !!b;
  });
  assert.ok(clicked, "action present");
  let page;
  await app.browser.waitUntil(async () => (page = await app.invoke("page_resolve", { title: `Wochenbericht KW ${kw}`, create: false })) != null, { timeout: 8000 });
  const doc = await app.invoke("page_get", { id: page.id });
  assert.match(doc.content, /Zusammenfassung/);
});

test("no console errors", async () => {
  assert.deepEqual(await app.consoleErrors(), []);
});
