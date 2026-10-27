// Posts from the X queue (docs/marketing/x-queue) to the X API v2, one post per call, for
// .github/workflows/x-post.yml. Setup and flow: docs/marketing/x-setup.md.
//
// Dependency-free on purpose (Node 22: fetch, FormData, Blob, node:crypto). This is a CI script, not
// app code, so the app's rule that every HTTP client goes through `network::client_for` does not apply.
//
//   node scripts/x-post.mjs next                  the next file to post (path, or nothing)
//   node scripts/x-post.mjs preview <file>        Markdown preview for the run summary
//   node scripts/x-post.mjs digest <file>         hash of the post text, image and reply target
//   node scripts/x-post.mjs post <file> [--dry-run] [--expect <digest>]
//
// `post` reads X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN and X_ACCESS_SECRET (OAuth 1.0a user context of
// the account), uploads the image, creates the post and records it in posted.json. `--dry-run` prints
// the requests instead of sending them and needs no keys.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const QUEUE = "docs/marketing/x-queue";
export const POSTED = `${QUEUE}/posted.json`;
const API = "https://api.x.com";
const FILE_NAME = /^(\d{4}-\d{2}-\d{2})-[a-z0-9][a-z0-9-]*\.md$/;
const KEYS = new Set(["text", "image", "reply_to"]);
const IMAGE_TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
/** X's limit for images uploaded in one request (docs.x.com, media upload). */
const IMAGE_MAX = 5 * 1024 * 1024;
export const MAX_LENGTH = 280;

// ---- OAuth 1.0a (RFC 5849, HMAC-SHA1) ----

/** RFC 3986 percent-encoding as OAuth 1.0a wants it (unreserved: A-Z a-z 0-9 - . _ ~). */
export function percentEncode(s) {
  return encodeURIComponent(String(s)).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * The signature base string. `params` are the oauth_* parameters plus query parameters and, for
 * form-encoded bodies only, the body parameters; JSON and multipart bodies are not signed.
 */
export function baseString(method, url, params) {
  const u = new URL(url);
  const all = [...Object.entries(params)];
  for (const [k, v] of u.searchParams) all.push([k, v]);
  const pairs = all.map(([k, v]) => [percentEncode(k), percentEncode(v)]);
  pairs.sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0));
  const normalized = pairs.map(([k, v]) => `${k}=${v}`).join("&");
  const base = `${u.protocol}//${u.host.toLowerCase()}${u.pathname}`;
  return [method.toUpperCase(), percentEncode(base), percentEncode(normalized)].join("&");
}

export function signature(base, consumerSecret, tokenSecret) {
  const key = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret ?? "")}`;
  return crypto.createHmac("sha1", key).update(base).digest("base64");
}

/** The Authorization header for one request. `extra` are signed non-oauth parameters (form bodies). */
export function authorization({ method, url, keys, extra = {}, nonce, timestamp }) {
  const oauth = {
    oauth_consumer_key: keys.apiKey,
    oauth_nonce: nonce ?? crypto.randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(timestamp ?? Math.floor(Date.now() / 1000)),
    oauth_token: keys.accessToken,
    oauth_version: "1.0",
  };
  oauth.oauth_signature = signature(baseString(method, url, { ...oauth, ...extra }), keys.apiSecret, keys.accessSecret);
  const parts = Object.keys(oauth)
    .sort()
    .map((k) => `${percentEncode(k)}="${percentEncode(oauth[k])}"`);
  return `OAuth ${parts.join(", ")}`;
}

// ---- Post files ----

/** Length as X counts it: URLs as 23, most Latin text 1 per character, other characters (CJK, emoji) 2. */
export function weightedLength(text) {
  const URL_RE = /\bhttps?:\/\/[^\s]+|\b(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|de|org|net|io|app|dev|ai|co|eu)\b(?:\/[^\s]*)?/gi;
  let n = 0;
  const rest = text.normalize("NFC").replace(URL_RE, () => {
    n += 23;
    return "";
  });
  for (const ch of rest) {
    const c = ch.codePointAt(0);
    const light = c <= 4351 || (c >= 8192 && c <= 8205) || (c >= 8208 && c <= 8223) || (c >= 8242 && c <= 8247);
    n += light ? 1 : 2;
  }
  return n;
}

export function hasLink(text) {
  return /\bhttps?:\/\//i.test(text);
}

function unquote(v, file) {
  if (v.startsWith('"')) {
    try {
      return JSON.parse(v);
    } catch {
      throw new Error(`${file}: bad double-quoted value ${v}`);
    }
  }
  if (v.startsWith("'")) {
    if (!v.endsWith("'") || v.length < 2) throw new Error(`${file}: bad single-quoted value ${v}`);
    return v.slice(1, -1).replace(/''/g, "'");
  }
  return v;
}

/**
 * Front matter (a small YAML subset: `key: value`, quoted values, and `key: |` blocks) and body.
 * Unknown keys are an error, so a typo never posts something unintended.
 */
export function parsePost(source, file = "post") {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(source);
  if (!m) throw new Error(`${file}: front matter (--- ... ---) missing`);
  const lines = m[1].split(/\r?\n/);
  const out = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const kv = /^([a-z_]+):\s*(.*)$/.exec(line);
    if (!kv) throw new Error(`${file}: cannot read front matter line "${line}"`);
    const [, key, raw] = kv;
    if (!KEYS.has(key)) throw new Error(`${file}: unknown key "${key}" (allowed: ${[...KEYS].join(", ")})`);
    if (raw === "|" || raw === "|-") {
      const block = [];
      while (i + 1 < lines.length && (/^\s+/.test(lines[i + 1]) || lines[i + 1] === "")) block.push(lines[++i]);
      const indent = Math.min(...block.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)[0].length));
      out[key] = block.map((l) => l.slice(indent)).join("\n").replace(/\s+$/, "");
    } else {
      out[key] = unquote(raw.trim(), file);
    }
  }
  return { ...out, notes: m[2] };
}

/** Checks a post and returns it with the resolved image path; throws with every problem found. */
export function loadPost(file, root = ROOT) {
  const name = path.basename(file);
  const post = parsePost(fs.readFileSync(path.resolve(root, file), "utf8"), name);
  const problems = [];
  if (!FILE_NAME.test(name)) problems.push(`file name must be <YYYY-MM-DD>-<slug>.md`);
  if (typeof post.text !== "string" || !post.text.trim()) problems.push("text is empty");
  else if (weightedLength(post.text) > MAX_LENGTH) problems.push(`text is ${weightedLength(post.text)} characters, X allows ${MAX_LENGTH}`);
  if (post.image) {
    const abs = path.resolve(root, post.image);
    if (!abs.startsWith(root + path.sep)) problems.push(`image ${post.image} is outside the repository`);
    else if (!fs.existsSync(abs)) problems.push(`image ${post.image} does not exist`);
    else if (!IMAGE_TYPES[path.extname(abs).toLowerCase()]) problems.push(`image ${post.image}: only png, jpg, gif and webp`);
    else if (fs.statSync(abs).size > IMAGE_MAX) problems.push(`image ${post.image} is larger than 5 MB`);
  }
  if (post.reply_to) {
    const id = /(?:status\/)?(\d{5,25})\/?$/.exec(String(post.reply_to));
    if (!id) problems.push(`reply_to must be a post ID or a post URL`);
    else post.reply_to = id[1];
  }
  if (problems.length) throw new Error(`${name}: ${problems.join("; ")}`);
  return post;
}

/** Hash of what gets posted (text, image bytes, reply target): what was previewed is what is posted. */
export function digest(post, root = ROOT) {
  const h = crypto.createHash("sha256");
  h.update(JSON.stringify([post.text, post.image ?? null, post.reply_to ?? null]));
  if (post.image) h.update(fs.readFileSync(path.resolve(root, post.image)));
  return h.digest("hex");
}

export function readPosted(root = ROOT) {
  const f = path.join(root, POSTED);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
}

export function writePosted(posted, root = ROOT) {
  const sorted = Object.fromEntries(Object.keys(posted).sort().map((k) => [k, posted[k]]));
  fs.writeFileSync(path.join(root, POSTED), `${JSON.stringify(sorted, null, 2)}\n`);
}

/** Today in Europe/Berlin as YYYY-MM-DD (the date in a file name is the earliest day it may go out). */
export function berlinToday(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** The oldest queued file that is due and not posted yet, or null. */
export function pickNext(names, posted, today) {
  const due = names.filter((n) => FILE_NAME.test(n) && !posted[n] && FILE_NAME.exec(n)[1] <= today).sort();
  return due[0] ?? null;
}

export function queueNames(root = ROOT) {
  const dir = path.join(root, QUEUE);
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

/** Markdown for the run summary: exactly the text and image that will be posted. */
export function preview(file, post, { repo, sha } = {}) {
  const len = weightedLength(post.text);
  const fence = "`".repeat(Math.max(3, ...[...post.text.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  const out = [`## X post waiting for approval`, ``, `File: \`${file}\``, ``, `${fence}text`, post.text, fence, ``];
  out.push(`${len} / ${MAX_LENGTH} characters (links count as 23).`);
  if (hasLink(post.text)) out.push(`Contains a link: X bills posts with a URL at a higher rate.`);
  if (post.reply_to) out.push(``, `Reply to: https://x.com/i/web/status/${post.reply_to}`);
  out.push(``);
  if (post.image) {
    const src = repo && sha ? `https://github.com/${repo}/raw/${sha}/${post.image}` : post.image;
    out.push(`Image: \`${post.image}\``, ``, `<img src="${src}" width="600" alt="Image of the post">`);
  } else out.push(`No image.`);
  out.push(``, `Approve: open the run, "Review deployments", tick x-approval, "Approve and deploy". Reject keeps the file queued.`);
  return out.join("\n") + "\n";
}

// ---- Posting ----

function redact(header) {
  return header.replace(/(oauth_(?:consumer_key|token|signature|nonce))="[^"]*"/g, '$1="..."');
}

/**
 * Uploads the image (if any) and creates the post. `send(url, init)` defaults to fetch; with `dryRun`
 * the requests are printed through `log` and nothing is sent.
 */
export async function publish(post, { keys, root = ROOT, send = fetch, dryRun = false, log = console.log } = {}) {
  const request = async (url, init, describe) => {
    if (dryRun) {
      log(`${init.method} ${url}`);
      for (const [k, v] of Object.entries(init.headers)) log(`${k}: ${k === "Authorization" ? redact(v) : v}`);
      log(describe);
      log("");
      return null;
    }
    const res = await send(url, init);
    const body = await res.text();
    let json;
    try {
      json = JSON.parse(body);
    } catch {
      json = null;
    }
    if (!res.ok) throw new Error(`${init.method} ${url}: HTTP ${res.status} ${body.slice(0, 500)}`);
    return json;
  };

  let mediaId = null;
  if (post.image) {
    const abs = path.resolve(root, post.image);
    const bytes = fs.readFileSync(abs);
    const type = IMAGE_TYPES[path.extname(abs).toLowerCase()];
    const url = `${API}/2/media/upload`;
    const form = new FormData();
    form.append("media", new Blob([bytes], { type }), path.basename(abs));
    form.append("media_category", "tweet_image");
    // Multipart bodies are not part of the OAuth 1.0a signature.
    const res = await request(
      url,
      { method: "POST", headers: { Authorization: authorization({ method: "POST", url, keys }) }, body: form },
      `multipart/form-data: media=<${bytes.length} bytes ${type}, ${post.image}>, media_category=tweet_image`,
    );
    mediaId = dryRun ? "<media id>" : res?.data?.id;
    if (!mediaId) throw new Error(`media upload returned no id: ${JSON.stringify(res)}`);
  }

  const url = `${API}/2/tweets`;
  const payload = { text: post.text };
  if (mediaId) payload.media = { media_ids: [mediaId] };
  if (post.reply_to) payload.reply = { in_reply_to_tweet_id: post.reply_to };
  const body = JSON.stringify(payload);
  const res = await request(
    url,
    { method: "POST", headers: { Authorization: authorization({ method: "POST", url, keys }), "Content-Type": "application/json" }, body },
    body,
  );
  if (dryRun) return null;
  const id = res?.data?.id;
  if (!id) throw new Error(`create post returned no id: ${JSON.stringify(res)}`);
  return { id, url: `https://x.com/i/web/status/${id}` };
}

export function keysFromEnv(env = process.env) {
  const keys = { apiKey: env.X_API_KEY, apiSecret: env.X_API_SECRET, accessToken: env.X_ACCESS_TOKEN, accessSecret: env.X_ACCESS_SECRET };
  const missing = Object.entries({ X_API_KEY: keys.apiKey, X_API_SECRET: keys.apiSecret, X_ACCESS_TOKEN: keys.accessToken, X_ACCESS_SECRET: keys.accessSecret })
    .filter(([, v]) => !v)
    .map(([k]) => k);
  return { keys, missing };
}

async function main(argv) {
  const [cmd, file, ...rest] = argv;
  const flag = (name) => rest.includes(name);
  const option = (name) => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : undefined);
  const rel = (f) => path.relative(ROOT, path.resolve(f));

  if (cmd === "next") {
    const next = pickNext(queueNames(), readPosted(), berlinToday());
    if (next) process.stdout.write(`${QUEUE}/${next}\n`);
    return;
  }
  if (!file) throw new Error("usage: x-post.mjs next | preview <file> | digest <file> | post <file> [--dry-run] [--expect <digest>]");
  const post = loadPost(rel(file));
  if (cmd === "preview") return void process.stdout.write(preview(rel(file), post, { repo: process.env.GITHUB_REPOSITORY, sha: process.env.PREVIEW_SHA }));
  if (cmd === "digest") return void process.stdout.write(`${digest(post)}\n`);
  if (cmd !== "post") throw new Error(`unknown command ${cmd}`);

  const name = path.basename(file);
  const posted = readPosted();
  if (posted[name]) throw new Error(`${name} was posted already: ${posted[name].url}`);
  const expect = option("--expect");
  if (expect && expect !== digest(post)) throw new Error(`${name} changed after the preview; nothing posted. The next run shows it again.`);
  const dryRun = flag("--dry-run");
  let { keys, missing } = keysFromEnv();
  if (dryRun) keys = { apiKey: keys.apiKey || "dry-run", apiSecret: keys.apiSecret || "dry-run", accessToken: keys.accessToken || "dry-run", accessSecret: keys.accessSecret || "dry-run" };
  else if (missing.length) throw new Error(`missing ${missing.join(", ")} (environment secrets of x-approval)`);

  const result = await publish(post, { keys, dryRun });
  if (dryRun) return void console.log(`Dry run: ${name}, ${weightedLength(post.text)} characters, nothing sent.`);
  posted[name] = { id: result.id, url: result.url, posted_at: new Date().toISOString() };
  writePosted(posted);
  console.log(`Posted ${name}: ${result.url}`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `url=${result.url}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`::error::${e.message}`);
    process.exit(1);
  });
}
