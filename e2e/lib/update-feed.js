// A local update feed for the auto-update tests: a throwaway minisign key (generated per run,
// never the release key), `latest.json` and one update file, with switches for the failures a
// user can meet (tampered file, 404, a download cut off midway, a slow download).

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

/** A fresh Ed25519 key in minisign format, as the Tauri updater reads it. */
export function throwawayKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
  const id = crypto.randomBytes(8);
  const pub = `untrusted comment: minisign public key (annalo e2e)\n${Buffer.concat([Buffer.from("Ed"), id, raw]).toString("base64")}\n`;
  return {
    /** `ANNALO_UPDATE_PUBKEY`: base64 of the public key file (like src-tauri/updater.pub). */
    pubkey: Buffer.from(pub).toString("base64"),
    /** The `.sig` content for `data`: base64 of a minisign signature file. */
    sign(data, version) {
      const sig = crypto.sign(null, data, privateKey);
      const trusted = `timestamp:${Math.floor(Date.now() / 1000)}\tfile:annalo-update.bin\tversion:${version}`;
      const global = crypto.sign(null, Buffer.concat([sig, Buffer.from(trusted)]), privateKey);
      const file = [
        "untrusted comment: signature from annalo e2e key",
        Buffer.concat([Buffer.from("Ed"), id, sig]).toString("base64"),
        `trusted comment: ${trusted}`,
        global.toString("base64"),
        "",
      ].join("\n");
      return Buffer.from(file).toString("base64");
    },
  };
}

/**
 * Serves `/latest.json` and `/annalo-update.bin`. `feed.mode`: "ok", "tampered" (one byte of the
 * file changed after signing), "missing" (latest.json 404), "cut" (the connection drops at a
 * third of the file), "slow" (the file trickles in over a few seconds, then fails its signature),
 * "throttle" (the valid file trickles in over a few seconds). "ok" and "throttle" answer a
 * `Range` request with the rest of the file (206); `feed.ranges` lists the offsets asked for.
 */
export async function startFeed({ key, version, size = 3 * 1024 * 1024, notes = "## Neu\n\n- Getestet" }) {
  const file = crypto.randomBytes(size);
  const feed = { mode: "ok", version, requests: [], ranges: [] };
  const server = http.createServer((req, res) => {
    feed.requests.push(req.url);
    const base = `http://127.0.0.1:${server.address().port}`;
    if (req.url.startsWith("/latest.json")) {
      if (feed.mode === "missing") return res.writeHead(404).end("Not Found");
      const body = {
        version: feed.version,
        notes,
        pub_date: "2026-09-25T12:00:00Z",
        platforms: { "linux-x86_64": { signature: key.sign(file, feed.version), url: `${base}/annalo-update.bin` } },
      };
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(body));
    }
    if (req.url === "/annalo-update.bin") {
      let bytes = Buffer.from(file);
      if (feed.mode === "tampered" || feed.mode === "slow") bytes[bytes.length >> 1] ^= 0xff;
      const range = /^bytes=(\d+)-$/.exec(req.headers.range ?? "");
      if (range && (feed.mode === "ok" || feed.mode === "throttle")) {
        const from = Number(range[1]);
        feed.ranges.push(from);
        bytes = bytes.subarray(Math.min(from, bytes.length));
        res.writeHead(206, { "content-type": "application/octet-stream", "content-length": bytes.length, "content-range": `bytes ${from}-${file.length - 1}/${file.length}` });
      } else res.writeHead(200, { "content-type": "application/octet-stream", "content-length": bytes.length });
      if (feed.mode === "cut") {
        res.write(bytes.subarray(0, bytes.length / 3));
        return setTimeout(() => req.socket.destroy(), 200);
      }
      if (feed.mode === "slow" || feed.mode === "throttle") {
        let at = 0;
        const step = Math.ceil(file.length / 20);
        const tick = setInterval(() => {
          if (res.destroyed) return clearInterval(tick);
          res.write(bytes.subarray(at, at + step));
          at += step;
          if (at >= bytes.length) {
            clearInterval(tick);
            res.end();
          }
        }, 200);
        return;
      }
      return res.end(bytes);
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  feed.url = `http://127.0.0.1:${server.address().port}/latest.json`;
  feed.close = () =>
    new Promise((r) => {
      server.close(r);
      server.closeAllConnections();
    });
  feed.server = server;
  return feed;
}

/**
 * A mirrored release in a folder (an internal share): `latest.json` naming the file by its bare
 * name, as the mirror script writes it, and the signed file next to it.
 */
export function writeShare(dir, { key, version, size = 256 * 1024 }) {
  const file = crypto.randomBytes(size);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "Arcalo-update.bin"), file);
  const body = {
    version,
    notes: "## Neu\n\n- Von der Freigabe",
    pub_date: "2026-10-01T12:00:00Z",
    platforms: { "linux-x86_64": { signature: key.sign(file, version), url: "Arcalo-update.bin" } },
  };
  fs.writeFileSync(path.join(dir, "latest.json"), JSON.stringify(body));
  return file;
}
