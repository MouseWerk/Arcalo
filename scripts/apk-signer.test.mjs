// The signing certificate's digest of an APK (scripts/apk-signer.mjs), on APKs built here: a ZIP with
// an APK Signing Block holding a v2 and/or v3 signer. node --test scripts/apk-signer.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { signerDigest } from "./apk-signer.mjs";

const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const u64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
const lp = (...parts) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([u32(body.length), body]);
};

/** A v2/v3 scheme block with one signer and its certificates (as the format nests them). */
function scheme(certs, v3 = false) {
  const digests = lp(lp(u32(0x0103), lp(Buffer.from("digest"))));
  const certificates = lp(...certs.map((c) => lp(c)));
  const signedData = lp(digests, certificates, ...(v3 ? [u32(28), u32(0x7fffffff)] : []), lp());
  const signer = lp(signedData, ...(v3 ? [u32(28), u32(0x7fffffff)] : []), lp(), lp(Buffer.from("key")));
  return lp(signer);
}

/** A ZIP with one stored file and an APK Signing Block of `pairs` ([id, value]) before its central directory. */
function apk(pairs, comment = "") {
  const name = Buffer.from("AndroidManifest.xml");
  const data = Buffer.from("manifest");
  const local = Buffer.concat([u32(0x04034b50), Buffer.alloc(22), Buffer.from([name.length, 0, 0, 0]), name, data]);
  let block = Buffer.alloc(0);
  if (pairs) {
    const body = Buffer.concat(pairs.map(([id, value]) => Buffer.concat([u64(value.length + 4), u32(id), value])));
    const size = body.length + 8 + 16;
    block = Buffer.concat([u64(size), body, u64(size), Buffer.from("APK Sig Block 42")]);
  }
  const cdStart = local.length + block.length;
  const central = Buffer.concat([u32(0x02014b50), Buffer.alloc(24), Buffer.from([name.length, 0]), Buffer.alloc(16), name]);
  const eocd = Buffer.concat([u32(0x06054b50), Buffer.alloc(4), Buffer.from([1, 0, 1, 0]), u32(central.length), u32(cdStart), Buffer.from([comment.length, 0]), Buffer.from(comment)]);
  return Buffer.concat([local, block, central, eocd]);
}

const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const certA = Buffer.from("0\x82 certificate A (DER)");
const certB = Buffer.from("0\x82 certificate B (DER)");

test("the first certificate of the v2 signer", () => {
  assert.equal(signerDigest(apk([[0x7109871a, scheme([certA, certB])]])), sha(certA));
  // Other pairs (padding, dependency info) and a ZIP comment do not disturb it.
  const padded = apk([[0x42726577, Buffer.alloc(100)], [0x7109871a, scheme([certA])], [0x504b4453, Buffer.from("deps")]], "a comment");
  assert.equal(signerDigest(padded), sha(certA));
});

test("v3 comes before v2 (the current signer after a key rotation)", () => {
  const both = apk([[0x7109871a, scheme([certA])], [0xf05368c0, scheme([certB], true)]]);
  assert.equal(signerDigest(both), sha(certB));
  assert.equal(signerDigest(apk([[0xf05368c0, scheme([certB], true)]])), sha(certB));
});

test("no digest without a v2 or v3 signer, or from a broken block", () => {
  assert.equal(signerDigest(apk(null)), null, "v1 only or unsigned");
  assert.equal(signerDigest(apk([[0x42726577, Buffer.alloc(8)]])), null);
  assert.equal(signerDigest(apk([[0x7109871a, Buffer.from([9, 0, 0, 0, 1])]])), null, "truncated");
  assert.equal(signerDigest(Buffer.from("not a zip at all")), null);
  assert.equal(signerDigest(Buffer.alloc(0)), null);
});

test("the command line prints the digest or fails", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arcalo-apk-signer-"));
  try {
    const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "apk-signer.mjs");
    const signed = path.join(dir, "signed.apk");
    fs.writeFileSync(signed, apk([[0x7109871a, scheme([certA])]]));
    assert.equal(execFileSync(process.execPath, [script, signed], { encoding: "utf8" }), `${sha(certA)}\n`);
    const unsigned = path.join(dir, "unsigned.apk");
    fs.writeFileSync(unsigned, apk(null));
    assert.throws(() => execFileSync(process.execPath, [script, unsigned], { stdio: "pipe" }), /no APK Signing Block/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
