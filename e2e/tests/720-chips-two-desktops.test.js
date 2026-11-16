// q124 r7b: a chip booked on another computer (synced into the note by the Git sync) is a booking
// from another device, also when its id is the id of a booking of this computer in that note: it
// keeps its own hours and text, is never linked, and this computer's own chip stays its booking.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
before(async () => (app = await launch()));
after(async () => app?.close());

const SHOWN = ".pane.active > .pane-content:not([hidden])";
const until = (f, msg, timeout = 8000) => app.browser.waitUntil(f, { timeout, timeoutMsg: msg });
const chips = () =>
  app.browser.execute(
    (s) => [...document.querySelectorAll(`${s} .ProseMirror .time-chip`)].map((c) => ({ text: c.textContent, link: c.dataset.chip ?? "" })),
    SHOWN,
  );
const open = async (id, title) => {
  await app.invoke("search_open", { target: { kind: "page", page_id: id, new_tab: false } });
  await app.waitText(".pane.active .tab.active .tab-title", new RegExp(title));
  await app.waitFor(`${SHOWN} .ProseMirror`);
};

test("a chip of another computer with the id of a booking here stays that computer's booking", async () => {
  await app.keys(["Control", "n"]);
  await app.browser.waitUntil(() => app.browser.execute(() => document.activeElement?.classList.contains("page-title") && document.activeElement.selectionEnd > 0));
  await app.type("Zwei Rechner");
  await app.keys(["Enter"]);
  await app.type("/zeit NP-8801/1040 1h #TEST Workshop im Buero");
  await app.keys(["Escape"]);
  await app.keys(["Enter"]);
  await app.waitFor(`${SHOWN} .ProseMirror .time-chip`);
  const page = (await app.invoke("page_resolve", { title: "Zwei Rechner", create: false })).id;
  const content = async () => (await app.invoke("page_get", { id: page })).content;
  await until(async () => /<time-entry id="\d+"[^>]*>Workshop im Buero<\/time-entry>/.test(await content()), "own chip saved");
  await until(async () => (await chips())[0]?.link === "linked", "own chip linked");
  const own = /<time-entry id="(\d+)"[^>]*date="([\d-]+)"/.exec(await content());
  const [id, date] = [Number(own[1]), own[2]];

  // The laptop's chip of the same id arrives with the sync, above this computer's chip.
  const other = await app.invoke("page_create", { parentId: null, title: "Andere Seite", icon: null, content: "Text\n" });
  await open(other.id, "Andere Seite");
  const laptop = `<time-entry id="${id}" hours="0,50" target="NP-8801/1040" la="TEST" date="${date}" ws="laptop-0123456789abcdef">Abends am Laptop</time-entry>`;
  await app.invoke("page_save", { id: page, content: `${laptop}\n\n${await content()}` });
  // As after a sync's take-over: the note is read again, not the copy kept open in the tab.
  await app.reload();
  await open(page, "Zwei Rechner");

  await until(async () => (await chips()).length === 2, "both chips shown").catch(async (e) => {
    throw new Error(`${e.message}: ${JSON.stringify(await chips())} ${await content()}`);
  });
  await app.browser.pause(1500); // the link check and any rewrite of stale values
  const shown = await chips();
  assert.match(shown[0].text, /^0,5 h.*Abends am Laptop/, `the laptop's chip keeps its values: ${JSON.stringify(shown)}`);
  assert.notEqual(shown[0].link, "linked", "the laptop's chip is not this computer's booking");
  assert.equal(shown[1].link, "linked", "this computer's chip stays its booking, not a copy");
  assert.match(await content(), /hours="0,50"[^>]*>Abends am Laptop<\/time-entry>/, "the stored chip keeps the laptop's hours");
  const entry = (await app.invoke("time_entries", { from: null, to: null })).find((e) => e.id === id);
  assert.equal(entry.description, "Workshop im Buero", "the booking here is unchanged");
  assert.equal(entry.duration_minutes, 60);
  await app.shot("720-chip-other-computer");
});
