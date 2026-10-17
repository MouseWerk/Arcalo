#!/usr/bin/env bash
# The simulator check of the iOS app (.github/workflows/ios.yml, docs/ios.md): installs the debug
# build on the runner's newest iPhone Pro, 13" iPad Pro and iPad mini, upright and sideways, with
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

# The newest simulator of the runtime whose name matches (e.g. "iPhone 17 Pro" before
# "iPhone 16 Pro"): the runner's own, so its device type fits the runtime.
device() {
  xcrun simctl list devices available -j | python3 -c '
import json, re, sys
pattern, runtime = re.compile(sys.argv[1]), sys.argv[2]
ds = [d for d in json.load(sys.stdin)["devices"].get(runtime, []) if pattern.search(d["name"])]
key = lambda d: [int(x) if x.isdigit() else x for x in re.split(r"(\d+)", d["name"])]
ds.sort(key=key)
print(ds[-1]["udid"], ds[-1]["name"]) if ds else print("")' "$1" "$runtime"
}

# Turns the simulated device to landscape: Simulator's „Rotate Left“ (Cmd+Left). An iPad app that
# supports every orientation and multitasking turns with the device only; the app asks an iPhone
# window itself (requestGeometryUpdate, src-tauri/src/mobile/ios.rs).
rotate_left() {
  osascript -e 'tell application "Simulator" to activate' \
    -e 'delay 1' \
    -e 'tell application "System Events" to key code 123 using command down' >/dev/null
  sleep 3
}

status=0
run() {
  local name="$1" pattern="$2" expect="$3"
  local found udid
  found=$(device "$pattern")
  if [ -z "$found" ]; then
    echo "::error::No simulator of $runtime matches '$pattern'"
    status=1
    return
  fi
  udid="${found%% *}"
  echo "== $name: ${found#* } ($udid)"
  xcrun simctl boot "$udid" 2>/dev/null || true
  xcrun simctl bootstatus "$udid" -b >/dev/null
  open -a Simulator --args -CurrentDeviceUDID "$udid"
  sleep 5
  xcrun simctl uninstall "$udid" "$BUNDLE" 2>/dev/null || true
  xcrun simctl install "$udid" "$APP"
  for orientation in portrait landscape; do
    local data report
    data=$(xcrun simctl get_app_container "$udid" "$BUNDLE" data)
    report="$data/Library/Application Support/$BUNDLE/smoke.json"
    rm -f "$report"
    if [ "$orientation" = landscape ]; then
      xcrun simctl terminate "$udid" "$BUNDLE" 2>/dev/null || true
      rotate_left || echo "::warning::$name: Simulator could not be rotated"
    fi
    # Upright the first start as a user sees it (the iPad: the setup over the full app); sideways
    # the app itself with the sample workspace.
    local demo=0
    [ "$orientation" = landscape ] && demo=1
    SIMCTL_CHILD_ARCALO_SMOKE=1 SIMCTL_CHILD_ARCALO_SMOKE_ORIENTATION="$orientation" \
      SIMCTL_CHILD_ARCALO_SMOKE_DEMO="$demo" SIMCTL_CHILD_ARCALO_SKIP_ONBOARDING="$demo" \
      xcrun simctl launch --terminate-running-process "$udid" "$BUNDLE" >/dev/null
    # The report's second round (20 s after the start), when the page settled.
    local waited=0
    until [ -f "$report" ] && grep -q '"round": 2' "$report"; do
      if [ "$waited" -ge 600 ]; then
        echo "::error::$name $orientation: no report after ${waited}s"
        status=1
        break
      fi
      sleep 5
      waited=$((waited + 5))
    done
    xcrun simctl io "$udid" screenshot "$OUT/$name-$orientation.png" >/dev/null
    # The simulator takes the picture in the device's upright orientation: turned to be read.
    [ "$orientation" = landscape ] && sips -r 270 "$OUT/$name-$orientation.png" >/dev/null
    if [ -f "$report" ]; then
      cp "$report" "$OUT/$name-$orientation.json"
      python3 "$(dirname "$0")/ios-smoke-check.py" "$OUT/$name-$orientation.json" "$expect" "$orientation" "$name $orientation" || status=1
    fi
  done
  # The app's log, for a failure.
  find "$(xcrun simctl get_app_container "$udid" "$BUNDLE" data)" -name '*.log' -exec cp {} "$OUT/$name.log" \; 2>/dev/null || true
  xcrun simctl shutdown "$udid" || true
}

run iphone '^iPhone [0-9]+ Pro$' phone
run ipad-pro-13 '^iPad Pro 13-inch' full
run ipad-mini '^iPad mini' full
exit $status
