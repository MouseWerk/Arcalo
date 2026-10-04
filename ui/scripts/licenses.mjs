// Writes src/generated/licenses.json for Settings → Über → „Lizenzen“: Arcalo's LICENSE text
// and the libraries it ships, with version and license. The interface: the dependencies of
// package.json (read from node_modules). The app itself: the direct dependencies of the
// `annalo` and `annalo-core` crates (versions from Cargo.lock, licenses from the crate sources
// cargo downloaded). Cargo downloads only the crates of the platform it builds for, so the
// Windows and macOS crates are missing on Linux (and the other way round); their licenses then
// come from `cargo metadata`, which fetches the crates of every platform. Runs before `vite`
// and `vite build`.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ui = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = join(ui, "..");
const out = join(ui, "src/generated/licenses.json");

const licenseOf = (pkg) => (typeof pkg.license === "string" ? pkg.license : pkg.license?.type ?? (Array.isArray(pkg.licenses) ? pkg.licenses.map((l) => l.type).join(" OR ") : ""));

function uiLibraries() {
  const own = JSON.parse(readFileSync(join(ui, "package.json"), "utf8"));
  return Object.keys(own.dependencies ?? {}).map((name) => {
    const file = join(ui, "node_modules", name, "package.json");
    const pkg = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
    return { name, version: pkg.version ?? "", license: licenseOf(pkg) };
  });
}

/** `[[package]]` blocks of Cargo.lock: name, version, dependencies. */
function lockPackages() {
  const text = readFileSync(join(root, "Cargo.lock"), "utf8");
  return text
    .split("[[package]]")
    .slice(1)
    .map((block) => {
      const name = /^name = "(.+)"$/m.exec(block)?.[1];
      const version = /^version = "(.+)"$/m.exec(block)?.[1];
      const deps = /^dependencies = \[([\s\S]*?)\]/m.exec(block)?.[1] ?? "";
      return { name, version, deps: [...deps.matchAll(/"([^"]+)"/g)].map((m) => m[1]) };
    });
}

/** Folders of cargo's unpacked crate sources. */
function registryDirs() {
  const home = process.env.CARGO_HOME ?? join(homedir(), ".cargo");
  const src = join(home, "registry", "src");
  if (!existsSync(src)) return [];
  return readdirSync(src).map((d) => join(src, d));
}

function crateLicense(dirs, name, version) {
  for (const d of dirs) {
    const file = join(d, `${name}-${version}`, "Cargo.toml");
    if (!existsSync(file)) continue;
    return /^license\s*=\s*"(.+)"$/m.exec(readFileSync(file, "utf8"))?.[1] ?? "";
  }
  return "";
}

function appLibraries() {
  const pkgs = lockPackages();
  const dirs = registryDirs();
  const own = new Set(["annalo", "annalo-core", "annalo-cli"]);
  const seen = new Map();
  for (const p of pkgs.filter((x) => x.name === "annalo" || x.name === "annalo-core")) {
    for (const dep of p.deps) {
      // "name" or "name version" when the lock holds several versions.
      const [name, version] = dep.split(" ");
      if (own.has(name) || seen.has(name)) continue;
      const v = version ?? pkgs.find((x) => x.name === name)?.version ?? "";
      seen.set(name, { name, version: v, license: crateLicense(dirs, name, v) });
    }
  }
  const libs = [...seen.values()];
  const missing = libs.filter((l) => !l.license);
  if (missing.length) {
    const known = metadataLicenses();
    for (const l of missing) l.license = known.get(`${l.name} ${l.version}`) ?? "";
    const still = libs.filter((l) => !l.license).map((l) => l.name);
    if (still.length) console.warn(`licenses: no license found for ${still.join(", ")}`);
  }
  return libs;
}

/** "name version" → license of every crate in the lock file, all platforms (`cargo metadata`). */
function metadataLicenses() {
  try {
    const out = execFileSync("cargo", ["metadata", "--format-version", "1", "--locked"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "inherit"],
    });
    return new Map(JSON.parse(out).packages.map((p) => [`${p.name} ${p.version}`, p.license ?? ""]));
  } catch (e) {
    console.warn(`licenses: cargo metadata failed: ${e.message}`);
    return new Map();
  }
}

const byName = (a, b) => a.name.localeCompare(b.name);
const license = existsSync(join(root, "LICENSE")) ? readFileSync(join(root, "LICENSE"), "utf8") : "";
const data = { license, ui: uiLibraries().sort(byName), app: appLibraries().sort(byName) };
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(data, null, 1)}\n`);
