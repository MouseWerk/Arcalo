#!/usr/bin/env bash
# Builds the desktop app with the production frontend embedded and runs the
# end-to-end suite against it (Linux, headless via Xvfb + tauri-driver).
set -euo pipefail
cd "$(dirname "$0")/.."
npm --prefix ui run build
cargo build -p annalo --features custom-protocol
cd e2e
rm -f screenshots/FAIL-*
[ -d node_modules ] || npm ci
ANNALO_APP="$PWD/../target/debug/annalo" node --test --test-concurrency=1 --test-reporter=spec tests/*.test.js
