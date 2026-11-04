// q124 H4: the full-text search with what people type: umlauts and case, punctuation and FTS
// operators as plain text, quotes, a very long query; renamed pages found by their new title,
// pages in the trash not at all; a page named like the query ranks first.

import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
before(async () => (app = await launch()));
after(async () => app?.close());

const create = (title, content) => app.invoke("page_create", { parentId: null, title, icon: null, content });
const search = (query, limit = 30) => app.invoke("search_workspace", { query, limit });
const pagesOf = (hits) => hits.map((h) => h.page_id).filter((id) => id != null);

test("umlauts, case, punctuation and operators are plain text", async () => {
  const p = await create("Größenänderung Übersicht", "Die ÄRGERLICHE Straße wurde gesperrt. C++ und C# Code, foo(bar), e-mail, don't, 50 %, $HOME, a*b.");
  // Decomposed umlauts (as macOS and some imports write them) are found by composed ones.
  const d = await create("Zerlegt", "Die Grünfläche vor dem Haus");
  const finds = async (q, id = p.id) => pagesOf(await search(q)).includes(id);
  for (const q of ["größen", "ubersicht", "ärgerlich", "ARGERLICH", "straße", "über*", '"Straße wurde"', "C++", "C#", "foo(bar)", "e-mail", "don't", "$HOME", "a*b", "-gesperrt"])
    assert.ok(await finds(q), `„${q}“ does not find the page`);
  assert.ok(await finds("grünfläche", d.id), "decomposed umlauts not found");
  // Operators and lone punctuation neither fail nor match everything.
  for (const q of ['"', "'", "(", ")", "NEAR(", "^", "*", ":", "status:", "AND", "OR", "NOT", "\\", "\u0000"]) {
    const hits = await search(q);
    assert.ok(Array.isArray(hits), q);
    assert.ok(!pagesOf(hits).includes(p.id), `„${q}“ matched the page`);
  }
});

test("a very long query answers quickly, by meaning too", async () => {
  const long = Array.from({ length: 3000 }, (_, i) => `wort${i}`).join(" ");
  let t = Date.now();
  assert.deepEqual(await search(long), []);
  assert.ok(Date.now() - t < 3000, `${Date.now() - t} ms`);
  t = Date.now();
  assert.deepEqual(await search("x".repeat(20000)), []);
  const sem = await app.invoke("search_semantic", { query: long, limit: 10 });
  assert.deepEqual(sem.hits, []);
});

test("renamed pages are found by their new title, trashed ones not at all", async () => {
  const p = await create("Quartalsplanung Zebrafisch", "Notiz zur Zebrafisch Haltung");
  assert.ok(pagesOf(await search("zebrafisch")).includes(p.id));
  await app.invoke("page_rename", { id: p.id, title: "Jahresplanung Okapi", updateLinks: true });
  assert.deepEqual((await search("okapi")).map((h) => [h.kind, h.title]), [["page", "Jahresplanung Okapi"]]);
  assert.ok(!(await search("quartalsplanung")).some((h) => h.kind === "page"), "old title still found");
  await app.invoke("page_delete", { id: p.id });
  assert.deepEqual(await search("zebrafisch"), []);
  assert.deepEqual(await search("okapi"), []);
  assert.deepEqual((await app.invoke("search_semantic", { query: "okapi", limit: 10 })).hits, []);
});

test("a page named like the query ranks before pages that only mention it", async () => {
  await create("Budget", "kurz");
  for (let i = 0; i < 5; i++) await create(`Notiz ${i} Rauschen`, "Budget Budget Budget budget budget budget Budget Planung budget");
  const hits = await search("budget", 10);
  assert.deepEqual([hits[0].kind, hits[0].title], ["page", "Budget"]);
});
