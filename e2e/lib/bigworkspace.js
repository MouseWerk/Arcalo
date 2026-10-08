// The large workspace of the performance benchmark (docs/performance.md): 5,000 pages, 20,000
// links, 30,000 tasks, three years of daily notes, two years of bookings, 300 attachments, a
// canvas of 200 cards, 2,000 Jira issues in 50 projects and three calendars. The data comes from
// the generator in crates/arcalo-core/tests/bigworkspace.rs (deterministic); it is built once
// into a cache folder and copied for every run, so each run starts from the same state.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");

/** The cached, generated workspace (built on first use, about a minute in a debug build). */
export function bigWorkspaceBase() {
  const base = process.env.ARCALO_BIG_BASE ?? path.join(os.tmpdir(), "arcalo-bigworkspace-v1");
  if (!fs.existsSync(path.join(base, "workspace.db"))) {
    fs.rmSync(base, { recursive: true, force: true });
    fs.mkdirSync(base, { recursive: true });
    execFileSync("cargo", ["test", "-q", "-p", "arcalo-core", "--test", "bigworkspace", "--", "--ignored"], {
      cwd: ROOT,
      env: { ...process.env, ARCALO_BIG_DIR: base, CARGO_INCREMENTAL: "0", CARGO_PROFILE_DEV_DEBUG: "0" },
      stdio: ["ignore", "ignore", "inherit"],
    });
  }
  return base;
}

/** A fresh copy of the large workspace in a new temporary data folder (the caller removes it). */
export function bigWorkspace() {
  const base = bigWorkspaceBase();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arcalo-big-"));
  fs.cpSync(base, dir, { recursive: true });
  return dir;
}
