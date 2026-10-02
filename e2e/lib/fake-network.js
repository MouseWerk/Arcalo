// Mock network for the per-service routing tests: forward proxies that record what they
// forward, a plain HTTP service (AI model list, Jira server info) and HTTPS servers with
// self-signed certificates (made with openssl). All on 127.0.0.1, port 0.
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

/** An HTTP forward proxy (absolute-URI requests) named `name`; `seen` lists what it forwarded. */
export async function startProxy(name) {
  const seen = [];
  const server = http.createServer((req, res) => {
    if (!/^http:\/\//.test(req.url)) {
      res.writeHead(400);
      return res.end("not a proxy request");
    }
    const target = new URL(req.url);
    seen.push({ path: target.pathname, host: target.host, auth: req.headers["proxy-authorization"] ?? null });
    const headers = { ...req.headers, "x-via-proxy": name };
    delete headers["proxy-authorization"];
    delete headers["proxy-connection"];
    const up = http.request({ host: target.hostname, port: target.port, path: target.pathname + target.search, method: req.method, headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on("error", () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(up);
  });
  const port = await listen(server);
  return { name, seen, port, address: `127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

const answer = (req, res) => {
  const p = new URL(req.url, "http://x").pathname;
  res.setHeader("content-type", "application/json");
  if (p.endsWith("/v1/models") || p.endsWith("/models")) return res.end(JSON.stringify({ object: "list", data: [{ id: "mock-model", object: "model" }] }));
  if (p.endsWith("/rest/api/2/serverInfo")) return res.end(JSON.stringify({ version: "9.12.0", deploymentType: "Server", serverTitle: "Mock" }));
  if (p.endsWith("/rest/api/2/myself")) return res.end(JSON.stringify({ name: "mia", displayName: "Mia Meyer", accountId: "mia" }));
  res.statusCode = 404;
  res.end("{}");
};

/** The service the proxies forward to: records each request with the proxy it came through. */
export async function startService() {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ path: new URL(req.url, "http://x").pathname, via: req.headers["x-via-proxy"] ?? "direct" });
    answer(req, res);
  });
  const port = await listen(server);
  return { seen, port, url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

/** An HTTPS server with a fresh self-signed certificate for 127.0.0.1; `sha256` = its fingerprint (lower-case hex). */
export async function startTls(cn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "annalo-e2e-tls-"));
  const key = path.join(dir, "key.pem");
  const cert = path.join(dir, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "30", "-subj", `/CN=${cn}`, "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" });
  const pem = fs.readFileSync(cert, "utf8");
  const sha256 = new crypto.X509Certificate(pem).fingerprint256.replace(/:/g, "").toLowerCase();
  const seen = [];
  const server = https.createServer({ key: fs.readFileSync(key), cert: pem }, (req, res) => {
    seen.push(new URL(req.url, "https://x").pathname);
    answer(req, res);
  });
  const port = await listen(server);
  return {
    seen,
    sha256,
    port,
    url: `https://127.0.0.1:${port}`,
    close: () => new Promise((r) => server.close(() => (fs.rmSync(dir, { recursive: true, force: true }), r()))),
  };
}
