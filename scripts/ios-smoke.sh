#!/usr/bin/env bash
# The simulator check of the iOS app (.github/workflows/ios.yml, docs/ios.md): installs the debug
# build on an iPhone, a 13" iPad Pro and an iPad mini, starts it upright and sideways with
# ARCALO_SMOKE=1 (src-tauri/src/mobile/ios.rs runs src-tauri/src/mobile/ios_smoke.js in the
# WebView and writes smoke.json into the app's data folder), takes a screenshot of each and checks
# the report with scripts/ios-smoke-check.py: the iPhone shows the phone app, the iPads the full
# app; nothing overflows sideways, no fixed control sits inside the safe-area insets, no errors.
#
#   scripts/ios-smoke.sh path/to/Arcalo.app out-dir
set -euo pipefail

APP="$1"
OUT="$2"
BUNDLE="de.mousewerk.arcalo"
mkdir -p "$OUT"

runtime=$(xcrun simctl list runtimes available -j | python3 -c '
import json, sys
rs = [r for r in json.load(sys.stdin)["runtimes"] if r.get("platform") == "iOS" and r.get("isAvailable")]
rs.sort(key=lambda r: [int(x) for x in r["version"].split(".")])
print(rs[-1]["identifier"] if rs else "")')
if [ -z "$runtime" ]; then
  echo "::error::No iOS simulator runtime on this runner"
  exit 1
fi
echo "Runtime: $runtime"

# The newest device type whose name matches (e.g. "iPhone 16 Pro" before "iPhone 15 Pro").
devicetype() {
  xcrun simctl list devicetypes -j | python3 -c '
import json, re, sys
pattern = re.compile(sys.argv[1])
ts = [t for t in json.load(sys.stdin)["devicetypes"] if pattern.search(t["name"])]
print(ts[-1]["identifier"] if ts else "")' "$1"
}

status=0
run() {
  local name="$1" pattern="$2" expect="$3"
  local type
  type=$(devicetype "$pattern")
  if [ -z "$type" ]; then
    echo "::error::No simulator device type matches '$pattern'"
    status=1
    return
  fi
  echo "== $name ($type)"
  local udid
  udid=$(xcrun simctl create "arcalo-$name" "$type" "$runtime")
  xcrun simctl boot "$udid"
  xcrun simctl bootstatus "$udid" -b >/dev/null
  xcrun simctl install "$udid" "$APP"
  for orientation in portrait landscape; do
    local data report
    data=$(xcrun simctl get_app_container "$udid" "$BUNDLE" data)
    report="$data/Library/Application Support/$BUNDLE/smoke.json"
    rm -f "$report"
    SIMCTL_CHILD_ARCALO_SMOKE=1 SIMCTL_CHILD_ARCALO_SMOKE_ORIENTATION="$orientation" \
      xcrun simctl launch --terminate-running-process "$udid" "$BUNDLE" >/dev/null
    # The report's second round (20 s after the start), when the page settled.
    local waited=0
    until [ -f "$report" ] && grep -q '"round": 2' "$report"; do
      if [ "$waited" -ge 150 ]; then
        echo "::error::$name $orientation: no report after ${waited}s"
        find "$data" -name '*.log' -path '*logs*' -exec tail -n 40 {} \; 2>/dev/null || true
        status=1
        break
      fi
      sleep 5
      waited=$((waited + 5))
    done
    xcrun simctl io "$udid" screenshot "$OUT/$name-$orientation.png" >/dev/null
    if [ -f "$report" ]; then
      cp "$report" "$OUT/$name-$orientation.json"
      python3 "$(dirname "$0")/ios-smoke-check.py" "$OUT/$name-$orientation.json" "$expect" "$name $orientation" || status=1
    fi
  done
  # The app's log, for a failure.
  find "$(xcrun simctl get_app_container "$udid" "$BUNDLE" data)" -name '*.log' -exec cp {} "$OUT/$name.log" \; 2>/dev/null || true
  xcrun simctl shutdown "$udid" || true
  xcrun simctl delete "$udid" || true
}

run iphone '^iPhone [0-9]+ Pro$' phone
run ipad-pro-13 '^iPad Pro 13-inch' full
run ipad-mini '^iPad mini' full
exit $status
