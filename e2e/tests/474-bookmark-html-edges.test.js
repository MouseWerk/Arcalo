// q124 round 2, H5: a bookmarks HTML export with what browsers really write (entities in names,
// upper- and lower-case tags, unclosed <DT>/<p>, attributes in any order, empty folders, names in
// other scripts, a javascript: link) reads with every folder, name and address.

import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
before(async () => (app = await launch({ demo: false })));
after(async () => app?.close());

const HTML = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<!-- This is an automatically generated file. -->
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3 ADD_DATE="1700000000" PERSONAL_TOOLBAR_FOLDER="true">Leiste &amp; Co</H3>
    <DL><p>
        <DT><A HREF="https://example.com/a?x=1&amp;y=2" ADD_DATE="1700000000">Tom &amp; Jerry&#39;s &quot;Seite&quot;</A>
        <dt><a add_date="1700000000" href="https://例え.jp/パス">日本語のページ</a>
        <DT><A HREF="https://example.org/he">שלום</A>
        <DT><H3>Leer</H3>
        <DL><p>
        </DL><p>
        <DT><A HREF="javascript:alert(1)">Bookmarklet</A>
    </DL><p>
    <DT><A HREF="https://example.net/" ICON="data:image/png;base64,AAAA">Mit &lt;Icon&gt;</A>
</DL><p>
`;

/** Every link as [folder path, name, url]. */
function links(tree, at = []) {
  const out = [];
  for (const n of tree.roots ?? tree.children ?? []) {
    if (n.url != null) out.push([at.join("/"), n.name ?? n.title, n.url]);
    else out.push(...links(n, [...at, n.name ?? n.title]));
  }
  return out;
}

test("an HTML export reads with its names, addresses and folders", async () => {
  const tree = await app.invoke("bookmarks_read_text", { text: HTML });
  const got = links(tree);
  const find = (name) => got.find((l) => l[1] === name);
  assert.deepEqual(find(`Tom & Jerry's "Seite"`)?.slice(2), ["https://example.com/a?x=1&y=2"], JSON.stringify(got));
  assert.ok(find("日本語のページ"), "lower-case tags, attributes in another order");
  assert.ok(find("שלום"));
  assert.ok(find("Mit <Icon>"), "entities in a name at the top");
  assert.match(find(`Tom & Jerry's "Seite"`)[0], /Leiste & Co$/);
  assert.ok(!got.some((l) => l[2].startsWith("javascript:")), "no javascript: link");
});
