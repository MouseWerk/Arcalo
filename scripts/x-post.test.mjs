// The X poster (scripts/x-post.mjs): node --test scripts/x-post.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  authorization,
  baseString,
  berlinToday,
  digest,
  loadPost,
  parsePost,
  percentEncode,
  pickNext,
  preview,
  publish,
  queueNames,
  readPosted,
  ROOT,
  signature,
  weightedLength,
} from "./x-post.mjs";

test("percent-encoding follows RFC 3986 (Twitter's OAuth examples)", () => {
  assert.equal(percentEncode("Ladies + Gentlemen"), "Ladies%20%2B%20Gentlemen");
  assert.equal(percentEncode("An encoded string!"), "An%20encoded%20string%21");
  assert.equal(percentEncode("Dogs, Cats & Mice"), "Dogs%2C%20Cats%20%26%20Mice");
  assert.equal(percentEncode("☃"), "%E2%98%83");
  assert.equal(percentEncode("-._~*'()"), "-._~%2A%27%28%29");
});

// The worked example of Twitter's "Creating a signature" guide (OAuth 1.0a, HMAC-SHA1).
const TW = {
  method: "POST",
  url: "https://api.twitter.com/1.1/statuses/update.json?include_entities=true",
  params: {
    status: "Hello Ladies + Gentlemen, a signed OAuth request!",
    oauth_consumer_key: "xvz1evFS4wEEPTGEFPHBog",
    oauth_nonce: "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg",
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: "1318622958",
    oauth_token: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb",
    oauth_version: "1.0",
  },
  consumerSecret: "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw",
  tokenSecret: "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE",
};

test("signature base string and signature match Twitter's worked example", () => {
  const base = baseString(TW.method, TW.url, TW.params);
  assert.equal(
    base,
    "POST&https%3A%2F%2Fapi.twitter.com%2F1.1%2Fstatuses%2Fupdate.json&include_entities%3Dtrue%26oauth_consumer_key%3Dxvz1evFS4wEEPTGEFPHBog%26oauth_nonce%3DkYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg%26oauth_signature_method%3DHMAC-SHA1%26oauth_timestamp%3D1318622958%26oauth_token%3D370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb%26oauth_version%3D1.0%26status%3DHello%2520Ladies%2520%252B%2520Gentlemen%252C%2520a%2520signed%2520OAuth%2520request%2521",
  );
  assert.equal(signature(base, TW.consumerSecret, TW.tokenSecret), "hCtSmYh+iHYCEqBWrE7C7hYmtUk=");
});

test("the Authorization header carries that signature, encoded and sorted", () => {
  const header = authorization({
    method: "POST",
    url: TW.url,
    keys: { apiKey: TW.params.oauth_consumer_key, apiSecret: TW.consumerSecret, accessToken: TW.params.oauth_token, accessSecret: TW.tokenSecret },
    extra: { status: TW.params.status },
    nonce: TW.params.oauth_nonce,
    timestamp: TW.params.oauth_timestamp,
  });
  assert.equal(
    header,
    'OAuth oauth_consumer_key="xvz1evFS4wEEPTGEFPHBog", oauth_nonce="kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg", oauth_signature="hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D", oauth_signature_method="HMAC-SHA1", oauth_timestamp="1318622958", oauth_token="370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb", oauth_version="1.0"',
  );
});

test("base string normalization of RFC 5849 section 3.4.1", () => {
  // Parameters from the RFC's example request (query, form body and oauth_*), sorted by encoded name and value.
  const base = baseString("post", "HTTP://EXAMPLE.COM/request?b5=%3D%253D&a3=a&c%40=&a2=r%20b", {
    c2: "",
    a3: "2 q",
    oauth_consumer_key: "9djdj82h48djs9d2",
    oauth_token: "kkk9d7dh3k39sjv7",
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: "137131201",
    oauth_nonce: "7d8f3e4a",
  });
  assert.equal(
    base,
    "POST&http%3A%2F%2Fexample.com%2Frequest&a2%3Dr%2520b%26a3%3D2%2520q%26a3%3Da%26b5%3D%253D%25253D%26c%2540%3D%26c2%3D%26oauth_consumer_key%3D9djdj82h48djs9d2%26oauth_nonce%3D7d8f3e4a%26oauth_signature_method%3DHMAC-SHA1%26oauth_timestamp%3D137131201%26oauth_token%3Dkkk9d7dh3k39sjv7",
  );
});

test("length counts links as 23 and wide characters as 2", () => {
  assert.equal(weightedLength("Hello"), 5);
  assert.equal(weightedLength("See https://arcalo.mousewerk.de/download/very/long/path?x=1"), 4 + 23);
  assert.equal(weightedLength("arcalo.mousewerk.de"), 23);
  assert.equal(weightedLength("日本"), 4);
  assert.equal(weightedLength("café – ok"), 9);
  assert.equal(weightedLength("é"), 1, "NFC first");
});

test("front matter: plain, quoted and block values; unknown keys are refused", () => {
  const p = parsePost('---\ntext: |\n  Line one\n\n  Line two\nimage: "docs/a.png"\nreply_to: \'123\'\n---\nNotes here\n');
  assert.equal(p.text, "Line one\n\nLine two");
  assert.equal(p.image, "docs/a.png");
  assert.equal(p.reply_to, "123");
  assert.equal(p.notes, "Notes here\n");
  assert.throws(() => parsePost("---\ntxt: hi\n---\n"), /unknown key "txt"/);
  assert.throws(() => parsePost("text: hi\n"), /front matter/);
});

function tmpRepo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "x-post-"));
  for (const [f, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), content);
  }
  return root;
}

test("a post is checked for length, image and reply target", () => {
  const root = tmpRepo({
    "q/2026-11-01-ok.md": "---\ntext: Hi\nimage: img/a.png\nreply_to: https://x.com/arcalo/status/1234567890\n---\n",
    "q/2026-11-01-long.md": `---\ntext: ${"a".repeat(281)}\n---\n`,
    "q/2026-11-01-noimg.md": "---\ntext: Hi\nimage: img/missing.png\n---\n",
    "q/2026-11-01-out.md": "---\ntext: Hi\nimage: ../etc/passwd\n---\n",
    "q/notes.md": "---\ntext: Hi\n---\n",
    "img/a.png": "png",
  });
  assert.equal(loadPost("q/2026-11-01-ok.md", root).reply_to, "1234567890");
  assert.throws(() => loadPost("q/2026-11-01-long.md", root), /281 characters/);
  assert.throws(() => loadPost("q/2026-11-01-noimg.md", root), /does not exist/);
  assert.throws(() => loadPost("q/2026-11-01-out.md", root), /outside the repository/);
  assert.throws(() => loadPost("q/notes.md", root), /file name/);
});

test("the digest changes with the text and with the image bytes", () => {
  const root = tmpRepo({ "img/a.png": "one" });
  const a = digest({ text: "Hi", image: "img/a.png" }, root);
  assert.notEqual(a, digest({ text: "Hi!", image: "img/a.png" }, root));
  fs.writeFileSync(path.join(root, "img/a.png"), "two");
  assert.notEqual(a, digest({ text: "Hi", image: "img/a.png" }, root));
});

test("the oldest due, unposted file is next; one at a time", () => {
  const names = ["2026-11-03-c.md", "2026-11-01-a.md", "2026-11-02-b.md", "posted.json", "README.md", "2026-12-24-later.md"];
  assert.equal(pickNext(names, {}, "2026-11-05"), "2026-11-01-a.md");
  assert.equal(pickNext(names, { "2026-11-01-a.md": { id: "1" } }, "2026-11-05"), "2026-11-02-b.md");
  assert.equal(pickNext(names, {}, "2026-10-31"), null, "not before its date");
  assert.equal(pickNext(["2026-12-24-later.md"], {}, "2026-12-24"), "2026-12-24-later.md");
  assert.equal(berlinToday(new Date("2026-10-27T23:30:00Z")), "2026-10-28");
});

test("the preview shows the exact text, its length and the image", () => {
  const md = preview("q/2026-11-01-a.md", { text: "Use `code` and https://example.com", image: "img/a.png" }, { repo: "o/r", sha: "abc" });
  assert.match(md, /```text\nUse `code` and https:\/\/example.com\n```/);
  assert.match(md, /38 \/ 280 characters/);
  assert.match(md, /Contains a link/);
  assert.match(md, /<img src="https:\/\/github.com\/o\/r\/raw\/abc\/img\/a.png"/);
});

const KEYS = { apiKey: "ck", apiSecret: "cs", accessToken: "at", accessSecret: "as" };

test("publishing uploads the image, then creates the post with it", async () => {
  const root = tmpRepo({ "img/a.png": "PNGDATA" });
  const calls = [];
  const send = async (url, init) => {
    calls.push({ url, init });
    const data = url.endsWith("/2/media/upload") ? { data: { id: "777", media_key: "3_777" } } : { data: { id: "1850000000000000001", text: "x" } };
    return new Response(JSON.stringify(data), { status: url.endsWith("/2/tweets") ? 201 : 200 });
  };
  const res = await publish({ text: "Hello", image: "img/a.png", reply_to: "42" }, { keys: KEYS, root, send });
  assert.deepEqual(res, { id: "1850000000000000001", url: "https://x.com/i/web/status/1850000000000000001" });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://api.x.com/2/media/upload");
  assert.match(calls[0].init.headers.Authorization, /^OAuth oauth_consumer_key="ck", .*oauth_token="at"/);
  assert.equal(calls[0].init.body.get("media_category"), "tweet_image");
  assert.equal(await calls[0].init.body.get("media").text(), "PNGDATA");
  assert.equal(calls[1].url, "https://api.x.com/2/tweets");
  assert.equal(calls[1].init.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(calls[1].init.body), { text: "Hello", media: { media_ids: ["777"] }, reply: { in_reply_to_tweet_id: "42" } });
});

test("an API error stops before anything else is sent", async () => {
  const calls = [];
  const send = async (url) => {
    calls.push(url);
    return new Response('{"title":"Forbidden","detail":"You are not permitted"}', { status: 403 });
  };
  await assert.rejects(publish({ text: "Hello" }, { keys: KEYS, send }), /HTTP 403 .*not permitted/);
  assert.equal(calls.length, 1);
});

test("a dry run prints the requests and sends nothing", async () => {
  const root = tmpRepo({ "img/a.png": "PNG" });
  const lines = [];
  const send = async () => assert.fail("nothing may be sent");
  const res = await publish({ text: "Hello", image: "img/a.png" }, { keys: KEYS, root, send, dryRun: true, log: (l) => lines.push(l) });
  assert.equal(res, null);
  const out = lines.join("\n");
  assert.match(out, /POST https:\/\/api.x.com\/2\/media\/upload/);
  assert.match(out, /POST https:\/\/api.x.com\/2\/tweets/);
  assert.match(out, /"media_ids":\["<media id>"\]/);
  assert.doesNotMatch(out, /oauth_token="at"/, "tokens are redacted");
});

test("every queued file in the repository is a valid post and posted.json is readable", () => {
  const posted = readPosted();
  for (const name of queueNames()) {
    if (!name.endsWith(".md")) continue;
    loadPost(`docs/marketing/x-queue/${name}`, ROOT);
  }
  assert.equal(typeof posted, "object");
});
