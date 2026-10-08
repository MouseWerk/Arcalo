#!/usr/bin/env bash
# Runs the end-to-end tests in a Linux container (see Dockerfile). Usage from the repository root:
#   e2e/docker/run.sh                       # whole suite
#   e2e/docker/run.sh tests/01-notes.test.js tests/63-calendar-view.test.js
# The Linux build output and node_modules live in Docker volumes, so the Mac's own target/ and
# node_modules stay untouched. Needs Docker Desktop, OrbStack or Colima.
set -euo pipefail
cd "$(dirname "$0")/../.."
docker build -t arcalo-e2e e2e/docker
files=("${@:-tests/*.test.js}")
docker run --rm -t \
  -v "$PWD":/repo \
  -v arcalo-e2e-target:/repo/target \
  -v arcalo-e2e-cargo:/usr/local/cargo/registry \
  -v arcalo-e2e-ui-modules:/repo/ui/node_modules \
  -v arcalo-e2e-e2e-modules:/repo/e2e/node_modules \
  arcalo-e2e bash -c "
    set -e
    npm ci --prefix ui --no-audit --no-fund
    npm ci --prefix e2e --no-audit --no-fund
    npm --prefix ui run build
    cargo build -p arcalo --features custom-protocol
    cd e2e && rm -f screenshots/FAIL-*
    ARCALO_APP=/repo/target/debug/arcalo node --test --test-concurrency=1 --test-reporter=spec ${files[*]}
  "
